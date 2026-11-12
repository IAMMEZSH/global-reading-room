'use strict';

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const zlib = require('node:zlib');
const { URL } = require('node:url');
const { promisify } = require('node:util');
const { describeNetError } = require('./util');

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotliDecompress = promisify(zlib.brotliDecompress);

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml;q=0.8,*/*;q=0.5',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'close',
};

function envProxy() {
  return process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy || '';
}

function parseProxy(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try { url = new URL(withScheme); } catch { throw new Error('代理地址格式不正确，例如 http://127.0.0.1:7890'); }
  if (url.protocol !== 'http:') {
    throw new Error('目前仅支持 HTTP 代理（Clash / v2rayN 的混合端口），例如 http://127.0.0.1:7890');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port) || 80;
  let auth = '';
  if (url.username) {
    const user = decodeURIComponent(url.username);
    const pass = decodeURIComponent(url.password || '');
    auth = 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
  }
  return { host, port, auth };
}

function timeoutError() {
  const err = new Error('请求超时');
  err.code = 'ETIMEDOUT';
  return err;
}

function decorateError(error) {
  if (error && !error.friendly) error.friendly = describeNetError(error);
  return error;
}

async function decompress(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (!enc || enc === 'identity') return buffer;
  const opts = { maxOutputLength: 32 * 1024 * 1024 };
  try {
    if (enc.includes('gzip')) return await gunzip(buffer, opts);
    if (enc.includes('deflate')) {
      try { return await inflate(buffer, opts); } catch { return await inflateRaw(buffer, opts); }
    }
    if (enc.includes('br')) return await brotliDecompress(buffer, opts);
  } catch (error) {
    throw decorateError(new Error(`内容解压失败：${error.message}`));
  }
  return buffer;
}

function collectResponse(res, req, { timeout, maxBytes }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* noop */ }
      reject(decorateError(error));
    };
    const timer = setTimeout(() => {
      fail(timeoutError());
    }, timeout);
    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const body = await decompress(Buffer.concat(chunks), res.headers['content-encoding']);
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body,
          url: res.url || '',
        });
      } catch (error) {
        reject(error);
      }
    };
    const contentLength = Number(res.headers['content-length'] || 0);
    if (contentLength && contentLength > maxBytes) {
      fail(new Error('响应内容过大'));
      return;
    }
    res.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(new Error('响应内容过大'));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', finish);
    res.on('error', fail);
    res.on('aborted', () => fail(new Error('连接被中断')));
  });
}

function directRequest(url, { method, headers, body, timeout, maxBytes }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    let req = null;
    try {
      req = mod.request(url, {
        method,
        headers,
        agent: false,
        rejectUnauthorized: true,
      }, (res) => {
        res.url = url.href;
        collectResponse(res, req, { timeout, maxBytes }).then(resolve, reject);
      });
    } catch (error) {
      reject(decorateError(error));
      return;
    }
    req.setTimeout(timeout, () => req.destroy(timeoutError()));
    req.on('error', (error) => reject(decorateError(error)));
    if (body) req.write(body);
    req.end();
  });
}

function proxiedRequest(url, proxy, { method, headers, body, timeout, maxBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connectReq = null;
    let tlsSocket = null;
    let innerReq = null;
    const timer = setTimeout(() => fail(timeoutError()), timeout);
    const cleanup = () => clearTimeout(timer);
    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      try { connectReq && connectReq.destroy(); } catch { /* noop */ }
      try { tlsSocket && tlsSocket.destroy(); } catch { /* noop */ }
      try { innerReq && innerReq.destroy(); } catch { /* noop */ }
      reject(decorateError(error));
    }
    function done(result) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    if (url.protocol === 'http:') {
      const proxyHeaders = { ...headers, Host: url.host };
      if (proxy.auth) proxyHeaders['Proxy-Authorization'] = proxy.auth;
      try {
        innerReq = http.request({
          host: proxy.host,
          port: proxy.port,
          method,
          path: url.href,
          headers: proxyHeaders,
          agent: false,
        }, (res) => {
          res.url = url.href;
          collectResponse(res, innerReq, { timeout, maxBytes }).then(done, fail);
        });
      } catch (error) {
        fail(error);
        return;
      }
      innerReq.on('error', fail);
      if (body) innerReq.write(body);
      innerReq.end();
      return;
    }

    const targetHost = url.hostname.replace(/^\[|\]$/g, '');
    const targetPort = Number(url.port) || 443;
    const connectHeaders = {
      Host: `${targetHost}:${targetPort}`,
      'Proxy-Connection': 'keep-alive',
      'User-Agent': headers['User-Agent'],
    };
    if (proxy.auth) connectHeaders['Proxy-Authorization'] = proxy.auth;
    try {
      connectReq = http.request({
        host: proxy.host,
        port: proxy.port,
        method: 'CONNECT',
        path: `${targetHost}:${targetPort}`,
        headers: connectHeaders,
        agent: false,
      });
    } catch (error) {
      fail(error);
      return;
    }
    connectReq.on('error', fail);
    connectReq.on('timeout', () => fail(timeoutError()));
    connectReq.on('connect', (res, socket) => {
      if (settled) { socket.destroy(); return; }
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`代理隧道建立失败：HTTP ${res.statusCode}`));
        return;
      }
      tlsSocket = tls.connect({
        socket,
        servername: targetHost,
        rejectUnauthorized: true,
      });
      tlsSocket.once('error', fail);
      tlsSocket.once('secureConnect', () => {
        if (settled) return;
        try {
          innerReq = http.request({
            host: targetHost,
            port: targetPort,
            method,
            path: url.pathname + url.search,
            headers: { ...headers, Host: url.host },
            agent: false,
            createConnection: () => tlsSocket,
          }, (response) => {
            response.url = url.href;
            collectResponse(response, innerReq, { timeout, maxBytes }).then(done, fail);
          });
        } catch (error) {
          fail(error);
          return;
        }
        innerReq.on('error', fail);
        if (body) innerReq.write(body);
        innerReq.end();
      });
    });
    connectReq.end();
  });
}

async function requestOnce(url, options, proxyConfig) {
  const timeout = Number(options.timeout) || 20000;
  const maxBytes = Number(options.maxBytes) || 8 * 1024 * 1024;
  const method = (options.method || 'GET').toUpperCase();
  const headers = { ...DEFAULT_HEADERS, ...(options.headers || {}) };
  const body = options.body || null;
  if (body && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8';
  }
  const params = { method, headers, body, timeout, maxBytes };
  if (proxyConfig) return proxiedRequest(url, proxyConfig, params);
  return directRequest(url, params);
}

async function httpRequest(rawUrl, options = {}) {
  let currentUrl;
  try { currentUrl = new URL(rawUrl); } catch {
    throw new Error(`无效的网址：${rawUrl}`);
  }
  if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') {
    throw new Error('只支持 http/https 网址');
  }
  let proxyConfig = null;
  const proxySetting = options.proxy !== undefined ? options.proxy : envProxy();
  if (proxySetting) proxyConfig = parseProxy(proxySetting);

  let method = (options.method || 'GET').toUpperCase();
  let body = options.body || null;
  const maxRedirects = Number.isFinite(options.maxRedirects) ? options.maxRedirects : 5;
  for (let index = 0; index <= maxRedirects; index++) {
    const result = await requestOnce(currentUrl, { ...options, method, body }, proxyConfig);
    const location = result.headers.location;
    if ([301, 302, 303, 307, 308].includes(result.status) && location) {
      if (index === maxRedirects) throw new Error('重定向次数过多');
      let next;
      try { next = new URL(location, currentUrl); } catch { throw new Error('跳转地址无效'); }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('跳转到了不支持的协议');
      if (typeof options.validateUrl === 'function') await options.validateUrl(next.toString());
      currentUrl = next;
      if ([301, 302, 303].includes(result.status)) {
        method = 'GET';
        body = null;
      }
      continue;
    }
    return result;
  }
  throw new Error('重定向次数过多');
}

module.exports = { httpRequest, parseProxy, DEFAULT_HEADERS };

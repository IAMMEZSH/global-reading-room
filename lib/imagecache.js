'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const dns = require('node:dns/promises');
const { URL } = require('node:url');
const { httpRequest } = require('./http');
const { hashId } = require('./util');

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};
const DNS_TTL = 5 * 60 * 1000;
const dnsCache = new Map();

function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase();
  if (!value) return true;
  if (value === '::1' || value === '::' || value === '0.0.0.0') return true;
  if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80')) return true;
  const v4 = value.startsWith('::ffff:') ? value.slice(7) : value;
  const parts = v4.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  return false;
}

function blockedUrl(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'BLOCKED_URL';
  return error;
}

async function assertPublicUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw blockedUrl('图片地址不正确'); }
  if (!/^https?:$/.test(parsed.protocol)) throw blockedUrl('只支持 http/https 图片地址');
  if (parsed.username || parsed.password) throw blockedUrl('图片地址不允许包含凭据');
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(hostname)) throw blockedUrl('不允许访问本机或内网地址');
  if (isPrivateAddress(hostname)) throw blockedUrl('不允许访问内网地址');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return parsed;
  const cached = dnsCache.get(hostname);
  if (cached && Date.now() - cached.at < DNS_TTL) {
    if (cached.private) throw blockedUrl('不允许访问内网地址');
    return parsed;
  }
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    const privateHost = records.some((record) => isPrivateAddress(record.address));
    dnsCache.set(hostname, { at: Date.now(), private: privateHost });
    if (privateHost) throw blockedUrl('不允许访问内网地址');
  } catch (error) {
    if (error.code === 'BLOCKED_URL') throw error;
    dnsCache.set(hostname, { at: Date.now(), private: false });
  }
  return parsed;
}

function sniffMime(buffer) {
  if (!buffer || buffer.length < 12) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.slice(4, 12).toString('ascii').includes('ftypavif')) return 'image/avif';
  return '';
}

function createImageCache(dataDir) {
  const dir = path.join(dataDir, 'images');
  const pending = new Map();
  let ready = null;

  function ensureDir() {
    if (!ready) ready = fsp.mkdir(dir, { recursive: true }).catch(() => {});
    return ready;
  }

  function fileFor(url, ext) {
    return path.join(dir, `${hashId(url, 28)}${ext}`);
  }

  async function findCached(url) {
    const base = hashId(url, 28);
    try {
      const entries = await fsp.readdir(dir);
      const match = entries.find((name) => name.startsWith(base + '.'));
      if (!match) return null;
      const file = path.join(dir, match);
      const stat = await fsp.stat(file);
      const ext = path.extname(match).toLowerCase();
      const mime = Object.keys(MIME_EXT).find((key) => MIME_EXT[key] === ext) || 'image/jpeg';
      return { file, mime, size: stat.size, cached: true };
    } catch {
      return null;
    }
  }

  async function fetchImage(url, options = {}) {
    const parsed = await assertPublicUrl(url);
    const referer = options.referer || `${parsed.protocol}//${parsed.host}/`;
    const response = await httpRequest(url, {
      proxy: options.proxy || undefined,
      timeout: 20000,
      maxBytes: 15 * 1024 * 1024,
      validateUrl: assertPublicUrl,
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8,*/*;q=0.5',
        Referer: referer,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
    });
    if (response.status >= 400) throw new Error(`图片返回 HTTP ${response.status}`);
    const declared = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const mime = MIME_EXT[declared] ? declared : sniffMime(response.body);
    if (!MIME_EXT[mime]) throw new Error('不支持的图片格式');
    await ensureDir();
    const file = fileFor(url, MIME_EXT[mime]);
    await fsp.writeFile(file, response.body);
    return { file, mime, size: response.body.length, cached: false, buffer: response.body };
  }

  async function get(url, options = {}) {
    if (!url || typeof url !== 'string') throw new Error('缺少图片地址');
    const cached = await findCached(url);
    if (cached && cached.size > 0) return cached;
    const key = hashId(url, 20);
    if (pending.has(key)) return pending.get(key);
    const job = fetchImage(url, options).finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }

  async function getBuffer(url, options = {}) {
    const result = await get(url, options);
    if (result.buffer) return result;
    const buffer = await fsp.readFile(result.file);
    return { ...result, buffer };
  }

  async function stats() {
    try {
      const entries = await fsp.readdir(dir);
      let bytes = 0;
      for (const name of entries) {
        try { bytes += (await fsp.stat(path.join(dir, name))).size; } catch { /* ignore */ }
      }
      return { count: entries.length, bytes };
    } catch {
      return { count: 0, bytes: 0 };
    }
  }

  return { get, getBuffer, stats, dir };
}

module.exports = { createImageCache, assertPublicUrl, isPrivateAddress, sniffMime };

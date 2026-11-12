'use strict';

const crypto = require('node:crypto');

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', middot: '\u00b7',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  laquo: '\u00ab', raquo: '\u00bb', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  deg: '\u00b0', plusmn: '\u00b1', times: '\u00d7', divide: '\u00f7',
  emsp: '\u2003', ensp: '\u2002', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d',
};

function decodeEntities(input) {
  if (input == null) return '';
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] && body[1].toLowerCase() === 'x';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return m; }
      }
      return m;
    }
    const val = ENTITIES[body.toLowerCase()];
    return val == null ? m : val;
  });
}

function escapeHtml(input) {
  return String(input == null ? '' : input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripMarkup(input) {
  const text = String(input == null ? '' : input)
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

function hashId(input, length = 16) {
  return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, length);
}

function hashText(text) {
  return crypto.createHash('sha1').update(String(text), 'utf8').digest('hex').slice(0, 16);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeUrl(raw, base) {
  if (raw == null) return '';
  try {
    const url = base ? new URL(String(raw).trim(), base) : new URL(String(raw).trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function feedKey(raw) {
  const normalized = normalizeUrl(raw);
  if (!normalized) return '';
  try {
    const url = new URL(normalized);
    url.hostname = url.hostname.toLowerCase();
    let key = url.href;
    key = key.replace(/\/$/, '');
    return key;
  } catch {
    return normalized;
  }
}

function stripTracking(urlString) {
  try {
    const url = new URL(urlString);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|spm$|from$|ref$|ref_src$|share|fbclid|gclid|yclid|mc_cid|mc_eid)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hash = '';
    return url.href;
  } catch {
    return urlString;
  }
}

function articleId(link, guid) {
  const basis = stripTracking(normalizeUrl(link) || '') || String(guid || '');
  if (!basis) return hashId(`${Date.now()}-${Math.random()}`);
  return hashId(basis);
}

function decodeBuffer(buffer, contentType = '') {
  const head = buffer.subarray(0, 4096).toString('latin1');
  let charset = null;
  const fromHeader = String(contentType || '').match(/charset\s*=\s*["']?([\w.:-]+)/i);
  if (fromHeader) charset = fromHeader[1];
  if (!charset) {
    const fromXml = head.match(/<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)/i);
    if (fromXml) charset = fromXml[1];
  }
  if (!charset) {
    const fromMeta = head.match(/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i);
    if (fromMeta) charset = fromMeta[1];
  }
  let label = (charset || 'utf-8').toLowerCase();
  const alias = {
    gb2312: 'gb18030', gbk: 'gb18030', 'x-gbk': 'gb18030', gb_2312: 'gb18030',
    utf8: 'utf-8', 'utf-8': 'utf-8', big5: 'big5', 'big5-hkscs': 'big5',
    'iso-8859-1': 'windows-1252', latin1: 'windows-1252', 'us-ascii': 'utf-8',
    shift_jis: 'shift_jis', sjis: 'shift_jis', euc_jp: 'euc-jp',
    euc_kr: 'euc-kr', koi8_r: 'koi8-r',
  };
  label = alias[label] || label;
  try {
    return new TextDecoder(label, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

const LATIN_HINTS = {
  de: /\b(der|die|das|und|nicht|mit|für|ist|eine|einer|einem|auch|werden|wurde|über|dem|des|sich|als|bei|aus|nach|wie|wir|dass)\b/g,
  fr: /\b(les|des|du|une|est|dans|pour|avec|sur|pas|plus|aux|par|cette|qui|nous|vous|ils|elles|être|ont|son|ses|selon|mais)\b/g,
  es: /\b(el|los|las|del|una|es|por|con|para|más|al|como|que|sus|pero|fue|han|este|esta|hay|desde|según|sobre)\b/g,
  it: /\b(il|lo|gli|le|di|del|della|è|per|con|non|più|che|una|al|come|sono|da|nel|nella|anche|questo|questa)\b/g,
  pt: /\b(os|as|do|da|dos|das|um|uma|é|em|para|com|não|mais|ao|como|seu|sua|são|foi|pela|segundo|sobre)\b/g,
  nl: /\b(het|een|en|van|voor|met|niet|zijn|dat|die|aan|ook|als|maar|bij|door|wordt|deze|dit)\b/g,
};
const ENGLISH_HINT = /\b(the|and|of|to|in|is|for|with|on|that|this|was|are|as|at|by|from|it|its|has|have|will|not|but|they|their|which|after|before)\b/g;

function countMatches(text, re) {
  const match = text.match(re);
  return match ? match.length : 0;
}

function guessLanguage(text) {
  const sample = String(text || '').slice(0, 3000);
  if (/[\u3040-\u30ff]/.test(sample)) return 'ja';
  if (/[\uac00-\ud7af]/.test(sample)) return 'ko';
  if (/[\u0400-\u04ff]/.test(sample)) return 'ru';
  if (/[\u0600-\u06ff]/.test(sample)) return 'ar';
  const cjk = (sample.match(/[\u3400-\u9fff]/g) || []).length;
  const letters = (sample.match(/[A-Za-z\u3400-\u9fff]/g) || []).length;
  if (cjk > 0 && cjk / Math.max(1, letters) > 0.22) return 'zh';

  const lower = sample.toLowerCase();
  const english = countMatches(lower, ENGLISH_HINT);
  let best = { code: '', score: 0 };
  for (const [code, re] of Object.entries(LATIN_HINTS)) {
    const score = countMatches(lower, re);
    if (score > best.score) best = { code, score };
  }
  if (best.score >= 2 && best.score >= english * 1.15) return best.code;
  if (english >= 2 && english > best.score * 1.15) return 'en';
  return '';
}

function sanitizeFilename(name, fallback = 'article') {
  let out = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 90)
    .trim();
  if (!out) out = fallback;
  return out;
}

function truncate(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)).trimEnd() + '\u2026';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitLongText(text, maxChars) {
  const parts = [];
  let rest = String(text || '');
  while (rest.length > maxChars) {
    let cut = -1;
    const window = rest.slice(0, maxChars);
    const punct = Math.max(
      window.lastIndexOf('\u3002'), window.lastIndexOf('\uff01'), window.lastIndexOf('\uff1f'),
      window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
      window.lastIndexOf('\uff1b'), window.lastIndexOf('; '), window.lastIndexOf('\u3001'),
      window.lastIndexOf(' '),
    );
    cut = punct > maxChars * 0.45 ? punct + 1 : maxChars;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

function splitForBytes(text, maxBytes = 450) {
  const chunks = [];
  const src = String(text || '');
  if (Buffer.byteLength(src, 'utf8') <= maxBytes) return [src];
  const sentenceParts = splitLongText(src, 400);
  let current = '';
  const push = () => {
    if (current.trim()) chunks.push(current);
    current = '';
  };
  for (const part of sentenceParts) {
    let piece = part;
    while (Buffer.byteLength(piece, 'utf8') > maxBytes) {
      let cut = piece.length - 1;
      while (cut > 1 && Buffer.byteLength(piece.slice(0, cut), 'utf8') > maxBytes) cut--;
      push();
      chunks.push(piece.slice(0, cut));
      piece = piece.slice(cut);
    }
    if (Buffer.byteLength((current + piece).trim(), 'utf8') > maxBytes) push();
    current += piece;
  }
  push();
  return chunks.length ? chunks : [src];
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function describeNetError(error) {
  if (!error) return '未知网络错误';
  const code = error.code || '';
  const message = String(error.message || '');
  if (/超时|timeout|ETIMEDOUT/i.test(`${code} ${message}`)) return '请求超时（网络较慢或站点无响应）';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败（检查网络或代理设置）';
  if (code === 'ECONNRESET' || code === 'EPIPE') return '连接被重置（可能需要配置代理）';
  if (code === 'ECONNREFUSED') return '连接被拒绝（代理地址或端口是否正确？）';
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return '网络不可达（检查网络或代理设置）';
  if (/CERT_|certificate/i.test(`${code} ${message}`)) return 'TLS 证书校验失败';
  if (/代理/.test(message) || /proxy/i.test(message)) return message;
  return message || '网络请求失败';
}

function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

module.exports = {
  decodeEntities,
  escapeHtml,
  stripMarkup,
  hashId,
  hashText,
  nowIso,
  normalizeUrl,
  feedKey,
  stripTracking,
  articleId,
  decodeBuffer,
  guessLanguage,
  sanitizeFilename,
  truncate,
  sleep,
  splitLongText,
  splitForBytes,
  mapLimit,
  describeNetError,
  safeJsonParse,
};

'use strict';

const crypto = require('node:crypto');
const { httpRequest } = require('./http');
const {
  hashText, decodeEntities, safeJsonParse, splitForBytes, splitLongText, sleep, mapLimit,
} = require('./util');

const TARGET_LABEL = { 'zh-CN': '简体中文', 'zh-TW': '繁体中文' };

const PROVIDER_LABELS = {
  mymemory: 'MyMemory 免费翻译',
  deepl: 'DeepL',
  azure: 'Azure 认知服务',
  baidu: '百度翻译开放平台',
  openai: 'OpenAI 兼容接口',
};

const FATAL_CODES = new Set(['AUTH', 'QUOTA', 'CONFIG', 'RATE_LIMIT']);

function txError(message, code = 'PROVIDER_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireValue(value, label) {
  const text = String(value || '').trim();
  if (!text) throw txError(`${label}尚未填写，请在“设置 → 翻译服务”中配置。`, 'CONFIG');
  return text;
}

function shortError(text, max = 200) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function statusError(label, status) {
  if (status === 401 || status === 403) return txError(`${label} 鉴权失败，请检查密钥、区域或账户状态。`, 'AUTH');
  if (status === 429) return txError(`${label} 请求过于频繁，请稍后再试。`, 'RATE_LIMIT');
  if (status === 456) return txError('DeepL 本月翻译额度已用完。', 'QUOTA');
  if (status === 402) return txError('翻译账户余额不足。', 'QUOTA');
  return txError(`${label} 返回 HTTP ${status}。`, 'PROVIDER_ERROR');
}

async function requestJson(url, options, label) {
  let response;
  try {
    response = await httpRequest(url, { ...options, timeout: options.timeout || 30000 });
  } catch (error) {
    throw txError(`${label} 网络请求失败：${error.friendly || error.message}`, 'NETWORK');
  }
  const text = response.body.toString('utf8');
  if (response.status >= 400) {
    let detail = '';
    try {
      const data = JSON.parse(text);
      detail = data.message || data.error_description || (data.error && (data.error.message || data.error.code)) || '';
    } catch { detail = shortError(text, 160); }
    if (response.status === 403 && /quota|limit/i.test(detail)) {
      throw txError(`${label} 额度不足：${shortError(detail)}`, 'QUOTA');
    }
    if (response.status === 429) {
      throw txError(`${label} 请求过于频繁：${shortError(detail) || '请稍后再试'}`, 'RATE_LIMIT');
    }
    const error = statusError(label, response.status);
    if (detail) error.message += `（${shortError(detail)}）`;
    throw error;
  }
  const data = safeJsonParse(text, null);
  if (!data) throw txError(`${label} 返回了无法解析的内容。`, 'PROVIDER_ERROR');
  return data;
}

async function mymemoryTranslate(texts, ctx) {
  const { settings, proxy } = ctx;
  const target = settings.translate.targetLang;
  const email = String(settings.translate.mymemoryEmail || '').trim();

  async function translateChunk(chunk) {
    const params = new URLSearchParams();
    params.set('q', chunk);
    params.set('langpair', `Autodetect|${target}`);
    if (email) params.set('de', email);
    const url = `https://api.mymemory.translated.net/get?${params.toString()}`;
    let response = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await httpRequest(url, { proxy, timeout: 25000, maxBytes: 2 * 1024 * 1024 });
      } catch (error) {
        if (attempt === 2) {
          throw txError(`MyMemory 网络请求失败：${error.friendly || error.message}`, 'NETWORK');
        }
        await sleep(600 * (attempt + 1));
        continue;
      }
      if (response.status === 429 && attempt < 2) {
        await sleep(1200 * (attempt + 1));
        continue;
      }
      break;
    }
    if (response.status === 429) throw txError('MyMemory 请求过于频繁，请稍后再试。', 'RATE_LIMIT');
    if (response.status >= 400) throw statusError('MyMemory', response.status);
    const data = safeJsonParse(response.body.toString('utf8'), null);
    if (!data) throw txError('MyMemory 返回内容无法解析。', 'PROVIDER_ERROR');
    if (data.quotaFinished) {
      throw txError('MyMemory 今日免费额度已用完。可在设置里填写邮箱提高到约 5 万字符/天，或改用 DeepL、Azure、百度、OpenAI 兼容接口。', 'QUOTA');
    }
    const translated = data.responseData && data.responseData.translatedText;
    const state = Number(data.responseStatus || 200);
    const detail = shortError(data.responseDetails || '');
    if (state !== 200) {
      if (/quota|limit|too many/i.test(detail)) {
        throw txError(`MyMemory 额度不足：${detail || '今日免费额度已用完'}`, 'QUOTA');
      }
      throw txError(`MyMemory 翻译失败：${detail || `状态 ${state}`}`, 'PROVIDER_ERROR');
    }
    if (!translated) return '';
    const value = decodeEntities(String(translated)).trim();
    if (/^(MYMEMORY WARNING|PLEASE SELECT TWO DISTINCT LANGUAGES|INVALID SOURCE LANGUAGE|NO QUERY SPECIFIED)/i.test(value)) {
      throw txError(`MyMemory 无法翻译这段内容：${shortError(value)}`, 'PROVIDER_ERROR');
    }
    return value;
  }

  async function translateOne(text) {
    const chunks = splitForBytes(text, 450).filter((chunk) => chunk.trim());
    const pieces = await mapLimit(chunks, 2, async (chunk) => {
      const value = await translateChunk(chunk);
      await sleep(120);
      return value;
    });
    return pieces.join(' ').replace(/\s+/g, ' ').trim();
  }

  return mapLimit(texts, 4, translateOne);
}

async function deeplTranslate(texts, ctx) {
  const key = requireValue(ctx.settings.translate.deeplKey, 'DeepL 密钥');
  const target = ctx.settings.translate.targetLang;
  const endpoint = key.endsWith(':fx') ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';
  const body = {
    text: texts,
    target_lang: target === 'zh-TW' ? 'ZH-HANT' : 'ZH',
  };
  if (ctx.sourceLang && ctx.sourceLang !== 'auto' && !ctx.sourceLang.startsWith('zh')) {
    body.source_lang = ctx.sourceLang.toUpperCase();
  }
  const data = await requestJson(endpoint, {
    method: 'POST',
    proxy: ctx.proxy,
    headers: {
      Authorization: `DeepL-Auth-Key ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, 'DeepL');
  if (!Array.isArray(data.translations) || data.translations.length !== texts.length) {
    throw txError('DeepL 返回的段落数量不一致，请重试。', 'ALIGNMENT');
  }
  return data.translations.map((item) => String(item.text || '').trim());
}

async function azureTranslate(texts, ctx) {
  const key = requireValue(ctx.settings.translate.azureKey, 'Azure 密钥');
  const region = String(ctx.settings.translate.azureRegion || '').trim();
  const target = ctx.settings.translate.targetLang === 'zh-TW' ? 'zh-Hant' : 'zh-Hans';
  const endpoint = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${target}`;
  const headers = {
    'Ocp-Apim-Subscription-Key': key,
    'Content-Type': 'application/json',
  };
  if (region) headers['Ocp-Apim-Subscription-Region'] = region;
  const data = await requestJson(endpoint, {
    method: 'POST',
    proxy: ctx.proxy,
    headers,
    body: JSON.stringify(texts.map((text) => ({ Text: text }))),
  }, 'Azure 翻译');
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw txError('Azure 返回的段落数量不一致，请重试。', 'ALIGNMENT');
  }
  return data.map((item) => {
    const translation = item && Array.isArray(item.translations) ? item.translations[0] : null;
    if (!translation) throw txError('Azure 返回内容缺少译文。', 'PROVIDER_ERROR');
    return String(translation.text || '').trim();
  });
}

const BAIDU_ERRORS = {
  52001: ['请求超时，请重试。', 'NETWORK'],
  52002: ['百度翻译系统错误，请稍后重试。', 'PROVIDER_ERROR'],
  52003: ['百度翻译未授权用户，请检查 APPID。', 'AUTH'],
  54001: ['百度翻译签名错误，请检查密钥是否正确。', 'AUTH'],
  54003: ['百度翻译访问频率受限，请稍后再试。', 'RATE_LIMIT'],
  54004: ['百度翻译账户余额不足。', 'QUOTA'],
  54005: ['百度翻译长文本请求过于频繁，请稍后再试。', 'RATE_LIMIT'],
  58000: ['客户端 IP 非法，请检查百度翻译后台的 IP 白名单设置。', 'AUTH'],
  58001: ['译文语言方向不支持。', 'CONFIG'],
  58002: ['百度翻译服务当前已关闭。', 'CONFIG'],
  90107: ['百度翻译认证未通过或尚未生效。', 'AUTH'],
};

async function baiduTranslateOne(text, ctx) {
  const appId = requireValue(ctx.settings.translate.baiduAppId, '百度翻译 APPID');
  const key = requireValue(ctx.settings.translate.baiduKey, '百度翻译密钥');
  const target = ctx.settings.translate.targetLang === 'zh-TW' ? 'cht' : 'zh';
  const chunks = splitForBytes(text, 4800);
  const pieces = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const salt = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const sign = crypto.createHash('md5').update(appId + chunk + salt + key, 'utf8').digest('hex');
    const params = new URLSearchParams();
    params.set('q', chunk);
    params.set('from', 'auto');
    params.set('to', target);
    params.set('appid', appId);
    params.set('salt', salt);
    params.set('sign', sign);
    const data = await requestJson('https://fanyi-api.baidu.com/api/trans/vip/translate', {
      method: 'POST',
      proxy: ctx.proxy,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: params.toString(),
    }, '百度翻译');
    if (data.error_code) {
      const mapped = BAIDU_ERRORS[String(data.error_code)];
      throw txError(`百度翻译：${mapped ? mapped[0] : data.error_msg || data.error_code}`, mapped ? mapped[1] : 'PROVIDER_ERROR');
    }
    if (!Array.isArray(data.trans_result) || !data.trans_result.length) {
      throw txError('百度翻译没有返回译文。', 'PROVIDER_ERROR');
    }
    pieces.push(data.trans_result.map((item) => String(item.dst || '')).join('\n'));
    await sleep(900);
  }
  return pieces.join(' ').replace(/\s+/g, ' ').trim();
}

async function baiduTranslate(texts, ctx) {
  const output = [];
  for (const text of texts) output.push(await baiduTranslateOne(text, ctx));
  return output;
}

function openaiPrompt(target) {
  const label = TARGET_LABEL[target] || '简体中文';
  return [
    `你是专业新闻翻译，把输入 JSON 数组里的每一段文本翻译成${label}。`,
    '要求：',
    '1. 输出必须是 JSON 字符串数组，长度和顺序与输入完全一致；每段输入对应一段输出，不合并、不拆分、不增删。',
    '2. 保留专有名词、机构名、人名、数字、日期、URL 和引号含义；新闻标题要简洁自然。',
    '3. 只输出 JSON 数组本身，不要 Markdown 代码块，不要解释。',
  ].join('\n');
}

function extractJsonArray(content) {
  let text = String(content || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  text = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function openaiTranslate(texts, ctx) {
  const t = ctx.settings.translate;
  const baseUrl = String(t.openaiBaseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw txError('OpenAI 兼容接口地址尚未填写。', 'CONFIG');
  const key = String(t.openaiKey || '').trim();
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(baseUrl);
  if (!key && !isLocal) throw txError('OpenAI 兼容接口密钥尚未填写。', 'CONFIG');
  const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  const target = t.targetLang;
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const data = await requestJson(endpoint, {
    method: 'POST',
    proxy: ctx.proxy,
    timeout: 60000,
    headers,
    body: JSON.stringify({
      model: String(t.openaiModel || 'deepseek-chat').trim(),
      temperature: 0.2,
      stream: false,
      max_tokens: 8000,
      messages: [
        { role: 'system', content: openaiPrompt(target) },
        { role: 'user', content: JSON.stringify(texts) },
      ],
    }),
  }, 'OpenAI 兼容接口');
  const choice = data.choices && data.choices[0];
  let content = choice && choice.message ? choice.message.content : '';
  if (Array.isArray(content)) content = content.map((part) => (typeof part === 'string' ? part : part.text || '')).join('');
  let items = extractJsonArray(content);
  if (!items && typeof content === 'string' && texts.length === 1) items = [content.trim()];
  if (!items) throw txError('翻译模型没有返回可解析的 JSON 数组。', 'PROVIDER_ERROR');
  items = items.map((item) => String(item == null ? '' : item).trim());
  if (items.length !== texts.length) {
    if (texts.length > 1) {
      const middle = Math.ceil(texts.length / 2);
      const first = await openaiTranslate(texts.slice(0, middle), ctx);
      const second = await openaiTranslate(texts.slice(middle), ctx);
      return first.concat(second);
    }
    throw txError('翻译模型返回的段落数量与原文不一致。', 'ALIGNMENT');
  }
  return items;
}

function engineFor(settings) {
  const provider = settings.translate.provider;
  if (provider === 'mymemory') {
    return { id: provider, label: PROVIDER_LABELS[provider], maxItems: 4, maxChars: 8000, translate: mymemoryTranslate };
  }
  if (provider === 'deepl') {
    return { id: provider, label: PROVIDER_LABELS[provider], maxItems: 20, maxChars: 9000, translate: deeplTranslate };
  }
  if (provider === 'azure') {
    return { id: provider, label: PROVIDER_LABELS[provider], maxItems: 20, maxChars: 9000, translate: azureTranslate };
  }
  if (provider === 'baidu') {
    return { id: provider, label: PROVIDER_LABELS[provider], maxItems: 1, maxChars: 5000, translate: baiduTranslate };
  }
  if (provider === 'openai') {
    return { id: provider, label: PROVIDER_LABELS[provider], maxItems: 10, maxChars: 6000, translate: openaiTranslate };
  }
  throw txError('未知的翻译服务，请在设置中重新选择。', 'CONFIG');
}

function buildSegments(article) {
  const segments = [];
  const seen = new Set();
  const add = (key, text) => {
    const value = String(text || '').trim();
    if (value.length < 2) return;
    const hash = hashText(value);
    if (seen.has(hash)) return;
    seen.add(hash);
    segments.push({ key, text: value, hash });
  };
  add('title', article.title);
  add('summary', article.summary);
  (article.blocks || []).forEach((block, index) => {
    if (!block || block.t === 'img' || !block.text) return;
    add(`b${index}`, block.text);
  });
  return segments;
}

function translationView(article, payload) {
  if (!payload) return null;
  const texts = payload.texts || {};
  return {
    provider: payload.provider || '',
    providerLabel: PROVIDER_LABELS[payload.provider] || payload.provider || '',
    targetLang: payload.targetLang || '',
    complete: Boolean(payload.complete),
    note: payload.note || '',
    stats: payload.stats || {},
    failed: Object.values(payload.failed || {}).slice(0, 20),
    updatedAt: payload.updatedAt || '',
    title: texts[hashText(article.title || '')] || '',
    summary: texts[hashText(article.summary || '')] || '',
    blocks: (article.blocks || []).map((block) => {
      if (block.t === 'img') return { ...block, translation: '' };
      const text = String(block.text || '');
      return { ...block, translation: texts[hashText(text)] || '' };
    }),
  };
}

async function testTranslation(settings, proxy) {
  const engine = engineFor(settings);
  const started = Date.now();
  const [text] = await engine.translate(['Hello, world. This is a translation test.'], {
    settings, proxy, sourceLang: 'en',
  });
  return {
    provider: engine.id,
    providerLabel: engine.label,
    text,
    elapsedMs: Date.now() - started,
  };
}

function batchSegments(segments, engine) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const segment of segments) {
    const length = segment.text.length;
    if (current.length && (current.length >= engine.maxItems || chars + length > engine.maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(segment);
    chars += length;
  }
  if (current.length) batches.push(current);
  return batches;
}

function prepareSegments(article, engine) {
  const segments = buildSegments(article);
  const units = [];
  for (const segment of segments) {
    const max = Math.min(3000, engine.maxChars);
    if (segment.text.length <= max) {
      units.push({ parent: segment, text: segment.text });
      continue;
    }
    const parts = splitLongText(segment.text, max);
    parts.forEach((part, index) => units.push({ parent: segment, text: part, part: index }));
  }
  return { segments, units };
}

module.exports = {
  TARGET_LABEL,
  PROVIDER_LABELS,
  FATAL_CODES,
  engineFor,
  buildSegments,
  prepareSegments,
  batchSegments,
  translationView,
  testTranslation,
  txError,
  hashText,
};

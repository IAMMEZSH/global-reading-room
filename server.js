'use strict';

const http = require('node:http');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');

const { Store } = require('./lib/store');
const { CATALOG, CATEGORIES, REGIONS } = require('./lib/sources');
const { loadFeed, discoverAndLoad } = require('./lib/rss');
const { httpRequest, parseProxy } = require('./lib/http');
const { extractArticle } = require('./lib/extract');
const { createImageCache, assertPublicUrl } = require('./lib/imagecache');
const { ocrImage, visionConfigured } = require('./lib/ocr');
const { parseCues, youtubeVideoId, parseCaptionTracks, pickCaptionTrack, cuesFromPlainText } = require('./lib/captions');
const {
  decodeBuffer, hashId, nowIso, feedKey, mapLimit, truncate, safeJsonParse, sanitizeFilename,
} = require('./lib/util');
const tx = require('./lib/translate');
const {
  articleToMarkdown, articleToHtml, buildExportZip, buildOpml, parseOpml,
} = require('./lib/exporters');

const PUBLIC_DIR = path.join(__dirname, 'public');
const TARGET_LANGS = new Set(['zh-CN', 'zh-TW']);
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' https: http: data:",
    "media-src 'self' https: http: blob:",
    "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://player.bilibili.com https://www.dailymotion.com https://geo.dailymotion.com",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function httpError(message, status = 400, code = '') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function attachmentHeader(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class JobManager {
  constructor() {
    this.jobs = new Map();
    this.order = [];
  }

  create(type, title, extra = {}) {
    const job = {
      id: hashId(`${type}|${Date.now()}|${Math.random()}`, 12),
      type,
      title,
      status: 'running',
      createdAt: nowIso(),
      startedAt: nowIso(),
      finishedAt: '',
      updatedAt: nowIso(),
      progress: { done: 0, total: 1, percent: 0 },
      ...extra,
    };
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    while (this.order.length > 40) {
      const oldId = this.order[0];
      const old = this.jobs.get(oldId);
      if (old && old.status === 'running') break;
      this.order.shift();
      this.jobs.delete(oldId);
    }
    return job;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  list(limit = 12) {
    return this.order.slice(-limit).reverse().map((id) => this.jobs.get(id)).filter(Boolean);
  }

  active(type) {
    return this.order.map((id) => this.jobs.get(id)).filter((job) => job && job.status === 'running' && (!type || job.type === type));
  }

  finish(job, status = 'done', extra = {}) {
    job.status = status;
    job.finishedAt = nowIso();
    job.updatedAt = job.finishedAt;
    Object.assign(job, extra);
    if (status === 'done') job.progress.percent = 100;
    return job;
  }
}

function progressOf(job) {
  const total = Math.max(0, Number(job.progress.total) || 0);
  const done = Math.min(total, Math.max(0, Number(job.progress.done) || 0));
  job.progress.done = done;
  job.progress.percent = total ? Math.round((done / total) * 100) : 0;
  job.updatedAt = nowIso();
}

async function startServer(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.GRR_DATA_DIR || path.join(__dirname, 'data'));
  const store = new Store(dataDir);
  await store.init();
  const imageCache = createImageCache(dataDir);
  const jobs = new JobManager();
  const activeTranslations = new Map();
  let activeSync = null;
  let autoTimer = null;
  let closingPromise = null;
  let closed = false;
  const exitOnShutdown = Boolean(options.exitOnShutdown);

  function sendJson(res, status, data) {
    const body = Buffer.from(JSON.stringify(data), 'utf8');
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  function sendText(res, status, text) {
    const body = Buffer.from(String(text), 'utf8');
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  async function readCacheJson(file) {
    const data = safeJsonParse(await fsp.readFile(file, 'utf8').catch(() => ''), null);
    return data && typeof data === 'object' ? data : null;
  }

  async function writeCacheJson(file, data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(data), 'utf8');
  }

  async function serveImage(req, res, url) {
    if (req.method !== 'GET') throw httpError('方法不支持', 405);
    const target = url.searchParams.get('url') || '';
    if (!/^https?:\/\//i.test(target) || target.length > 2048) throw httpError('图片地址不正确', 400);
    const settings = store.getSettings();
    const result = await imageCache.get(target, { proxy: settings.proxy });
    const data = await fsp.readFile(result.file);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': result.mime,
      'Content-Length': data.length,
      'Cache-Control': 'public, max-age=604800, immutable',
    });
    res.end(data);
  }

  function sendBuffer(res, status, buffer, contentType, extra = {}) {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': contentType,
      'Content-Length': buffer.length,
      ...extra,
    });
    res.end(buffer);
  }

  function readBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let finished = false;
      req.on('data', (chunk) => {
        if (finished) return;
        total += chunk.length;
        if (total > limit) {
          finished = true;
          reject(httpError('请求内容过大', 413));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (finished) return;
        finished = true;
        resolve(Buffer.concat(chunks));
      });
      req.on('error', (error) => {
        if (finished) return;
        finished = true;
        reject(error);
      });
    });
  }

  async function readJson(req, limit) {
    const buffer = await readBody(req, limit);
    if (!buffer.length) return {};
    const data = safeJsonParse(buffer.toString('utf8'), null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw httpError('请求格式不正确', 400);
    return data;
  }

  async function serveStatic(req, res, url) {
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { pathname = url.pathname; }
    if (pathname === '' || pathname === '/') pathname = '/index.html';
    const allowed = new Set(['/index.html', '/app.js', '/styles.css', '/theme-future.css', '/icon.svg']);
    if (!allowed.has(pathname)) {
      sendText(res, 404, '找不到这个页面');
      return;
    }
    const file = path.join(PUBLIC_DIR, pathname);
    let data;
    try {
      data = await fsp.readFile(file);
    } catch {
      sendText(res, 404, '找不到这个文件');
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  }

  async function startSync(options = {}) {
    const sourceId = String(options.sourceId || '');
    if (activeSync && activeSync.status === 'running') return activeSync;
    const sources = sourceId
      ? [store.getSource(sourceId)].filter(Boolean)
      : store.db.sources.filter((source) => source.enabled);
    if (!sources.length) throw httpError(sourceId ? '订阅源不存在' : '没有启用的订阅源', 400);
    const job = jobs.create('sync', sourceId ? `同步：${sources[0].title}` : '同步全部订阅源', {
      total: sources.length,
      added: 0,
      failed: 0,
      summary: null,
    });
    if (sources.length === 1) job.sourceId = sources[0].id;
    job.progress.total = sources.length;
    job.progress.done = 0;
    progressOf(job);
    activeSync = job;
    runSync(job, sources)
      .catch((error) => {
        if (job.status === 'running') {
          job.error = error.friendly || error.message;
          jobs.finish(job, 'error');
        }
      })
      .finally(() => {
        if (activeSync === job) activeSync = null;
      });
    return job;
  }

  async function runSync(job, sources) {
    const settings = store.getSettings();
    const proxy = settings.proxy || undefined;
    const summary = { ok: 0, failed: 0, added: 0, errors: [] };
    await mapLimit(sources, 4, async (source) => {
      if (job.status === 'canceled') return;
      job.current = source.title;
      try {
        const { feed } = await loadFeed(source.url, { proxy, timeout: 25000 });
        const result = await store.ingest(source.id, feed.items);
        await store.updateSourceSyncState(source.id, { error: '' });
        summary.ok++;
        summary.added += result.added;
        job.added = summary.added;
      } catch (error) {
        summary.failed++;
        job.failed = summary.failed;
        const message = error.friendly || error.message || '同步失败';
        await store.updateSourceSyncState(source.id, { error: message });
        if (summary.errors.length < 20) summary.errors.push(`${source.title}：${truncate(message, 200)}`);
        console.error(`[sync] ${source.title}: ${message}`);
      }
      job.progress.done++;
      progressOf(job);
    });
    await store.setMeta({
      lastSyncAt: nowIso(),
      lastSyncSummary: {
        at: nowIso(),
        ok: summary.ok,
        failed: summary.failed,
        added: summary.added,
        errors: summary.errors.slice(0, 10),
      },
    });
    await store.flush();
    job.summary = summary;
    if (job.status === 'canceled') {
      job.finishedAt = nowIso();
      return;
    }
    job.progress.done = job.progress.total;
    progressOf(job);
    jobs.finish(job, 'done', {
      summary,
      warning: summary.failed ? `${summary.failed} 个订阅源同步失败，详情见“订阅源”中的错误提示。` : '',
    });
  }

  async function startTranslation(articleId, options = {}) {
    const article = await store.getArticle(articleId);
    if (!article) throw httpError('文章不存在', 404);
    if (!Array.isArray(article.blocks) || !article.blocks.length) {
      throw httpError('这篇文章还没有正文，请先点“抓取全文”，或换一篇带完整内容的文章。', 400);
    }
    const settings = store.getSettings();
    const provider = String(options.provider || settings.translate.provider);
    if (!tx.PROVIDER_LABELS[provider]) throw httpError('未知的翻译服务', 400);
    const targetLang = String(options.lang || settings.translate.targetLang);
    if (!TARGET_LANGS.has(targetLang)) throw httpError('不支持的翻译语言', 400);
    const key = `${articleId}|${provider}|${targetLang}`;
    const running = activeTranslations.get(key);
    if (running && running.status === 'running') return running;
    const effective = clone(settings);
    effective.translate.provider = provider;
    effective.translate.targetLang = targetLang;
    const job = jobs.create('translate', `翻译：${truncate(article.title, 40)}`, {
      articleId,
      provider,
      targetLang,
      translated: 0,
      failed: 0,
      warning: '',
      progress: { done: 0, total: 1, percent: 0 },
    });
    activeTranslations.set(key, job);
    runTranslation(job, article, effective, Boolean(options.force))
      .catch(async (error) => {
        if (job.status === 'canceled') return;
        job.error = error.friendly || error.message;
        job.errorCode = error.code || '';
        jobs.finish(job, 'error');
      })
      .finally(() => {
        if (activeTranslations.get(key) === job) activeTranslations.delete(key);
      });
    return job;
  }

  async function runTranslation(job, article, settings, force) {
    const provider = settings.translate.provider;
    const targetLang = settings.translate.targetLang;
    const proxy = settings.proxy || undefined;
    let existing = force ? null : await store.getTranslation(article.id, provider, targetLang);
    const texts = existing && existing.texts && typeof existing.texts === 'object' ? { ...existing.texts } : {};
    const failed = {};
    let totalChars = 0;
    const payload = {
      version: 1,
      provider,
      targetLang,
      targetLabel: tx.TARGET_LABEL[targetLang] || '',
      sourceLang: article.language || '',
      texts,
      failed,
      complete: false,
      note: '',
      stats: {},
    };

    async function persist(final) {
      payload.texts = texts;
      payload.failed = failed;
      payload.complete = Boolean(final) && Object.keys(failed).length === 0;
      payload.stats = {
        segments: payload.stats.segments || 0,
        translated: Object.keys(texts).length,
        failed: Object.keys(failed).length,
        chars: totalChars,
      };
      await store.saveTranslation(article.id, provider, targetLang, payload);
      job.translated = payload.stats.translated;
      job.failed = payload.stats.failed;
      job.chars = totalChars;
    }

    if (String(article.language || '').startsWith('zh') && targetLang === 'zh-CN') {
      payload.complete = true;
      payload.note = '原文就是中文，无需翻译。';
      payload.stats = { segments: 0, translated: 0, failed: 0, chars: 0 };
      await store.saveTranslation(article.id, provider, targetLang, payload);
      job.note = payload.note;
      progressOf(job);
      jobs.finish(job, 'done', { progress: { done: 1, total: 1, percent: 100 } });
      return;
    }

    const engine = tx.engineFor(settings);
    const { segments, units } = tx.prepareSegments(article, engine);
    payload.stats.segments = segments.length;

    let uid = 0;
    for (const unit of units) unit.uid = uid++;

    const pending = units.filter((unit) => !texts[unit.parent.hash]);
    job.progress.total = Math.max(1, pending.length);
    job.progress.done = 0;
    progressOf(job);

    if (!pending.length) {
      payload.note = Object.keys(texts).length ? '已使用上次保存的译文缓存。' : '';
      await persist(true);
      job.note = payload.note;
      jobs.finish(job, 'done', { progress: { done: 1, total: 1, percent: 100 } });
      return;
    }

    const parentStates = new Map();
    for (const unit of pending) {
      const hash = unit.parent.hash;
      if (!parentStates.has(hash)) {
        parentStates.set(hash, { parent: unit.parent, parts: new Map(), pending: 0, done: 0, errors: [] });
      }
      parentStates.get(hash).pending++;
    }

    let translatedParents = 0;
    let failedParents = 0;

    function applyResult(unit, value, error) {
      const state = parentStates.get(unit.parent.hash);
      if (!state) return;
      state.done++;
      if (error) {
        state.errors.push(truncate(error.friendly || error.message || '翻译失败', 160));
      } else {
        const text = String(value == null ? '' : value).trim();
        state.parts.set(unit.uid, text);
      }
      if (state.done < state.pending) return;
      if (state.errors.length) {
        failed[unit.parent.hash] = state.errors[0];
        failedParents++;
        return;
      }
      const assembled = [...state.parts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map((entry) => entry[1])
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!assembled) {
        failed[unit.parent.hash] = '翻译结果为空';
        failedParents++;
        return;
      }
      texts[unit.parent.hash] = assembled;
      translatedParents++;
      totalChars += assembled.length;
    }

    const context = { settings, proxy, sourceLang: article.language || 'auto' };
    const batches = tx.batchSegments(pending, engine);
    let lastSaved = 0;

    for (const batch of batches) {
      if (job.status === 'canceled') break;
      let results = null;
      let batchError = null;
      try {
        results = await engine.translate(batch.map((unit) => unit.text), context);
        if (!Array.isArray(results) || results.length !== batch.length) {
          throw tx.txError('翻译服务返回的段落数与原文不一致，请重试。', 'ALIGNMENT');
        }
      } catch (error) {
        batchError = error;
        if (tx.FATAL_CODES.has(error.code)) throw error;
      }
      if (!batchError) {
        batch.forEach((unit, index) => applyResult(unit, results[index], null));
      } else {
        for (const unit of batch) {
          if (job.status === 'canceled') break;
          try {
            const single = await engine.translate([unit.text], context);
            applyResult(unit, single[0], null);
          } catch (error) {
            if (tx.FATAL_CODES.has(error.code)) throw error;
            applyResult(unit, null, error);
          }
        }
      }
      job.progress.done = Math.min(job.progress.total, job.progress.done + batch.length);
      progressOf(job);
      job.translated = translatedParents;
      job.failed = failedParents;
      if (Date.now() - lastSaved > 700) {
        lastSaved = Date.now();
        await persist(false);
      }
    }

    await persist(true);
    job.translated = Object.keys(texts).length;
    job.failed = Object.keys(failed).length;
    job.warning = job.failed ? `${job.failed} 段翻译失败，已保留原文；可重试生成缺失部分。` : '';
    if (job.status === 'canceled') {
      job.finishedAt = nowIso();
      return;
    }
    job.progress.done = job.progress.total;
    progressOf(job);
    jobs.finish(job, 'done');
  }

  function catalogPayload() {
    const byKey = new Map();
    const byUrl = new Map();
    for (const source of store.db.sources) {
      if (source.key) byKey.set(source.key, source);
      byUrl.set(feedKey(source.url), source);
    }
    return {
      categories: CATEGORIES,
      regions: REGIONS,
      catalog: CATALOG.map((item) => {
        const source = byKey.get(item.key) || byUrl.get(feedKey(item.url)) || null;
        return {
          ...item,
          subscribed: Boolean(source),
          sourceId: source ? source.id : '',
          enabled: source ? source.enabled : false,
        };
      }),
    };
  }

  async function handleApi(req, res, url) {
    const method = req.method || 'GET';
    const pathname = url.pathname;
    const query = url.searchParams;

    if (method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        app: '环球报阁',
        version: require('./package.json').version,
        uptimeSeconds: Math.round(process.uptime()),
        dataDir,
        articles: store.db.articles.length,
        sources: store.db.sources.length,
        lastSyncAt: store.db.meta.lastSyncAt || '',
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/state') {
      const state = store.state();
      state.dataDir = dataDir;
      state.lastSyncAt = store.db.meta.lastSyncAt || '';
      state.lastSyncSummary = store.db.meta.lastSyncSummary || null;
      state.jobs = jobs.list(10);
      state.activeSyncJobId = activeSync && activeSync.status === 'running' ? activeSync.id : '';
      state.translation = {
        providers: Object.entries(tx.PROVIDER_LABELS).map(([id, label]) => ({ id, label })),
        targetLangs: [{ id: 'zh-CN', label: '简体中文' }, { id: 'zh-TW', label: '繁體中文' }],
      };
      state.media = {
        ocrWindows: process.platform === 'win32',
        ocrVision: visionConfigured(store.getSettings()),
        imageCache: await imageCache.stats(),
      };
      sendJson(res, 200, state);
      return;
    }

    if (method === 'POST' && pathname === '/api/ocr') {
      const body = await readJson(req, 4096);
      const target = String(body.url || '');
      if (!/^https?:\/\//i.test(target) || target.length > 2048) throw httpError('图片地址不正确', 400);
      const settings = store.getSettings();
      const targetLang = settings.translate.targetLang;
      const engineKey = visionConfigured(settings) ? String(settings.translate.ocrModel).trim() : 'windows';
      const cacheFile = path.join(dataDir, 'ocr', `${hashId(`${target}|${engineKey}|${targetLang}`, 28)}.json`);
      const cached = await readCacheJson(cacheFile);
      if (cached) {
        sendJson(res, 200, { ...cached, cached: true });
        return;
      }
      const image = await imageCache.getBuffer(target, { proxy: settings.proxy });
      const result = await ocrImage({
        file: image.file,
        buffer: image.buffer,
        mime: image.mime,
        settings,
        proxy: settings.proxy,
        targetLang,
      });
      const payload = { ...result, url: target, engineKey, updatedAt: nowIso() };
      if (result.text) await writeCacheJson(cacheFile, payload);
      sendJson(res, 200, payload);
      return;
    }

    if (method === 'POST' && pathname === '/api/captions') {
      const body = await readJson(req, 262144);
      const target = String(body.url || '').trim();
      const pasted = typeof body.text === 'string' ? body.text.trim() : '';
      if (!pasted && (!/^https?:\/\//i.test(target) || target.length > 2048)) throw httpError('字幕地址不正确', 400);
      if (pasted.length > 200000) throw httpError('粘贴的字幕太长，请控制在 20 万字符以内', 400);
      const settings = store.getSettings();
      const engine = tx.engineFor(settings);
      const targetLang = settings.translate.targetLang;
      const cacheKey = pasted
        ? `paste|${hashId(pasted, 24)}|${engine.id}|${targetLang}`
        : `${target}|${engine.id}|${targetLang}`;
      const cacheFile = path.join(dataDir, 'captions', `${hashId(cacheKey, 28)}.json`);
      const cached = await readCacheJson(cacheFile);
      if (cached) {
        sendJson(res, 200, { ...cached, cached: true });
        return;
      }

      let cues = [];
      let note = '';
      if (pasted) {
        cues = parseCues(pasted);
        if (!cues.length) cues = cuesFromPlainText(pasted);
        if (!cues.length) throw httpError('粘贴的内容里没有可识别的文字', 400, 'NO_CUES');
        note = '粘贴的字幕文本';
      } else {
        const videoId = youtubeVideoId(target);
        if (videoId) {
          let page = null;
          try {
            page = await httpRequest(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`, {
              proxy: settings.proxy || undefined,
              timeout: 20000,
              maxBytes: 4 * 1024 * 1024,
              headers: { 'Accept-Language': 'en-US,en;q=0.9' },
            });
          } catch (error) {
            throw httpError(`无法打开 YouTube 视频页：${error.friendly || error.message}`, 400, 'CAPTION_FETCH');
          }
          if (page.status >= 400) throw httpError(`YouTube 视频页返回 HTTP ${page.status}，请检查代理设置。`, 400, 'CAPTION_FETCH');
          const tracks = parseCaptionTracks(decodeBuffer(page.body, String(page.headers['content-type'] || '')));
          const track = pickCaptionTrack(tracks);
          if (!track) throw httpError('这个视频没有平台字幕。可以在视频页面打开文字稿，复制后使用“粘贴字幕翻译”。', 400, 'NO_TRACKS');
          note = `平台字幕轨：${track.name || track.language}${track.kind === 'asr' ? '（自动生成）' : ''}`;
          try {
            const trackResponse = await httpRequest(track.url, {
              proxy: settings.proxy || undefined,
              timeout: 20000,
              maxBytes: 3 * 1024 * 1024,
              headers: { Accept: 'text/vtt,application/x-subrip,text/plain,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.9' },
            });
            const raw = trackResponse.status < 400
              ? decodeBuffer(trackResponse.body, String(trackResponse.headers['content-type'] || ''))
              : '';
            cues = parseCues(raw);
          } catch {
            cues = [];
          }
          if (!cues.length) {
            throw httpError('YouTube 拒绝服务端下载该视频的字幕（返回空文件）。请点播放器里的 CC 查看平台字幕，或把视频页面的字幕文本复制到“粘贴字幕翻译”框，由本程序翻译。', 400, 'CAPTIONS_BLOCKED');
          }
        } else {
          await assertPublicUrl(target);
          let response;
          try {
            response = await httpRequest(target, {
              proxy: settings.proxy || undefined,
              timeout: 20000,
              maxBytes: 3 * 1024 * 1024,
              validateUrl: assertPublicUrl,
              headers: { Accept: 'text/vtt,application/x-subrip,text/plain,*/*;q=0.5' },
            });
          } catch (error) {
            throw httpError(`字幕下载失败：${error.friendly || error.message}`, 400, 'CAPTION_FETCH');
          }
          if (response.status >= 400) throw httpError(`字幕文件返回 HTTP ${response.status}`, 400, 'CAPTION_FETCH');
          const raw = decodeBuffer(response.body, String(response.headers['content-type'] || ''));
          cues = parseCues(raw);
          if (!cues.length) throw httpError('这个字幕文件里没有可识别的文本（支持 WebVTT 与 SRT）', 400, 'NO_CUES');
        }
      }
      const units = [];
      let budget = 0;
      cues.forEach((cue, index) => {
        if (units.length >= 300 || budget + cue.text.length > 12000) return;
        units.push({ index, text: cue.text });
        budget += cue.text.length;
      });
      const output = new Array(cues.length).fill('');
      let warning = '';
      try {
        const batches = tx.batchSegments(units, engine);
        for (const batch of batches) {
          const results = await engine.translate(batch.map((unit) => unit.text), {
            settings, proxy: settings.proxy, sourceLang: 'auto',
          });
          batch.forEach((unit, index) => { output[unit.index] = String(results[index] || '').trim(); });
        }
      } catch (error) {
        warning = `部分字幕翻译失败：${error.friendly || error.message}`;
      }
      const payload = {
        url: target,
        note,
        provider: engine.id,
        providerLabel: engine.label,
        targetLang,
        cues: cues.map((cue, index) => ({ ...cue, translation: output[index] || '' })),
        warning,
        updatedAt: nowIso(),
      };
      await writeCacheJson(cacheFile, payload);
      sendJson(res, 200, payload);
      return;
    }

    if (method === 'GET' && pathname === '/api/catalog') {
      sendJson(res, 200, catalogPayload());
      return;
    }

    if (method === 'GET' && pathname === '/api/articles') {
      const view = ['all', 'unread', 'starred'].includes(query.get('view')) ? query.get('view') : 'all';
      const filter = {
        view,
        category: query.get('category') || '',
        sourceId: query.get('sourceId') || '',
        q: query.get('q') || '',
        limit: query.get('limit') || 50,
        offset: query.get('offset') || 0,
      };
      sendJson(res, 200, store.listArticles(filter));
      return;
    }

    if (method === 'GET' && pathname === '/api/jobs') {
      sendJson(res, 200, { jobs: jobs.list(20), active: jobs.active() });
      return;
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([a-f0-9]+)$/i);
    if (jobMatch && method === 'GET') {
      const job = jobs.get(jobMatch[1]);
      if (!job) throw httpError('任务不存在或已过期', 404);
      sendJson(res, 200, { job });
      return;
    }
    if (jobMatch && method === 'POST' && pathname.endsWith('/cancel')) {
      throw httpError('取消接口请使用 /api/jobs/:id/cancel', 400);
    }

    const cancelMatch = pathname.match(/^\/api\/jobs\/([a-f0-9]+)\/cancel$/i);
    if (cancelMatch && method === 'POST') {
      const job = jobs.get(cancelMatch[1]);
      if (!job) throw httpError('任务不存在或已过期', 404);
      if (job.status === 'running') {
        job.status = 'canceled';
        job.finishedAt = nowIso();
        job.updatedAt = job.finishedAt;
      }
      sendJson(res, 200, { job });
      return;
    }

    if (method === 'POST' && pathname === '/api/sync') {
      const body = await readJson(req);
      const job = await startSync({ sourceId: body.sourceId || '' });
      sendJson(res, 202, { job });
      return;
    }

    if (method === 'POST' && pathname === '/api/settings') {
      const body = await readJson(req);
      if (body.proxy) {
        try { parseProxy(body.proxy); } catch (error) {
          throw httpError(error.message, 400, 'PROXY');
        }
      }
      const settings = await store.updateSettings(body);
      sendJson(res, 200, { settings });
      return;
    }

    if (method === 'POST' && pathname === '/api/translate/test') {
      const body = await readJson(req);
      const settings = store.getSettings();
      if (body.provider) settings.translate.provider = String(body.provider);
      if (body.lang) settings.translate.targetLang = String(body.lang);
      if (!tx.PROVIDER_LABELS[settings.translate.provider]) throw httpError('未知的翻译服务', 400);
      if (!TARGET_LANGS.has(settings.translate.targetLang)) throw httpError('不支持的翻译语言', 400);
      try {
        const result = await tx.testTranslation(settings, settings.proxy || undefined);
        sendJson(res, 200, result);
      } catch (error) {
        throw httpError(error.friendly || error.message || '翻译测试失败', 400, error.code || '');
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/opml') {
      const content = buildOpml(store.db.sources);
      sendBuffer(res, 200, Buffer.from(content, 'utf8'), 'text/x-opml; charset=utf-8', {
        'Content-Disposition': attachmentHeader('环球报阁订阅源.opml'),
        'Cache-Control': 'no-store',
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/opml') {
      const body = await readJson(req, 2 * 1024 * 1024);
      if (!body.content) throw httpError('OPML 内容为空', 400);
      let feeds;
      try { feeds = parseOpml(body.content); } catch (error) {
        throw httpError(error.message, 400, 'OPML');
      }
      let added = 0;
      let skipped = 0;
      for (const feed of feeds) {
        const category = CATEGORIES.find((item) => item.label === feed.category || item.id === feed.category);
        const record = store.addSourceRecord({
          title: feed.title,
          url: feed.url,
          siteUrl: feed.siteUrl,
          category: category ? category.id : '综合',
          region: '全球',
          note: '从 OPML 导入',
          custom: true,
        });
        if (record) added++;
        else skipped++;
      }
      await store.flush();
      sendJson(res, 200, { added, skipped, total: feeds.length });
      return;
    }

    if (method === 'POST' && pathname === '/api/feeds/preview') {
      const body = await readJson(req);
      const normalized = String(body.url || '').trim();
      if (!/^https?:\/\//i.test(normalized)) throw httpError('请输入以 http:// 或 https:// 开头的网址', 400);
      const settings = store.getSettings();
      let result;
      try {
        result = await discoverAndLoad(normalized, { proxy: settings.proxy || undefined, timeout: 25000 });
      } catch (error) {
        throw httpError(`读取订阅源失败：${error.friendly || error.message}`, 400, 'FEED');
      }
      sendJson(res, 200, {
        title: result.feed.title,
        siteUrl: result.feed.siteUrl,
        description: result.feed.description,
        language: result.feed.language,
        feedUrl: result.feedUrl,
        discovered: result.discovered,
        count: result.feed.items.length,
        items: result.feed.items.slice(0, 8).map((item) => ({
          title: item.title,
          link: item.link,
          publishedAt: item.publishedAt,
          summary: truncate(item.summary, 180),
        })),
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/sources') {
      const body = await readJson(req);
      let entry = null;
      if (body.catalogKey) {
        entry = CATALOG.find((item) => item.key === String(body.catalogKey));
        if (!entry) throw httpError('源库中没有这个订阅源', 404);
        entry = { ...entry, custom: false };
      } else {
        const raw = String(body.url || '').trim();
        if (!/^https?:\/\//i.test(raw)) throw httpError('请输入以 http:// 或 https:// 开头的订阅地址', 400);
        const settings = store.getSettings();
        let result;
        try {
          result = await discoverAndLoad(raw, { proxy: settings.proxy || undefined, timeout: 25000 });
        } catch (error) {
          throw httpError(`无法添加这个订阅源：${error.friendly || error.message}`, 400, 'FEED');
        }
        entry = {
          title: String(body.title || '').trim() || result.feed.title,
          url: result.feedUrl,
          siteUrl: result.feed.siteUrl,
          category: String(body.category || '综合'),
          region: String(body.region || '全球'),
          language: result.feed.language || 'en',
          note: '自定义订阅源',
          custom: true,
        };
      }
      let source;
      try {
        source = await store.addSource(entry);
      } catch (error) {
        throw httpError(error.message, 409, 'DUPLICATE');
      }
      sendJson(res, 201, { source });
      return;
    }

    const sourceMatch = pathname.match(/^\/api\/sources\/([a-f0-9]+)$/i);
    if (sourceMatch && method === 'PATCH') {
      const body = await readJson(req);
      try {
        const source = await store.updateSource(sourceMatch[1], body);
        sendJson(res, 200, { source });
      } catch (error) {
        throw httpError(error.message, 404);
      }
      return;
    }
    if (sourceMatch && method === 'DELETE') {
      try {
        const result = await store.deleteSource(sourceMatch[1]);
        sendJson(res, 200, result);
      } catch (error) {
        throw httpError(error.message, 404);
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/export') {
      const body = await readJson(req, 512 * 1024);
      const mode = ['original', 'translation', 'bilingual'].includes(body.mode) ? body.mode : 'original';
      let articles = [];
      if (Array.isArray(body.articleIds) && body.articleIds.length) {
        const ids = [...new Set(body.articleIds.map(String))].slice(0, 200);
        articles = (await Promise.all(ids.map((id) => store.getArticle(id)))).filter(Boolean);
      } else {
        const filter = body.filter && typeof body.filter === 'object' ? body.filter : {};
        const list = store.listArticles({ ...filter, limit: 200, offset: 0 });
        for (const item of list.items) {
          const article = await store.getArticle(item.id);
          if (article) articles.push(article);
        }
      }
      if (!articles.length) throw httpError('没有可导出的文章', 400);
      const settings = store.getSettings();
      const provider = String(body.provider || settings.translate.provider);
      const lang = String(body.lang || settings.translate.targetLang);
      const views = {};
      if (mode !== 'original') {
        await mapLimit(articles, 4, async (article) => {
          const payload = await store.getTranslation(article.id, provider, lang);
          if (payload) views[article.id] = tx.translationView(article, payload);
        });
      }
      const result = buildExportZip({ articles, views, mode });
      sendBuffer(res, 200, result.buffer, 'application/zip', {
        'Content-Disposition': attachmentHeader(`${result.folder}.zip`),
        'Cache-Control': 'no-store',
      });
      return;
    }

    const articleMatch = pathname.match(/^\/api\/articles\/([a-f0-9]+)(?:\/([a-z]+))?$/i);
    if (articleMatch) {
      const id = articleMatch[1];
      const action = articleMatch[2] || '';
      if (!action && method === 'GET') {
        const article = await store.getArticle(id);
        if (!article) throw httpError('文章不存在', 404);
        sendJson(res, 200, { article });
        return;
      }
      if (action === 'read' && method === 'POST') {
        const body = await readJson(req);
        try {
          const read = await store.setRead(id, body.read !== false);
          sendJson(res, 200, { read });
        } catch (error) { throw httpError(error.message, 404); }
        return;
      }
      if (action === 'star' && method === 'POST') {
        const body = await readJson(req);
        try {
          const starred = await store.setStarred(id, Boolean(body.starred));
          sendJson(res, 200, { starred });
        } catch (error) { throw httpError(error.message, 404); }
        return;
      }
      if (action === 'fulltext' && method === 'POST') {
        const record = store.getArticleRecord(id);
        if (!record) throw httpError('文章不存在', 404);
        if (!record.link) throw httpError('这篇文章没有原文链接，无法抓取全文', 400);
        const settings = store.getSettings();
        let response;
        try {
          response = await httpRequest(record.link, {
            proxy: settings.proxy || undefined,
            timeout: 30000,
            maxBytes: 12 * 1024 * 1024,
            headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
          });
        } catch (error) {
          throw httpError(`抓取原文失败：${error.friendly || error.message}`, 400, 'FETCH');
        }
        if (response.status >= 400) {
          throw httpError(`原文页面返回 HTTP ${response.status}，可能已失效或需要登录`, 400, 'FETCH');
        }
        const contentType = String(response.headers['content-type'] || '');
        if (/application\/pdf/i.test(contentType)) {
          throw httpError('这个链接指向 PDF 文件，暂不支持提取，可在原文链接中直接阅读', 400, 'PDF');
        }
        const html = decodeBuffer(response.body, contentType);
        let extracted;
        try {
          extracted = extractArticle(html, response.url || record.link, { rssTitle: record.title });
        } catch (error) {
          throw httpError(`正文提取失败：${error.message}`, 400, 'EXTRACT');
        }
        if (!extracted.blocks || !extracted.blocks.length) throw httpError('没有提取到正文', 400, 'EXTRACT');
        await store.saveFulltext(id, {
          blocks: extracted.blocks,
          videos: extracted.videos || [],
          title: extracted.title || record.title,
        });
        await store.clearTranslations(id);
        const article = await store.getArticle(id);
        sendJson(res, 200, {
          article,
          extractedTitle: extracted.title || '',
          blocks: extracted.blocks.length,
          videos: article.videos.length,
        });
        return;
      }
      if (action === 'translate' && method === 'POST') {
        const body = await readJson(req);
        const job = await startTranslation(id, {
          provider: body.provider,
          lang: body.lang,
          force: Boolean(body.force),
        });
        sendJson(res, 202, { job });
        return;
      }
      if (action === 'translation' && method === 'GET') {
        const settings = store.getSettings();
        const provider = query.get('provider') || settings.translate.provider;
        const lang = query.get('lang') || settings.translate.targetLang;
        if (!tx.PROVIDER_LABELS[provider] || !TARGET_LANGS.has(lang)) throw httpError('翻译参数不正确', 400);
        const article = await store.getArticle(id);
        if (!article) throw httpError('文章不存在', 404);
        const payload = await store.getTranslation(id, provider, lang);
        if (!payload) throw httpError('这篇文章还没有这个翻译版本', 404, 'NO_TRANSLATION');
        sendJson(res, 200, {
          translation: tx.translationView(article, payload),
          provider,
          targetLang: lang,
        });
        return;
      }
      if (action === 'download' && method === 'GET') {
        const mode = ['original', 'translation', 'bilingual'].includes(query.get('mode')) ? query.get('mode') : 'original';
        const format = query.get('format') === 'html' ? 'html' : 'md';
        const article = await store.getArticle(id);
        if (!article) throw httpError('文章不存在', 404);
        let view = null;
        if (mode !== 'original') {
          const settings = store.getSettings();
          const provider = query.get('provider') || settings.translate.provider;
          const lang = query.get('lang') || settings.translate.targetLang;
          const payload = await store.getTranslation(id, provider, lang);
          if (payload) view = tx.translationView(article, payload);
        }
        const content = format === 'html' ? articleToHtml(article, view, mode) : articleToMarkdown(article, view, mode);
        const displayTitle = mode === 'translation' && view && view.title ? view.title : article.title;
        const filename = `${sanitizeFilename(displayTitle, 'article')}.${format}`;
        sendBuffer(res, 200, Buffer.from(content, 'utf8'), format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8', {
          'Content-Disposition': attachmentHeader(filename),
          'Cache-Control': 'no-store',
        });
        return;
      }
    }

    if (method === 'POST' && pathname === '/api/shutdown') {
      sendJson(res, 200, { ok: true, message: '正在退出' });
      setTimeout(() => {
        close().finally(() => {
          if (exitOnShutdown) process.exit(0);
        });
      }, 250);
      return;
    }

    throw httpError('接口不存在', 404);
  }

  const server = http.createServer((req, res) => {
    const host = String(req.headers.host || '');
    let hostname = '';
    try { hostname = new URL(`http://${host}`).hostname; } catch { hostname = ''; }
    if (!ALLOWED_HOSTS.has(hostname)) {
      res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('仅允许通过本机访问');
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method || 'GET')) {
      const origin = req.headers.origin;
      if (origin) {
        let originHost = '';
        try { originHost = new URL(origin).hostname; } catch { originHost = ''; }
        if (!ALLOWED_HOSTS.has(originHost)) {
          res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('跨站请求被拒绝');
          return;
        }
      }
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, SECURITY_HEADERS);
      res.end();
      return;
    }
    const url = new URL(req.url || '/', `http://${host || '127.0.0.1'}`);
    const task = url.pathname === '/img'
      ? serveImage(req, res, url)
      : url.pathname.startsWith('/api/')
        ? handleApi(req, res, url)
        : serveStatic(req, res, url);
    Promise.resolve(task).catch((error) => {
      const status = error.status || 500;
      if (status >= 500) console.error('[api]', error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, status, {
        error: error.friendly || error.message || '服务器内部错误',
        code: error.code || '',
      });
    });
  });

  const port = Number.isFinite(Number(options.port)) ? Number(options.port) : Number(process.env.GRR_PORT || process.env.PORT) || 7317;
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      if (error.code === 'EADDRINUSE') {
        error.message = `端口 ${port} 已被占用。请关闭已经运行的“环球报阁”，或设置环境变量 GRR_PORT 使用其他端口。`;
      }
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });

  const actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}`;

  async function close() {
    if (closingPromise) return closingPromise;
    closed = true;
    if (autoTimer) clearInterval(autoTimer);
    closingPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { server.closeAllConnections?.(); } catch { /* noop */ }
        resolve();
      }, 1200);
      timer.unref?.();
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      try { server.closeAllConnections?.(); } catch { /* noop */ }
    });
    await closingPromise;
    await store.flush().catch(() => {});
    return closingPromise;
  }

  function maybeAutoSync(initial) {
    if (closed || activeSync) return;
    const enabled = store.db.sources.filter((source) => source.enabled).length;
    if (!enabled) return;
    const interval = Number(store.getSettings().syncIntervalMinutes) || 0;
    const last = Date.parse(store.db.meta.lastSyncAt || '') || 0;
    const due = initial
      ? (store.db.articles.length === 0 || (!last && interval > 0))
      : (interval > 0 && Date.now() - last >= interval * 60000);
    if (due) {
      startSync({}).catch((error) => console.error('[sync] 自动同步未启动：', error.message));
    }
  }

  if (options.autoSync !== false) {
    autoTimer = setInterval(() => maybeAutoSync(false), 60000);
    autoTimer.unref?.();
    const startupTimer = setTimeout(() => maybeAutoSync(true), 1200);
    startupTimer.unref?.();
  }

  return {
    server,
    store,
    jobs,
    port: actualPort,
    url,
    dataDir,
    close,
    startSync,
    startTranslation,
    activeSync: () => activeSync,
  };
}

function isOurAppRunning(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 1200 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(Boolean(data && data.ok && data.app === '环球报阁'));
        } catch {
          resolve(false);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function openBrowser(url) {
  let command = 'xdg-open';
  let args = [url];
  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
  } else if (process.env.TERMUX_VERSION) {
    command = 'termux-open-url';
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {
      console.error(`无法自动打开浏览器，请手动访问：${url}`);
    });
    child.unref();
  } catch (error) {
    console.error('无法自动打开浏览器，请手动访问：', url);
  }
}

async function cliMain() {
  const port = Number(process.env.GRR_PORT || process.env.PORT) || 7317;
  const noOpen = process.argv.includes('--no-open') || process.env.GRR_NO_OPEN === '1';
  if (await isOurAppRunning(port)) {
    if (!noOpen) openBrowser(`http://127.0.0.1:${port}`);
    console.log(`环球报阁已经在运行：http://127.0.0.1:${port}`);
    return;
  }
  let info;
  try {
    info = await startServer({
      port,
      dataDir: process.env.GRR_DATA_DIR || path.join(__dirname, 'data'),
      autoSync: true,
      exitOnShutdown: true,
    });
  } catch (error) {
    console.error(`启动失败：${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log('==============================================');
  console.log('  环球报阁 · 全球新闻与报刊阅读');
  console.log('==============================================');
  console.log(`  访问地址：${info.url}`);
  console.log(`  数据目录：${info.dataDir}`);
  console.log('  关闭此窗口会停止程序；也可以在页面“设置”中点击“退出程序”。');
  console.log('  首次启动会自动同步订阅源，中文界面稍等片刻即可。');
  console.log('==============================================');
  if (!noOpen) openBrowser(info.url);
  const shutdown = async () => {
    console.log('\n正在退出……');
    await info.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  cliMain().catch((error) => {
    console.error('启动失败：', error);
    process.exit(1);
  });
}

module.exports = { startServer, openBrowser, isOurAppRunning };

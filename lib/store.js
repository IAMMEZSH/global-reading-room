'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { CATALOG, CATEGORIES, REGIONS } = require('./sources');
const {
  hashId, nowIso, normalizeUrl, stripTracking, feedKey, truncate, safeJsonParse,
} = require('./util');

const CATEGORY_IDS = new Set(CATEGORIES.map((item) => item.id));
const REGION_IDS = new Set(REGIONS);
const PROVIDERS = new Set(['mymemory', 'deepl', 'azure', 'baidu', 'openai']);
const TARGET_LANGS = new Set(['zh-CN', 'zh-TW']);

function defaultSettings() {
  return {
    syncIntervalMinutes: 30,
    retentionPerSource: 150,
    maxItemsPerSync: 60,
    proxy: '',
    translate: {
      provider: 'mymemory',
      targetLang: 'zh-CN',
      autoForeign: false,
      mymemoryEmail: '',
      deeplKey: '',
      azureKey: '',
      azureRegion: '',
      baiduAppId: '',
      baiduKey: '',
      openaiBaseUrl: 'https://api.deepseek.com/v1',
      openaiKey: '',
      openaiModel: 'deepseek-chat',
      ocrModel: '',
    },
  };
}

function cleanString(value, max = 500) {
  if (value == null) return '';
  return String(value).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

function mergeSettings(current, patch) {
  const next = JSON.parse(JSON.stringify(current));
  if (!patch || typeof patch !== 'object') return next;
  if (patch.syncIntervalMinutes !== undefined) {
    const value = Number(patch.syncIntervalMinutes);
    if (Number.isFinite(value) && (value === 0 || (value >= 5 && value <= 1440))) next.syncIntervalMinutes = value;
  }
  if (patch.retentionPerSource !== undefined) {
    const value = Number(patch.retentionPerSource);
    if (Number.isFinite(value) && value >= 20 && value <= 2000) next.retentionPerSource = Math.round(value);
  }
  if (patch.maxItemsPerSync !== undefined) {
    const value = Number(patch.maxItemsPerSync);
    if (Number.isFinite(value) && value >= 10 && value <= 200) next.maxItemsPerSync = Math.round(value);
  }
  if (patch.proxy !== undefined) next.proxy = cleanString(patch.proxy, 200);
  const t = patch.translate;
  if (t && typeof t === 'object') {
    if (t.provider !== undefined && PROVIDERS.has(String(t.provider))) next.translate.provider = String(t.provider);
    if (t.targetLang !== undefined && TARGET_LANGS.has(String(t.targetLang))) next.translate.targetLang = String(t.targetLang);
    if (t.autoForeign !== undefined) next.translate.autoForeign = Boolean(t.autoForeign);
    const fields = {
      mymemoryEmail: 120, deeplKey: 300, azureKey: 300, azureRegion: 80,
      baiduAppId: 120, baiduKey: 300, openaiBaseUrl: 300, openaiKey: 400, openaiModel: 120, ocrModel: 120,
    };
    for (const [key, max] of Object.entries(fields)) {
      if (t[key] !== undefined) next.translate[key] = cleanString(t[key], max);
    }
  }
  return next;
}

function atomicSuffix() {
  return `.tmp-${process.pid}-${Date.now()}`;
}

async function writeFileSafe(target, content) {
  const temp = target + atomicSuffix();
  await fsp.writeFile(temp, content, 'utf8');
  try {
    await fsp.rename(temp, target);
  } catch (error) {
    if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
      try { await fsp.unlink(temp); } catch { /* noop */ }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    await fsp.rename(temp, target);
  }
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, 'db.json');
    this.backupPath = this.dbPath + '.bak';
    this.fulltextDir = path.join(dataDir, 'fulltext');
    this.translationDir = path.join(dataDir, 'translations');
    this.backupDir = path.join(dataDir, 'backups');
    this.db = null;
    this.dirty = false;
    this.saveTimer = null;
    this.writeChain = Promise.resolve();
    this.notice = '';
    this._searchIndex = null;
  }

  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.mkdir(this.fulltextDir, { recursive: true });
    await fsp.mkdir(this.translationDir, { recursive: true });
    await fsp.mkdir(this.backupDir, { recursive: true });

    let raw = null;
    try {
      raw = await fsp.readFile(this.dbPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') this.notice = `读取数据文件失败：${error.message}`;
    }
    let parsed = raw ? safeJsonParse(raw, null) : null;
    if (!parsed) {
      try {
        const backupRaw = await fsp.readFile(this.backupPath, 'utf8');
        parsed = safeJsonParse(backupRaw, null);
        if (parsed) this.notice = '主数据文件损坏，已从备份恢复。';
      } catch { /* no backup */ }
    }
    if (!parsed) {
      if (raw) {
        const brokenPath = path.join(this.backupDir, `db-broken-${Date.now()}.json`);
        try { await fsp.writeFile(brokenPath, raw, 'utf8'); } catch { /* noop */ }
        this.notice = '数据文件无法解析，已保留损坏副本并重新初始化。';
      }
      parsed = { version: 1, createdAt: nowIso(), seeded: false, settings: defaultSettings(), sources: [], articles: [], meta: {} };
    }

    this.db = {
      version: 1,
      createdAt: parsed.createdAt || nowIso(),
      seeded: Boolean(parsed.seeded),
      settings: mergeSettings(defaultSettings(), parsed.settings || {}),
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
      articles: Array.isArray(parsed.articles) ? parsed.articles : [],
      meta: parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {},
    };

    this.db.sources = this.db.sources.filter((source) => source && source.id && source.url).map((source) => ({
      id: source.id,
      key: source.key || '',
      title: source.title || source.url,
      url: source.url,
      siteUrl: source.siteUrl || '',
      category: CATEGORY_IDS.has(source.category) ? source.category : '综合',
      region: REGION_IDS.has(source.region) ? source.region : '全球',
      language: source.language || 'en',
      needsProxy: Boolean(source.needsProxy),
      note: source.note || '',
      enabled: source.enabled !== false,
      custom: Boolean(source.custom),
      addedAt: source.addedAt || nowIso(),
      lastSyncAt: source.lastSyncAt || '',
      lastError: source.lastError || '',
    }));
    this.db.articles = this.db.articles.filter((article) => article && article.id && article.title && article.sourceId);
    for (const article of this.db.articles) {
      if (typeof article.read !== 'boolean') article.read = false;
      if (typeof article.starred !== 'boolean') article.starred = false;
      if (article.blocks && !Array.isArray(article.blocks)) article.blocks = null;
    }

    if (!this.db.seeded) {
      for (const entry of CATALOG.filter((item) => item.defaultEnabled)) {
        this.addSourceRecord(entry);
      }
      this.db.seeded = true;
      this.notice = this.notice || '已为你订阅首批中文与全球媒体，可在“订阅源”中增减。';
    }

    this.prune();
    await this.backupDaily();
    await this.flush();
    return this;
  }

  async backupDaily() {
    if (!this.db || !this.db.sources.length) return;
    const date = new Date().toISOString().slice(0, 10);
    const target = path.join(this.backupDir, `db-${date}.json`);
    try {
      await fsp.access(target);
    } catch {
      try { await fsp.writeFile(target, JSON.stringify(this.db), 'utf8'); } catch { return; }
    }
    try {
      const files = (await fsp.readdir(this.backupDir))
        .filter((name) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(name))
        .sort();
      while (files.length > 7) {
        const old = files.shift();
        await fsp.unlink(path.join(this.backupDir, old)).catch(() => {});
      }
    } catch { /* noop */ }
  }

  addSourceRecord(entry) {
    const normalized = normalizeUrl(entry.url);
    if (!normalized) return null;
    const key = feedKey(normalized);
    if (this.db.sources.some((source) => feedKey(source.url) === key)) return null;
    let siteUrl = entry.siteUrl || '';
    if (!siteUrl) {
      try { siteUrl = new URL(normalized).origin; } catch { siteUrl = ''; }
    }
    const source = {
      id: hashId(`source|${key}`, 12),
      key: entry.key || '',
      title: cleanString(entry.title || entry.feedTitle || normalized, 120),
      url: normalized,
      siteUrl,
      category: CATEGORY_IDS.has(entry.category) ? entry.category : '综合',
      region: REGION_IDS.has(entry.region) ? entry.region : '全球',
      language: /^[a-z]{2}(-[a-z]{2})?$/i.test(entry.language || '') ? entry.language : 'en',
      needsProxy: Boolean(entry.needsProxy),
      note: cleanString(entry.note || entry.description || '', 200),
      enabled: entry.enabled !== false,
      custom: Boolean(entry.custom),
      addedAt: nowIso(),
      lastSyncAt: '',
      lastError: '',
    };
    this.db.sources.push(source);
    this.dirty = true;
    return source;
  }

  async addSource(entry) {
    const source = this.addSourceRecord(entry);
    if (!source) throw new Error('这个订阅源已经在列表中');
    await this.flush();
    return source;
  }

  async updateSource(id, patch) {
    const source = this.db.sources.find((item) => item.id === id);
    if (!source) throw new Error('订阅源不存在');
    if (patch.enabled !== undefined) source.enabled = Boolean(patch.enabled);
    if (patch.title !== undefined) source.title = cleanString(patch.title, 120) || source.title;
    if (patch.category !== undefined && CATEGORY_IDS.has(patch.category)) source.category = patch.category;
    if (patch.region !== undefined && REGION_IDS.has(patch.region)) source.region = patch.region;
    this.dirty = true;
    await this.flush();
    return source;
  }

  async deleteSource(id) {
    const source = this.db.sources.find((item) => item.id === id);
    if (!source) throw new Error('订阅源不存在');
    this.db.sources = this.db.sources.filter((item) => item.id !== id);
    const removed = this.db.articles.filter((article) => article.sourceId === id);
    this.db.articles = this.db.articles.filter((article) => article.sourceId !== id);
    for (const article of removed) {
      if (this._searchIndex) this._searchIndex.delete(article.id);
      this.cleanupFiles(article.id);
    }
    this.dirty = true;
    await this.flush();
    return { removedArticles: removed.length };
  }

  getSource(id) {
    return this.db.sources.find((source) => source.id === id) || null;
  }

  getSettings() {
    return JSON.parse(JSON.stringify(this.db.settings));
  }

  async updateSettings(patch) {
    this.db.settings = mergeSettings(this.db.settings, patch);
    this.dirty = true;
    await this.flush();
    return this.getSettings();
  }

  async updateSourceSyncState(sourceId, { error = '', lastSyncAt = nowIso() } = {}) {
    const source = this.getSource(sourceId);
    if (!source) return;
    source.lastSyncAt = lastSyncAt;
    source.lastError = error ? truncate(error, 300) : '';
    this.dirty = true;
  }

  async ingest(sourceId, items) {
    const source = this.getSource(sourceId);
    if (!source) return { added: 0 };
    const existingIds = new Set(this.db.articles.map((article) => article.id));
    const existingLinks = new Set(
      this.db.articles.filter((article) => article.link).map((article) => stripTracking(article.link)),
    );
    const max = Math.max(10, Number(this.db.settings.maxItemsPerSync) || 60);
    const fresh = [];
    for (const item of items) {
      if (fresh.length >= max) break;
      if (!item || !item.title) continue;
      const link = item.link ? normalizeUrl(item.link) : '';
      const linkKey = link ? stripTracking(link) : '';
      if (linkKey && existingLinks.has(linkKey)) continue;
      const basis = linkKey || item.guid || `${item.title}|${item.publishedAt}`;
      const id = hashId(`${sourceId}|${basis}`);
      if (existingIds.has(id)) continue;
      const article = {
        id,
        sourceId,
        title: cleanString(item.title, 300),
        link,
        author: cleanString(item.author || '', 80),
        publishedAt: item.publishedAt || nowIso(),
        fetchedAt: nowIso(),
        summary: cleanString(item.summary || '', 500),
        blocks: Array.isArray(item.blocks) ? item.blocks.slice(0, 220) : null,
        image: item.image || '',
        videos: Array.isArray(item.videos) ? item.videos.slice(0, 3) : [],
        categories: Array.isArray(item.categories) ? item.categories.slice(0, 5) : [],
        language: item.language || source.language || 'en',
        read: false,
        starred: false,
        fulltextAt: '',
      };
      fresh.push(article);
      existingIds.add(id);
      if (linkKey) existingLinks.add(linkKey);
      if (this._searchIndex) this._searchIndex.set(id, this.buildSearchText(article));
    }
    if (fresh.length) {
      this.db.articles.unshift(...fresh);
      source.lastSyncAt = nowIso();
      source.lastError = '';
    }
    this.prune();
    this.dirty = true;
    return { added: fresh.length };
  }

  prune() {
    const retention = Math.max(20, Number(this.db.settings.retentionPerSource) || 150);
    const bySource = new Map();
    for (const article of this.db.articles) {
      if (!bySource.has(article.sourceId)) bySource.set(article.sourceId, []);
      bySource.get(article.sourceId).push(article);
    }
    const keep = new Set();
    for (const list of bySource.values()) {
      list.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
      let retained = 0;
      for (const article of list) {
        if (article.starred || article.fulltextAt || retained < retention) {
          keep.add(article.id);
          retained++;
        } else {
          this.cleanupFiles(article.id);
          if (this._searchIndex) this._searchIndex.delete(article.id);
        }
      }
    }
    const before = this.db.articles.length;
    this.db.articles = this.db.articles.filter((article) => keep.has(article.id));
    if (before !== this.db.articles.length) this.dirty = true;
  }

  buildSearchText(article) {
    const blockText = article.blocks
      ? article.blocks.filter((block) => block.t !== 'img').map((block) => block.text).join(' ')
      : '';
    return `${article.title} ${article.summary} ${article.author || ''} ${blockText}`.toLowerCase().slice(0, 8000);
  }

  ensureSearchIndex() {
    if (this._searchIndex) return this._searchIndex;
    this._searchIndex = new Map();
    for (const article of this.db.articles) this._searchIndex.set(article.id, this.buildSearchText(article));
    return this._searchIndex;
  }

  matchesFilter(article, filter = {}) {
    const { view = 'all', category = '', sourceId = '', q = '' } = filter;
    if (view === 'unread' && article.read) return false;
    if (view === 'starred' && !article.starred) return false;
    if (sourceId && article.sourceId !== sourceId) return false;
    if (category) {
      const source = this.getSource(article.sourceId);
      if (!source || source.category !== category) return false;
    }
    if (q) {
      const index = this.ensureSearchIndex().get(article.id);
      if (!index) return false;
      const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.every((term) => index.includes(term))) return false;
    }
    return true;
  }

  listArticles(filter = {}) {
    const limit = Math.min(200, Math.max(1, Number(filter.limit) || 60));
    const offset = Math.max(0, Number(filter.offset) || 0);
    let list = this.db.articles.filter((article) => this.matchesFilter(article, filter));
    list.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    const total = list.length;
    const page = list.slice(offset, offset + limit);
    const sources = new Map(this.db.sources.map((source) => [source.id, source]));
    return {
      total,
      offset,
      limit,
      hasMore: offset + page.length < total,
      items: page.map((article) => {
        const source = sources.get(article.sourceId);
        return {
          id: article.id,
          title: article.title,
          summary: truncate(article.summary || '', 220),
          sourceId: article.sourceId,
          sourceTitle: source ? source.title : '未知来源',
          category: source ? source.category : '',
          language: article.language || (source ? source.language : 'en'),
          publishedAt: article.publishedAt,
          read: article.read,
          starred: article.starred,
          image: article.image || '',
          hasVideo: Boolean(article.videos && article.videos.length),
          author: article.author || '',
          link: article.link || '',
          hasContent: Boolean((article.blocks && article.blocks.length) || article.fulltextAt),
        };
      }),
    };
  }

  getArticleRecord(id) {
    return this.db.articles.find((article) => article.id === id) || null;
  }

  async getArticle(id) {
    const article = this.getArticleRecord(id);
    if (!article) return null;
    const source = this.getSource(article.sourceId);
    let blocks = Array.isArray(article.blocks) ? article.blocks : [];
    let contentSource = blocks.length ? 'feed' : '';
    let videos = Array.isArray(article.videos) ? article.videos : [];
    if (article.fulltextAt) {
      const stored = await this.readJsonFile(path.join(this.fulltextDir, `${article.id}.json`));
      if (stored && Array.isArray(stored.blocks) && stored.blocks.length) {
        blocks = stored.blocks;
        contentSource = 'fulltext';
      }
      if (stored && Array.isArray(stored.videos) && stored.videos.length) videos = stored.videos;
    }
    return {
      id: article.id,
      title: article.title,
      link: article.link,
      author: article.author,
      publishedAt: article.publishedAt,
      fetchedAt: article.fetchedAt,
      summary: article.summary,
      image: article.image,
      videos,
      categories: article.categories || [],
      language: article.language,
      read: article.read,
      starred: article.starred,
      fulltextAt: article.fulltextAt || '',
      blocks,
      contentSource,
      source: source ? {
        id: source.id, title: source.title, category: source.category,
        region: source.region, language: source.language, siteUrl: source.siteUrl,
      } : null,
    };
  }

  async setRead(id, read) {
    const article = this.getArticleRecord(id);
    if (!article) throw new Error('文章不存在');
    article.read = Boolean(read);
    this.dirty = true;
    this.scheduleSave();
    return article.read;
  }

  async setStarred(id, starred) {
    const article = this.getArticleRecord(id);
    if (!article) throw new Error('文章不存在');
    article.starred = Boolean(starred);
    this.dirty = true;
    this.prune();
    this.scheduleSave();
    return article.starred;
  }

  async saveFulltext(id, { blocks, videos = [], title = '', fetchedAt = nowIso() }) {
    const article = this.getArticleRecord(id);
    if (!article) throw new Error('文章不存在');
    if (!Array.isArray(blocks) || !blocks.length) throw new Error('没有提取到正文');
    const cleanVideos = Array.isArray(videos) ? videos.slice(0, 3) : [];
    const payload = { id, title, url: article.link, fetchedAt, blocks, videos: cleanVideos };
    await writeFileSafe(path.join(this.fulltextDir, `${id}.json`), JSON.stringify(payload));
    article.fulltextAt = fetchedAt;
    article.blocks = null;
    if (cleanVideos.length) article.videos = cleanVideos;
    if (this._searchIndex) this._searchIndex.set(id, this.buildSearchText({ ...article, blocks }));
    this.dirty = true;
    await this.flush();
    return payload;
  }

  async getTranslation(id, provider, lang) {
    return this.readJsonFile(path.join(this.translationDir, `${id}.${provider}.${lang}.json`));
  }

  async saveTranslation(id, provider, lang, payload) {
    await writeFileSafe(
      path.join(this.translationDir, `${id}.${provider}.${lang}.json`),
      JSON.stringify({ ...payload, articleId: id, provider, targetLang: lang, updatedAt: nowIso() }),
    );
  }

  async readJsonFile(file) {
    try {
      const raw = await fsp.readFile(file, 'utf8');
      return safeJsonParse(raw, null);
    } catch {
      return null;
    }
  }

  cleanupFiles(id) {
    const prefix = `${id}.`;
    fsp.unlink(path.join(this.fulltextDir, `${id}.json`)).catch(() => {});
    fsp.readdir(this.translationDir).then((files) => {
      for (const file of files) {
        if (file.startsWith(prefix)) fsp.unlink(path.join(this.translationDir, file)).catch(() => {});
      }
    }).catch(() => {});
  }

  async clearTranslations(id) {
    const prefix = `${id}.`;
    try {
      const files = await fsp.readdir(this.translationDir);
      await Promise.all(files
        .filter((file) => file.startsWith(prefix))
        .map((file) => fsp.unlink(path.join(this.translationDir, file)).catch(() => {})));
    } catch { /* noop */ }
  }

  counts() {
    const bySource = {};
    const byCategory = {};
    let unread = 0;
    let starred = 0;
    const sources = new Map(this.db.sources.map((source) => [source.id, source]));
    for (const source of this.db.sources) {
      bySource[source.id] = { total: 0, unread: 0 };
    }
    for (const category of CATEGORIES) {
      byCategory[category.id] = { total: 0, unread: 0 };
    }
    for (const article of this.db.articles) {
      const source = sources.get(article.sourceId);
      if (!source) continue;
      if (!bySource[source.id]) bySource[source.id] = { total: 0, unread: 0 };
      bySource[source.id].total++;
      if (!byCategory[source.category]) byCategory[source.category] = { total: 0, unread: 0 };
      byCategory[source.category].total++;
      if (!article.read) {
        unread++;
        bySource[source.id].unread++;
        byCategory[source.category].unread++;
      }
      if (article.starred) starred++;
    }
    return { bySource, byCategory, total: this.db.articles.length, unread, starred };
  }

  state() {
    const counts = this.counts();
    return {
      app: { name: '环球报阁', version: '1.0.0' },
      settings: this.getSettings(),
      meta: this.db.meta,
      notice: this.notice,
      categories: CATEGORIES,
      regions: REGIONS,
      stats: { total: counts.total, unread: counts.unread, starred: counts.starred, sources: this.db.sources.length },
      sources: this.db.sources.map((source) => ({
        ...source,
        unread: counts.bySource[source.id] ? counts.bySource[source.id].unread : 0,
        total: counts.bySource[source.id] ? counts.bySource[source.id].total : 0,
      })),
      unreadByCategory: counts.byCategory,
    };
  }

  async setMeta(patch) {
    this.db.meta = { ...this.db.meta, ...patch };
    this.dirty = true;
    await this.flush();
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch((error) => console.error('[store] 保存失败：', error.message));
    }, 500);
    this.saveTimer.unref?.();
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const content = JSON.stringify(this.db);
    this.writeChain = this.writeChain.then(async () => {
      try {
        await fsp.copyFile(this.dbPath, this.backupPath).catch(() => {});
        await writeFileSafe(this.dbPath, content);
      } catch (error) {
        this.dirty = true;
        console.error('[store] 写入数据失败：', error.message);
        throw error;
      }
    });
    return this.writeChain;
  }
}

module.exports = { Store, defaultSettings, CATEGORY_IDS, REGION_IDS, PROVIDERS, TARGET_LANGS };

'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const S = {
  state: null,
  catalog: null,
  articles: [],
  total: 0,
  offset: 0,
  limit: 40,
  hasMore: false,
  filter: { view: 'all', category: '', sourceId: '', q: '' },
  selectedId: '',
  article: null,
  translation: null,
  translationMeta: null,
  translationMode: 'original',
  translationJobId: '',
  translating: false,
  translateProgress: null,
  translateError: '',
  translationToken: 0,
  syncing: false,
  syncToken: 0,
  syncJobId: '',
  fetchingFulltext: false,
  loadingList: false,
  listToken: 0,
  sourcesTab: 'subscribed',
  sourceQuery: '',
  sourceCategory: '',
  sourceRegion: '',
  autoTranslatedFor: '',
  theme: 'dark',
  stateRefreshTimer: null,
  syncBannerTimer: null,
  ocrResults: {},
  captionResults: {},
};

const LANG_LABELS = {
  zh: '中文', en: '英语', ja: '日语', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语',
  it: '意大利语', ru: '俄语', ar: '阿拉伯语', pt: '葡萄牙语', nl: '荷兰语', sv: '瑞典语',
  no: '挪威语', da: '丹麦语', fi: '芬兰语', pl: '波兰语', tr: '土耳其语', hi: '印地语',
  th: '泰语', vi: '越南语', id: '印尼语', ms: '马来语', he: '希伯来语', el: '希腊语',
  cs: '捷克语', uk: '乌克兰语',
};

const PROVIDER_LABELS = {
  mymemory: 'MyMemory', deepl: 'DeepL', azure: 'Azure 翻译', baidu: '百度翻译', openai: 'OpenAI 兼容接口',
};

const OPENAI_PRESETS = {
  deepseek: { base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  qwen: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  moonshot: { base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  ollama: { base: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
};

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(value) {
  const text = String(value || '').trim();
  return /^https?:\/\//i.test(text) ? text : '';
}

function proxyImage(value) {
  const url = safeUrl(value);
  if (!url) return '';
  return `/img?url=${encodeURIComponent(url)}`;
}

function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function timeAgo(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  const diff = Date.now() - time;
  if (diff < -60000) return '刚刚';
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.max(1, Math.floor(diff / 60000))} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)} 天前`;
  const date = new Date(value);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function formatDate(value, withTime) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (number) => String(number).padStart(2, '0');
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime ? `${base} ${pad(date.getHours())}:${pad(date.getMinutes())}` : base;
}

function formatSyncTime(value) {
  if (!value) return '尚未同步';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '尚未同步';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return `今天 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return formatDate(value, true);
}

function langName(code) {
  const key = String(code || '').toLowerCase().split('-')[0];
  return LANG_LABELS[key] || String(code || '').toUpperCase();
}

function langBadge(code) {
  const key = String(code || '').toLowerCase().split('-')[0];
  if (key === 'zh') return '中文';
  return key ? key.toUpperCase() : '—';
}

async function api(path, options = {}) {
  const opts = { method: options.method || 'GET', headers: { Accept: 'application/json' } };
  if (options.body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, opts);
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json().catch(() => null) : await response.text();
  if (!response.ok) {
    const error = new Error((data && data.error) || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    error.code = data && data.code;
    throw error;
  }
  return data;
}

function toast(message, type = 'info', duration = 4200) {
  const host = $('#toasts');
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  host.appendChild(element);
  setTimeout(() => {
    element.style.opacity = '0';
    element.style.transition = 'opacity .25s';
    setTimeout(() => element.remove(), 280);
  }, duration);
}

function setStrip(text, tone = '') {
  const label = $('#stripSync');
  if (label) label.textContent = text;
  const dot = $('#statusDot');
  if (dot) dot.className = `status-dot ${tone}`.trim();
}

function applyTheme(theme) {
  S.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = S.theme;
  try { localStorage.setItem('grr-theme', S.theme); } catch { /* noop */ }
  const button = $('#themeBtn');
  if (button) {
    button.innerHTML = icon(S.theme === 'dark' ? 'sun' : 'moon');
    button.title = S.theme === 'dark' ? '切换日间模式' : '切换夜间模式';
  }
}

function initTheme() {
  let theme = 'dark';
  try { theme = localStorage.getItem('grr-theme') || 'dark'; } catch { theme = 'dark'; }
  applyTheme(theme);
}

function currentProvider() {
  return (S.state && S.state.settings.translate.provider) || 'mymemory';
}

function currentLang() {
  return (S.state && S.state.settings.translate.targetLang) || 'zh-CN';
}

function closeDrawer() {
  document.body.classList.remove('sidebar-open');
  $('#drawerBackdrop').classList.add('hidden');
}

function openDrawer() {
  document.body.classList.add('sidebar-open');
  $('#drawerBackdrop').classList.remove('hidden');
}

function closeReader() {
  document.body.classList.remove('reader-open');
}

function showModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
  const focusable = modal.querySelector('button, input, select, a[href]');
  if (focusable) setTimeout(() => focusable.focus(), 30);
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add('hidden');
  if (!$('.modal-layer:not(.hidden)')) document.body.classList.remove('modal-open');
}

function closeAllModals() {
  $$('.modal-layer').forEach((modal) => modal.classList.add('hidden'));
  document.body.classList.remove('modal-open');
}

function updateSyncButton() {
  const button = $('#syncBtn');
  if (!button) return;
  button.classList.toggle('spinning', S.syncing);
  button.disabled = S.syncing;
  const label = button.querySelector('span');
  if (label) label.textContent = S.syncing ? '同步中' : '同步';
}

function updateStrip() {
  if (!S.state) return;
  if (S.syncing) setStrip('正在同步订阅源…', 'warn');
  else setStrip(`上次同步 ${formatSyncTime(S.state.lastSyncAt)}`, '');
  $('#stripStats').textContent = `${S.state.stats.sources} 个订阅源 · ${S.state.stats.total} 篇文章 · 未读 ${S.state.stats.unread}`;
  updateSyncButton();
}

function showListSkeleton() {
  $('#articleList').innerHTML = Array.from({ length: 5 }, () => `
    <div class="skeleton-card">
      <div class="skeleton-line w40"></div>
      <div class="skeleton-line w90"></div>
      <div class="skeleton-line w70"></div>
    </div>`).join('');
  $('#listEnd').textContent = '';
  $('#loadMoreBtn').classList.add('hidden');
}

async function refreshState() {
  const state = await api('/api/state');
  S.state = state;
  renderViewNav();
  renderCategories();
  renderSourcesSidebar();
  renderStats();
  populateFilterSelects();
  updateStrip();
  if (!$('#sourcesModal').classList.contains('hidden')) renderSources();
}

function scheduleStateRefresh() {
  clearTimeout(S.stateRefreshTimer);
  S.stateRefreshTimer = setTimeout(() => {
    refreshState().catch(() => {});
  }, 900);
}

function renderStats() {
  if (!S.state) return;
  const { stats } = S.state;
  $('#countAll').textContent = stats.total;
  $('#countUnread').textContent = stats.unread;
  $('#countStarred').textContent = stats.starred;
  $('#sideStats').innerHTML = `${stats.sources} 个订阅源 · ${stats.total} 篇文章<br>未读 ${stats.unread} · 收藏 ${stats.starred}`;
  updateStrip();
}

function renderViewNav() {
  if (!S.state) return;
  $$('#viewNav button').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === S.filter.view);
  });
  $$('#viewSeg button').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === S.filter.view);
  });
}

function renderCategories() {
  if (!S.state) return;
  const counts = S.state.unreadByCategory || {};
  const items = [{
    id: '',
    label: '全部分类',
    unread: S.state.stats.unread,
  }].concat(S.state.categories.map((category) => ({
    id: category.id,
    label: category.label,
    unread: counts[category.id] ? counts[category.id].unread : 0,
  })));
  $('#catList').innerHTML = items.map((item) => `
    <button data-category="${esc(item.id)}" class="${S.filter.category === item.id && !S.filter.sourceId ? 'active' : ''}">
      <span>${esc(item.label)}</span>
      <span class="nav-count">${item.unread || ''}</span>
    </button>`).join('');
}

function renderSourcesSidebar() {
  if (!S.state) return;
  const sources = S.state.sources
    .filter((source) => source.enabled)
    .filter((source) => !S.filter.category || source.category === S.filter.category)
    .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  if (!sources.length) {
    $('#sourceList').innerHTML = '<div class="section-empty">这个分类下没有启用的订阅源。</div>';
    return;
  }
  const rows = sources.map((source) => `
    <button class="source-row ${S.filter.sourceId === source.id ? 'active' : ''}" data-source="${esc(source.id)}" title="${esc(source.title)}">
      <span class="source-name">${esc(source.title)}</span>
      <span class="nav-count">${source.unread || ''}</span>
    </button>`);
  $('#sourceList').innerHTML = rows.join('');
}

function populateFilterSelects() {
  if (!S.state) return;
  const categorySelect = $('#sourceCategoryFilter');
  if (categorySelect) {
    const current = categorySelect.value;
    categorySelect.innerHTML = '<option value="">全部分类</option>' + S.state.categories
      .map((category) => `<option value="${esc(category.id)}">${esc(category.label)}</option>`).join('');
    categorySelect.value = current;
  }
  const regionSelect = $('#sourceRegionFilter');
  if (regionSelect) {
    const current = regionSelect.value;
    regionSelect.innerHTML = '<option value="">全部地区</option>' + S.state.regions
      .map((region) => `<option value="${esc(region)}">${esc(region)}</option>`).join('');
    regionSelect.value = current;
  }
  const customCategory = $('#customFeedCategory');
  if (customCategory) {
    const current = customCategory.value || '综合';
    customCategory.innerHTML = S.state.categories
      .map((category) => `<option value="${esc(category.id)}">${esc(category.label)}</option>`).join('');
    customCategory.value = current;
  }
}

function listQuery(reset) {
  const params = new URLSearchParams();
  params.set('view', S.filter.view);
  params.set('limit', String(S.limit));
  params.set('offset', String(reset ? 0 : S.offset));
  if (S.filter.category) params.set('category', S.filter.category);
  if (S.filter.sourceId) params.set('sourceId', S.filter.sourceId);
  if (S.filter.q) params.set('q', S.filter.q);
  return params.toString();
}

async function loadArticles(options = {}) {
  const reset = Boolean(options.reset);
  if (!reset && S.loadingList) return;
  const token = ++S.listToken;
  S.loadingList = true;
  if (reset && !options.silent) showListSkeleton();
  if (!reset) {
    const button = $('#loadMoreBtn');
    button.disabled = true;
    button.textContent = '正在加载…';
  }
  try {
    const data = await api(`/api/articles?${listQuery(reset)}`);
    if (token !== S.listToken) return;
    S.articles = reset ? data.items : S.articles.concat(data.items);
    S.total = data.total;
    S.offset = data.offset + data.items.length;
    S.hasMore = data.hasMore;
    renderList();
    renderListMeta();
  } catch (error) {
    if (token !== S.listToken) return;
    if (reset) {
      $('#articleList').innerHTML = `<div class="empty-list"><h3>读取文章失败</h3><p>${esc(error.message)}</p><button class="btn ghost small" onclick="location.reload()">重新加载页面</button></div>`;
      $('#listEnd').textContent = '';
    }
    toast(`读取文章失败：${error.message}`, 'error');
  } finally {
    if (token === S.listToken) S.loadingList = false;
    const button = $('#loadMoreBtn');
    button.disabled = false;
    button.textContent = '加载更多';
  }
}

function renderListMeta() {
  const heading = listHeading();
  $('#listEyebrow').textContent = heading.eyebrow;
  $('#listTitle').textContent = heading.title;
  const source = S.filter.sourceId && S.state ? S.state.sources.find((item) => item.id === S.filter.sourceId) : null;
  const detailParts = [`${S.total} 篇`];
  if (source && source.lastSyncAt) detailParts.push(`上次同步 ${formatSyncTime(source.lastSyncAt)}`);
  else if (S.state && S.state.lastSyncAt) detailParts.push(`更新于 ${formatSyncTime(S.state.lastSyncAt)}`);
  if (S.filter.q) detailParts.unshift(`“${S.filter.q}”`);
  $('#listSub').textContent = detailParts.join(' · ');
  $('#loadMoreBtn').classList.toggle('hidden', !S.hasMore);
  if (S.total === 0) $('#listEnd').textContent = '';
  else if (S.hasMore) $('#listEnd').textContent = '';
  else $('#listEnd').textContent = `已显示全部 ${S.total} 篇`;
  renderViewNav();
}

function listHeading() {
  if (S.filter.q) return { eyebrow: '搜索', title: `“${truncate(S.filter.q, 24)}”` };
  if (S.filter.sourceId && S.state) {
    const source = S.state.sources.find((item) => item.id === S.filter.sourceId);
    if (source) return { eyebrow: source.category + ' · ' + source.region, title: source.title };
  }
  if (S.filter.category && S.state) {
    const category = S.state.categories.find((item) => item.id === S.filter.category);
    if (category) {
      const title = S.filter.view === 'unread' ? `${category.label} · 未读` : S.filter.view === 'starred' ? `${category.label} · 收藏` : category.label;
      return { eyebrow: '分类', title };
    }
  }
  if (S.filter.view === 'unread') return { eyebrow: '未读', title: '未读文章' };
  if (S.filter.view === 'starred') return { eyebrow: '收藏', title: '收藏文章' };
  return { eyebrow: '全部', title: '最新文章' };
}

function renderList() {
  const host = $('#articleList');
  if (!S.articles.length) {
    const hasSources = S.state && S.state.sources.some((source) => source.enabled);
    host.innerHTML = `<div class="empty-list">
      <div class="empty-seal">阁</div>
      <h3>${S.filter.q ? '没有找到匹配的文章' : '这里还没有文章'}</h3>
      <p>${S.filter.q ? '换一个关键词，或清除筛选再试。' : hasSources ? '首次同步可能需要一两分钟，稍后刷新，或手动点一次“同步”。' : '先在“订阅源”里添加几家媒体。'}</p>
      <button class="btn ghost small" data-empty-action="sources">${hasSources ? '管理订阅源' : '添加订阅源'}</button>
    </div>`;
    return;
  }
  host.innerHTML = S.articles.map((article) => {
    const image = proxyImage(article.image);
    const lang = langBadge(article.language);
    return `<article class="card ${article.read ? 'read' : 'unread'} ${article.starred ? 'starred' : ''} ${S.selectedId === article.id ? 'selected' : ''}" data-id="${esc(article.id)}">
      <div class="card-main">
        <div class="card-content">
          <div class="card-source"><span>${esc(article.sourceTitle)}</span><span class="src-time">${esc(timeAgo(article.publishedAt))}</span></div>
          <h2>${esc(article.title)}</h2>
          ${article.summary ? `<p class="card-summary">${esc(article.summary)}</p>` : ''}
          <div class="card-foot">
            <div class="card-tags">
              <span class="mini-tag">${esc(article.category || '综合')}</span>
              <span class="mini-tag">${esc(lang)}</span>
              ${article.hasVideo ? '<span class="mini-tag media-tag">视频</span>' : ''}
              ${article.hasContent ? '<span class="mini-tag translated">正文</span>' : ''}
            </div>
            <button class="card-star ${article.starred ? 'active' : ''}" data-star="${esc(article.id)}" title="${article.starred ? '取消收藏' : '收藏'}">${icon('star')}</button>
          </div>
        </div>
        ${image ? `<img class="card-thumb" src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      </div>
    </article>`;
  }).join('');
  $$('.card-thumb', host).forEach((image) => {
    const drop = () => image.remove();
    image.addEventListener('load', () => image.classList.add('loaded'), { once: true });
    image.addEventListener('error', drop, { once: true });
    setTimeout(() => { if (!image.complete || !image.naturalWidth) drop(); }, 12000);
  });
}

function showReaderLoading() {
  $('#readerEmpty').classList.add('hidden');
  $('#articleView').classList.add('hidden');
  let loader = $('#readerLoading');
  if (!loader) {
    loader = document.createElement('div');
    loader.id = 'readerLoading';
    loader.className = 'reader-empty';
    loader.innerHTML = '<div class="empty-seal">阁</div><h2>正在打开…</h2><p>读取正文与已有译文。</p>';
    $('#readerPane').appendChild(loader);
  }
  loader.classList.remove('hidden');
}

function hideReaderLoading() {
  const loader = $('#readerLoading');
  if (loader) loader.remove();
}

async function openArticle(id) {
  if (!id) return;
  closeDrawer();
  document.body.classList.add('reader-open');
  if (S.selectedId === id && S.article && S.article.id === id) {
    $('#readerPane').scrollTop = 0;
    return;
  }
  S.selectedId = id;
  S.article = null;
  S.translation = null;
  S.translationMeta = null;
  S.translationMode = 'original';
  S.translateError = '';
  S.translating = false;
  S.translationJobId = '';
  S.autoTranslatedFor = '';
  S.ocrResults = {};
  S.captionResults = {};
  S.translationToken++;
  $$('.card').forEach((card) => card.classList.toggle('selected', card.dataset.id === id));
  showReaderLoading();
  try {
    const provider = currentProvider();
    const lang = currentLang();
    const translationRequest = api(`/api/articles/${id}/translation?provider=${encodeURIComponent(provider)}&lang=${encodeURIComponent(lang)}`)
      .catch((error) => (error.status === 404 ? null : Promise.reject(error)));
    const [articleResponse, translationResponse] = await Promise.all([
      api(`/api/articles/${id}`),
      translationRequest,
    ]);
    if (S.selectedId !== id) return;
    S.article = articleResponse.article;
    if (translationResponse && translationResponse.translation) {
      S.translation = translationResponse.translation;
      S.translationMeta = { provider: translationResponse.provider, targetLang: translationResponse.targetLang };
      S.translationMode = S.translation.note ? 'original' : 'bilingual';
    }
    hideReaderLoading();
    renderArticle();
    $('#readerPane').scrollTop = 0;
    markRead(S.article);
    kickAutoTranslate();
  } catch (error) {
    hideReaderLoading();
    $('#articleView').classList.add('hidden');
    $('#readerEmpty').classList.remove('hidden');
    toast(`打开文章失败：${error.message}`, 'error');
  }
}

function markRead(article) {
  if (!article || article.read) return;
  api(`/api/articles/${article.id}/read`, { method: 'POST', body: { read: true } })
    .then(() => {
      article.read = true;
      const card = $(`.card[data-id="${article.id}"]`);
      if (card) {
        card.classList.add('read');
        card.classList.remove('unread');
      }
      scheduleStateRefresh();
    })
    .catch(() => {});
}

function kickAutoTranslate() {
  const settings = S.state && S.state.settings;
  if (!settings || !settings.translate.autoForeign) return;
  if (!S.article || S.translation || S.translating) return;
  if (S.autoTranslatedFor === S.article.id) return;
  const language = String(S.article.language || '').toLowerCase();
  if (language.startsWith('zh')) return;
  if (!S.article.blocks || !S.article.blocks.length) return;
  S.autoTranslatedFor = S.article.id;
  setTimeout(() => {
    if (S.article && S.article.id === S.autoTranslatedFor && !S.translation) startTranslation(false);
  }, 500);
}

function articleTitleForView() {
  if (!S.article) return '';
  if (S.translationMode === 'translation' && S.translation && S.translation.title) return S.translation.title;
  return S.article.title;
}

function renderArticle() {
  if (!S.article) return;
  hideReaderLoading();
  $('#readerEmpty').classList.add('hidden');
  $('#articleView').classList.remove('hidden');
  const article = S.article;
  const source = article.source || {};
  const kickerParts = [
    `<span>${esc(source.title || '未知来源')}</span>`,
    '<span class="sep"></span>',
    `<span class="kicker-muted">${esc(source.category || '')} · ${esc(langName(article.language))}</span>`,
  ];
  if (article.fulltextAt) kickerParts.push('<span class="mini-tag">全文已抓取</span>');
  $('#articleKicker').innerHTML = kickerParts.join('');
  $('#articleTitle').textContent = articleTitleForView();

  const translatedTitle = S.translation && S.translation.title && S.translationMode !== 'translation'
    ? S.translation.title : '';
  const titleNote = $('#articleTranslatedTitle');
  if (translatedTitle && translatedTitle !== article.title) {
    titleNote.textContent = `译：${translatedTitle}`;
    titleNote.classList.remove('hidden');
  } else {
    titleNote.classList.add('hidden');
    titleNote.textContent = '';
  }

  const meta = [];
  if (article.author) meta.push(`<span>${esc(article.author)}</span>`);
  if (article.publishedAt) meta.push(`<span>${esc(formatDate(article.publishedAt, true))}</span>`);
  const chars = (article.blocks || []).reduce((total, block) => total + (block.t === 'img' ? 0 : String(block.text || '').length), 0);
  if (chars > 300) meta.push(`<span>约 ${Math.max(1, Math.round(chars / 500))} 分钟阅读</span>`);
  if (article.contentSource === 'fulltext') meta.push('<span>正文来自原文页面</span>');
  $('#articleMeta').innerHTML = meta.join('<span class="meta-sep">·</span>');

  const originalLink = $('#originalLink');
  const link = safeUrl(article.link);
  if (link) {
    originalLink.href = link;
    originalLink.classList.remove('hidden');
  } else {
    originalLink.classList.add('hidden');
  }

  const hasTranslation = Boolean(S.translation && !S.translation.note);
  $('#langSwitch').classList.toggle('hidden', !hasTranslation);
  $$('#langSwitch button').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === S.translationMode);
  });

  const translateButton = $('#translateBtn');
  translateButton.disabled = S.translating || !(article.blocks || []).length;
  translateButton.innerHTML = S.translating ? '<span>翻译中…</span>' : `<span>${S.translation ? '重新翻译' : '翻译'}</span>`;
  const fulltextButton = $('#fulltextBtn');
  fulltextButton.disabled = S.fetchingFulltext;
  fulltextButton.querySelector('span').textContent = S.fetchingFulltext
    ? '抓取中…'
    : (article.fulltextAt ? '重新抓取' : '抓取全文');
  fulltextButton.classList.toggle('spinning', S.fetchingFulltext);
  const starButton = $('#starBtn');
  starButton.classList.toggle('active', Boolean(article.starred));
  starButton.title = article.starred ? '取消收藏' : '收藏';
  starButton.setAttribute('aria-label', starButton.title);

  const body = $('#articleBody');
  if (!article.blocks || !article.blocks.length) {
    body.innerHTML = `<div class="empty-list" style="padding:36px 0 10px">
      <div class="empty-seal" style="margin:0 auto 14px">阁</div>
      <h3>RSS 只提供了摘要</h3>
      <p>点右上角“抓取全文”读取原文页面，之后再翻译或下载。部分需要登录或付费的媒体可能提取失败。</p>
    </div>`;
  } else {
    body.innerHTML = renderBlocks(article.blocks, S.translation, S.translationMode, article.title);
    $$('img', body).forEach((image) => {
      image.addEventListener('error', () => {
        const figure = image.closest('figure');
        if (figure) figure.remove(); else image.remove();
      });
    });
  }
  renderArticleMedia();
  renderTranslateBanner();
  updateDownloadLink();
}

function translatedBlock(translation, index) {
  if (!translation || !translation.blocks) return '';
  const item = translation.blocks[index];
  return item ? String(item.translation || '') : '';
}

function renderBlocks(blocks, translation, mode, skipTitle = '') {
  const out = [];
  let listOpen = false;
  let titleSkipped = false;
  const closeList = () => {
    if (listOpen) { out.push('</ul>'); listOpen = false; }
  };
  blocks.forEach((block, index) => {
    if (!block || !block.t) return;
    if (block.t === 'img') {
      closeList();
      const src = safeUrl(block.src);
      if (!src) return;
      const cached = S.ocrResults[src];
      out.push(`<figure class="article-figure">
        <img src="${esc(proxyImage(src))}" alt="${esc(block.alt || '')}" loading="lazy" referrerpolicy="no-referrer">
        <figcaption class="media-tools">
          ${block.alt ? `<span class="media-caption">${esc(block.alt)}</span>` : '<span class="media-caption">配图</span>'}
          <button type="button" class="media-btn ocr-btn" data-url="${esc(src)}">识别图中文字</button>
        </figcaption>
        <div class="ocr-panel ${cached ? '' : 'hidden'}" data-ocr-for="${esc(src)}">${ocrPanelHtml(cached)}</div>
      </figure>`);
      return;
    }
    const text = String(block.text || '');
    if (!text.trim()) return;
    if (!titleSkipped) {
      titleSkipped = true;
      if (skipTitle && text.trim() === skipTitle.trim()) return;
    }
    const translated = translatedBlock(translation, index);
    const useTranslation = Boolean(translated && translated.trim());
    if (block.t === 'li') {
      if (!listOpen) { out.push('<ul>'); listOpen = true; }
      if (mode === 'translation' && useTranslation) out.push(`<li>${formatParagraph(translated)}</li>`);
      else if (mode === 'bilingual' && useTranslation) out.push(`<li><div class="src">${formatParagraph(text)}</div><div class="dst">${formatParagraph(translated)}</div></li>`);
      else out.push(`<li class="${mode !== 'original' && !useTranslation ? 'untranslated' : ''}">${formatParagraph(text)}</li>`);
      return;
    }
    closeList();
    if (block.t === 'quote') {
      if (mode === 'translation') {
        out.push(`<blockquote>${formatParagraph(useTranslation ? translated : text)}</blockquote>`);
      } else if (mode === 'bilingual' && useTranslation) {
        out.push(`<div class="pair"><blockquote class="src">${formatParagraph(text)}</blockquote><blockquote class="dst">${formatParagraph(translated)}</blockquote></div>`);
      } else {
        out.push(`<blockquote class="${mode !== 'original' && !useTranslation ? 'untranslated' : ''}">${formatParagraph(text)}</blockquote>`);
      }
      return;
    }
    if (block.t === 'h2' || block.t === 'h3') {
      const tag = block.t;
      if (mode === 'translation') out.push(`<${tag}>${esc(useTranslation ? translated : text)}</${tag}>`);
      else if (mode === 'bilingual' && useTranslation) out.push(`<div class="pair"><${tag} class="src">${esc(text)}</${tag}><${tag} class="dst">${esc(translated)}</${tag}></div>`);
      else out.push(`<${tag} class="${mode !== 'original' && !useTranslation ? 'untranslated' : ''}">${esc(text)}</${tag}>`);
      return;
    }
    if (mode === 'translation') out.push(`<p class="${useTranslation ? '' : 'untranslated'}">${formatParagraph(useTranslation ? translated : text)}</p>`);
    else if (mode === 'bilingual' && useTranslation) out.push(`<div class="pair"><p class="src">${formatParagraph(text)}</p><p class="dst">${formatParagraph(translated)}</p></div>`);
    else out.push(`<p class="${mode !== 'original' && !useTranslation ? 'untranslated' : ''}">${formatParagraph(text)}</p>`);
  });
  closeList();
  return out.join('\n');
}

function formatParagraph(text) {
  return esc(text).replace(/\n/g, '<br>');
}

function ocrPanelHtml(result) {
  if (!result) return '';
  if (result.error) return `<div class="ocr-error">${esc(result.error)}</div>`;
  const text = String(result.text || '').trim();
  const translation = String(result.translation || '').trim();
  if (!text) return '<div class="ocr-empty">图片里没有识别到文字。</div>';
  const source = `<div class="ocr-src">${esc(text)}</div>`;
  const target = translation && translation !== text
    ? `<div class="ocr-dst">${esc(translation)}</div>`
    : '';
  const provider = esc(result.providerLabel || result.model || (result.provider === 'vision' ? '视觉模型' : '系统 OCR'));
  return `<div class="ocr-head"><span>图片文字 · ${provider}</span><span>${target ? '原文 / 译文' : '原文'}</span></div>${source}${target}`;
}

function formatCueTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function captionPasteFormHtml() {
  return `<div class="caption-paste">
    <textarea rows="4" placeholder="在视频页面打开字幕 / 文字稿，复制后粘贴到这里。支持 WebVTT、SRT 或纯文本。"></textarea>
    <div class="caption-paste-foot">
      <span>适用于平台禁止本程序下载字幕的视频，最多 300 行。</span>
      <button type="button" class="media-btn paste-run">翻译粘贴内容</button>
    </div>
  </div>`;
}

function captionPanelHtml(result) {
  if (!result) return '';
  if (result.error) return `<div class="ocr-error">${esc(result.error)}</div>${captionPasteFormHtml()}`;
  const cues = Array.isArray(result.cues) ? result.cues.slice(0, 200) : [];
  if (!cues.length) return `<div class="ocr-empty">字幕里没有可用文本。</div>${captionPasteFormHtml()}`;
  const rows = cues.map((cue) => `<div class="cue">
    <span class="cue-time">${formatCueTime(cue.start)}</span>
    <div class="cue-text"><div class="cue-src">${esc(cue.text)}</div>${cue.translation ? `<div class="cue-dst">${esc(cue.translation)}</div>` : ''}</div>
  </div>`).join('');
  return `<div class="ocr-head"><span>字幕 · ${esc(result.providerLabel || '')}${result.cached ? ' · 缓存' : ''}${result.note ? ` · ${esc(result.note)}` : ''}</span><span>${cues.length} 条</span></div>
    ${result.warning ? `<div class="ocr-error">${esc(result.warning)}</div>` : ''}
    <div class="cue-list">${rows}</div>`;
}

function mediaSectionHtml(article) {
  const videos = Array.isArray(article.videos) ? article.videos : [];
  if (!videos.length) return '';
  const items = videos.map((video, index) => {
    const poster = proxyImage(video.poster || '');
    const player = video.type === 'embed'
      ? `<iframe src="${esc(video.url)}" title="${esc(video.title || `视频 ${index + 1}`)}" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" referrerpolicy="strict-origin-when-cross-origin"></iframe>`
      : `<video controls preload="metadata" playsinline${poster ? ` poster="${esc(poster)}"` : ''} src="${esc(video.url)}"></video>`;
    const tracks = Array.isArray(video.tracks) ? video.tracks : [];
    const captionUrl = tracks.length ? tracks[0].url : (video.provider === 'YouTube' ? video.url : '');
    const cached = captionUrl ? S.captionResults[captionUrl] : null;
    return `<div class="video-item">
      <div class="video-frame">${player}</div>
      <div class="media-tools">
        <span class="media-caption">${esc(video.provider || '视频')}${video.title ? ` · ${esc(video.title)}` : ''}</span>
        <span class="media-tools-right">
          ${captionUrl ? `<button type="button" class="media-btn caption-btn" data-url="${esc(captionUrl)}">翻译字幕</button>` : ''}
          <button type="button" class="media-btn caption-paste-btn">粘贴字幕</button>
          <a class="media-btn ghost-link" href="${esc(video.url)}" target="_blank" rel="noreferrer noopener">打开视频</a>
        </span>
      </div>
      ${video.type === 'embed' ? '<div class="media-hint">嵌入播放器由视频平台提供；YouTube 等平台可在播放器内开启 CC 自动字幕。</div>' : ''}
      <div class="ocr-panel ${cached ? '' : 'hidden'}" data-caption-panel>${captionPanelHtml(cached)}</div>
    </div>`;
  }).join('');
  return `<div class="article-media"><div class="media-section-title">视频 · ${videos.length}</div>${items}</div>`;
}

function renderArticleMedia() {
  const host = $('#articleMedia');
  if (!host) return;
  const html = S.article ? mediaSectionHtml(S.article) : '';
  host.innerHTML = html;
  host.classList.toggle('hidden', !html);
}

async function runOcr(button) {
  const url = button.dataset.url;
  const figure = button.closest('figure');
  const panel = figure && figure.querySelector('.ocr-panel');
  if (!url || !panel) return;
  panel.classList.remove('hidden');
  button.disabled = true;
  button.textContent = '识别中…';
  panel.innerHTML = '<div class="ocr-loading">正在识别图片文字并翻译…</div>';
  try {
    const result = await api('/api/ocr', { method: 'POST', body: { url } });
    S.ocrResults[url] = result;
    panel.innerHTML = ocrPanelHtml(result);
    if (!result.text) toast('图片里没有识别到文字', 'info');
  } catch (error) {
    S.ocrResults[url] = { error: error.message };
    panel.innerHTML = ocrPanelHtml({ error: error.message });
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '重新识别';
  }
}

async function runCaptions(button) {
  const url = button.dataset.url;
  if (!url) return;
  const item = button.closest('.video-item');
  const panel = item && item.querySelector('[data-caption-panel]');
  if (!panel) return;
  panel.classList.remove('hidden');
  button.disabled = true;
  button.textContent = '翻译中…';
  panel.innerHTML = '<div class="ocr-loading">正在解析平台字幕并翻译，字幕较多时需要一会儿…</div>';
  try {
    const result = await api('/api/captions', { method: 'POST', body: { url } });
    S.captionResults[url] = result;
    panel.innerHTML = captionPanelHtml(result);
  } catch (error) {
    S.captionResults[url] = { error: error.message };
    panel.innerHTML = captionPanelHtml({ error: error.message });
    toast(error.message, 'error', 7000);
  } finally {
    button.disabled = false;
    button.textContent = '重新加载字幕';
  }
}

function openCaptionPaste(button) {
  const item = button.closest('.video-item');
  const panel = item && item.querySelector('[data-caption-panel]');
  if (!panel) return;
  panel.classList.remove('hidden');
  panel.innerHTML = captionPasteFormHtml();
  const area = panel.querySelector('textarea');
  if (area) area.focus();
}

async function runPasteCaptions(button) {
  const panel = button.closest('[data-caption-panel]');
  const area = panel && panel.querySelector('textarea');
  const text = area ? area.value.trim() : '';
  if (!text) {
    toast('请先粘贴字幕或文字稿内容', 'info');
    if (area) area.focus();
    return;
  }
  button.disabled = true;
  button.textContent = '翻译中…';
  panel.innerHTML = '<div class="ocr-loading">正在翻译粘贴的字幕…</div>';
  try {
    const result = await api('/api/captions', { method: 'POST', body: { text } });
    panel.innerHTML = captionPanelHtml(result);
  } catch (error) {
    panel.innerHTML = captionPanelHtml({ error: error.message });
    toast(error.message, 'error', 7000);
  }
}

function translateBannerHtml() {
  if (S.translating) {
    const progress = S.translateProgress || { done: 0, total: 0, percent: 0 };
    const provider = (S.translationMeta && S.translationMeta.provider) || currentProvider();
    return `<div class="banner-row"><span class="banner-title">正在翻译整篇文章…</span><span class="banner-detail">${progress.done || 0}/${progress.total || '—'} 段 · ${esc(PROVIDER_LABELS[provider] || provider)}</span></div>
      <div class="progress-track"><i style="width:${Math.max(2, progress.percent || 0)}%"></i></div>
      <div class="banner-actions"><button class="text-btn" data-cancel-translate>停止翻译</button></div>`;
  }
  if (S.translateError) {
    return `<div class="banner-row"><span class="banner-title">翻译没有完成</span><span class="banner-detail">${esc(S.translateError)}</span></div>
      <div class="banner-actions"><button class="text-btn" data-retry-translate>重试</button></div>`;
  }
  if (S.translation) {
    const failed = (S.translation.failed || []).length;
    if (S.translation.note) {
      return `<div class="banner-row"><span class="banner-title">无需翻译</span><span class="banner-detail">${esc(S.translation.note)}</span></div>`;
    }
    if (failed) {
      return `<div class="banner-row"><span class="banner-title">有 ${failed} 段没有翻译成功</span><span class="banner-detail">已保留原文，可只补译缺失部分。</span></div>
        <div class="banner-actions"><button class="text-btn" data-retry-translate>重试缺失段落</button></div>`;
    }
    const label = S.translation.providerLabel || PROVIDER_LABELS[(S.translationMeta || {}).provider] || '';
    return `<div class="banner-row"><span class="banner-title">整篇译文已就绪</span><span class="banner-detail">${esc(label)} · ${esc(S.translation.targetLang === 'zh-TW' ? '繁體中文' : '简体中文')}${S.translation.complete ? '' : ' · 部分段落'}</span></div>`;
  }
  return '';
}

function renderTranslateBanner() {
  const host = $('#translateBanner');
  const html = translateBannerHtml();
  if (!html) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }
  host.classList.remove('hidden');
  host.className = `banner ${S.translateError ? 'error' : S.translating ? '' : (S.translation && (S.translation.failed || []).length ? 'warn' : 'success')}`;
  host.innerHTML = html;
}

async function startTranslation(force = false) {
  if (!S.article) return;
  if (S.translating) return;
  if (!S.article.blocks || !S.article.blocks.length) {
    toast('这篇文章还没有正文，请先抓取全文。', 'warn');
    return;
  }
  const articleId = S.article.id;
  const token = ++S.translationToken;
  S.translating = true;
  S.translateError = '';
  S.translationMeta = { provider: currentProvider(), targetLang: currentLang() };
  S.translateProgress = { done: 0, total: 0, percent: 0 };
  renderArticle();
  try {
    const response = await api(`/api/articles/${articleId}/translate`, {
      method: 'POST',
      body: { provider: currentProvider(), lang: currentLang(), force },
    });
    const job = response.job;
    S.translationJobId = job.id;
    if (job.provider) S.translationMeta.provider = job.provider;
    if (job.targetLang) S.translationMeta.targetLang = job.targetLang;
    renderTranslateBanner();
    pollTranslationJob(job.id, articleId, token);
  } catch (error) {
    S.translating = false;
    S.translateError = error.message;
    renderArticle();
    toast(`翻译失败：${error.message}`, 'error', 6000);
  }
}

async function pollTranslationJob(jobId, articleId, token) {
  while (token === S.translationToken) {
    let job;
    try {
      const response = await api(`/api/jobs/${jobId}`);
      job = response.job;
    } catch (error) {
      if (token !== S.translationToken) return;
      S.translating = false;
      S.translateError = error.message;
      renderArticle();
      return;
    }
    if (token !== S.translationToken || !S.article || S.article.id !== articleId) return;
    S.translateProgress = job.progress || { done: 0, total: 0, percent: 0 };
    if (job.provider) S.translationMeta.provider = job.provider;
    if (job.targetLang) S.translationMeta.targetLang = job.targetLang;
    if (job.status === 'running') {
      renderTranslateBanner();
      await sleep(1100);
      continue;
    }
    S.translating = false;
    if (job.status === 'done') {
      await loadTranslation(articleId, S.translationMeta.provider, S.translationMeta.targetLang, token);
      if (S.translation && !S.translation.note) {
        S.translationMode = 'bilingual';
        toast(job.warning || '整篇翻译完成。', job.warning ? 'warn' : 'success');
      } else if (S.translation && S.translation.note) {
        S.translationMode = 'original';
        toast(S.translation.note, 'info');
      }
      renderArticle();
    } else if (job.status === 'canceled') {
      renderArticle();
      toast('已停止翻译。已完成的段落会保留。', 'info');
    } else {
      S.translateError = job.error || '翻译失败';
      renderArticle();
      toast(S.translateError, 'error', 7000);
    }
    return;
  }
}

async function loadTranslation(articleId, provider, lang, token) {
  try {
    const response = await api(`/api/articles/${articleId}/translation?provider=${encodeURIComponent(provider)}&lang=${encodeURIComponent(lang)}`);
    if (token !== undefined && token !== S.translationToken) return;
    S.translation = response.translation;
    S.translationMeta = { provider: response.provider, targetLang: response.targetLang };
  } catch (error) {
    if (error.status === 404) {
      S.translation = null;
    } else if (token === undefined || token === S.translationToken) {
      S.translateError = error.message;
    }
  }
}

async function cancelTranslation() {
  if (!S.translationJobId) return;
  try {
    await api(`/api/jobs/${S.translationJobId}/cancel`, { method: 'POST' });
    toast('正在停止翻译…', 'info');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function fetchFulltext() {
  if (!S.article || S.fetchingFulltext) return;
  S.fetchingFulltext = true;
  renderArticle();
  try {
    const response = await api(`/api/articles/${S.article.id}/fulltext`, { method: 'POST' });
    S.article = response.article;
    S.translation = null;
    S.translationMeta = null;
    S.translationMode = 'original';
    S.translateError = '';
    S.translationToken++;
    toast(`已抓取全文，共 ${response.blocks} 段。`, 'success');
    scheduleStateRefresh();
  } catch (error) {
    toast(`抓取全文失败：${error.message}`, 'error', 7000);
  } finally {
    S.fetchingFulltext = false;
    if (S.article) renderArticle();
  }
}

async function toggleStar(id) {
  if (!id) return;
  const listItem = S.articles.find((article) => article.id === id);
  const current = S.article && S.article.id === id ? S.article.starred : (listItem ? listItem.starred : false);
  const target = !current;
  if (S.article && S.article.id === id) S.article.starred = target;
  if (listItem) listItem.starred = target;
  const card = $(`.card[data-id="${id}"]`);
  if (card) {
    card.classList.toggle('starred', target);
    const button = $('.card-star', card);
    if (button) {
      button.classList.toggle('active', target);
      button.title = target ? '取消收藏' : '收藏';
    }
  }
  if (S.article && S.article.id === id) {
    const button = $('#starBtn');
    button.classList.toggle('active', target);
    button.title = target ? '取消收藏' : '收藏';
  }
  try {
    await api(`/api/articles/${id}/star`, { method: 'POST', body: { starred: target } });
    toast(target ? '已加入收藏' : '已取消收藏', 'success', 1800);
    scheduleStateRefresh();
    if (S.filter.view === 'starred' && !target) setTimeout(() => loadArticles({ reset: true, silent: true }), 350);
  } catch (error) {
    if (S.article && S.article.id === id) S.article.starred = !target;
    if (listItem) listItem.starred = !target;
    renderList();
    if (S.article) renderArticle();
    toast(`操作失败：${error.message}`, 'error');
  }
}

function navigateArticle(direction) {
  if (!S.articles.length) return;
  let index = S.articles.findIndex((article) => article.id === S.selectedId);
  if (index < 0) index = 0;
  const next = index + direction;
  if (next < 0) return;
  if (next >= S.articles.length) {
    if (S.hasMore) {
      loadArticles({}).then(() => {
        if (S.articles[next]) openArticle(S.articles[next].id);
      });
    }
    return;
  }
  openArticle(S.articles[next].id);
}

async function startSync() {
  if (S.syncing) return;
  try {
    const response = await api('/api/sync', { method: 'POST' });
    S.syncing = true;
    S.syncJobId = response.job.id;
    const token = ++S.syncToken;
    updateSyncButton();
    showSyncBanner(response.job);
    pollSyncJob(response.job.id, token);
  } catch (error) {
    toast(`同步失败：${error.message}`, 'error');
  }
}

async function syncSource(sourceId) {
  try {
    const response = await api('/api/sync', { method: 'POST', body: { sourceId } });
    S.syncing = true;
    S.syncJobId = response.job.id;
    const token = ++S.syncToken;
    updateSyncButton();
    showSyncBanner(response.job);
    pollSyncJob(response.job.id, token);
    toast('已开始同步这个订阅源。', 'info');
  } catch (error) {
    toast(`同步失败：${error.message}`, 'error');
  }
}

function showSyncBanner(job) {
  const banner = $('#syncBanner');
  if (!job) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  const progress = job.progress || { done: 0, total: 0, percent: 0 };
  const status = job.status === 'running' ? '正在同步订阅源' : job.status === 'done' ? '同步完成' : job.status === 'error' ? '同步失败' : '同步已停止';
  $('#syncTitle').textContent = status;
  const pieces = [`${progress.done}/${progress.total} 个源`];
  if (job.added !== undefined) pieces.push(`新增 ${job.added} 篇`);
  if (job.failed) pieces.push(`失败 ${job.failed}`);
  if (job.current && job.status === 'running') pieces.push(job.current);
  $('#syncDetail').textContent = pieces.join(' · ');
  $('#syncProgress').style.width = `${Math.max(2, progress.percent || 0)}%`;
}

function hideSyncBannerSoon() {
  clearTimeout(S.syncBannerTimer);
  S.syncBannerTimer = setTimeout(() => {
    if (!S.syncing) $('#syncBanner').classList.add('hidden');
  }, 5000);
}

async function pollSyncJob(jobId, token) {
  while (token === S.syncToken) {
    let job;
    try {
      const response = await api(`/api/jobs/${jobId}`);
      job = response.job;
    } catch (error) {
      if (token !== S.syncToken) return;
      S.syncing = false;
      updateSyncButton();
      setStrip('无法读取同步状态', 'error');
      return;
    }
    if (token !== S.syncToken) return;
    S.syncing = job.status === 'running';
    updateSyncButton();
    showSyncBanner(job);
    if (job.status === 'running') {
      await sleep(1100);
      continue;
    }
    S.syncing = false;
    updateSyncButton();
    if (job.status === 'done') {
      const summary = job.summary || {};
      const message = `同步完成：${summary.ok || 0} 个源成功，新增 ${summary.added || 0} 篇${summary.failed ? `，${summary.failed} 个源失败` : ''}。`;
      toast(message, summary.failed ? 'warn' : 'success', 6500);
      setStrip(`上次同步 ${formatSyncTime(new Date().toISOString())}`, summary.failed ? 'warn' : '');
    } else if (job.status === 'error') {
      toast(`同步失败：${job.error || '未知错误'}`, 'error', 7000);
      setStrip('同步失败', 'error');
    }
    hideSyncBannerSoon();
    try { await refreshState(); } catch { /* noop */ }
    try { await loadArticles({ reset: true, silent: true }); } catch { /* noop */ }
    return;
  }
}

async function detectActiveSync() {
  if (S.syncing) return;
  try {
    const response = await api('/api/jobs');
    const job = (response.active || []).find((item) => item.type === 'sync');
    if (job) {
      S.syncing = true;
      S.syncJobId = job.id;
      const token = ++S.syncToken;
      updateSyncButton();
      showSyncBanner(job);
      pollSyncJob(job.id, token);
    }
  } catch { /* noop */ }
}

/* sidebar interactions */
function setView(view) {
  if (!['all', 'unread', 'starred'].includes(view)) return;
  S.filter.view = view;
  renderViewNav();
  renderCategories();
  renderSourcesSidebar();
  loadArticles({ reset: true });
}

function setCategory(category) {
  S.filter.category = category;
  S.filter.sourceId = '';
  renderCategories();
  renderSourcesSidebar();
  loadArticles({ reset: true });
  closeDrawer();
}

function setSource(sourceId) {
  S.filter.sourceId = sourceId;
  renderCategories();
  renderSourcesSidebar();
  loadArticles({ reset: true });
  closeDrawer();
}

function clearFilters() {
  S.filter = { view: 'all', category: '', sourceId: '', q: '' };
  $('#searchInput').value = '';
  renderViewNav();
  renderCategories();
  renderSourcesSidebar();
  loadArticles({ reset: true });
}

/* source manager */
async function openSources(tab) {
  S.sourcesTab = tab || S.sourcesTab || 'subscribed';
  showModal('sourcesModal');
  renderSourcesTabs();
  if (!S.catalog) {
    $('#sourcesBody').innerHTML = '<div class="section-empty">正在读取源库…</div>';
    try {
      S.catalog = await api('/api/catalog');
    } catch (error) {
      $('#sourcesBody').innerHTML = `<div class="section-empty">源库读取失败：${esc(error.message)}</div>`;
      return;
    }
  }
  renderSources();
}

function renderSourcesTabs() {
  $$('#sourcesTabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset.sourcesTab === S.sourcesTab);
  });
  $('#sourcesFoot').classList.toggle('hidden', S.sourcesTab !== 'subscribed');
  const sources = S.state ? S.state.sources : [];
  const catalog = S.catalog ? S.catalog.catalog : [];
  $('#subCount').textContent = sources.length;
  $('#catCount').textContent = catalog.length;
}

function sourceMatches(source) {
  const query = S.sourceQuery.trim().toLowerCase();
  if (S.sourceCategory && source.category !== S.sourceCategory) return false;
  if (S.sourceRegion && source.region !== S.sourceRegion) return false;
  if (!query) return true;
  return `${source.title} ${source.url} ${source.note || ''}`.toLowerCase().includes(query);
}

function renderSources() {
  if (!S.state) return;
  renderSourcesTabs();
  const host = $('#sourcesBody');
  if (S.sourcesTab === 'subscribed') {
    const sources = S.state.sources.filter(sourceMatches);
    if (!sources.length) {
      host.innerHTML = `<div class="section-empty">${S.state.sources.length ? '没有符合筛选条件的订阅源。' : '还没有订阅源。切换到“源库”挑几家媒体，或在下方添加 RSS 地址。'}</div>`;
      return;
    }
    host.innerHTML = sources.map((source) => {
      const error = source.lastError
        ? `<span class="err" title="${esc(source.lastError)}">· ${esc(truncate(source.lastError, 60))}</span>`
        : '';
      return `<div class="source-item" data-id="${esc(source.id)}">
        <div class="source-toggle"><label class="switch" title="${source.enabled ? '停用' : '启用'}"><input type="checkbox" data-toggle-source="${esc(source.id)}" ${source.enabled ? 'checked' : ''}><i></i></label></div>
        <div class="source-info">
          <div class="source-title">${esc(source.title)}${source.custom ? '<span class="mini-tag">自定义</span>' : ''}${source.needsProxy ? '<span class="mini-tag">需代理</span>' : ''}</div>
          <div class="source-meta">${esc(source.category)} · ${esc(source.region)} · ${esc(langName(source.language))} · ${esc(source.url)}</div>
          <div class="source-meta">${source.lastSyncAt ? `上次同步 ${esc(formatSyncTime(source.lastSyncAt))}` : '尚未同步'}${error}</div>
        </div>
        <div class="source-counts">${source.unread} 未读<br>${source.total} 篇</div>
        <div class="source-actions">
          <button class="btn ghost" data-sync-source="${esc(source.id)}">同步</button>
          <button class="btn ghost" data-delete-source="${esc(source.id)}">删除</button>
        </div>
      </div>`;
    }).join('');
    return;
  }
  if (!S.catalog) {
    host.innerHTML = '<div class="section-empty">正在读取源库…</div>';
    return;
  }
  const items = S.catalog.catalog.filter(sourceMatches);
  if (!items.length) {
    host.innerHTML = '<div class="section-empty">没有符合筛选条件的源。试试更换分类，或清空搜索词。</div>';
    return;
  }
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  const parts = [];
  for (const [category, list] of groups) {
    parts.push(`<div class="catalog-group-title">${esc(category)} <span class="nav-count">${list.length}</span></div>`);
    parts.push(list.map((item) => {
      const note = item.note || (item.siteUrl ? new URL(item.siteUrl).hostname : '');
      return `<div class="catalog-item">
        <div class="catalog-info">
          <div class="catalog-title">${esc(item.title)}${item.needsProxy ? '<span class="mini-tag">需代理</span>' : ''}${item.defaultEnabled && item.subscribed ? '<span class="mini-tag translated">默认</span>' : ''}</div>
          <div class="catalog-desc">${esc(note || '公开 RSS 订阅源')}</div>
          <div class="catalog-meta"><span>${esc(item.category)}</span><span>${esc(item.region)}</span><span>${esc(langName(item.language))}</span><span>${esc(item.url)}</span></div>
        </div>
        <div class="catalog-action">${item.subscribed
          ? '<span class="mini-tag translated">已订阅</span>'
          : `<button class="btn accent small" data-add-catalog="${esc(item.key)}">添加</button>`}</div>
      </div>`;
    }).join(''));
  }
  host.innerHTML = parts.join('');
}

async function reloadCatalog() {
  try {
    S.catalog = await api('/api/catalog');
  } catch { /* noop */ }
  renderSourcesTabs();
}

async function addCatalogSource(key) {
  try {
    const button = $(`[data-add-catalog="${key}"]`);
    if (button) { button.disabled = true; button.textContent = '添加中…'; }
    const response = await api('/api/sources', { method: 'POST', body: { catalogKey: key } });
    toast(`已添加：${response.source.title}`, 'success');
    await refreshState();
    await reloadCatalog();
    renderSources();
    syncSource(response.source.id);
  } catch (error) {
    toast(`添加失败：${error.message}`, 'error');
    renderSources();
  }
}

async function addCustomFeed() {
  const input = $('#customFeedUrl');
  const url = input.value.trim();
  if (!url) {
    toast('请先填写 RSS / Atom 地址。', 'warn');
    input.focus();
    return;
  }
  const button = $('#customFeedAdd');
  button.disabled = true;
  button.textContent = '读取中…';
  try {
    const response = await api('/api/sources', {
      method: 'POST',
      body: { url, category: $('#customFeedCategory').value || '综合', region: '全球' },
    });
    input.value = '';
    toast(`已添加：${response.source.title}`, 'success');
    await refreshState();
    await reloadCatalog();
    renderSources();
    syncSource(response.source.id);
  } catch (error) {
    toast(`添加失败：${error.message}`, 'error', 6000);
  } finally {
    button.disabled = false;
    button.textContent = '添加';
  }
}

async function toggleSource(id, enabled) {
  try {
    await api(`/api/sources/${id}`, { method: 'PATCH', body: { enabled } });
    const source = S.state.sources.find((item) => item.id === id);
    if (source) source.enabled = enabled;
    toast(enabled ? '已启用订阅源。' : '已停用订阅源。', 'success', 2000);
    await refreshState();
    renderSources();
  } catch (error) {
    toast(`操作失败：${error.message}`, 'error');
    renderSources();
  }
}

async function deleteSource(id) {
  const source = S.state.sources.find((item) => item.id === id);
  if (!source) return;
  if (!window.confirm(`删除订阅源“${source.title}”？\n该源已下载的文章、全文和译文也会被删除。`)) return;
  try {
    await api(`/api/sources/${id}`, { method: 'DELETE' });
    toast('订阅源已删除。', 'success');
    if (S.filter.sourceId === id) S.filter.sourceId = '';
    await refreshState();
    await reloadCatalog();
    renderSources();
    loadArticles({ reset: true, silent: true });
  } catch (error) {
    toast(`删除失败：${error.message}`, 'error');
  }
}

async function importOpmlFile(file) {
  if (!file) return;
  try {
    const content = await file.text();
    const response = await api('/api/opml', { method: 'POST', body: { content } });
    toast(`OPML 导入完成：新增 ${response.added} 个，跳过 ${response.skipped} 个。`, response.added ? 'success' : 'info', 6000);
    await refreshState();
    await reloadCatalog();
    renderSources();
  } catch (error) {
    toast(`导入失败：${error.message}`, 'error', 6000);
  }
}

/* settings */
function openSettings() {
  if (!S.state) return;
  fillSettingsForm();
  showModal('settingsModal');
}

function fillSettingsForm() {
  if (!S.state) return;
  const settings = S.state.settings;
  const t = settings.translate;
  $('#setSyncInterval').value = String(settings.syncIntervalMinutes);
  $('#setRetention').value = settings.retentionPerSource;
  $('#setMaxItems').value = settings.maxItemsPerSync;
  $('#setProxy').value = settings.proxy || '';
  $('#setProvider').value = t.provider;
  $('#setTargetLang').value = t.targetLang;
  $('#setAutoForeign').checked = Boolean(t.autoForeign);
  $('#setMymemoryEmail').value = t.mymemoryEmail || '';
  $('#setDeeplKey').value = t.deeplKey || '';
  $('#setAzureKey').value = t.azureKey || '';
  $('#setAzureRegion').value = t.azureRegion || '';
  $('#setBaiduAppId').value = t.baiduAppId || '';
  $('#setBaiduKey').value = t.baiduKey || '';
  $('#setOpenaiBase').value = t.openaiBaseUrl || '';
  $('#setOpenaiKey').value = t.openaiKey || '';
  $('#setOpenaiModel').value = t.openaiModel || '';
  if ($('#setOcrModel')) $('#setOcrModel').value = t.ocrModel || '';
  $('#setDataDir').textContent = S.state.dataDir || '';
  $('#testResult').textContent = '';
  $('#testResult').className = 'test-result';
  updateProviderFields();
}

function updateProviderFields() {
  const provider = $('#setProvider').value;
  $$('.provider-fields').forEach((group) => {
    group.classList.toggle('hidden', group.dataset.provider !== provider);
  });
}

function collectSettings() {
  return {
    syncIntervalMinutes: Number($('#setSyncInterval').value),
    retentionPerSource: Number($('#setRetention').value),
    maxItemsPerSync: Number($('#setMaxItems').value),
    proxy: $('#setProxy').value.trim(),
    translate: {
      provider: $('#setProvider').value,
      targetLang: $('#setTargetLang').value,
      autoForeign: $('#setAutoForeign').checked,
      mymemoryEmail: $('#setMymemoryEmail').value.trim(),
      deeplKey: $('#setDeeplKey').value.trim(),
      azureKey: $('#setAzureKey').value.trim(),
      azureRegion: $('#setAzureRegion').value.trim(),
      baiduAppId: $('#setBaiduAppId').value.trim(),
      baiduKey: $('#setBaiduKey').value.trim(),
      openaiBaseUrl: $('#setOpenaiBase').value.trim(),
      openaiKey: $('#setOpenaiKey').value.trim(),
      openaiModel: $('#setOpenaiModel').value.trim(),
      ocrModel: $('#setOcrModel') ? $('#setOcrModel').value.trim() : '',
    },
  };
}

async function saveSettings(options = {}) {
  const response = await api('/api/settings', { method: 'POST', body: collectSettings() });
  if (S.state) S.state.settings = response.settings;
  if (!options.quiet) toast('设置已保存。', 'success');
  return response.settings;
}

async function submitSettings(event) {
  event.preventDefault();
  const button = $('#settingsForm button[type="submit"]');
  button.disabled = true;
  try {
    await saveSettings();
    closeModal('settingsModal');
  } catch (error) {
    toast(`保存失败：${error.message}`, 'error', 6000);
  } finally {
    button.disabled = false;
  }
}

async function testTranslation() {
  const button = $('#testTranslateBtn');
  const result = $('#testResult');
  button.disabled = true;
  button.textContent = '正在测试…';
  result.className = 'test-result';
  result.textContent = '';
  try {
    await saveSettings({ quiet: true });
    const response = await api('/api/translate/test', {
      method: 'POST',
      body: { provider: $('#setProvider').value, lang: $('#setTargetLang').value },
    });
    result.className = 'test-result ok';
    result.textContent = `成功（${response.providerLabel}，${response.elapsedMs} 毫秒）：${truncate(response.text, 90)}`;
  } catch (error) {
    result.className = 'test-result err';
    result.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = '保存并测试翻译';
  }
}

async function shutdownApp() {
  if (!window.confirm('确定退出环球报阁？浏览器页面会断开，重新双击启动图标即可再次打开。')) return;
  try {
    await api('/api/shutdown', { method: 'POST' });
    closeAllModals();
    const screen = document.createElement('div');
    screen.className = 'shutdown-screen';
    screen.innerHTML = '<div class="empty-seal">阁</div><h2>环球报阁已退出</h2><p>服务已停止。需要继续阅读时，双击程序目录里的“启动环球报阁.vbs”。</p>';
    document.body.appendChild(screen);
  } catch (error) {
    toast(`退出失败：${error.message}`, 'error');
  }
}

/* download */
function openDownload() {
  if (!S.article) {
    toast('先选择一篇文章。', 'warn');
    return;
  }
  updateDownloadLink();
  showModal('downloadModal');
}

function updateDownloadLink() {
  const link = $('#downloadArticleBtn');
  if (!S.article) {
    link.removeAttribute('href');
    return;
  }
  const mode = $('#downloadMode').value;
  const format = $('#downloadFormat').value;
  const params = new URLSearchParams({ mode, format, provider: currentProvider(), lang: currentLang() });
  link.href = `/api/articles/${S.article.id}/download?${params.toString()}`;
  const note = $('#downloadArticleNote');
  if (mode !== 'original' && (!S.translation || S.translation.note)) {
    note.textContent = '这篇文章还没有可用的译文，下载时会保留原文。';
  } else if (mode !== 'original' && (S.translation.failed || []).length) {
    note.textContent = '译文有少量段落失败，下载内容会对失败段落保留原文。';
  } else if (mode !== 'original') {
    note.textContent = '译文已就绪，下载将包含中文译文。';
  } else {
    note.textContent = '按原文下载，不包含译文。';
  }
}

function parseFilename(contentDisposition) {
  if (!contentDisposition) return '';
  const utf8 = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) {
    try { return decodeURIComponent(utf8[1]); } catch { return utf8[1]; }
  }
  const plain = contentDisposition.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : '';
}

async function exportZip() {
  const button = $('#exportZipBtn');
  button.disabled = true;
  button.textContent = '正在打包…';
  try {
    const response = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: $('#exportMode').value,
        filter: S.filter,
        provider: currentProvider(),
        lang: currentLang(),
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error((data && data.error) || `导出失败（HTTP ${response.status}）`);
    }
    const blob = await response.blob();
    const filename = parseFilename(response.headers.get('content-disposition')) || '环球报阁-导出.zip';
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('导出完成。', 'success');
  } catch (error) {
    toast(`导出失败：${error.message}`, 'error', 6000);
  } finally {
    button.disabled = false;
    button.textContent = '导出 ZIP（最多 200 篇）';
  }
}

/* events */
const lightbox = { scale: 1, fit: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0, originX: 0, originY: 0, moved: false };

function applyLightbox() {
  const img = $('#lightboxImg');
  img.style.transform = `translate(calc(-50% + ${lightbox.x}px), calc(-50% + ${lightbox.y}px)) scale(${lightbox.scale})`;
  $('#lightboxScale').textContent = `${Math.round(lightbox.scale * 100)}%`;
}

function openLightbox(src, alt = '') {
  const box = $('#lightbox');
  const img = $('#lightboxImg');
  const stage = $('#lightboxStage');
  if (!box || !img || !src) return;
  img.src = src;
  img.alt = alt;
  box.classList.remove('hidden');
  document.body.classList.add('lightbox-open');
  const fit = () => {
    const width = stage.clientWidth || window.innerWidth;
    const height = stage.clientHeight || window.innerHeight;
    lightbox.fit = Math.min(width / (img.naturalWidth || width), height / (img.naturalHeight || height), 1);
    lightbox.scale = lightbox.fit;
    lightbox.x = 0;
    lightbox.y = 0;
    applyLightbox();
  };
  if (img.complete && img.naturalWidth) fit();
  else img.onload = fit;
}

function closeLightbox() {
  const box = $('#lightbox');
  if (!box) return;
  box.classList.add('hidden');
  document.body.classList.remove('lightbox-open');
  $('#lightboxImg').removeAttribute('src');
}

function zoomLightbox(factor) {
  const next = Math.min(6, Math.max(0.2, lightbox.scale * factor));
  lightbox.scale = next;
  applyLightbox();
}

function bindMediaEvents() {
  document.addEventListener('click', (event) => {
    const ocrButton = event.target.closest('.ocr-btn');
    if (ocrButton) {
      runOcr(ocrButton);
      return;
    }
    const captionButton = event.target.closest('.caption-btn');
    if (captionButton) {
      runCaptions(captionButton);
      return;
    }
    const pasteButton = event.target.closest('.caption-paste-btn');
    if (pasteButton) {
      openCaptionPaste(pasteButton);
      return;
    }
    const pasteRun = event.target.closest('.paste-run');
    if (pasteRun) {
      runPasteCaptions(pasteRun);
      return;
    }
    const image = event.target.closest('#articleBody figure.article-figure img');
    if (image) {
      openLightbox(image.src, image.alt || '');
      return;
    }
    const zoom = event.target.closest('[data-zoom]');
    if (zoom) {
      if (zoom.dataset.zoom === 'in') zoomLightbox(1.25);
      else if (zoom.dataset.zoom === 'out') zoomLightbox(0.8);
      else {
        lightbox.scale = lightbox.fit;
        lightbox.x = 0;
        lightbox.y = 0;
        applyLightbox();
      }
      return;
    }
    if (event.target.closest('[data-close-lightbox]')) closeLightbox();
  });

  const stage = $('#lightboxStage');
  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomLightbox(event.deltaY < 0 ? 1.12 : 0.9);
  }, { passive: false });

  stage.addEventListener('dblclick', () => {
    lightbox.scale = lightbox.scale > lightbox.fit + 0.01 ? lightbox.fit : Math.min(6, lightbox.fit * 2);
    lightbox.x = 0;
    lightbox.y = 0;
    applyLightbox();
  });

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    lightbox.dragging = true;
    lightbox.moved = false;
    lightbox.startX = event.clientX;
    lightbox.startY = event.clientY;
    lightbox.originX = lightbox.x;
    lightbox.originY = lightbox.y;
    stage.classList.add('dragging');
    stage.setPointerCapture(event.pointerId);
  });

  stage.addEventListener('pointermove', (event) => {
    if (!lightbox.dragging) return;
    lightbox.x = lightbox.originX + event.clientX - lightbox.startX;
    lightbox.y = lightbox.originY + event.clientY - lightbox.startY;
    if (Math.abs(event.clientX - lightbox.startX) + Math.abs(event.clientY - lightbox.startY) > 4) lightbox.moved = true;
    applyLightbox();
  });

  const endDrag = (event) => {
    if (!lightbox.dragging) return;
    lightbox.dragging = false;
    stage.classList.remove('dragging');
    try { stage.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
}

function bindEvents() {
  $('#menuBtn').addEventListener('click', () => {
    if (document.body.classList.contains('sidebar-open')) closeDrawer();
    else openDrawer();
  });
  $('#drawerBackdrop').addEventListener('click', closeDrawer);
  $('#syncBtn').addEventListener('click', startSync);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#themeBtn').addEventListener('click', () => applyTheme(S.theme === 'dark' ? 'light' : 'dark'));
  $('#manageSourcesBtn').addEventListener('click', () => openSources('subscribed'));
  $('#clearFilterBtn').addEventListener('click', clearFilters);

  const search = $('#searchInput');
  const runSearch = debounce(() => {
    S.filter.q = search.value.trim();
    loadArticles({ reset: true });
  }, 350);
  search.addEventListener('input', runSearch);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      search.value = '';
      S.filter.q = '';
      loadArticles({ reset: true });
      search.blur();
    }
  });

  $('#viewNav').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (button) setView(button.dataset.view);
  });
  $('#viewSeg').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (button) setView(button.dataset.view);
  });
  $('#catList').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-category]');
    if (button) setCategory(button.dataset.category);
  });
  $('#sourceList').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-source]');
    if (button) setSource(button.dataset.source);
  });
  $('#loadMoreBtn').addEventListener('click', () => loadArticles({}));

  $('#articleList').addEventListener('click', (event) => {
    const star = event.target.closest('[data-star]');
    if (star) {
      event.stopPropagation();
      toggleStar(star.dataset.star);
      return;
    }
    const emptyAction = event.target.closest('[data-empty-action]');
    if (emptyAction) {
      openSources('subscribed');
      return;
    }
    const card = event.target.closest('.card[data-id]');
    if (card) openArticle(card.dataset.id);
  });

  $('#backBtn').addEventListener('click', closeReader);
  $('#fulltextBtn').addEventListener('click', fetchFulltext);
  $('#translateBtn').addEventListener('click', () => startTranslation(Boolean(S.translation)));
  $('#starBtn').addEventListener('click', () => S.article && toggleStar(S.article.id));
  $('#downloadBtn').addEventListener('click', openDownload);
  $('#langSwitch').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]');
    if (!button) return;
    if (button.dataset.mode !== 'original' && !S.translation) {
      toast('还没有可用的译文。', 'warn');
      return;
    }
    S.translationMode = button.dataset.mode;
    renderArticle();
  });
  $('#translateBanner').addEventListener('click', (event) => {
    if (event.target.closest('[data-retry-translate]')) startTranslation(false);
    if (event.target.closest('[data-cancel-translate]')) cancelTranslation();
  });

  $$('[data-close]').forEach((button) => {
    button.addEventListener('click', () => closeModal(button.dataset.close));
  });
  $$('.modal-layer').forEach((layer) => {
    layer.addEventListener('click', (event) => {
      if (event.target === layer) closeModal(layer.id);
    });
  });

  $('#sourcesTabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-sources-tab]');
    if (!button) return;
    S.sourcesTab = button.dataset.sourcesTab;
    renderSourcesTabs();
    renderSources();
  });
  $('#sourceFilterInput').addEventListener('input', (event) => {
    S.sourceQuery = event.target.value;
    renderSources();
  });
  $('#sourceCategoryFilter').addEventListener('change', (event) => {
    S.sourceCategory = event.target.value;
    renderSources();
  });
  $('#sourceRegionFilter').addEventListener('change', (event) => {
    S.sourceRegion = event.target.value;
    renderSources();
  });
  $('#sourcesBody').addEventListener('click', (event) => {
    const add = event.target.closest('[data-add-catalog]');
    if (add) { addCatalogSource(add.dataset.addCatalog); return; }
    const sync = event.target.closest('[data-sync-source]');
    if (sync) { syncSource(sync.dataset.syncSource); return; }
    const remove = event.target.closest('[data-delete-source]');
    if (remove) deleteSource(remove.dataset.deleteSource);
  });
  $('#sourcesBody').addEventListener('change', (event) => {
    const toggle = event.target.closest('[data-toggle-source]');
    if (toggle) toggleSource(toggle.dataset.toggleSource, toggle.checked);
  });
  $('#customFeedAdd').addEventListener('click', addCustomFeed);
  $('#customFeedUrl').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addCustomFeed();
  });
  $('#opmlImportBtn').addEventListener('click', () => $('#opmlFile').click());
  $('#opmlFile').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    importOpmlFile(file);
    event.target.value = '';
  });
  $('#opmlExportBtn').addEventListener('click', () => { window.location.href = '/api/opml'; });

  $('#settingsForm').addEventListener('submit', submitSettings);
  $('#setProvider').addEventListener('change', updateProviderFields);
  $('#testTranslateBtn').addEventListener('click', testTranslation);
  $('#shutdownBtn').addEventListener('click', shutdownApp);
  $$('[data-openai-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const preset = OPENAI_PRESETS[button.dataset.openaiPreset];
      if (!preset) return;
      $('#setOpenaiBase').value = preset.base;
      $('#setOpenaiModel').value = preset.model;
    });
  });

  $('#downloadMode').addEventListener('change', updateDownloadLink);
  $('#downloadFormat').addEventListener('change', updateDownloadLink);
  $('#exportZipBtn').addEventListener('click', exportZip);

  document.addEventListener('keydown', (event) => {
    const tag = String((event.target && event.target.tagName) || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (event.target && event.target.isContentEditable);
    if (event.key === 'Escape') {
      if (!$('#lightbox').classList.contains('hidden')) {
        closeLightbox();
        return;
      }
      if ($('.modal-layer:not(.hidden)')) {
        closeAllModals();
        return;
      }
      if (document.body.classList.contains('sidebar-open')) closeDrawer();
      else if (document.body.classList.contains('reader-open')) closeReader();
      return;
    }
    if (typing) return;
    if (event.key === '/') {
      event.preventDefault();
      $('#searchInput').focus();
    } else if (event.key === 'j') {
      navigateArticle(1);
    } else if (event.key === 'k') {
      navigateArticle(-1);
    } else if (event.key === 's' && S.article) {
      toggleStar(S.article.id);
    } else if (event.key === 't' && S.article) {
      startTranslation(Boolean(S.translation));
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 1180) closeDrawer();
    if (window.innerWidth > 880) document.body.classList.remove('reader-open');
  });
}

async function init() {
  initTheme();
  bindEvents();
  bindMediaEvents();
  showListSkeleton();
  try {
    await refreshState();
  } catch (error) {
    setStrip('无法连接本地服务', 'error');
    $('#articleList').innerHTML = `<div class="empty-list"><div class="empty-seal">阁</div><h3>本地服务没有响应</h3><p>${esc(error.message)}</p><p>请确认启动窗口仍在运行，然后刷新页面。</p></div>`;
    $('#listSub').textContent = '连接失败';
    toast(`无法连接本地服务：${error.message}`, 'error', 8000);
    return;
  }
  await loadArticles({ reset: true });
  setTimeout(detectActiveSync, 1600);
  setInterval(detectActiveSync, 8000);
  if (S.state && S.state.activeSyncJobId) detectActiveSync();
  setTimeout(() => {
    if (S.article) kickAutoTranslate();
  }, 600);
}

document.addEventListener('DOMContentLoaded', init);

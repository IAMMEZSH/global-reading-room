'use strict';

const { httpRequest } = require('./http');
const { decodeBuffer, normalizeUrl, stripMarkup, truncate, guessLanguage, sleep } = require('./util');
const { htmlToBlocks, htmlToText } = require('./extract');
const { collectVideos, videoFromEnclosure, normalizeVideo } = require('./media');
const {
  parseXml, documentRoot, children, first, findAll, findDeep, textContent, cleanText, attr,
} = require('./xml');

const FEED_HEADERS = {
  'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
};

function parseDate(value, fallbackMs) {
  const text = String(value || '').trim();
  if (!text) return new Date(fallbackMs).toISOString();
  if (/^\d{10}$/.test(text)) return new Date(Number(text) * 1000).toISOString();
  if (/^\d{13}$/.test(text)) return new Date(Number(text)).toISOString();
  let timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    const normalized = text.replace(/[年/]/g, '-').replace(/月/g, '-').replace(/日/g, ' ');
    timestamp = Date.parse(normalized);
  }
  if (!Number.isFinite(timestamp)) return new Date(fallbackMs).toISOString();
  return new Date(timestamp).toISOString();
}

function unwrapAggregatorLink(link) {
  try {
    const url = new URL(link);
    if (/(^|\.)bing\.com$/i.test(url.hostname) && /\/news\/apiclick\.aspx$/i.test(url.pathname)) {
      const target = url.searchParams.get('url');
      if (target && /^https?:\/\//i.test(target)) return target;
    }
  } catch { /* keep original */ }
  return link;
}

function articleLink(item, feedUrl, siteUrl) {
  const links = children(item, 'link');
  for (const node of links) {
    const rel = attr(node, 'rel');
    if (rel && rel !== 'alternate') continue;
    const href = attr(node, 'href') || cleanText(node);
    const resolved = normalizeUrl(href, feedUrl);
    if (resolved) return unwrapAggregatorLink(resolved);
  }
  const guidNode = first(item, 'guid') || first(item, 'id');
  if (guidNode) {
    const isPermaLink = attr(guidNode, 'isPermaLink');
    const value = cleanText(guidNode);
    if (isPermaLink !== 'false' || /^https?:\/\//i.test(value)) {
      const resolved = normalizeUrl(value, feedUrl);
      if (resolved) return unwrapAggregatorLink(resolved);
    }
  }
  return '';
}

function itemContent(item) {
  const names = ['encoded', 'content', 'description', 'summary', 'abstract'];
  let best = '';
  let bestName = '';
  for (const node of item.children || []) {
    const local = node.local.toLowerCase();
    if (!names.includes(local)) continue;
    const value = textContent(node);
    if (!value) continue;
    if (value.length > best.length) {
      best = value;
      bestName = local;
    }
  }
  return { html: best, name: bestName };
}

function itemImage(item, contentHtml, baseUrl) {
  const enclosures = children(item, 'enclosure');
  for (const node of enclosures) {
    const url = normalizeUrl(attr(node, 'url') || attr(node, 'href'), baseUrl);
    const type = attr(node, 'type') || '';
    if (url && (!type || /^image\//i.test(type))) return url;
  }
  const mediaAll = findAll(item, 'thumbnail').concat(findAll(item, 'content'));
  for (const node of mediaAll) {
    const url = normalizeUrl(attr(node, 'url'), baseUrl);
    if (url && /\.(jpg|jpeg|png|webp|avif|gif)(\?|$)/i.test(url)) return url;
  }
  const match = String(contentHtml || '').match(/<img\b[^>]+src\s*=\s*["']([^"']+)["']/i);
  if (match) return normalizeUrl(match[1], baseUrl);
  return '';
}

function normalizeFeedLanguage(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return '';
  if (text.startsWith('zh') || text === 'cn' || text === 'chinese') return 'zh';
  if (text.startsWith('en')) return 'en';
  if (text.startsWith('ja')) return 'ja';
  if (text.startsWith('ko')) return 'ko';
  return text;
}

function parseFeed(xmlText, feedUrl) {
  const doc = parseXml(xmlText);
  const root = documentRoot(doc);
  if (!root) throw new Error('订阅源内容为空');
  const rootLocal = root.local.toLowerCase();
  let type = 'rss';
  let channel = null;
  let entries = [];
  let feedTitle = '';
  let feedDescription = '';
  let siteUrl = '';
  let declaredLanguage = '';

  if (rootLocal === 'rss') {
    channel = first(root, 'channel');
    if (!channel) throw new Error('RSS 缺少 channel 节点');
    entries = children(channel, 'item');
    feedTitle = cleanText(first(channel, 'title'));
    feedDescription = cleanText(first(channel, 'description'));
    siteUrl = normalizeUrl(cleanText(first(channel, 'link')), feedUrl);
    declaredLanguage = cleanText(first(channel, 'language'));
  } else if (rootLocal === 'feed') {
    type = 'atom';
    entries = children(root, 'entry');
    feedTitle = cleanText(first(root, 'title'));
    feedDescription = cleanText(first(root, 'subtitle'));
    for (const link of children(root, 'link')) {
      const rel = attr(link, 'rel');
      if (!rel || rel === 'alternate') {
        siteUrl = normalizeUrl(attr(link, 'href'), feedUrl);
        if (siteUrl) break;
      }
    }
    declaredLanguage = attr(root, 'xml:lang') || attr(root, 'lang') || cleanText(first(root, 'language'));
  } else if (rootLocal === 'rdf') {
    type = 'rdf';
    channel = first(root, 'channel');
    entries = findAll(root, 'item');
    feedTitle = channel ? cleanText(first(channel, 'title')) : '';
    feedDescription = channel ? cleanText(first(channel, 'description')) : '';
    siteUrl = normalizeUrl(channel ? cleanText(first(channel, 'link')) : '', feedUrl);
    declaredLanguage = channel ? cleanText(first(channel, 'language')) : '';
  } else {
    throw new Error('不是有效的 RSS / Atom 订阅源');
  }

  if (!feedTitle) {
    try { feedTitle = new URL(feedUrl).hostname; } catch { feedTitle = '未命名订阅源'; }
  }
  if (!siteUrl) {
    try { siteUrl = new URL(feedUrl).origin; } catch { siteUrl = ''; }
  }
  const feedLanguage = normalizeFeedLanguage(declaredLanguage);

  const items = [];
  const seen = new Set();
  entries.forEach((entry, index) => {
    const title = stripMarkup(cleanText(first(entry, 'title'))).slice(0, 300);
    if (!title) return;
    const link = articleLink(entry, feedUrl, siteUrl);
    const guid = cleanText(first(entry, 'guid')) || cleanText(first(entry, 'id')) || '';
    const key = link || `${guid || title}|${index}`;
    if (seen.has(key)) return;
    seen.add(key);

    const { html } = itemContent(entry);
    const summaryText = htmlToText(html);
    const summary = truncate(summaryText, 500);
    const fallbackMs = Date.now() - index * 60000;
    const dateNode = first(entry, 'pubDate') || first(entry, 'published') || first(entry, 'updated')
      || first(entry, 'created') || findDeep(entry, 'date');
    const publishedAt = parseDate(dateNode ? cleanText(dateNode) : '', fallbackMs);

    let author = '';
    const authorNode = first(entry, 'author') || first(entry, 'creator');
    if (authorNode) {
      const nameNode = findDeep(authorNode, 'name');
      author = cleanText(nameNode || authorNode);
      author = author.replace(/\S+@\S+\.\S+/g, '').replace(/[()<>]/g, '').trim().slice(0, 80);
    }

    const categories = [];
    for (const category of children(entry, 'category')) {
      const value = attr(category, 'term') || cleanText(category);
      if (value && !categories.includes(value)) categories.push(value.slice(0, 40));
      if (categories.length >= 5) break;
    }

    const language = feedLanguage || guessLanguage(`${title} ${summary}`) || '';
    let blocks = null;
    if (summaryText.length >= 500) {
      const contentBlocks = htmlToBlocks(html, link || siteUrl || feedUrl, {
        filters: true, title, maxBlocks: 220, maxChars: 30000, maxImages: 8,
      });
      const blockText = contentBlocks.filter((block) => block.t !== 'img').map((block) => block.text).join('');
      if (blockText.length >= 450) blocks = contentBlocks;
    }

    const baseUrl = link || siteUrl || feedUrl;
    const videos = collectVideos(html, baseUrl);
    for (const node of children(entry, 'enclosure')) {
      if (videos.length >= 3) break;
      const video = videoFromEnclosure(attr(node, 'url') || attr(node, 'href'), attr(node, 'type'), baseUrl);
      if (video && !videos.some((item) => item.url === video.url)) {
        videos.push({
          type: video.type, provider: video.provider, url: video.url,
          poster: video.poster || '', tracks: [], title: '',
        });
      }
    }
    if (videos.length < 3) {
      for (const node of findAll(entry, 'content').concat(findAll(entry, 'group'))) {
        if (videos.length >= 3) break;
        const kind = String(attr(node, 'type') || attr(node, 'medium') || '').toLowerCase();
        if (kind && !kind.startsWith('video') && kind !== 'video') continue;
        const video = normalizeVideo(attr(node, 'url'), baseUrl);
        if (video && !videos.some((item) => item.url === video.url)) {
          videos.push({
            type: video.type, provider: video.provider, url: video.url,
            poster: video.poster || '', tracks: [], title: '',
          });
        }
      }
    }
    if (!videos.length) {
      const linkVideo = normalizeVideo(link, baseUrl);
      if (linkVideo) {
        videos.push({
          type: linkVideo.type, provider: linkVideo.provider, url: linkVideo.url,
          poster: linkVideo.poster || '', tracks: [], title: title.slice(0, 120),
        });
      }
    }
    const image = itemImage(entry, html, baseUrl) || (videos[0] && videos[0].poster) || '';

    items.push({
      title,
      link,
      guid,
      author,
      publishedAt,
      summary: summary || truncate(summaryText, 240),
      blocks,
      image,
      videos: videos.slice(0, 3),
      categories,
      language,
    });
  });

  if (!items.length) throw new Error('订阅源中没有可读条目（可能已停止更新）');
  return {
    type,
    title: stripMarkup(feedTitle).slice(0, 120) || '未命名订阅源',
    siteUrl,
    description: truncate(stripMarkup(feedDescription), 300),
    language: feedLanguage,
    items,
    fetchedAt: new Date().toISOString(),
  };
}

function looksLikeHtml(text) {
  const head = String(text || '').slice(0, 1000).toLowerCase();
  return /<!doctype html|<html[\s>]/.test(head);
}

function findFeedLinks(html, baseUrl) {
  const links = [];
  const linkRe = /<link\b([^>]*)>/gi;
  let match;
  while ((match = linkRe.exec(html))) {
    const attrs = match[1] || '';
    const relMatch = attrs.match(/rel\s*=\s*["']([^"']+)["']/i);
    const typeMatch = attrs.match(/type\s*=\s*["']([^"']+)["']/i);
    const hrefMatch = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const rel = (relMatch && relMatch[1]) || '';
    const kind = (typeMatch && typeMatch[1]) || '';
    if (!/alternate|feed|rss/i.test(rel) && !/rss|atom|xml/i.test(kind)) continue;
    if (!/rss|atom|xml/i.test(kind) && !/rss|atom/i.test(rel)) continue;
    const url = normalizeUrl(hrefMatch[1], baseUrl);
    if (url && !links.includes(url)) links.push(url);
  }
  return links.slice(0, 5);
}

async function fetchFeedDocument(url, options = {}) {
  const res = await httpRequest(url, {
    headers: FEED_HEADERS,
    timeout: options.timeout || 20000,
    maxBytes: 12 * 1024 * 1024,
    proxy: options.proxy,
  });
  if (res.status >= 400) {
    const error = new Error(`订阅源返回 HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  const text = decodeBuffer(res.body, res.headers['content-type']);
  return { text, finalUrl: res.url || url, contentType: res.headers['content-type'] || '' };
}

async function loadFeed(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const doc = await fetchFeedDocument(url, options);
      if (looksLikeHtml(doc.text)) {
        const links = findFeedLinks(doc.text, doc.finalUrl);
        if (!links.length) throw new Error('该网页没有提供公开的 RSS / Atom 订阅');
        let innerError;
        for (const link of links) {
          try {
            const inner = await fetchFeedDocument(link, options);
            const feed = parseFeed(inner.text, inner.finalUrl);
            return { feed, feedUrl: inner.finalUrl, discovered: true };
          } catch (error) {
            innerError = error;
          }
        }
        throw innerError || new Error('未能读取网页中的订阅源');
      }
      const feed = parseFeed(doc.text, doc.finalUrl);
      return { feed, feedUrl: doc.finalUrl, discovered: false };
    } catch (error) {
      lastError = error;
      const retryable = error.code || error.status >= 500;
      if (attempt === 0 && retryable) {
        await sleep(700);
        continue;
      }
      break;
    }
  }
  throw lastError;
}

async function discoverAndLoad(url, options = {}) {
  const normalized = normalizeUrl(url);
  if (!normalized) throw new Error('请输入有效的网址');
  let lastError;
  try {
    return await loadFeed(normalized, options);
  } catch (error) {
    lastError = error;
  }
  let origin;
  try { origin = new URL(normalized).origin; } catch { throw lastError; }
  const candidates = ['/feed', '/rss', '/atom.xml', '/index.xml']
    .map((path) => origin + path)
    .filter((candidate) => candidate !== normalized);
  for (const candidate of candidates.slice(0, 3)) {
    try {
      return await loadFeed(candidate, options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

module.exports = {
  parseFeed,
  loadFeed,
  discoverAndLoad,
  findFeedLinks,
};

'use strict';

const { decodeEntities, normalizeUrl, stripMarkup } = require('./util');
const { collectVideos } = require('./media');

const BOILERPLATE = /^(责任编辑|责编|编辑|校对|编译|来源|稿源|作者|摄影|视觉|监制|主编|原标题|本文来源|文章来源|免责声明|版权声明|特别声明|相关阅读|推荐阅读|延伸阅读|更多精彩|更多内容|点击|扫码|扫描|关注我们|下载|未经授权|禁止转载|广告|广而告之|举报|分享到|返回首页|上一篇|下一篇|热门推荐|猜你喜欢|网友评论|评论区|登录|注册|发布时间|更新时间|记者|通讯员)/;
const JUNK_ONLY = /^[\d\s.,;:!?+\-–—_()（）\[\]【】"'“”‘’、|/\\%#@&*=~<>…]+$/;

function stripDangerous(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed|select|textarea|button|input)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed|select|textarea|button|input)[^>]*\/?>/gi, ' ');
}

function cleanInline(text) {
  return decodeEntities(String(text || ''))
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isBoilerplate(text) {
  if (!text) return true;
  if (JUNK_ONLY.test(text)) return true;
  if (text.length < 8) return true;
  if (text.length < 90 && BOILERPLATE.test(text)) return true;
  if (text.length < 60 && /(责任编辑|校对|编辑：|来源：|原标题：)/.test(text)) return true;
  if (/^(window\.|var\s|function\s|document\.|if\s*\()/.test(text)) return true;
  if (/^(https?:\/\/|www\.)\S+$/.test(text)) return true;
  return false;
}

function parseTagAttrs(source) {
  const attrs = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/g;
  let match;
  while ((match = re.exec(source || ''))) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] != null ? match[2] : match[3] != null ? match[3] : match[4] || '');
  }
  return attrs;
}

function pickImage(tagSource, baseUrl) {
  const attrs = parseTagAttrs(tagSource);
  const raw = attrs['data-src'] || attrs['data-original'] || attrs['data-lazy-src'] || attrs.src || '';
  const src = normalizeUrl(raw, baseUrl);
  if (!src) return null;
  if (/1x1|pixel|spacer|blank\.(gif|png)|avatar|logo|icon|emoji|qrcode|qrcode|share|tracking/i.test(src)) return null;
  const width = parseInt(attrs.width || '', 10);
  const height = parseInt(attrs.height || '', 10);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width < 200 && height < 200) return null;
  return { t: 'img', src, alt: cleanInline(attrs.alt || '') };
}

function blockTypeFor(tag) {
  if (tag === 'h1' || tag === 'h2') return 'h2';
  if (tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'h3';
  if (tag === 'li') return 'li';
  if (tag === 'blockquote' || tag === 'q') return 'quote';
  if (tag === 'pre') return 'p';
  return 'p';
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote', 'pre',
  'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'dl', 'dt', 'dd',
]);

const TOKEN_RE = /<\/?([A-Za-z][\w:-]*)((?:\s+[^<>]*?)?)\/?>|[^<]+/g;

function htmlToBlocks(html, baseUrl, options = {}) {
  const filters = options.filters !== false;
  const title = cleanInline(options.title || '');
  const skipTitles = new Set([title, ...(options.titles || []).map((value) => cleanInline(value || ''))].filter(Boolean));
  const maxBlocks = options.maxBlocks || 400;
  const maxChars = options.maxChars || 100000;
  const maxImages = options.maxImages || 12;
  let source = stripDangerous(html);
  if (!source) return [];

  if (!/<[A-Za-z][^>]*>/.test(source)) {
    const plain = decodeEntities(source)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .trim();
    if (!plain) return [];
    return plain.split(/\n+/).map((line) => line.trim())
      .filter((line) => line && (!filters || !isBoilerplate(line)))
      .slice(0, maxBlocks)
      .map((line) => ({ t: 'p', text: line }));
  }

  const blocks = [];
  let currentText = '';
  let currentType = 'p';
  let images = 0;
  let totalChars = 0;
  let lastText = '';
  let titleSkipped = false;

  function flush() {
    const text = cleanInline(currentText);
    currentText = '';
    if (!text) return;
    if (filters && isBoilerplate(text)) return;
    if (text === lastText) return;
    if (!titleSkipped && skipTitles.has(text)) {
      titleSkipped = true;
      return;
    }
    if (totalChars + text.length > maxChars) return;
    lastText = text;
    totalChars += text.length;
    blocks.push({ t: currentType, text });
  }

  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(source))) {
    if (blocks.length >= maxBlocks) break;
    if (!match[1]) {
      currentText += ' ' + match[0];
      continue;
    }
    const rawTag = match[0];
    const tag = match[1].toLowerCase();
    const closing = rawTag.startsWith('</');
    if (tag === 'img') {
      if (closing || images >= maxImages) continue;
      flush();
      const image = pickImage(rawTag, baseUrl);
      if (image) { blocks.push(image); images++; }
      continue;
    }
    if (tag === 'br' || tag === 'hr') {
      flush();
      continue;
    }
    if (!BLOCK_TAGS.has(tag)) continue;
    if (closing) {
      flush();
      currentType = 'p';
    } else {
      flush();
      currentType = blockTypeFor(tag);
    }
  }
  flush();
  return blocks;
}

function blocksToText(blocks) {
  return (blocks || []).filter((block) => block.t !== 'img' && block.text).map((block) => block.text).join('\n\n');
}

function htmlToText(html) {
  const text = stripDangerous(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ');
  return decodeEntities(text).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function candidateMeta(html) {
  const ogTitle = html.match(/<meta[^>]+property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:title["']/i);
  if (ogTitle) return cleanInline(ogTitle[1]);
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const value = cleanInline(stripMarkup(h1[1]));
    if (value && value.length > 3) return value;
  }
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag) {
    const value = cleanInline(stripMarkup(titleTag[1]));
    if (value) return value.split(/\s+[-_|｜]\s+/)[0].trim();
  }
  return '';
}

function balancedElement(html, startIndex) {
  const openEnd = html.indexOf('>', startIndex);
  if (openEnd < 0) return '';
  if (/\/>$/.test(html.slice(startIndex, openEnd + 1))) return html.slice(startIndex, openEnd + 1);
  const tag = html.slice(startIndex + 1, openEnd).match(/^[A-Za-z][\w:-]*/);
  if (!tag) return '';
  const name = tag[0];
  const re = new RegExp(`<\\/?${name}\\b[^>]*>`, 'gi');
  re.lastIndex = openEnd + 1;
  let depth = 1;
  let match;
  while ((match = re.exec(html))) {
    if (/^<\//.test(match[0])) depth--;
    else if (!/\/>$/.test(match[0])) depth++;
    if (depth === 0) return html.slice(startIndex, re.lastIndex);
  }
  return html.slice(startIndex);
}

function collectCandidates(html) {
  const list = [];
  const articleRe = /<article\b[^>]*>[\s\S]*?<\/article>/gi;
  let match;
  let count = 0;
  while ((match = articleRe.exec(html)) && count < 3) {
    list.push({ html: match[0], bonus: 550, label: 'article' });
    count++;
  }
  const mainRe = /<main\b[^>]*>[\s\S]*?<\/main>/gi;
  count = 0;
  while ((match = mainRe.exec(html)) && count < 2) {
    list.push({ html: match[0], bonus: 380, label: 'main' });
    count++;
  }
  const divRe = /<div\b([^>]*)>/gi;
  count = 0;
  while ((match = divRe.exec(html)) && count < 12) {
    const attrs = match[1] || '';
    if (!/(class|id)\s*=/i.test(attrs)) continue;
    if (!/(article|content|post|story|detail|entry|main|body|text|rich_media|news_txt)/i.test(attrs)) continue;
    if (/(comment|sidebar|footer|header|nav|menu|related|recommend|hot|rank|share|advert|banner|login|subscribe|toolbar|breadcrumb|qrcode|download)/i.test(attrs)) continue;
    const fragment = balancedElement(html, match.index);
    if (fragment && fragment.length > 300) {
      list.push({ html: fragment, bonus: 260, label: 'div' });
      count++;
    }
  }
  list.push({ html, bonus: 0, label: 'body' });
  return list;
}

function linkPenalty(html) {
  let total = 0;
  const re = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) total += stripMarkup(match[1]).length;
  return total;
}

function extractArticle(html, pageUrl, options = {}) {
  const videos = collectVideos(html, pageUrl);
  const source = stripDangerous(html);
  if (!source || source.length < 80) throw new Error('页面内容为空');
  const title = candidateMeta(source);
  const rssTitle = cleanInline(options.rssTitle || '');
  const candidates = collectCandidates(source);
  let best = null;
  for (const candidate of candidates) {
    const blocks = htmlToBlocks(candidate.html, pageUrl, { filters: true, title, titles: [rssTitle], maxBlocks: 350, maxChars: 90000 });
    const text = blocksToText(blocks);
    if (!text) continue;
    const penalty = Math.min(linkPenalty(candidate.html) * 1.4, text.length);
    const headings = blocks.filter((block) => block.t === 'h2' || block.t === 'h3').length;
    const score = text.length - penalty + candidate.bonus + headings * 25;
    if (!best || score > best.score) best = { blocks, text, score, label: candidate.label, title };
  }
  if (!best || best.text.length < 200) {
    const fallback = htmlToText(source);
    if (fallback.length < 120) throw new Error('未能识别正文内容（页面可能需要登录或由脚本渲染）');
    const paragraphs = fallback.split(/\n+/).map((line) => cleanInline(line))
      .filter((line) => line.length >= 20 && !isBoilerplate(line))
      .slice(0, 250);
    const blocks = paragraphs.length
      ? paragraphs.map((text) => ({ t: 'p', text }))
      : [{ t: 'p', text: fallback.slice(0, 50000) }];
    return { title, blocks, text: blocksToText(blocks), videos };
  }
  return { title: best.title, blocks: best.blocks, text: best.text, videos };
}

module.exports = {
  htmlToBlocks,
  htmlToText,
  blocksToText,
  extractArticle,
  stripDangerous,
  cleanInline,
};

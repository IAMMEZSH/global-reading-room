'use strict';

const { escapeHtml, sanitizeFilename, decodeEntities } = require('./util');
const { createZip } = require('./zip');
const { parseXml, documentRoot, children, attr, cleanText } = require('./xml');

const MODE_LABELS = { original: '原文', translation: '译文', bilingual: '双语' };

function pad(value) {
  return String(value).padStart(2, '0');
}

function dateText(value, withTime = true) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime ? `${base} ${pad(date.getHours())}:${pad(date.getMinutes())}` : base;
}

function metaLine(article) {
  const parts = [];
  if (article.source && article.source.title) parts.push(`来源：${article.source.title}`);
  if (article.author) parts.push(`作者：${article.author}`);
  if (article.publishedAt) parts.push(`时间：${dateText(article.publishedAt)}`);
  return parts.join(' · ');
}

function blockWithMode(block, mode) {
  if (!block || block.t === 'img') return block;
  const source = String(block.text || '');
  const translation = String(block.translation || '');
  if (mode === 'translation') return { ...block, text: translation || source, translated: Boolean(translation) };
  return { ...block, text: source, translation };
}

function markdownBlock(block, mode) {
  if (block.t === 'img') {
    const alt = String(block.alt || '图片').replace(/[\[\]]/g, '');
    return block.src ? `![${alt}](${block.src})` : '';
  }
  const text = String(block.text || '').trim();
  if (!text) return '';
  const translation = String(block.translation || '').trim();
  if (mode === 'translation') {
    if (block.t === 'h2') return `## ${text}`;
    if (block.t === 'h3') return `### ${text}`;
    if (block.t === 'li') return `- ${text}`;
    if (block.t === 'quote') return text.split('\n').map((line) => `> ${line}`).join('\n');
    return text;
  }
  if (mode === 'bilingual' && translation) {
    if (block.t === 'h2') return `## ${translation}\n\n> 原文：${text}`;
    if (block.t === 'h3') return `### ${translation}\n\n> 原文：${text}`;
    if (block.t === 'li') return `- ${text}\n  - 译：${translation}`;
    const quoted = translation.split('\n').map((line) => `> ${line}`).join('\n');
    if (block.t === 'quote') return `${text.split('\n').map((line) => `> ${line}`).join('\n')}\n${quoted.replace(/^> /, '> 译：')}`;
    return `${text}\n\n${quoted.replace(/^> /, '> 译：')}`;
  }
  if (block.t === 'h2') return `## ${text}`;
  if (block.t === 'h3') return `### ${text}`;
  if (block.t === 'li') return `- ${text}`;
  if (block.t === 'quote') return text.split('\n').map((line) => `> ${line}`).join('\n');
  return text;
}

function articleToMarkdown(article, view, mode = 'original') {
  const translatedTitle = view && view.title && view.title !== article.title ? view.title : '';
  const title = (mode === 'translation' || mode === 'bilingual') && translatedTitle ? translatedTitle : article.title;
  const lines = [`# ${title}`, ''];
  if (mode === 'bilingual' && translatedTitle) {
    lines.push(`> 原标题：${article.title}`, '');
  }
  const meta = metaLine(article);
  if (meta) lines.push(`> ${meta}`, '');
  if (article.link) lines.push(`> 原文链接：${article.link}`, '');
  if (view && view.provider) {
    lines.push(`> 翻译：${view.providerLabel || view.provider}${view.complete ? '' : '（部分段落翻译失败）'}`, '');
  }
  lines.push('---', '');
  const blocks = view && Array.isArray(view.blocks) ? view.blocks : (article.blocks || []);
  for (const block of blocks) {
    const prepared = blockWithMode(block, mode);
    const chunk = markdownBlock(prepared, mode);
    if (chunk) lines.push(chunk, '');
  }
  const videos = Array.isArray(article.videos) ? article.videos : [];
  if (videos.length) {
    lines.push('## 视频', '');
    for (const video of videos) {
      const label = [video.provider, video.title].filter(Boolean).join(' · ') || '视频';
      lines.push(`- [${label}](${video.url})`);
      if (video.poster) lines.push(`  - 封面：${video.poster}`);
    }
    lines.push('');
  }
  lines.push('---', '', '本文由「环球报阁」导出，仅供个人离线阅读。版权归原作者与媒体所有。', '');
  return lines.join('\n');
}

function htmlBlock(block, mode) {
  if (block.t === 'img') {
    if (!block.src) return '';
    return `<figure><img src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt || '')}" loading="lazy"></figure>`;
  }
  const source = String(block.text || '');
  const translation = String(block.translation || '');
  const useTranslated = mode === 'translation' && translation;
  const text = useTranslated ? translation : source;
  const tag = block.t === 'h2' ? 'h2' : block.t === 'h3' ? 'h3' : block.t === 'li' ? 'li' : block.t === 'quote' ? 'blockquote' : 'p';
  if (mode === 'bilingual' && translation && translation !== source) {
    if (tag === 'h2' || tag === 'h3') {
      return `<${tag}>${escapeHtml(translation)}</${tag}><p class="orig-heading">原文：${escapeHtml(source)}</p>`;
    }
    if (tag === 'li') {
      return `<li><span class="src">${escapeHtml(source)}</span><span class="dst">译：${escapeHtml(translation)}</span></li>`;
    }
    return `<div class="pair"><${tag} class="src">${escapeHtml(source)}</${tag}><${tag} class="dst">${escapeHtml(translation)}</${tag}></div>`;
  }
  if (tag === 'li') return `<li>${escapeHtml(text)}</li>`;
  return `<${tag}>${escapeHtml(text)}</${tag}>`;
}

function articleToHtml(article, view, mode = 'original') {
  const translatedTitle = view && view.title && view.title !== article.title ? view.title : '';
  const title = (mode === 'translation' || mode === 'bilingual') && translatedTitle ? translatedTitle : article.title;
  const originalTitleNote = mode === 'bilingual' && translatedTitle
    ? `<p class="orig-heading">原文标题：${escapeHtml(article.title)}</p>` : '';
  const body = [];
  let listOpen = false;
  const blocks = view && Array.isArray(view.blocks) ? view.blocks : (article.blocks || []);
  for (const block of blocks) {
    const isList = block.t === 'li';
    if (isList && !listOpen) { body.push('<ul>'); listOpen = true; }
    if (!isList && listOpen) { body.push('</ul>'); listOpen = false; }
    const html = htmlBlock(block, mode);
    if (html) body.push(html);
  }
  if (listOpen) body.push('</ul>');
  const videos = Array.isArray(article.videos) ? article.videos : [];
  const videoHtml = videos.length ? `<section class="videos">
<h2>视频</h2>
<ul>${videos.map((video) => {
    const label = [video.provider, video.title].filter(Boolean).join(' · ') || '视频';
    return `<li><a href="${escapeHtml(video.url)}" rel="noreferrer noopener">${escapeHtml(label)}</a>${video.poster ? `<br><img src="${escapeHtml(video.poster)}" alt="${escapeHtml(video.title || '视频封面')}" loading="lazy">` : ''}</li>`;
  }).join('')}</ul>
</section>` : '';
  const meta = metaLine(article);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #f4f0e8; color: #23211d; font-family: "Noto Serif SC", "Songti SC", SimSun, Georgia, serif; line-height: 1.9; }
.page { max-width: 780px; margin: 0 auto; padding: 48px 24px 80px; }
.kicker { font: 600 12px/1.4 system-ui, "Microsoft YaHei", sans-serif; letter-spacing: .18em; color: #9c2f25; text-transform: uppercase; }
h1 { font-size: 30px; line-height: 1.35; margin: 12px 0 14px; letter-spacing: .01em; }
.meta { font: 13px/1.7 system-ui, "Microsoft YaHei", sans-serif; color: #77726a; padding-bottom: 18px; border-bottom: 1px solid #d8d2c6; margin-bottom: 26px; }
.meta a { color: #9c2f25; text-decoration: none; word-break: break-all; }
h2 { font-size: 21px; margin: 34px 0 12px; line-height: 1.5; }
h3 { font-size: 18px; margin: 26px 0 10px; }
p { margin: 0 0 18px; font-size: 17px; text-align: justify; }
blockquote { margin: 0 0 18px; padding: 4px 0 4px 18px; border-left: 3px solid #c9a227; color: #5b564c; }
ul { margin: 0 0 18px; padding-left: 24px; }
li { margin-bottom: 8px; }
.pair { margin-bottom: 18px; }
.pair p { margin: 0 0 6px; }
.pair .dst { color: #7c2d24; border-left: 3px solid #d9c8a9; padding-left: 12px; }
.pair blockquote.dst { border-left: 3px solid #c9a227; }
.src { color: #23211d; }
.dst { color: #7c2d24; }
.orig-heading { font: 13px/1.7 system-ui, "Microsoft YaHei", sans-serif; color: #8a8478; margin: -6px 0 22px; }
figure { margin: 24px 0; }
img { max-width: 100%; height: auto; display: block; margin: 0 auto; }
.videos { margin-top: 34px; padding-top: 18px; border-top: 1px solid #d8d2c6; }
.videos h2 { font-size: 19px; }
.videos ul { padding-left: 20px; }
.videos a { color: #9c2f25; word-break: break-all; }
.videos img { max-width: 360px; margin: 10px 0 0; border-radius: 6px; }
.note { margin-top: 40px; padding-top: 16px; border-top: 1px solid #d8d2c6; font: 12px/1.7 system-ui, "Microsoft YaHei", sans-serif; color: #9a9488; }
@media (max-width: 600px) { .page { padding: 28px 16px 60px; } h1 { font-size: 24px; } p { font-size: 16px; } }
@media print { body { background: #fff; } .page { max-width: none; padding: 0; } }
</style>
</head>
<body>
<main class="page">
<div class="kicker">环球报阁 · ${escapeHtml(MODE_LABELS[mode] || '原文')}</div>
<h1>${escapeHtml(title)}</h1>
${originalTitleNote}
<div class="meta">${escapeHtml(meta)}${article.link ? `<br><a href="${escapeHtml(article.link)}">${escapeHtml(article.link)}</a>` : ''}</div>
${body.join('\n')}
${videoHtml}
<div class="note">本文由「环球报阁」导出，仅供个人离线阅读。版权归原作者与媒体所有。</div>
</main>
</body>
</html>`;
}

function uniqueName(name, used) {
  let candidate = name;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = name.replace(/(\.[^.]+)$/, `-${counter}$1`);
    counter++;
  }
  used.add(candidate);
  return candidate;
}

function buildExportZip({ articles, views, mode = 'original', generatedAt = new Date() }) {
  const dateFolder = `环球报阁-${dateText(generatedAt, false)}`;
  const used = new Set();
  const entries = [];
  const indexLines = [`# 环球报阁导出 · ${dateText(generatedAt, false)}`, '', `共 ${articles.length} 篇 · ${MODE_LABELS[mode] || '原文'}`, ''];
  let fallback = 0;
  articles.forEach((article, index) => {
    const view = views[article.id] || null;
    if (mode !== 'original' && (!view || !view.complete)) fallback++;
    const displayTitle = mode === 'translation' && view && view.title ? view.title : article.title;
    const baseName = `${String(index + 1).padStart(3, '0')}-${sanitizeFilename(displayTitle, 'article')}`;
    const fileName = uniqueName(`${baseName}.md`, used);
    entries.push({ name: `${dateFolder}/${fileName}`, data: articleToMarkdown(article, view, mode) });
    indexLines.push(`${index + 1}. [${displayTitle}${mode !== 'original' && view && !view.complete ? '（部分未翻译）' : ''}](${encodeURI(fileName)})`);
  });
  if (!articles.length) indexLines.push('（没有匹配的文章）');
  entries.unshift({ name: `${dateFolder}/index.md`, data: indexLines.join('\n') });
  const readme = [
    '环球报阁 · 离线阅读导出包',
    '',
    `生成时间：${dateText(generatedAt)}`,
    `文章数量：${articles.length}`,
    `导出模式：${MODE_LABELS[mode] || '原文'}`,
    fallback ? `其中 ${fallback} 篇没有完整译文，已保留原文。` : '',
    '',
    '内容来自公开 RSS 与公开网页，仅供个人离线阅读。',
    '版权归原作者与媒体所有，请勿再分发或用于商业用途。',
    '',
  ].filter(Boolean).join('\r\n');
  entries.push({ name: `${dateFolder}/README.txt`, data: readme });
  return { buffer: createZip(entries, { date: generatedAt }), folder: dateFolder, fallback };
}

function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildOpml(sources, title = '环球报阁订阅源') {
  const groups = new Map();
  for (const source of sources) {
    const category = source.category || '综合';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(source);
  }
  const outlines = [];
  for (const [category, list] of groups) {
    outlines.push(`    <outline text="${xmlEscape(category)}" title="${xmlEscape(category)}">`);
    for (const source of list) {
      outlines.push(`      <outline type="rss" text="${xmlEscape(source.title)}" title="${xmlEscape(source.title)}" xmlUrl="${xmlEscape(source.url)}"${source.siteUrl ? ` htmlUrl="${xmlEscape(source.siteUrl)}"` : ''} />`);
    }
    outlines.push('    </outline>');
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${xmlEscape(title)}</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${outlines.join('\n')}
  </body>
</opml>
`;
}

function parseOpml(content) {
  const text = String(content || '').replace(/^\uFEFF/, '');
  if (!/<opml[\s>]/i.test(text)) throw new Error('不是有效的 OPML 文件');
  const doc = parseXml(text);
  const root = documentRoot(doc);
  if (!root || root.local.toLowerCase() !== 'opml') throw new Error('OPML 根节点不正确');
  const body = children(root, 'body')[0];
  if (!body) throw new Error('OPML 缺少 body 节点');
  const feeds = [];
  const seen = new Set();
  function visit(node, category) {
    for (const item of children(node, 'outline')) {
      const xmlUrl = attr(item, 'xmlUrl');
      if (xmlUrl) {
        if (feeds.length >= 500) return;
        if (!/^https?:\/\//i.test(xmlUrl) || seen.has(xmlUrl)) continue;
        seen.add(xmlUrl);
        const title = attr(item, 'title') || attr(item, 'text') || xmlUrl;
        feeds.push({
          url: xmlUrl,
          title: decodeEntities(title),
          siteUrl: attr(item, 'htmlUrl') || '',
          category: category || '综合',
          type: attr(item, 'type') || 'rss',
        });
      } else {
        const groupName = cleanText(attr(item, 'title') || attr(item, 'text') || '');
        visit(item, groupName || category);
      }
    }
  }
  visit(body, '');
  return feeds;
}

module.exports = {
  MODE_LABELS,
  dateText,
  articleToMarkdown,
  articleToHtml,
  buildExportZip,
  buildOpml,
  parseOpml,
};

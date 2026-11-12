'use strict';

const { decodeEntities, normalizeUrl } = require('./util');

const FILE_RE = /\.(mp4|webm|ogv|ogg|mov|m4v)(\?|#|$)/i;

function q(value) {
  return decodeEntities(String(value || '')).replace(/&amp;/g, '&').trim();
}

function parseAttrs(source) {
  const attrs = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/g;
  let match;
  while ((match = re.exec(source || ''))) {
    attrs[match[1].toLowerCase()] = q(match[2] != null ? match[2] : match[3] != null ? match[3] : match[4] || '');
  }
  return attrs;
}

function youtubeId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') return parsed.pathname.split('/')[1] || '';
    if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return '';
    if (parsed.pathname === '/watch') return parsed.searchParams.get('v') || '';
    const match = parsed.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{6,})/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function vimeoId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    if (host !== 'vimeo.com' && host !== 'player.vimeo.com') return '';
    const match = parsed.pathname.match(/(\d{6,})/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function bilibiliTarget(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\.|^m\./, '');
    if (!host.endsWith('bilibili.com')) return null;
    const bv = parsed.pathname.match(/(BV[0-9A-Za-z]{10})/);
    if (bv) return { kind: 'bvid', id: bv[1] };
    const av = parsed.pathname.match(/\/video\/av(\d+)/i);
    if (av) return { kind: 'aid', id: av[1] };
    const param = parsed.searchParams.get('bvid');
    if (param && /^BV[0-9A-Za-z]{10}$/.test(param)) return { kind: 'bvid', id: param };
    return null;
  } catch {
    return null;
  }
}

function dailymotionId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    if (host === 'dai.ly') return parsed.pathname.split('/')[1] || '';
    if (host !== 'dailymotion.com' && host !== 'geo.dailymotion.com') return '';
    const match = parsed.pathname.match(/\/video\/([A-Za-z0-9]+)/);
    if (match) return match[1];
    return parsed.searchParams.get('video') || '';
  } catch {
    return '';
  }
}

function normalizeVideo(rawUrl, baseUrl) {
  const url = normalizeUrl(rawUrl, baseUrl);
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) return null;

  const youtube = youtubeId(url);
  if (youtube) {
    return {
      type: 'embed',
      provider: 'YouTube',
      url: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtube)}?rel=0`,
      poster: `https://i.ytimg.com/vi/${encodeURIComponent(youtube)}/hqdefault.jpg`,
      id: youtube,
    };
  }
  const vimeo = vimeoId(url);
  if (vimeo) {
    return {
      type: 'embed',
      provider: 'Vimeo',
      url: `https://player.vimeo.com/video/${vimeo}`,
      poster: '',
      id: vimeo,
    };
  }
  const bili = bilibiliTarget(url);
  if (bili) {
    const query = bili.kind === 'bvid' ? `bvid=${bili.id}` : `aid=${bili.id}`;
    return {
      type: 'embed',
      provider: '哔哩哔哩',
      url: `https://player.bilibili.com/player.html?${query}&autoplay=0&high_quality=1`,
      poster: '',
      id: bili.id,
    };
  }
  const dailymotion = dailymotionId(url);
  if (dailymotion) {
    return {
      type: 'embed',
      provider: 'Dailymotion',
      url: `https://www.dailymotion.com/embed/video/${encodeURIComponent(dailymotion)}`,
      poster: '',
      id: dailymotion,
    };
  }
  if (FILE_RE.test(url)) {
    return { type: 'file', provider: '视频文件', url, poster: '', id: '' };
  }
  return null;
}

function collectVideos(html, baseUrl, limit = 3) {
  const source = String(html || '');
  if (!source) return [];
  const found = [];
  const seen = new Set();
  const add = (video, poster, title) => {
    if (!video || found.length >= limit || seen.has(video.url)) return;
    seen.add(video.url);
    found.push({
      type: video.type,
      provider: video.provider,
      url: video.url,
      poster: poster ? normalizeUrl(poster, baseUrl) || '' : video.poster || '',
      tracks: Array.isArray(video.tracks) ? video.tracks : [],
      title: q(title || '').slice(0, 120),
    });
  };

  const videoRe = /<video\b([^>]*)>([\s\S]*?)<\/video>/gi;
  let match;
  while ((match = videoRe.exec(source)) && found.length < limit) {
    const attrs = parseAttrs(match[1]);
    const poster = attrs.poster || '';
    const tracks = [];
    const trackRe = /<track\b([^>]*)>/gi;
    let trackMatch;
    while ((trackMatch = trackRe.exec(match[2])) && tracks.length < 4) {
      const tAttrs = parseAttrs(trackMatch[1]);
      const src = normalizeUrl(tAttrs.src, baseUrl);
      if (!src || !/^https?:\/\//i.test(src)) continue;
      tracks.push({
        url: src,
        lang: String(tAttrs.srclang || '').slice(0, 12),
        label: q(tAttrs.label || '').slice(0, 40),
        kind: String(tAttrs.kind || 'subtitles').slice(0, 20),
      });
    }
    const candidates = [];
    if (attrs.src) candidates.push(attrs.src);
    const sourceRe = /<source\b([^>]*)>/gi;
    let inner;
    while ((inner = sourceRe.exec(match[2]))) {
      const sAttrs = parseAttrs(inner[1]);
      if (sAttrs.src) candidates.push(sAttrs.src);
    }
    for (const candidate of candidates) {
      const video = normalizeVideo(candidate, baseUrl);
      if (video) { video.tracks = tracks; add(video, poster, attrs.title); break; }
    }
  }

  const iframeRe = /<iframe\b([^>]*)>/gi;
  while ((match = iframeRe.exec(source)) && found.length < limit) {
    const attrs = parseAttrs(match[1]);
    if (!attrs.src) continue;
    const video = normalizeVideo(attrs.src, baseUrl);
    if (video) add(video, '', attrs.title);
  }

  const metaRes = [
    /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:video(?::url|:secure_url)?|twitter:player)["'][^>]*content\s*=\s*["']([^"']+)["']/gi,
    /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["'](?:og:video(?::url|:secure_url)?|twitter:player)["']/gi,
  ];
  for (const re of metaRes) {
    while ((match = re.exec(source)) && found.length < limit) {
      const video = normalizeVideo(match[1], baseUrl);
      if (video) add(video, '', '');
    }
  }

  return found;
}

function videoFromEnclosure(rawUrl, type, baseUrl) {
  const kind = String(type || '').toLowerCase();
  if (kind && !kind.startsWith('video/')) return null;
  const video = normalizeVideo(rawUrl, baseUrl);
  if (!video) return null;
  if (!kind && video.type !== 'file') return null;
  return video;
}

module.exports = {
  normalizeVideo,
  collectVideos,
  videoFromEnclosure,
};

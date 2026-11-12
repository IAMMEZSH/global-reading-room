'use strict';

const { decodeEntities } = require('./util');

function cleanCue(text) {
  return decodeEntities(String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\\[^}]*\}/g, ''))
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function parseTimestamp(value) {
  const match = String(value || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const ms = Number(match[4].padEnd(3, '0'));
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

function parseCues(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!/-->/.test(text)) return [];
  const blocks = text.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim());
    const timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex < 0) continue;
    const times = lines[timeIndex].split('-->');
    const start = parseTimestamp(times[0]);
    const end = parseTimestamp((times[1] || '').trim().split(/\s+/)[0]);
    if (start == null || end == null) continue;
    const body = cleanCue(lines.slice(timeIndex + 1).join('\n'));
    if (!body) continue;
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(body)) continue;
    cues.push({ start, end, text: body.slice(0, 300) });
    if (cues.length >= 400) break;
  }
  return cues;
}

function looksLikeVtt(text) {
  return /^\uFEFF?WEBVTT/.test(String(text || '').trimStart()) || /-->/.test(text);
}

function youtubeVideoId(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl || '')); } catch { return ''; }
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (host === 'youtu.be') {
    const id = parsed.pathname.split('/').filter(Boolean)[0] || '';
    return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : '';
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host.endsWith('.youtube.com') || host.endsWith('.youtube-nocookie.com')) {
    if (parsed.pathname === '/watch') {
      const id = parsed.searchParams.get('v') || '';
      return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : '';
    }
    const match = parsed.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{6,20})/);
    return match ? match[1] : '';
  }
  return '';
}

function parseCaptionTracks(html) {
  const match = String(html || '').match(/"captionTracks":(\[[^\]]*\])/);
  if (!match) return [];
  let list;
  try { list = JSON.parse(match[1]); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list
    .filter((track) => track && typeof track.baseUrl === 'string' && /^https?:\/\//i.test(track.baseUrl))
    .map((track) => {
      const name = track.name && (track.name.simpleText
        || (Array.isArray(track.name.runs) ? track.name.runs.map((run) => run.text || '').join('') : ''));
      return {
        url: track.baseUrl,
        language: String(track.languageCode || ''),
        kind: String(track.kind || ''),
        name: String(name || track.languageCode || ''),
      };
    });
}

function pickCaptionTrack(tracks) {
  if (!Array.isArray(tracks) || !tracks.length) return null;
  const manualEn = tracks.find((track) => /^en/i.test(track.language) && track.kind !== 'asr');
  const anyEn = tracks.find((track) => /^en/i.test(track.language));
  return manualEn || anyEn || tracks[0];
}

function cuesFromPlainText(text) {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
  const pieces = [];
  for (const line of lines) {
    if (line.length <= 180) { pieces.push(line); continue; }
    const sentences = line.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
    let buffer = '';
    for (const sentence of sentences) {
      if (buffer && buffer.length + sentence.length > 180) { pieces.push(buffer); buffer = ''; }
      buffer += sentence;
    }
    if (buffer) pieces.push(buffer);
  }
  return pieces.slice(0, 400).map((body, index) => ({
    start: index * 2,
    end: index * 2 + 2,
    text: body.slice(0, 300),
  }));
}

module.exports = { parseCues, looksLikeVtt, youtubeVideoId, parseCaptionTracks, pickCaptionTrack, cuesFromPlainText };

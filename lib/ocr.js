'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { httpRequest } = require('./http');
const { safeJsonParse, hashId, sleep } = require('./util');
const tx = require('./translate');

const PS_SCRIPT = path.join(__dirname, 'ocr-windows.ps1');

function friendly(message, code = 'OCR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isChineseText(text) {
  const value = String(text || '');
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (value.match(/[A-Za-z\u4e00-\u9fff]/g) || []).length;
  return letters > 0 && cjk / letters > 0.6;
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function windowsOcr(file) {
  if (process.platform !== 'win32') throw friendly('当前系统没有可用的内置 OCR。', 'NO_OCR');
  const outDir = path.join(os.tmpdir(), 'grr-ocr');
  await fsp.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${Date.now()}-${hashId(file, 8)}.txt`);
  const shell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT, '-ImagePath', file, '-OutPath', outPath];
  await new Promise((resolve, reject) => {
    const child = spawn(shell, args, { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(friendly('图片文字识别超时，请换一张更小的图片。', 'OCR_TIMEOUT'));
    }, 25000);
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-1500); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(friendly(`无法调用系统 OCR：${error.message}`, 'NO_OCR'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(friendly(`系统 OCR 失败：${stderr.trim().split('\n').slice(-1)[0] || `退出码 ${code}`}`, 'OCR_FAILED'));
    });
  });
  const text = await fsp.readFile(outPath, 'utf8').catch(() => '');
  await fsp.rm(outPath, { force: true }).catch(() => {});
  return { text: normalizeText(text), provider: 'windows', model: 'Windows OCR' };
}

function visionConfigured(settings) {
  const t = settings.translate || {};
  return Boolean(String(t.ocrModel || '').trim() && String(t.openaiBaseUrl || '').trim());
}

async function visionOcr(buffer, mime, settings, proxy, target) {
  const t = settings.translate;
  const baseUrl = String(t.openaiBaseUrl || '').trim().replace(/\/+$/, '');
  const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  const key = String(t.openaiKey || '').trim();
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(baseUrl);
  if (!key && !isLocal) throw friendly('视觉模型接口密钥尚未填写。', 'CONFIG');
  const label = target === 'zh-TW' ? '繁体中文' : '简体中文';
  const prompt = [
    `读取图片中的全部可见文字，保持原有顺序与换行，然后翻译成${label}。`,
    '只输出 JSON：{"text":"图片原文","translation":"译文"}。',
    '如果图片没有文字，text 与 translation 都输出空字符串；不要描述图片。',
  ].join('\n');
  let response;
  try {
    response = await httpRequest(endpoint, {
      method: 'POST',
      proxy: proxy || undefined,
      timeout: 60000,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: String(t.ocrModel).trim(),
        temperature: 0.1,
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime || 'image/jpeg'};base64,${buffer.toString('base64')}` } },
          ],
        }],
      }),
    });
  } catch (error) {
    throw friendly(`视觉模型请求失败：${error.friendly || error.message}`, 'NETWORK');
  }
  const text = response.body.toString('utf8');
  if (response.status >= 400) {
    throw friendly(`视觉模型返回 HTTP ${response.status}：${text.slice(0, 200)}`, 'PROVIDER');
  }
  const data = safeJsonParse(text, null);
  const choice = data && data.choices && data.choices[0];
  let content = choice && choice.message ? choice.message.content : '';
  if (Array.isArray(content)) content = content.map((part) => (typeof part === 'string' ? part : part.text || '')).join('');
  const start = String(content).indexOf('{');
  const end = String(content).lastIndexOf('}');
  const parsed = start >= 0 && end > start ? safeJsonParse(String(content).slice(start, end + 1), null) : null;
  if (!parsed || typeof parsed !== 'object') throw friendly('视觉模型没有返回可解析的 JSON。', 'PROVIDER');
  return {
    text: normalizeText(parsed.text || parsed.original || ''),
    translation: normalizeText(parsed.translation || parsed.zh || ''),
    provider: 'vision',
    model: String(t.ocrModel).trim(),
  };
}

async function translateLines(text, settings, proxy) {
  const engine = tx.engineFor(settings);
  const lines = normalizeText(text).split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return '';
  let budget = 0;
  const picked = [];
  for (const line of lines) {
    if (picked.length >= 80 || budget + line.length > 8000) break;
    picked.push(line);
    budget += line.length;
  }
  const units = picked.map((line, index) => ({ index, text: line }));
  const batches = tx.batchSegments(units, engine);
  const output = new Array(picked.length).fill('');
  let lastError = null;
  for (const batch of batches) {
    try {
      const results = await engine.translate(batch.map((unit) => unit.text), {
        settings, proxy, sourceLang: 'auto',
      });
      batch.forEach((unit, index) => { output[unit.index] = String(results[index] || '').trim(); });
    } catch (error) {
      lastError = error;
      for (const unit of batch) {
        try {
          const results = await engine.translate([unit.text], { settings, proxy, sourceLang: 'auto' });
          output[unit.index] = String(results[0] || '').trim();
        } catch { /* skip lines the provider cannot handle */ }
        await sleep(90);
      }
    }
    await sleep(120);
  }
  if (lastError && !output.some(Boolean)) throw lastError;
  return normalizeText(output.filter(Boolean).join('\n'));
}

async function ocrImage({ file, buffer, mime, settings, proxy, targetLang = 'zh-CN' }) {
  if (!file && !buffer) throw friendly('没有可识别的图片。', 'NO_IMAGE');
  let result = null;
  if (visionConfigured(settings)) {
    const bytes = buffer || await fsp.readFile(file);
    result = await visionOcr(bytes, mime, settings, proxy, targetLang);
  } else {
    result = await windowsOcr(file);
  }
  const text = normalizeText(result.text);
  if (!text) {
    return { text: '', translation: '', provider: result.provider, model: result.model || '', empty: true };
  }
  let translation = '';
  if (result.translation) {
    translation = result.translation;
  } else if (!(targetLang === 'zh-CN' || targetLang === 'zh-TW') || !isChineseText(text)) {
    translation = await translateLines(text, settings, proxy).catch((error) => {
      throw friendly(`文字识别成功，但翻译失败：${error.friendly || error.message}`, error.code || 'TRANSLATE');
    });
  } else {
    translation = text;
  }
  return {
    text,
    translation,
    provider: result.provider,
    model: result.model || '',
    empty: false,
  };
}

module.exports = { ocrImage, visionConfigured };

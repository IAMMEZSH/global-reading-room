'use strict';

// Generates the English field-guide pages rendered to PNG by .testout/cdp-shot.js.
const fs = require('node:fs');
const path = require('node:path');

const CSS = `
:root {
  --bg: #030a13;
  --panel: rgba(7, 20, 34, 0.86);
  --ink: #e6f7ff;
  --soft: #a9c7d9;
  --muted: #6f93a9;
  --cyan: #35e6ff;
  --violet: #a78bfa;
  --green: #45ffb0;
  --line: rgba(88, 198, 255, 0.2);
  --line-strong: rgba(88, 198, 255, 0.42);
}
* { box-sizing: border-box; }
html, body { margin: 0; width: 1600px; height: 1000px; overflow: hidden; }
body {
  background:
    radial-gradient(1100px 640px at 88% -12%, rgba(124, 58, 237, 0.22), transparent 62%),
    radial-gradient(900px 560px at -4% 108%, rgba(0, 229, 255, 0.14), transparent 60%),
    linear-gradient(180deg, #050d19 0%, #02060d 100%);
  color: var(--ink);
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  position: relative;
}
body::before {
  content: "";
  position: absolute; inset: 0;
  background-image:
    linear-gradient(rgba(88, 198, 255, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(88, 198, 255, 0.045) 1px, transparent 1px);
  background-size: 44px 44px;
  mask-image: radial-gradient(circle at 50% 30%, #000 30%, transparent 88%);
  pointer-events: none;
}
body::after {
  content: "";
  position: absolute; inset: 0;
  background: repeating-linear-gradient(180deg, rgba(255,255,255,0.014) 0 1px, transparent 1px 4px);
  pointer-events: none;
}
.page { position: relative; z-index: 2; height: 1000px; padding: 46px 58px 34px; display: flex; flex-direction: column; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; font-family: "Cascadia Code", Consolas, monospace; font-size: 12px; letter-spacing: 0.18em; color: var(--muted); text-transform: uppercase; }
.brand { display: flex; align-items: center; gap: 14px; color: var(--soft); }
.seal {
  width: 38px; height: 38px; display: grid; place-items: center;
  color: var(--cyan); border: 1px solid var(--line-strong);
  font: 700 17px/1 "Segoe UI", sans-serif; letter-spacing: 0;
  background: linear-gradient(145deg, rgba(53,230,255,0.12), rgba(167,139,250,0.08));
  clip-path: polygon(50% 0, 93% 25%, 93% 75%, 50% 100%, 7% 75%, 7% 25%);
}
.brand b { color: var(--ink); font-weight: 600; letter-spacing: 0.12em; }
.fig { color: var(--cyan); }
.head { margin: 26px 0 22px; display: flex; align-items: flex-end; justify-content: space-between; gap: 30px; }
.kicker { font-family: "Cascadia Code", Consolas, monospace; font-size: 12px; letter-spacing: 0.24em; color: var(--violet); text-transform: uppercase; margin-bottom: 8px; }
h1 { margin: 0; font-size: 46px; line-height: 1.06; letter-spacing: -0.01em; font-weight: 680; }
.sub { max-width: 620px; margin: 8px 0 0; color: var(--soft); font-size: 15.5px; line-height: 1.6; }
.chiprow { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; max-width: 520px; }
.chip {
  padding: 6px 11px; border: 1px solid var(--line); border-radius: 2px;
  color: var(--muted); font: 11px/1.2 "Cascadia Code", Consolas, monospace; letter-spacing: 0.08em; text-transform: uppercase;
  background: rgba(53, 230, 255, 0.03);
}
.stage { flex: 1; min-height: 0; display: grid; grid-template-columns: 1.58fr 1fr; gap: 30px; }
.shot-wrap { min-height: 0; display: flex; flex-direction: column; gap: 10px; }
.shot-label { display: flex; justify-content: space-between; font: 10px/1 "Cascadia Code", Consolas, monospace; letter-spacing: 0.16em; color: var(--muted); text-transform: uppercase; }
.shot {
  position: relative; flex: 1; min-height: 0; overflow: hidden;
  border: 1px solid var(--line-strong);
  background: #02060c;
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(53, 230, 255, 0.06) inset;
}
.shot::after {
  content: ""; position: absolute; inset: 0;
  box-shadow: inset 0 0 60px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}
.shot img { width: 100%; height: 100%; object-fit: cover; object-position: top left; display: block; }
.shot.fit img { object-fit: contain; }
.shot .crop-bottom img { object-position: bottom left; }
.shot .crop-center img { object-position: center; }
.shot .crop-right img { object-position: 100% 50%; }
.corner { position: absolute; width: 18px; height: 18px; border-color: var(--cyan); z-index: 3; }
.corner.tl { left: -1px; top: -1px; border-left: 2px solid; border-top: 2px solid; }
.corner.tr { right: -1px; top: -1px; border-right: 2px solid; border-top: 2px solid; }
.corner.bl { left: -1px; bottom: -1px; border-left: 2px solid; border-bottom: 2px solid; }
.corner.br { right: -1px; bottom: -1px; border-right: 2px solid; border-bottom: 2px solid; }
.calls { display: flex; flex-direction: column; gap: 14px; min-height: 0; }
.call {
  position: relative; padding: 16px 18px 15px 58px;
  border: 1px solid var(--line); background: linear-gradient(120deg, rgba(8, 24, 40, 0.92), rgba(4, 12, 22, 0.8));
}
.call::before {
  content: attr(data-n);
  position: absolute; left: 16px; top: 15px;
  width: 30px; height: 30px; display: grid; place-items: center;
  border: 1px solid var(--line-strong); color: var(--cyan);
  font: 600 12px/1 "Cascadia Code", Consolas, monospace;
  background: rgba(53, 230, 255, 0.06);
}
.call h3 { margin: 0 0 5px; font-size: 16.5px; font-weight: 640; letter-spacing: 0.01em; }
.call p { margin: 0; color: var(--soft); font-size: 13px; line-height: 1.55; }
.call em { color: var(--cyan); font-style: normal; }
.footer { margin-top: 22px; padding-top: 14px; border-top: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 20px; font: 10.5px/1.4 "Cascadia Code", Consolas, monospace; letter-spacing: 0.12em; color: var(--muted); text-transform: uppercase; }
.footer .ok { color: var(--green); }
.wide { display: flex; flex-direction: column; gap: 16px; }
.wide .shot { min-height: 0; }
.callrow { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.callrow .call { padding: 14px 15px 13px 15px; }
.callrow .call::before { position: static; display: inline-grid; margin-bottom: 8px; }
.callrow .call h3 { font-size: 14.5px; }
.callrow .call p { font-size: 12px; }
.duo { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; flex: 1; min-height: 0; }
.duo .shot { height: 100%; }
.duo figure { margin: 0; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.duo figcaption { font: 10px/1.4 "Cascadia Code", Consolas, monospace; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; }
.tree { border: 1px solid var(--line); padding: 18px 20px; background: rgba(3, 10, 18, 0.7); font: 12.5px/1.9 "Cascadia Code", Consolas, monospace; color: var(--soft); }
.tree b { color: var(--cyan); font-weight: 600; }
.tree span { color: var(--muted); }
.flow { flex: 1; display: grid; grid-template-columns: 1fr 1.2fr 1fr; grid-template-rows: auto 1fr auto; gap: 18px; align-items: stretch; }
.node {
  border: 1px solid var(--line-strong); background: linear-gradient(145deg, rgba(8,25,42,0.92), rgba(3,10,18,0.86));
  padding: 18px 18px 16px; position: relative;
}
.node h3 { margin: 0 0 8px; font-size: 15px; color: var(--cyan); letter-spacing: 0.04em; }
.node p, .node li { margin: 0; color: var(--soft); font-size: 12.5px; line-height: 1.7; }
.node ul { margin: 0; padding-left: 16px; }
.node small { display: block; margin-top: 8px; color: var(--muted); font: 10px/1.5 "Cascadia Code", Consolas, monospace; letter-spacing: 0.08em; text-transform: uppercase; }
.node.core { border-color: var(--cyan); box-shadow: 0 0 36px rgba(53, 230, 255, 0.12); }
.arch { flex: 1; display: grid; grid-template-columns: 1fr 56px 1.15fr 56px 1fr; grid-template-rows: 1fr auto auto; gap: 16px; align-items: stretch; }
.arch .node { display: flex; flex-direction: column; }
.arch .data-strip { grid-column: 1 / -1; }
.arch .trustbox { grid-column: 1 / -1; }
.arrow { display: grid; place-items: center; color: var(--cyan); font: 22px/1 "Cascadia Code", Consolas, monospace; }
.data-strip { grid-column: 1 / -1; border: 1px dashed var(--line-strong); padding: 14px 18px; display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
.data-strip b { color: var(--violet); font: 600 11px/1 "Cascadia Code", Consolas, monospace; letter-spacing: 0.16em; text-transform: uppercase; }
.data-strip span { color: var(--soft); font: 12px/1.4 "Cascadia Code", Consolas, monospace; }
.platforms { flex: 1; display: grid; grid-template-columns: repeat(5, 1fr); gap: 14px; align-content: stretch; }
.plat { border: 1px solid var(--line); background: linear-gradient(160deg, rgba(8,24,40,0.9), rgba(3,10,18,0.76)); padding: 20px 17px; display: flex; flex-direction: column; gap: 10px; }
.plat h3 { margin: 0; font-size: 19px; color: var(--ink); }
.plat .st { align-self: flex-start; padding: 4px 8px; font: 9.5px/1 "Cascadia Code", Consolas, monospace; letter-spacing: 0.12em; color: var(--green); border: 1px solid rgba(69,255,176,0.35); background: rgba(69,255,176,0.06); }
.plat .st.exp { color: #ffd166; border-color: rgba(255,209,102,0.4); background: rgba(255,209,102,0.06); }
.plat p { margin: 0; color: var(--soft); font-size: 12.5px; line-height: 1.6; }
.plat code { display: block; margin-top: auto; padding: 9px 10px; background: rgba(0,0,0,0.35); border: 1px solid var(--line); color: var(--cyan); font: 11px/1.5 "Cascadia Code", Consolas, monospace; word-break: break-all; }
.plat small { color: var(--muted); font-size: 10.5px; line-height: 1.5; }
.plat ul { margin: 2px 0 0; padding-left: 15px; color: var(--muted); font-size: 11px; line-height: 1.55; }
.plat li { margin: 0 0 3px; }
.plat .lbl { margin-top: 4px; color: var(--muted); font: 9.5px/1 "Cascadia Code", Consolas, monospace; letter-spacing: 0.14em; text-transform: uppercase; }
.plat ol { margin: 0; padding-left: 16px; color: var(--soft); font-size: 11px; line-height: 1.6; }
.plat ol li { margin: 0 0 2px; }
.plat ol b { color: var(--cyan); font-weight: 600; }
.note { margin-top: 12px; padding: 12px 16px; border-left: 2px solid var(--violet); background: rgba(167,139,250,0.06); color: var(--soft); font-size: 12.5px; line-height: 1.6; }
.metric { display: flex; gap: 28px; margin-top: 18px; }
.metric div { border-left: 1px solid var(--line); padding-left: 12px; }
.metric b { display: block; color: var(--cyan); font: 600 22px/1.2 "Cascadia Code", Consolas, monospace; }
.metric span { color: var(--muted); font: 10px/1.4 "Cascadia Code", Consolas, monospace; letter-spacing: 0.1em; text-transform: uppercase; }
`;

const head = (n, kicker, title, sub, chips) => `
<div class="topbar">
  <div class="brand"><div class="seal">阁</div><span><b>GLOBAL READING ROOM</b> // FIELD GUIDE</span></div>
  <div>LOCAL-FIRST NEWS INTELLIGENCE <span class="fig">FIG. ${n} / 10</span></div>
</div>
<div class="head">
  <div>
    <div class="kicker">${kicker}</div>
    <h1>${title}</h1>
    <p class="sub">${sub}</p>
  </div>
  <div class="chiprow">${chips.map((chip) => `<span class="chip">${chip}</span>`).join('')}</div>
</div>`;

const footer = (label) => `
<div class="footer">
  <span>GLOBAL READING ROOM · LOCAL-FIRST NEWS INTELLIGENCE</span>
  <span class="ok">${label}</span>
</div>`;

const shot = (src, label, extra = '', objectPosition = 'top left') => `
<div class="shot-wrap">
  <div class="shot-label"><span>${label}</span><span>1600 × 1000 · DARK HUD</span></div>
  <div class="shot ${extra}"><img src="../images/${src}" style="object-position:${objectPosition}" alt=""><span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span></div>
</div>`;

const call = (n, title, body) => `<div class="call" data-n="${n}"><h3>${title}</h3><p>${body}</p></div>`;

const pages = [];

pages.push({
  file: '01-command-deck.html',
  html: `
${head('01', 'Overview', 'The Command Deck',
  'One local reading room for the world’s press. Subscribe to public RSS and Atom feeds, sync on a schedule, and keep every article, translation and image on your own disk.',
  ['61 feeds active', '2,200+ articles', '9 categories', '7 regions'])}
<div class="stage">
  ${shot('ui-home.png', 'Live interface · home')}
  <div class="calls">
    ${call('01', 'Unified incoming feed', 'Chinese and international outlets share one chronological stream. Every card shows its source, category, language and reading state.')}
    ${call('02', 'Category and region filters', 'Jump between World, China, International, Business, Technology, Science, Culture, Sport and Video without leaving the page.')}
    ${call('03', 'Search the whole archive', 'Full-text search covers titles, summaries and authors. Keyboard <em>/</em> focuses the field instantly.')}
    ${call('04', 'A dedicated reader pane', 'Select any article to open the reading room. <em>J</em> and <em>K</em> move through the list without touching the mouse.')}
    ${call('05', 'Local by design', 'The UI talks only to 127.0.0.1. No account, no cloud sync, no telemetry — your reading history stays in the data folder.')}
  </div>
</div>
${footer('FIG. 01 · COMMAND DECK')}`,
});

pages.push({
  file: '02-bilingual-reader.html',
  html: `
${head('02', 'Reading experience', 'Bilingual Reading Room',
  'Generate a full Chinese translation for any foreign-language article, then read it as a paragraph-by-paragraph bilingual pair with the original always one click away.',
  ['Whole-article translation', 'Bilingual pairs', 'Original / translation / dual', 'Full-text capture'])}
<div class="stage">
  ${shot('ui-reader.png', 'Live interface · bilingual reader', 'fit')}
  <div class="calls">
    ${call('01', 'Whole-article translation', 'The browser translates every paragraph, heading, quote and list item — not just the summary — and caches the result on disk.')}
    ${call('02', 'Three reading modes', 'Switch between <em>Original</em>, <em>Bilingual</em> and <em>Translation</em>. Bilingual mode keeps the source directly above its translation.')}
    ${call('03', 'Translation status banner', 'A visible banner reports the provider, target language and completion state, so a partial translation is never mistaken for the original.')}
    ${call('04', 'Full-text capture first', '<em>Capture full text</em> extracts the public article body, removes navigation and ads, and preserves images and videos for offline reading.')}
    ${call('05', 'Source and language badges', 'BBC · World — World · English shows exactly which feed produced the item and which language it was written in.')}
  </div>
</div>
${footer('FIG. 02 · BILINGUAL READER')}`,
});

pages.push({
  file: '03-video-subtitles.html',
  html: `
${head('03', 'Media intelligence', 'Video, Subtitles & Translation',
  'Video articles keep their player inside the reader. Subtitle tracks are parsed cue by cue; when a platform blocks server-side downloads, paste the transcript and translate it locally.',
  ['YouTube · Vimeo · Bilibili', 'WebVTT / SRT', 'Cue-level bilingual output', 'Paste-transcript fallback'])}
<div class="stage">
  ${shot('ui-video.png', 'Live interface · video article', 'fit')}
  <div class="calls">
    ${call('01', 'Embedded playback', 'YouTube, Vimeo, Bilibili and Dailymotion players are embedded from the original platform. Direct MP4/WebM files use a native HTML5 player with poster art.')}
    ${call('02', 'Best-effort platform subtitles', '<em>Translate captions</em> resolves the public caption track and translates it. Some platforms return empty caption files; the app explains exactly what happened instead of failing silently.')}
    ${call('03', 'Paste the transcript', 'Copy the transcript from the video page and drop it into <em>Paste captions</em>. WebVTT, SRT and plain text are accepted, up to 300 lines.')}
    ${call('04', 'Cue-by-cue bilingual list', 'Each cue shows its timestamp, original line and Chinese translation — useful for study, quoting and fact-checking.')}
    ${call('05', 'Video stays online', 'Embedded players are not downloaded. The transcript translation works offline once generated and cached.')}
  </div>
</div>
${footer('FIG. 03 · VIDEO & SUBTITLES')}`,
});

pages.push({
  file: '04-image-ocr.html',
  html: `
${head('04', 'Media intelligence', 'Image Intelligence & OCR',
  'Article images are proxied, cached and OCR-ready. Recognize the text inside a chart, screenshot or infographic with the Windows OCR engine or a vision model, then translate it line by line.',
  ['Cached image proxy', 'Windows OCR', 'Vision-model OCR', 'Line-level translation'])}
<div class="stage">
  ${shot('ui-ocr-crop.png', 'Live interface · OCR result', 'fit')}
  <div class="calls">
    ${call('01', 'Cached, guarded image proxy', 'Remote images are fetched once, validated against private-network addresses, stored under <em>data/images</em> and served from localhost.')}
    ${call('02', 'Two OCR engines', 'Windows uses the built-in WinRT OCR engine with no extra install. A vision model can be configured for other systems or harder layouts.')}
    ${call('03', 'Read, then translate', 'The panel keeps the recognized source text separate from the Chinese translation, so OCR errors stay visible and checkable.')}
    ${call('04', 'Zoom to verify', 'Any article image opens in a full-screen lightbox with wheel zoom, drag-to-pan and a one-click reset — ideal for dense charts.')}
  </div>
</div>
${footer('FIG. 04 · IMAGE OCR')}`,
});

pages.push({
  file: '05-source-atlas.html',
  html: `
${head('05', 'Library control', 'Source Atlas & Sync Control',
  'A curated catalog of 195 public feeds across nine categories and seven regions. Enable what you read, retire what you do not, or bring your own RSS and OPML.',
  ['195-feed catalog', 'Per-source sync', 'OPML import / export', 'Retention policy'])}
<div class="stage">
  ${shot('ui-sources.png', 'Live interface · source manager', '', 'center')}
  <div class="calls">
    ${call('01', 'A curated world catalog', 'Chinese outlets, global newspapers, science and culture magazines, plus video channels. Each entry records its language, region and category.')}
    ${call('02', 'Per-source control', 'Toggle a feed on or off, sync it immediately, or delete it together with its articles. The switch is immediate and local.')}
    ${call('03', 'Bring your own feeds', 'Paste any public RSS or Atom URL at the bottom of the panel. Use OPML to import a reading list from another reader — or export yours.')}
    ${call('04', 'Retention without surprises', 'Each source keeps up to 150 articles by default. Adjust the limit in Settings; old items are trimmed predictably.')}
    ${call('05', 'Honest source health', 'The last-sync time and article count sit under every source. A failing feed is visible instead of silently disappearing.')}
  </div>
</div>
${footer('FIG. 05 · SOURCE ATLAS')}`,
});

pages.push({
  file: '06-translation-engine.html',
  html: `
${head('06', 'Configuration', 'Translation Engine Room',
  'Five providers, one interface. Start free with MyMemory, add DeepL or Azure for volume, use Baidu for mainland access, or point the app at any OpenAI-compatible endpoint.',
  ['MyMemory · free', 'DeepL · Azure', 'Baidu', 'OpenAI-compatible'])}
<div class="stage">
  ${shot('ui-settings.png', 'Live interface · settings', 'fit')}
  <div class="calls">
    ${call('01', 'Provider matrix', 'MyMemory needs no key and is ideal for evaluation. DeepL, Azure, Baidu and OpenAI-compatible services are configured with credentials in the same panel.')}
    ${call('02', 'Simplified or traditional Chinese', 'Choose Simplified or Traditional Chinese as the target. Every translation is cached per provider and language.')}
    ${call('03', 'Auto-translate foreign articles', 'When enabled, opening a non-Chinese article starts a whole-article translation after half a second. Leave it off to translate on demand.')}
    ${call('04', 'Vision OCR model', 'A multimodal OpenAI-compatible model can read images directly, returning both the original text and its translation in one request.')}
    ${call('05', 'Keys stay local', 'Credentials are stored in your data folder, never transmitted anywhere except the provider you chose. Protect the folder like any other document archive.')}
  </div>
</div>
${footer('FIG. 06 · TRANSLATION ENGINE')}`,
});

pages.push({
  file: '07-architecture.html',
  html: `
${head('07', 'Under the hood', 'Local-First Architecture',
  'A single zero-dependency Node.js process serves the browser UI, syncs public feeds and owns every byte of state. There is no database server and no build step.',
  ['Node.js ≥ 20', 'Zero runtime dependencies', '127.0.0.1 only', 'Atomic JSON store'])}
<div class="arch">
  <div class="node">
    <h3>Browser UI</h3>
    <ul>
      <li>Feed, filters &amp; search</li>
      <li>Reader &amp; bilingual view</li>
      <li>Lightbox, OCR &amp; captions</li>
      <li>Settings &amp; export dialogs</li>
    </ul>
    <small>public/ · served from localhost</small>
  </div>
  <div class="arrow">⇄</div>
  <div class="node core">
    <h3>Local Node Core</h3>
    <ul>
      <li>HTTP API &amp; static server</li>
      <li>RSS 2.0 / Atom / RDF parser</li>
      <li>Full-text extraction &amp; sanitizing</li>
      <li>Translation pipeline + disk cache</li>
      <li>Image proxy &amp; SSRF guard</li>
      <li>Windows OCR bridge / vision client</li>
      <li>WebVTT &amp; SRT cue parser</li>
    </ul>
    <small>server.js · lib/</small>
  </div>
  <div class="arrow">⇄</div>
  <div class="node">
    <h3>Public Web</h3>
    <ul>
      <li>Publisher RSS &amp; article pages</li>
      <li>Image CDNs</li>
      <li>Video platforms</li>
      <li>Your translation provider</li>
    </ul>
    <small>HTTPS · optional local proxy</small>
  </div>
  <div class="data-strip">
    <b>Data folder</b>
    <span>db.json</span><span>fulltext/</span><span>translations/</span><span>images/</span><span>ocr/</span><span>captions/</span><span>backups/</span>
    <span style="margin-left:auto;color:var(--muted)">Atomic writes · rotating backups · easy migration</span>
  </div>
  <div class="node trustbox">
    <h3>Trust boundary</h3>
    <p>The server binds to 127.0.0.1 by default, validates host headers, blocks path traversal, strips dangerous markup, rate-limits request bodies, and refuses private-network targets in the image proxy. Nothing is uploaded; export files are generated on demand. No paywall, login or DRM is bypassed — only public feeds and publicly reachable article pages are read.</p>
  </div>
</div>
${footer('FIG. 07 · ARCHITECTURE')}`,
});

pages.push({
  file: '08-platforms.html',
  html: `
${head('08', 'Deployment', 'Five Platforms, One Codebase',
  'The same zero-dependency source runs on Windows, Linux, macOS, Android through Termux, and iPhone/iPad through iSH. Native installers are intentionally not faked.',
  ['Windows portable', 'Linux / macOS', 'Termux', 'iSH', 'No fake APK / IPA'])}
<div class="platforms">
  <div class="plat">
    <h3>Windows</h3><span class="st">PORTABLE · READY</span>
    <p>Windows 10/11 x64. The ZIP bundles Node.js, the app and a double-click launcher. No installer, no registry changes.</p>
    <ul><li>Bundled Node.js runtime</li><li>Portable data folder</li><li>Auto-opens the browser</li></ul>
    <div class="lbl">Quick start</div>
    <ol><li>Unzip the folder.</li><li>Double-click the VBS launcher.</li><li>The browser opens on port 7317.</li></ol>
    <code>Start Global Reading Room.vbs</code>
    <small>Data lives in the app’s data folder next to the launcher.</small>
  </div>
  <div class="plat">
    <h3>Linux</h3><span class="st">SOURCE · READY</span>
    <p>Any modern x64 or ARM distribution with Node.js 20 or newer. Launch from the extracted folder.</p>
    <ul><li>glibc or musl</li><li>No root required</li><li>xdg-open for the browser</li></ul>
    <div class="lbl">Quick start</div>
    <ol><li>Install Node.js 20+.</li><li>Run <b>chmod +x start.sh</b>.</li><li>Run <b>./start.sh</b>.</li></ol>
    <code>./start.sh</code>
    <small>Set GRR_PORT or GRR_DATA_DIR to relocate the service or its data.</small>
  </div>
  <div class="plat">
    <h3>macOS</h3><span class="st">SOURCE · READY</span>
    <p>macOS 12 or newer with Node.js 20+. Double-click the .command launcher, or run it from Terminal.</p>
    <ul><li>Apple silicon or Intel</li><li>No app bundle required</li><li>Gatekeeper: right-click → Open</li></ul>
    <div class="lbl">Quick start</div>
    <ol><li>Install Node.js 20+.</li><li>Double-click the .command file.</li><li>Allow it in Privacy &amp; Security.</li></ol>
    <code>Start Global Reading Room.command</code>
    <small>If Gatekeeper blocks it: right-click → Open once.</small>
  </div>
  <div class="plat">
    <h3>Android</h3><span class="st">TERMUX · READY</span>
    <p>No APK is provided. Install Termux from F-Droid, then run the installer; Node.js is installed inside Termux.</p>
    <ul><li>Android 8 or newer</li><li>Node.js via pkg</li><li>Localhost in your browser</li></ul>
    <div class="lbl">Quick start</div>
    <ol><li>Install Termux from F-Droid.</li><li>Copy the app and run the installer.</li><li>Open the printed localhost URL.</li></ol>
    <code>bash install-termux.sh</code>
    <small>Open the printed localhost URL in the phone browser.</small>
  </div>
  <div class="plat">
    <h3>iPhone / iPad</h3><span class="st exp">iSH · EXPERIMENTAL</span>
    <p>iSH emulates Alpine Linux. Install Node.js inside iSH and start the server; performance is modest but usable for reading.</p>
    <ul><li>Alpine / iSH</li><li>Keep it foregrounded</li><li>Reading-only performance</li></ul>
    <div class="lbl">Quick start</div>
    <ol><li>Install iSH from the App Store.</li><li>Run <b>apk add nodejs</b>.</li><li>Run <b>sh start-ish.sh</b>.</li></ol>
    <code>apk add nodejs &amp;&amp; sh start-ish.sh</code>
    <small>Keep iSH in the foreground while syncing large feeds.</small>
  </div>
</div>
<div class="note">Why no native APK, IPA, APP or DMG? Building and signing those packages requires platform SDKs and code-signing identities that are not available in this environment. Shipping an unsigned or repackaged binary would be dishonest. The Termux and iSH paths are fully supported alternatives, and the Windows ZIP is genuinely click-to-run because it bundles the official Node.js runtime.</div>
${footer('FIG. 08 · PLATFORMS')}`,
});

pages.push({
  file: '09-export-vault.html',
  html: `
${head('09', 'Offline library', 'Offline Export Vault',
  'Turn any article into Markdown or a self-styled HTML file, or package the current list into a ZIP with an index, README and one file per article — ready for any Markdown reader.',
  ['Markdown', 'Standalone HTML', 'ZIP up to 200', 'OPML'])}
<div class="stage">
  ${shot('ui-export.png', 'Live interface · export dialog', '', 'center')}
  <div class="calls">
    ${call('01', 'Current article', 'Download the article you are reading as Markdown or HTML, in original, translated or bilingual mode.')}
    ${call('02', 'Batch ZIP', 'Package up to 200 current-list articles. The archive includes an index and a README with export metadata.')}
    ${call('03', 'Media links preserved', 'Image references and video links are written into the export. Text works fully offline; remote images and embedded players still need a connection.')}
    ${call('04', 'OPML round-trip', 'Export your subscriptions as OPML for another reader, or import an existing OPML list into the app.')}
  </div>
</div>
${footer('FIG. 09 · EXPORT VAULT')}`,
});

pages.push({
  file: '10-lightbox.html',
  html: `
${head('10', 'Inspection', 'Zoom, Pan, Inspect',
  'News photography and data graphics deserve more than a thumbnail. Every article image opens into a full-screen inspection stage with precise zoom and drag controls.',
  ['Wheel zoom', 'Drag to pan', 'Double-click reset', 'Esc to close'])}
<div class="wide" style="flex:1;min-height:0">
  ${shot('ui-lightbox.png', 'Live interface · lightbox', '', 'center')}
  <div class="callrow">
    ${call('01', 'Zoom', 'Use the toolbar or the mouse wheel to move between 20% and 600%. The current scale is always visible.')}
    ${call('02', 'Pan', 'Drag the image to inspect any corner. The cursor changes while dragging and the position is preserved between zooms.')}
    ${call('03', 'Reset', 'Double-click the stage, or press the reset button, to return to fit-to-screen.')}
    ${call('04', 'Dismiss', 'Press Esc or click the close control. The reader stays exactly where you left it.')}
  </div>
</div>
${footer('FIG. 10 · LIGHTBOX')}`,
});

const dir = __dirname;
for (const page of pages) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Global Reading Room — Field Guide</title><style>${CSS}</style></head><body><div class="page">${page.html}</div></body></html>`;
  fs.writeFileSync(path.join(dir, page.file), html, 'utf8');
  console.log('wrote', page.file);
}

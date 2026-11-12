'use strict';

const { decodeEntities } = require('./util');

function parseAttributes(source) {
  const attrs = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = re.exec(source || ''))) {
    attrs[match[1]] = decodeEntities(match[2] != null ? match[2] : match[3]);
  }
  return attrs;
}

function localName(name) {
  const text = String(name || '');
  const index = text.indexOf(':');
  return index >= 0 ? text.slice(index + 1) : text;
}

const TOKEN_RE = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/\s*([A-Za-z_][\w:.-]*)\s*>|<\s*([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;

function parseXml(source) {
  const root = { name: '#document', local: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const text = String(source || '').replace(/^\uFEFF/, '');
  let cursor = 0;
  let match;

  function appendText(value, isCdata) {
    if (!value) return;
    const node = stack[stack.length - 1];
    node.text += isCdata ? value : decodeEntities(value);
  }

  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(text))) {
    if (match.index > cursor) appendText(text.slice(cursor, match.index), false);
    cursor = TOKEN_RE.lastIndex;

    if (match[1] !== undefined) {
      appendText(match[1], true);
      continue;
    }
    if (match[2]) {
      const closing = match[2];
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === closing || stack[i].local === localName(closing)) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (!match[3]) continue;

    const name = match[3];
    const node = {
      name,
      local: localName(name),
      attrs: parseAttributes(match[4] || ''),
      children: [],
      text: '',
    };
    stack[stack.length - 1].children.push(node);
    if (!match[5]) stack.push(node);
  }
  if (cursor < text.length) appendText(text.slice(cursor), false);
  return root;
}

function documentRoot(doc) {
  return doc && doc.children ? doc.children.find((child) => child.local !== '#text') || null : null;
}

function children(node, local) {
  if (!node || !node.children) return [];
  if (!local) return node.children;
  const target = local.toLowerCase();
  return node.children.filter((child) => child.local.toLowerCase() === target);
}

function first(node, local) {
  return children(node, local)[0] || null;
}

function deaccent(name) {
  return String(name || '').toLowerCase();
}

function* walk(node) {
  if (!node) return;
  yield node;
  for (const child of node.children || []) yield* walk(child);
}

function findAll(node, local) {
  const target = deaccent(local);
  const out = [];
  for (const item of walk(node)) {
    if (item.local && item.local.toLowerCase() === target) out.push(item);
  }
  return out;
}

function findDeep(node, local) {
  return findAll(node, local)[0] || null;
}

function textContent(node) {
  if (!node) return '';
  let out = node.text || '';
  for (const child of node.children || []) out += textContent(child);
  return out;
}

function cleanText(node) {
  return textContent(node).replace(/\s+/g, ' ').trim();
}

function attr(node, name) {
  if (!node || !node.attrs) return '';
  if (node.attrs[name] != null) return node.attrs[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(node.attrs)) {
    if (key.toLowerCase() === lower) return node.attrs[key];
  }
  return '';
}

module.exports = {
  parseXml,
  documentRoot,
  children,
  first,
  findAll,
  findDeep,
  textContent,
  cleanText,
  attr,
  localName,
  walk,
};

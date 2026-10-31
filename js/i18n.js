// 界面多语言：中文原文就是键，缺少译文时显示中文。游戏术语只从 i18n-terms.js 取。
import { MESSAGES } from './i18n-messages.js';
import { TERMS } from './i18n-terms.js';

const STORE_KEY = 'pil-lottery:lang';
export const LANGUAGES = [
  { id: 'zh', label: '中文', html: 'zh-CN' },
  { id: 'en', label: 'English', html: 'en' },
  { id: 'ja', label: '日本語', html: 'ja' },
];
const TRANSLATED_ATTRS = ['aria-label', 'placeholder', 'title', 'alt'];

// 语言由 i18n-boot.js 在页面显示前选定；服务端和测试里固定中文
let lang = globalThis.document?.documentElement.dataset.lang || 'zh';
export const currentLanguage = () => lang;

export function t(text, params = {}) {
  const template = lang === 'zh' ? text : MESSAGES[lang]?.[text] ?? text;
  return template.replace(/\{(\w+)\}/g, (full, key) => (key in params ? String(params[key]) : full));
}

const term = (kind, name) => (lang === 'zh' ? name : TERMS[lang]?.[kind]?.[name] ?? name);
export const charName = (char) => term('char', char.name);
export const talentName = (name) => term('talent', name);
export const traitName = (name) => term('trait', name);
export const roleName = (name) => term('role', name);
export const talentDesc = (node) => (lang === 'zh' ? node.desc : TERMS[lang]?.desc?.[node.name] ?? node.desc);
export const joinList = (items) => items.join(lang === 'en' ? ', ' : '、');

// 记住每个节点的中文原文；节点被脚本改写后，以新内容为准
const textSources = new WeakMap();
const attrSources = new WeakMap();

function translated(sources, key, current) {
  const known = sources.get(key);
  const source = known && known.shown === current ? known.source : current;
  const shown = t(source);
  sources.set(key, { source, shown });
  return shown;
}

function translateNode(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const current = node.nodeValue;
    const body = current.trim();
    if (!body) continue;
    const known = textSources.get(node);
    const source = known && known.shown === body ? known.source : body;
    const shown = t(source);
    textSources.set(node, { source, shown });
    if (shown !== body) node.nodeValue = current.replace(body, shown);
  }
  const elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
  for (const element of elements) {
    for (const attr of TRANSLATED_ATTRS) {
      const current = element.getAttribute(attr);
      if (!current) continue;
      let sources = attrSources.get(element);
      if (!sources) attrSources.set(element, sources = new Map());
      const shown = translated(sources, attr, current);
      if (shown !== current) element.setAttribute(attr, shown);
    }
  }
}

/** 翻译页面上的固定文字；脚本生成的固定结构也用它处理。 */
export function applyI18n(root = document) {
  if (root !== document) { translateNode(root); return; }
  document.documentElement.lang = LANGUAGES.find((l) => l.id === lang).html;
  translateNode(document.head);
  translateNode(document.body);
  const description = document.querySelector('meta[name="description"]');
  if (description) {
    description.dataset.source ??= description.content;
    description.content = t(description.dataset.source);
  }
  document.documentElement.classList.remove('i18n-pending');
}

export function bindLanguageSelect(onChange) {
  const select = document.querySelector('#lang-select');
  select.replaceChildren(...LANGUAGES.map(({ id, label }) => new Option(label, id, id === lang, id === lang)));
  select.addEventListener('change', () => {
    lang = select.value;
    try { localStorage.setItem(STORE_KEY, lang); } catch { /* 隐私模式等 */ }
    onChange(lang);
  });
}

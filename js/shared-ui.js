// 抽取页和选手页共用的界面函数。

import { POINTS_PER_LAYER } from './rules.js';
import { joinList, t, talentDesc, talentName } from './i18n.js';

const DESPAIR = '绝处逢生';
const SVG_NS = 'http://www.w3.org/2000/svg';
const ASSET_BASE = new URL('../', import.meta.url);

export const asset = (path) => new URL(encodeURI(path), ASSET_BASE).href;

/** 个别立绘主体偏离画面中央，按 characters.json 的 portrait_view 调整取景。 */
export function applyPortraitView(img, char, tile = false) {
  const view = char.portrait_view || {};
  const set = (name, value) => (value === undefined ? img.style.removeProperty(name) : img.style.setProperty(name, value));
  if (tile) {
    set('--tile-x', view.tile_x === undefined ? undefined : `${view.tile_x}%`);
    set('--tile-y', view.tile_y === undefined ? undefined : `${view.tile_y}%`);
    set('--tile-scale', view.tile_scale);
  } else {
    set('--portrait-x', view.card_x === undefined ? undefined : `${view.card_x}%`);
    set('--portrait-y', view.card_y === undefined ? undefined : `${view.card_y}%`);
  }
}

export function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

export function splitBuild(tree, build) {
  const lit = tree.talents.filter((n) => build.levels[n.id]).map((n) => ({ node: n, level: build.levels[n.id] }));
  return {
    ultimates: lit.filter((t) => t.node.is_ultimate),
    others: lit.filter((t) => !t.node.is_ultimate),
  };
}

/** 绝处逢生独立一行，大小和最终天赋相同，用颜色区分有无。 */
export function despairItem(tree, has) {
  const node = tree.findByName(DESPAIR);
  const li = el('li', `t t-ult is-single t-despair ${has ? 'is-on' : 'is-off'}`);
  li.title = t(has ? '带{name}' : '没带{name}', { name: talentName(DESPAIR) });
  li.setAttribute('aria-label', li.title);
  if (node?.icon?.local_path) {
    const img = new Image();
    img.src = asset(node.icon.local_path);
    img.alt = '';
    li.append(img);
  }
  li.append(el('span', '', talentName(DESPAIR)));
  return li;
}

export function talentItems(tree, build) {
  const { ultimates, others } = splitBuild(tree, build);
  const despair = tree.findByName(DESPAIR);
  const items = [];
  if (!ultimates.length) items.push(el('li', 't t-ult is-single is-none', t('无最终天赋')));
  for (const { node } of ultimates) {
    const li = el('li', ultimates.length === 1 ? 't t-ult is-single' : 't t-ult');
    const img = new Image();
    img.src = asset(node.icon.local_path);
    img.alt = '';
    li.append(img, el('span', '', talentName(node.name)));
    li.title = talentDesc(node);
    items.push(li);
  }
  if (despair) items.push(despairItem(tree, Boolean(build.levels[despair.id])));
  for (const { node, level } of others) {
    if (node === despair) continue;
    const li = el('li', 't', talentName(node.name));
    if (node.max_level > 1) li.append(el('small', '', level < node.max_level ? `${level}/${node.max_level}` : `${level}`));
    li.title = talentDesc(node);
    items.push(li);
  }
  items.forEach((li, i) => li.style.setProperty('--i', i));
  return items;
}

export function talentStatus(node, level) {
  if (node.is_ultimate) return t(level ? '最终天赋' : '最终天赋（未解锁）');
  return level ? t('{level}/{max} 层', { level, max: node.max_level }) : t('未解锁（最高 {max} 层）', { max: node.max_level });
}

export function renderWeb(svg, tree, build, { animate = false, detailed = false } = {}) {
  const levels = build?.levels || {};
  svg.replaceChildren();
  svg.classList.toggle('lighting', animate);

  const edges = svgEl('g', { class: 'edges' });
  for (const e of tree.edges) {
    const a = tree.byId.get(e.from);
    const b = tree.byId.get(e.to);
    const line = svgEl('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      class: levels[b.id] ? 'edge lit' : 'edge',
    });
    line.style.setProperty('--d', b.depth - 1);
    line.style.setProperty('--len', Math.hypot(b.x - a.x, b.y - a.y).toFixed(1));
    edges.append(line);
  }

  const nodes = svgEl('g', { class: 'nodes' });
  nodes.append(svgEl('circle', { class: 'hub', r: 13 }));
  for (const n of tree.talents) {
    const level = levels[n.id] || 0;
    const r = n.is_ultimate ? 31 : 25;
    const cls = ['node'];
    if (level) cls.push('lit');
    if (n.is_ultimate) cls.push('ult');
    const g = svgEl('g', { class: cls.join(' '), transform: `translate(${n.x} ${n.y})`, 'data-id': n.id });
    g.style.setProperty('--d', n.depth);
    if (detailed) {
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', `${talentName(n.name)}${t('，')}${talentStatus(n, level)}`);
    }
    const body = svgEl('g', { class: 'node-body' });
    if (n.is_ultimate) body.append(svgEl('circle', { class: 'burst', r: r + 4 }));
    body.append(svgEl('circle', { class: 'disc', r }));
    if (n.icon?.local_path) {
      body.append(svgEl('image', {
        href: asset(n.icon.local_path), x: -r * 0.8, y: -r * 0.8, width: r * 1.6, height: r * 1.6,
      }));
    }
    if (level && n.max_level > 1) {
      // 缩略图缩小显示，角标画大一些才看得清
      body.append(svgEl('circle', { class: 'badge', cx: r * 0.78, cy: -r * 0.78, r: detailed ? 13 : 19 }));
      const t = svgEl('text', { class: detailed ? 'badge-text' : 'badge-text badge-text-mini', x: r * 0.78, y: -r * 0.78 });
      t.textContent = String(level);
      body.append(t);
    }
    g.append(body);
    if (!detailed) {
      const title = svgEl('title');
      title.textContent = `${talentName(n.name)}　${level}/${n.max_level}${n.is_ultimate ? t('（最终天赋）') : ''}${n.desc ? `\n${talentDesc(n)}` : ''}`;
      g.append(title);
    }
    nodes.append(g);
  }
  svg.append(edges, nodes);
}

/** 人格文案：换行标签转成换行，去掉“【WIKI编辑组注：…】”。 */
export function cleanDescription(text) {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/【\s*WIKI编辑组注[\s\S]*?】/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** 打开人格树详情弹窗；页面里需要有 #dlg-tree。 */
export function showTreeDialog({ tree, build, side, name }) {
  const $ = (sel) => document.querySelector(sel);
  const { ultimates, others } = splitBuild(tree, build);
  const dlg = $('#dlg-tree');
  dlg.classList.remove('side-survivor', 'side-hunter');
  dlg.classList.add(`side-${side}`);
  $('#tree-title').textContent = t('{name}的人格', { name });
  $('#tree-sub').textContent = t('{layers} 层，{points} 点。', { layers: build.used, points: build.used * POINTS_PER_LAYER })
    + (ultimates.length ? t('最终天赋：{names}', { names: joinList(ultimates.map((u) => talentName(u.node.name))) }) : t('这套人格没有最终天赋'));

  const svg = svgEl('svg', { class: 'web', viewBox: '-372 -372 744 744', role: 'group', 'aria-label': t('人格树，点击人格图标查看详情') });
  renderWeb(svg, tree, build, { detailed: true });
  $('#tree-web').replaceChildren(svg);

  const list = $('#tree-list');
  list.replaceChildren(...[...ultimates, ...others].map(({ node, level }) => {
    const li = el('li', node.is_ultimate ? 'is-ult' : '');
    li.dataset.id = node.id;
    const img = new Image();
    img.src = asset(node.icon.local_path);
    img.alt = '';
    const body = el('div');
    const head = el('p', 'tree-item-head');
    head.append(el('b', '', talentName(node.name)), el('span', '', talentStatus(node, level)));
    body.append(head);
    if (node.desc) body.append(el('p', 'tree-item-desc', talentDesc(node)));
    li.append(img, body);
    return li;
  }));

  const focus = $('#tree-focus');
  focus.className = 'tree-focus is-empty';
  focus.textContent = t('点击人格树上的图标，查看对应人格的说明。');

  const select = (id, fromTree = true) => {
    const node = tree.byId.get(id);
    if (!node || node.is_center) return;
    const level = build.levels[id] || 0;
    svg.querySelectorAll('.node.is-selected').forEach((g) => g.classList.remove('is-selected'));
    svg.querySelector(`.node[data-id="${id}"]`)?.classList.add('is-selected');
    list.querySelectorAll('li').forEach((li) => li.classList.toggle('is-selected', li.dataset.id === id));

    const cls = ['tree-focus'];
    if (node.is_ultimate) cls.push('is-ult');
    if (!level) cls.push('is-off');
    focus.className = cls.join(' ');
    const img = new Image();
    img.src = asset(node.icon.local_path);
    img.alt = '';
    const body = el('div');
    const head = el('p', 'tree-focus-head');
    head.append(el('b', '', talentName(node.name)), el('span', '', talentStatus(node, level)));
    body.append(head, el('p', 'tree-focus-desc', talentDesc(node) || t('暂无说明。')));
    focus.replaceChildren(img, body);
    // 说明显示在固定位置，列表不跟着跳；窄屏时说明在人格树下方，要保证看得到
    if (fromTree) focus.scrollIntoView({ block: 'nearest' });
  };

  svg.addEventListener('click', (e) => {
    const g = e.target.closest('.node[data-id]');
    if (g) select(g.dataset.id);
  });
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const g = e.target.closest('.node[data-id]');
    if (!g) return;
    e.preventDefault();
    select(g.dataset.id);
  });
  list.onclick = (e) => {
    const li = e.target.closest('li[data-id]');
    if (li) select(li.dataset.id, false);
  };

  dlg.showModal();
}

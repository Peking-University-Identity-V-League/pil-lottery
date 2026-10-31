import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { MESSAGES } from '../js/i18n-messages.js';
import { TERMS } from '../js/i18n-terms.js';
import { FIT_RULES } from '../js/fit-rules.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const json = async (path) => JSON.parse(await read(path));
const HAN = /\p{Script=Han}/u;

test('every character, trait and talent has a sourced name in both languages', async () => {
  const chars = await json('characters.json');
  const traits = await json('auxiliary-traits.json');
  const trees = await json('talent-trees.json');
  const talents = Object.values(trees.trees).flatMap((tree) => tree.nodes.filter((n) => n.name).map((n) => n.name));
  assert.equal(talents.length, 80);
  for (const lang of ['en', 'ja']) {
    const terms = TERMS[lang];
    for (const c of [...chars.survivors, ...chars.hunters]) assert.ok(terms.char[c.name], `${lang} char ${c.name}`);
    for (const r of chars.survivors.flatMap((c) => c.roles || [])) assert.ok(terms.role[r], `${lang} role ${r}`);
    for (const t of traits.traits) assert.ok(terms.trait[t.name], `${lang} trait ${t.name}`);
    for (const n of talents) assert.ok(terms.talent[n], `${lang} talent ${n}`);
  }
  for (const [lang, kind] of [['en', 'char'], ['en', 'trait'], ['en', 'talent'], ['en', 'desc']]) {
    for (const value of Object.values(TERMS[lang][kind])) assert.ok(!HAN.test(value), `${lang} ${kind} ${value}`);
  }
});

test('English descriptions keep the same numbers as the Chinese text', async () => {
  const config = await json('tree-config-source.json');
  const numbers = (text) => [...new Set(text.replace(/（[^）]*）|【[^】]*】/g, '').match(/\d+(?:\.\d+)?/g) || [])].sort().join();
  for (const side of ['survivor', 'hunter']) {
    for (const node of config[side].treeData.nodes) {
      const english = TERMS.en.desc[node.name];
      if (english) assert.equal(numbers(english), numbers(node.content), node.name);
    }
  }
});

test('every interface string is translated and keeps its placeholders', async () => {
  const sources = await Promise.all([
    'js/app.js', 'js/live.js', 'js/shared-ui.js', 'js/fit-rules.js',
  ].map(read));
  const pages = await Promise.all(['index.html', 'live/index.html'].map(read));
  const keys = new Set();
  for (const source of sources) {
    for (const [, text] of source.matchAll(/'([^'\n<>]*\p{Script=Han}[^'\n<>]*)'/gu)) keys.add(text);
  }
  const skip = /^(绝处逢生|厂长|摄影师|梦之女巫|疯眼|时空之影|博士|红夫人|临界点|追猎|嬉弄|兴奋|张狂|应急储备|人格校验未通过|图片生成失败|不支持复制图片|第一位|第二位|第三位|第四位)$/;
  for (const page of pages) {
    const body = page.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '');
    for (const [, text] of body.matchAll(/>([^<>]*\p{Script=Han}[^<>]*)</gu)) keys.add(text.trim());
    for (const [, text] of body.matchAll(/(?:aria-label|placeholder|title|content)="([^"]*\p{Script=Han}[^"]*)"/gu)) keys.add(text);
  }
  for (const rule of FIT_RULES) for (const text of [rule.summary, rule.note]) if (text) keys.add(text);
  for (const key of keys) {
    if (skip.test(key)) continue;
    for (const lang of ['en', 'ja']) {
      assert.ok(MESSAGES[lang][key] !== undefined, `${lang} missing: ${key}`);
    }
  }
  const placeholders = (text) => (text.match(/\{\w+\}/g) || []).sort().join();
  for (const lang of ['en', 'ja']) {
    assert.deepEqual(Object.keys(MESSAGES[lang]).sort(), Object.keys(MESSAGES.en).sort());
    for (const [key, value] of Object.entries(MESSAGES[lang])) assert.equal(placeholders(value), placeholders(key), key);
  }
  for (const value of Object.values(MESSAGES.en)) assert.ok(!HAN.test(value), value);
});

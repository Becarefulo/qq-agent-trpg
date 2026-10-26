// trpg-tools 的本地补丁回归：种族 / 职业 / 等级 / 升一级 / 删卡 / 属性表。
//
// 这些是我们在市场插件上打的补丁，市场更新会覆盖——所以每一条都得有测试盯着，
// 一旦被覆盖掉就立刻红，而不是等群里发现"技能：等级1"这种怪东西。
//
// 运行：node test/trpg-tools-fields-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-tools-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const m = await import('../plugins/trpg-tools/index.js');
m.setup({ config: () => ({}), log: () => {}, warn: () => {}, fetch: fetch });

const cap = (name, args) => m.providers[name](args);
const chatKey = 'group:456';
const uid = '111';

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

check('属性表里有感知（DnD 六属性之一）', () => {
  const card = cap('trpg.character-set', { chatKey, userId: uid, key: '感知', value: 12, name: '张三' });
  assert.equal(card.attrs['感知'], 12);
  assert.ok(!('感知' in card.skills), '感知不该落进技能');
});

check('character-set 把 等级/种族/职业 写到对应字段，而不是技能', () => {
  cap('trpg.character-set', { chatKey, userId: uid, key: '等级', value: 3 });
  cap('trpg.character-set', { chatKey, userId: uid, key: '种族', value: '矮人' });
  cap('trpg.character-set', { chatKey, userId: uid, key: '职业', value: '战士' });
  const card = cap('trpg.character-get', { chatKey, userId: uid });
  assert.equal(card.level, 3, '等级应写进 level');
  assert.equal(card.race, '矮人');
  assert.equal(card.class, '战士');
  for (const bad of ['等级', '种族', '职业']) {
    assert.ok(!(bad in (card.skills || {})), `「${bad}」不该出现在技能里`);
  }
});

check('character-set 仍然能把未知键当技能（侦查 45）', () => {
  cap('trpg.character-set', { chatKey, userId: uid, key: '侦查', value: 45 });
  const card = cap('trpg.character-get', { chatKey, userId: uid });
  assert.equal(card.skills['侦查'], 45);
});

check('等级会被夹在 1~20', () => {
  cap('trpg.character-set', { chatKey, userId: uid, key: '等级', value: 999 });
  assert.equal(cap('trpg.character-get', { chatKey, userId: uid }).level, 20);
  cap('trpg.character-set', { chatKey, userId: uid, key: '等级', value: -5 });
  assert.equal(cap('trpg.character-get', { chatKey, userId: uid }).level, 1);
});

check('character-profile 能一次写种族/职业/等级', () => {
  const card = cap('trpg.character-profile', { chatKey, userId: uid, race: '精灵', clazz: '游侠', level: 2 });
  assert.equal(card.race, '精灵');
  assert.equal(card.class, '游侠');
  assert.equal(card.level, 2);
});

check('character-levelup：等级+1、按生命骰加血（战士 d10、体质14 → +7）', () => {
  cap('trpg.character-set', { chatKey, userId: uid, key: '体质', value: 14 });
  cap('trpg.character-profile', { chatKey, userId: uid, clazz: '战士', level: 2 });
  cap('trpg.character-set', { chatKey, userId: uid, key: 'hp', value: 15 });
  const r = cap('trpg.character-levelup', { chatKey, userId: uid });
  assert.equal(r.ok, true);
  assert.equal(r.level, 3);
  assert.equal(r.prevLevel, 2);
  assert.equal(r.gainHp, 8, 'd10 → floor(10/2)+1 = 6，体质14 调整值 +2，共 +8');
  assert.equal(r.hp, 23);
});

check('character-levelup：Lv.20 封顶，不再涨', () => {
  cap('trpg.character-profile', { chatKey, userId: uid, level: 20 });
  const r = cap('trpg.character-levelup', { chatKey, userId: uid });
  assert.equal(r.maxed, true);
  assert.equal(r.level, 20);
  assert.equal(r.gainHp, 0);
});

check('里程碑制：character-exp 已经移除', () => {
  assert.equal(m.providers['trpg.character-exp'], undefined);
});

check('character-clear：删掉整张卡', () => {
  assert.equal(cap('trpg.character-clear', { chatKey, userId: uid }), true);
  assert.equal(cap('trpg.character-get', { chatKey, userId: uid }), null);
  assert.equal(cap('trpg.character-clear', { chatKey, userId: uid }), false, '删不存在的卡应返回 false');
});

check('清单里声明了这些能力（否则审计会红）', () => {
  const manifest = JSON.parse(fs.readFileSync('plugins/trpg-tools/plugin.json', 'utf8').replace(/^\uFEFF/, ''));
  for (const c of ['trpg.character-clear', 'trpg.character-profile', 'trpg.character-levelup']) {
    assert.ok(manifest.capabilities.includes(c), `清单缺 ${c}`);
  }
  assert.ok(!manifest.capabilities.includes('trpg.character-exp'), '清单里不该再有 exp');
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\ntrpg-tools 字段补丁：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);

// 护甲 AC + 药水随身用 回归
//
// 这一版加了：
//   1) 三个装备槽（武器/护甲/盾牌），AC 按 PHB 规则算
//   2) 消耗品随身用：.pc 用 治疗药水 / .pc 用 解毒剂
//
// 明确不做：火把/绳索的场景效果、光照系统。
//
// 运行：node test/trpg-armor-item-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-armor-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const tools = await import('../plugins/trpg-tools/index.js');
tools.setup({ config: () => ({}), log: () => {}, warn: () => {}, fetch });
const cards = await import('../plugins/trpg-tools/cards.js');
cards.setupApi({
  config: () => ({}), log: () => {}, warn: () => {}, fetch,
  capability: (n, a) => tools.providers[n]?.(a),
  hasCapability: (n) => typeof tools.providers[n] === 'function',
});
const p = cards.__internals;

const chatKey = 'group:1';
const A = { chatKey, chatId: '1', senderId: '111', kind: 'group' };
const card = () => tools.providers['trpg.character-get']({ chatKey, userId: '111' });
const give = (t) => tools.providers['trpg.character-items']({ chatKey, userId: '111', text: t });

// 张三：敏捷 16（+3）、HP 12
tools.providers['trpg.character-set']({ chatKey, userId: '111', key: '敏捷', value: 16, name: '张三' });
tools.providers['trpg.character-set']({ chatKey, userId: '111', key: '力量', value: 10 });
tools.providers['trpg.character-set']({ chatKey, userId: '111', key: 'hp', value: 12 });

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

await check('无甲 AC = 10 + 敏捷（16 → 13）', async () => {
  assert.equal(p.acOf(card()), 13);
});

await check('穿皮甲：11 + 敏捷 = 14', async () => {
  give('皮甲');
  const t = await p.runPcEquip('皮甲', A);
  assert.match(t, /已穿上「皮甲」/, t);
  assert.match(t, /当前 AC：14/, t);
  assert.equal(card().armor, '皮甲');
  assert.equal(p.acOf(card()), 14);
});

await check('拿盾牌：+2 → 16', async () => {
  give('盾牌');
  const t = await p.runPcEquip('盾牌', A);
  assert.match(t, /AC \+2/, t);
  assert.match(t, /当前 AC：16/, t);
  assert.equal(card().shield, '盾牌');
  assert.equal(p.acOf(card()), 16);
});

await check('换链甲：16 且敏捷不再叠加 → 16 + 盾 2 = 18', async () => {
  give('链甲');
  await p.runPcEquip('链甲', A);
  assert.equal(p.acOf(card()), 18);
});

await check('链甲 + 敏捷 20 也只有 16（上限 0）', async () => {
  tools.providers['trpg.character-set']({ chatKey, userId: '111', key: '敏捷', value: 20 });
  assert.equal(p.acOf(card()), 18, '16 + 盾 2');
});

await check('鳞甲：14 + min(敏捷,2) = 16，加盾 18', async () => {
  tools.providers['trpg.character-items']({ chatKey, userId: '111', text: '鳞甲' });
  await p.runPcEquip('鳞甲', A);
  assert.equal(p.acOf(card()), 18, '14 + 2 + 2');
});

await check('卸下护甲 → 回到 10 + 敏捷，盾牌还在', async () => {
  const t = await p.runPcUnequip('护甲', A);
  assert.match(t, /已卸下护甲/, t);
  assert.equal(card().armor, '');
  // 敏捷 20 → +5，无甲 15，加盾 17
  assert.equal(p.acOf(card()), 17);
});

await check('卸下盾牌 → -2', async () => {
  await p.runPcUnequip('盾牌', A);
  assert.equal(card().shield, '');
  assert.equal(p.acOf(card()), 15);
});

await check('装备分槽：武器进 weapon、护甲进 armor，互不覆盖', async () => {
  give('长剑');
  give('皮甲');
  await p.runPcEquip('长剑', A);
  await p.runPcEquip('皮甲', A);
  const c = card();
  assert.equal(c.weapon, '长剑');
  assert.equal(c.armor, '皮甲');
});

await check('魔法护甲 +1：皮甲+1 → 12 + 敏捷', async () => {
  give('皮甲+1');
  await p.runPcEquip('皮甲+1', A);
  assert.equal(p.acOf(card()), 12 + 5, '敏捷 20 → +5');
});

await check('药水：随身用，回血并消耗', async () => {
  tools.providers['trpg.character-hp']({ chatKey, userId: '111', delta: -8 });   // 12 → 4
  assert.equal(card().hp, 4);
  give('治疗药水');
  const t = await p.runPcUse('治疗药水', '喝', A);
  assert.match(t, /HP 4\/12 → 12\/12/, t);
  assert.equal(card().hp, 12);
  assert.ok(!(card().items || []).includes('治疗药水'), '用掉后应该从背包消失');
});

await check('解毒剂：解除中毒并消耗', async () => {
  tools.providers['trpg.character-conditions']({ chatKey, userId: '111', add: ['中毒'] });
  assert.ok((card().conditions || []).includes('中毒'));
  give('解毒剂');
  const t = await p.runPcUse('解毒剂', '用', A);
  assert.match(t, /中毒解除/, t);
  assert.ok(!(card().conditions || []).includes('中毒'));
  assert.ok(!(card().items || []).includes('解毒剂'));
});

await check('背包里没有的东西用不了', async () => {
  const t = await p.runPcUse('传说中的神药', '用', A);
  assert.match(t, /背包里没有/, t);
});

await check('没有特殊效果的物品会直说（火把/绳索不做效果）', async () => {
  give('火把×5');
  const t = await p.runPcUse('火把×5', '用', A);
  assert.match(t, /没有特殊效果/, t);
  assert.ok((card().items || []).includes('火把×5'), '不该被消耗');
});

await check('卡面显示护甲/盾牌/AC', async () => {
  const text = p.renderStatus(card(), { maxSkills: 6, showItems: true });
  assert.match(text, /护甲：皮甲\+1/, text);
  assert.match(text, /AC：\d+/, text);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n护甲/药水：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);

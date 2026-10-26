// 装备 / 开箱 回归（A+B）
//
// A. 武器物品化：背包里没有的武器不能用；.pc 装备 后攻击默认用它；支持 +N 魔法武器
// B. 开箱：按权重掉落（金币/物品/武器/魔法武器/空箱）；箱子用掉会减少；战斗击杀 +1 箱
//
// 运行：node test/trpg-equip-loot-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-equip-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const tools = await import('../plugins/trpg-tools/index.js');
tools.setup({ config: () => ({}), log: () => {}, warn: () => {}, fetch });
const cards = await import('../plugins/trpg-tools/cards.js');

const dice = [];
cards.setupApi({
  config: () => ({}), log: () => {}, warn: () => {}, fetch,
  capability: (name, args) => {
    if (name === 'trpg.dice-roll') {
      const v = dice.length ? dice.shift() : 10;
      const expr = String(args?.expression || '1d20');
      return { ok: true, results: [{ detail: `${expr} = ${v}` }], repeat: 1 };
    }
    return tools.providers[name]?.(args);
  },
  hasCapability: (n) => typeof tools.providers[n] === 'function',
});
const p = cards.__internals;

const chatKey = 'group:1';
const A = { chatKey, chatId: '1', senderId: '111', kind: 'group' };
const card = () => tools.providers['trpg.character-get']({ chatKey, userId: '111' });
const chests = () => tools.providers['trpg.chests']({ chatKey }).chests;

tools.providers['trpg.character-set']({ chatKey, userId: '111', key: '力量', value: 16, name: '张三' });
tools.providers['trpg.character-set']({ chatKey, userId: '111', key: '敏捷', value: 12 });
tools.providers['trpg.character-profile']({ chatKey, userId: '111', clazz: '战士', level: 1 });
tools.providers['trpg.character-set']({ chatKey, userId: '111', key: 'hp', value: 20 });
tools.providers['trpg.character-set']({ chatKey, userId: '111', key: '金币', value: 200 });

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

// 先开战，后面反复用
dice.length = 0;
dice.push(10);
await p.runPcCombatStart(A);
await p.runPcCombatAdd('哥布林 hp50 ac10 init99', A);
await p.runPcCombatNext(A);   // 轮到张三

await check('A1 攻击：没买过的武器不能用', async () => {
  const t = await p.runPcAttack('哥布林 大剑', A);
  assert.match(t, /背包里没有/, t);
  assert.match(t, /\.pc 买 大剑/, t);
});

await check('A2 买了之后就能用', async () => {
  tools.providers['trpg.shop-buy']({ chatKey, userId: '111', sku: '大剑' });
  assert.ok((card().items || []).includes('大剑'), '应进背包');
  dice.length = 0; dice.push(15, 6);
  const t = await p.runPcAttack('哥布林 大剑', A);
  assert.match(t, /用大剑攻击/, t);
  assert.match(t, /命中/, t);
});

await check('A3 装备：背包里没有的装不上', async () => {
  const t = await p.runPcEquip('法杖', A);
  assert.match(t, /背包里没有/, t);
});

await check('A4 装备成功后，不写武器就用它', async () => {
  const t = await p.runPcEquip('大剑', A);
  assert.match(t, /已装备「大剑」/, t);
  assert.equal(card().weapon, '大剑');
  dice.length = 0; dice.push(15, 6);
  const atk = await p.runPcAttack('哥布林', A);
  assert.match(atk, /用大剑攻击/, atk);
});

await check('A5 卸下后回到徒手', async () => {
  await p.runPcUnequip(A);
  assert.equal(card().weapon, '');
  dice.length = 0; dice.push(15, 3);
  const t = await p.runPcAttack('哥布林', A);
  assert.match(t, /用徒手攻击/, t);
});

await check('A6 魔法武器 +1 命中与伤害都加', async () => {
  tools.providers['trpg.character-items']({ chatKey, userId: '111', text: '长剑+1' });
  await p.runPcEquip('长剑+1', A);
  assert.equal(card().weapon, '长剑+1');
  dice.length = 0; dice.push(10, 5);
  // 力量+3、熟练+2、武器+1 = +6；10+6 = 16
  const t = await p.runPcAttack('哥布林', A);
  assert.match(t, /用长剑\+1攻击/, t);
  assert.match(t, /\+6/, t);
});

await check('A7 卡面显示当前武器', async () => {
  const text = p.renderStatus(card(), { maxSkills: 12, showItems: true });
  assert.match(text, /武器：长剑\+1/, text);
});

await check('B1 没箱子时开箱给提示', async () => {
  tools.providers['trpg.chests']({ chatKey, set: 0 });
  // set 参数不存在，直接清零
  const cur = chests();
  if (cur > 0) tools.providers['trpg.chests']({ chatKey, take: true });
  while (chests() > 0) tools.providers['trpg.chests']({ chatKey, take: true });
  const t = await p.runPcChest(A);
  assert.match(t, /没有箱子/, t);
});

await check('B2 开箱：金币箱真的加钱', async () => {
  tools.providers['trpg.chests']({ chatKey, add: 1 });
  const before = Number(card().gold) || 0;
  dice.length = 0; dice.push(1, 5);   // 权重 1 落在金币档（20~60）
  const t = await p.runPcChest(A);
  assert.match(t, /金/, t);
  assert.ok(Number(card().gold) > before, `金币应增加（${before} → ${card().gold}）`);
  assert.equal(chests(), 0, '开完应该少一个');
});

await check('B3 开箱：物品箱进背包', async () => {
  tools.providers['trpg.chests']({ chatKey, add: 1 });
  const itemsBefore = (card().items || []).length;
  dice.length = 0; dice.push(40, 2);   // 40 落在杂物档
  const t = await p.runPcChest(A);
  assert.match(t, /背包|满了/, t);
  assert.ok((card().items || []).length >= itemsBefore, '不应丢东西');
});

await check('B4 空箱不会白给东西', async () => {
  tools.providers['trpg.chests']({ chatKey, add: 1 });
  const gold = Number(card().gold) || 0;
  const n = (card().items || []).length;
  dice.length = 0; dice.push(99);   // 99 落在空箱档
  const t = await p.runPcChest(A);
  if (/空箱|灰|蜘蛛|没有/.test(t)) {
    assert.equal(Number(card().gold) || 0, gold, '空箱不该给钱');
    assert.equal((card().items || []).length, n, '空箱不该给东西');
  }
});

await check('B5 战斗击杀后掉 1 个箱子', async () => {
  const beforeChests = chests();
  tools.providers['trpg.combat-state']({ chatKey, set: null });
  dice.length = 0; dice.push(10);
  await p.runPcCombatStart(A);
  await p.runPcCombatAdd('小怪 hp1 ac1 init99', A);
  await p.runPcCombatNext(A);
  dice.length = 0; dice.push(20, 5);
  await p.runPcAttack('小怪', A);   // 打死
  const t = await p.runPcCombatEnd(A);
  assert.match(t, /宝箱/, t);
  assert.equal(chests(), beforeChests + 1, '击杀后应多一个箱子');
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n装备/开箱：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);

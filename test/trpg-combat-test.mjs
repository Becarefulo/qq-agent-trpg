// 战斗系统回归（DnD 5e 简化版）
//
// 覆盖：开战自动掷先攻、加敌人、攻击命中/伤害/暴击、扣血、回合推进、结束。
//
// 运行：node test/trpg-combat-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-combat-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const tools = await import('../plugins/trpg-tools/index.js');
tools.setup({ config: () => ({}), log: () => {}, warn: () => {}, fetch });
const cards = await import('../plugins/trpg-tools/cards.js');

// 可控骰子：按队列返回
const dice = [];
const api = {
  config: () => ({}), log: () => {}, warn: () => {}, fetch,
  capability: (name, args) => {
    if (name === 'trpg.dice-roll') {
      const v = dice.length ? dice.shift() : 10;
      return { ok: true, results: [{ detail: `1d20 = ${v}` }], repeat: 1 };
    }
    return tools.providers[name]?.(args);
  },
  hasCapability: (n) => typeof tools.providers[n] === 'function',
};
cards.setupApi(api);
const p = cards.__internals;

const ctx = { chatKey: 'group:1', chatId: '1', senderId: '111', kind: 'group' };
const chatKey = 'group:1';

// 张三：力量16(+3)、敏捷16(+3)、战士 Lv1（熟练+2）→ 攻击 +5、HP 20
tools.providers['trpg.character-set']({ chatKey, userId: '111', key: '力量', value: 16, name: '张三' });
tools.providers['trpg.character-set']({ chatKey, userId: '111', key: '敏捷', value: 16 });
tools.providers['trpg.character-profile']({ chatKey, userId: '111', clazz: '战士', level: 1 });
tools.providers['trpg.character-set']({ chatKey, userId: '111', key: 'hp', value: 20 });
// 李四：敏捷10
tools.providers['trpg.character-set']({ chatKey, userId: '222', key: '敏捷', value: 10, name: '李四' });
tools.providers['trpg.character-set']({ chatKey, userId: '222', key: 'hp', value: 10 });

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

await check('没开战时给出提示', async () => {
  assert.match(await p.runPcCombat(ctx), /现在没有战斗/);
  assert.match(await p.runPcCombatNext(ctx), /没有战斗/);
});

await check('开战：自动掷先攻并排序（张三敏捷16 应排在李四前）', async () => {
  dice.length = 0;
  dice.push(5, 15);   // 张三 d20=5+3=8，李四 15+0=15 → 李四先手
  const t = await p.runPcCombatStart(ctx);
  assert.match(t, /战斗开始/, t);
  const c = tools.providers['trpg.combat-state']({ chatKey }).combat;
  assert.equal(c.active, true);
  assert.equal(c.round, 1);
  assert.equal(c.combatants.length, 2);
  assert.equal(c.combatants[0].name, '李四', '总先攻高的先手');
  assert.equal(c.combatants[0].init, 15);
  assert.equal(c.combatants[1].init, 8);
});

await check('加敌人：按 ac/hp/init 解析并重新排序', async () => {
  const t = await p.runPcCombatAdd('哥布林 hp12 ac13 init20', ctx);
  assert.match(t, /加入了 哥布林/, t);
  const c = tools.providers['trpg.combat-state']({ chatKey }).combat;
  const goblin = c.combatants.find((x) => x.name === '哥布林');
  assert.ok(goblin, '哥布林应在战场');
  assert.equal(goblin.hp, 12);
  assert.equal(goblin.ac, 13);
  assert.equal(c.combatants[0].name, '哥布林', 'init 20 应排第一');
});

await check('攻击：命中后扣血（d20 15 +5 vs AC13）', async () => {
  dice.length = 0;
  dice.push(15, 6);   // 命中（15+5=20 ≥13），伤害 1d8=6
  const t = await p.runPcAttack('哥布林 长剑', ctx);
  assert.match(t, /1d20=15 \+5 = 20 vs AC13/, t);
  assert.match(t, /命中/, t);
  assert.match(t, /9 点伤害/, t);   // 1d8=6 + 力量调整值 3
});

await check('攻击：没打中时不掉血', async () => {
  const before = tools.providers['trpg.combat-state']({ chatKey }).combat.combatants.find((x) => x.name === '哥布林').hp;
  dice.length = 0;
  dice.push(2);   // 2+5=7 < 13
  const t = await p.runPcAttack('哥布林 长剑', ctx);
  assert.match(t, /没打中/, t);
  const after = tools.providers['trpg.combat-state']({ chatKey }).combat.combatants.find((x) => x.name === '哥布林').hp;
  assert.equal(after, before, '未命中不该扣血');
});

await check('攻击：天然 20 暴击双倍伤害', async () => {
  dice.length = 0;
  dice.push(20, 4);   // nat20，伤害 1d8=4 → (4+3)×2 = 14
  const t = await p.runPcAttack('哥布林 长剑', ctx);
  assert.match(t, /暴击/, t);
  const goblin = tools.providers['trpg.combat-state']({ chatKey }).combat.combatants.find((x) => x.name === '哥布林');
  assert.equal(goblin.hp, 0, '暴击应打倒 12 HP 的哥布林');
  assert.match(t, /倒下了/, t);
});

await check('怪物打玩家：同步到人物卡 HP', async () => {
  dice.length = 0;
  const t = await p.runPcCombatHit('张三 8', ctx);
  assert.match(t, /受到 8 点伤害/, t);
  const card = tools.providers['trpg.character-get']({ chatKey, userId: '111' });
  assert.equal(card.hp, 12, '20 - 8 = 12');
});

await check('回合推进：走到头会进入下一轮', async () => {
  const c0 = tools.providers['trpg.combat-state']({ chatKey }).combat;
  const n = c0.combatants.length;
  for (let i = 0; i < n; i += 1) await p.runPcCombatNext(ctx);
  const c1 = tools.providers['trpg.combat-state']({ chatKey }).combat;
  assert.equal(c1.round, 2, '绕一圈应该进第 2 轮');
  assert.equal(c1.index, 0);
});

await check('结束战斗后状态清空', async () => {
  assert.match(await p.runPcCombatEnd(ctx), /战斗结束/);
  assert.equal(tools.providers['trpg.combat-state']({ chatKey }).combat, null);
  assert.match(await p.runPcCombat(ctx), /现在没有战斗/);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n战斗系统：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);

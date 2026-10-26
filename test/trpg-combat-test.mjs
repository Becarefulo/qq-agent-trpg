// 战斗系统 v2 回归（2026-10-26 重写）
//
// 这一版修了 5 个"不好用"的点，每一条都要有测试盯住：
//   ① 回合约束：不是你的回合不能打
//   ② 敌方回合：.战 敌方回合 让所有怪自动出手
//   ③ 战况 HP 实时同步（治疗/扣血后不能显示旧数字）
//   ④ 武器名容错：写"剑"能认成短剑，写错的给候选列表
//   ⑤ 灵巧武器取敏捷调整值（匕首/短弓等）
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

// 可控骰子：按队列返回 d20 结果
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

const chatKey = 'group:1';
const A = { chatKey, chatId: '1', senderId: '111', kind: 'group' };   // 张三
const B = { chatKey, chatId: '1', senderId: '222', kind: 'group' };   // 李四
const combatState = () => tools.providers['trpg.combat-state']({ chatKey }).combat;
const enemy = (name) => combatState()?.combatants.find((x) => x.name === name);

// 张三：力量16(+3)、敏捷16(+3)、魅力14、盗贼 Lv1（熟练+2）、HP 20
tools.providers['trpg.character-set']({ chatKey, userId: '111', key: '力量', value: 16, name: '张三' });
tools.providers['trpg.character-set']({ chatKey, userId: '111', key: '敏捷', value: 16 });
tools.providers['trpg.character-set']({ chatKey, userId: '111', key: '魅力', value: 14 });
tools.providers['trpg.character-profile']({ chatKey, userId: '111', clazz: '盗贼', level: 1 });
tools.providers['trpg.character-set']({ chatKey, userId: '111', key: 'hp', value: 20 });
// 李四：力量10、敏捷8、HP 10
tools.providers['trpg.character-set']({ chatKey, userId: '222', key: '力量', value: 10, name: '李四' });
tools.providers['trpg.character-set']({ chatKey, userId: '222', key: '敏捷', value: 8 });
tools.providers['trpg.character-set']({ chatKey, userId: '222', key: 'hp', value: 10 });

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

await check('没开战时给出提示', async () => {
  assert.match(await p.runPcCombat(A), /现在没有战斗/);
  assert.match(await p.runPcCombatNext(A), /没有战斗/);
});

await check('开战：自动掷先攻并排序', async () => {
  dice.length = 0;
  dice.push(5, 15);   // 张三 5+3=8，李四 15-1=14
  const t = await p.runPcCombatStart(A);
  assert.match(t, /战斗开始/, t);
  const c = combatState();
  assert.equal(c.active, true);
  assert.equal(c.combatants[0].name, '李四', '先攻高的先手');
  assert.equal(c.combatants[1].name, '张三');
});

await check('回合约束：不是自己的回合不能攻击', async () => {
  // 当前是李四的回合，张三去打应该被拒
  const t = await p.runPcAttack('哥布林 长剑', A);
  assert.match(t, /还没到你|轮到/, t);
});

await check('加敌人：解析 hp/ac/init/atk/dmg 并重排', async () => {
  const t = await p.runPcCombatAdd('哥布林 hp12 ac13 init30 atk5 dmg1d8+2', A);
  assert.match(t, /加入了 哥布林/, t);
  const g = enemy('哥布林');
  assert.equal(g.hp, 12);
  assert.equal(g.ac, 13);
  assert.equal(g.atk, 5);
  assert.equal(g.dmg, '1d8+2');
  assert.equal(combatState().combatants[0].name, '哥布林', 'init 30 应排第一');
});

await check('敌方回合：怪自动打玩家并扣卡上的 HP', async () => {
  dice.length = 0;
  dice.push(14, 6);   // 命中 14+5=19 ≥ AC13；伤害骰由 stub 返回 6
  const t = await p.runPcEnemyTurn(A);
  assert.match(t, /哥布林 攻击/, t);
  assert.match(t, /命中/, t);
  const card111 = tools.providers['trpg.character-get']({ chatKey, userId: '111' });
  const card222 = tools.providers['trpg.character-get']({ chatKey, userId: '222' });
  const damaged = (20 - Number(card111.hp)) + (10 - Number(card222.hp));
  assert.ok(damaged > 0, '敌方回合应该有人掉血');
});

await check('战况：HP 从人物卡实时同步（不再显示旧数字）', async () => {
  // 直接改卡（模拟治疗/受伤），不动战斗表
  tools.providers['trpg.character-set']({ chatKey, userId: '111', key: 'hp', value: 7 });
  const t = await p.runPcCombat(A);
  assert.match(t, /张三\s+HP 7\/20/, t);
});

await check('武器：写"剑"能容错认出来', async () => {
  const w = p.findWeapon('剑');
  assert.ok(w, '应认得出来');
  assert.ok(['短剑', '长剑'].includes(w.key), `认成了 ${w.key}`);
});

await check('武器：写错给出候选列表，不当徒手算', async () => {
  // 先把回合切到张三
  const c = combatState();
  c.index = c.combatants.findIndex((x) => x.name === '张三');
  tools.providers['trpg.combat-state']({ chatKey, set: c });
  const t = await p.runPcAttack('哥布林 火箭筒', A);
  assert.match(t, /不认识武器/, t);
  assert.match(t, /匕首/, t);
});

await check('灵巧武器：匕首用敏捷调整值', async () => {
  // 力量 10（+0）、敏捷 16（+3）→ 匕首应 +3 敏捷 +2 熟练 = +5
  tools.providers['trpg.character-set']({ chatKey, userId: '111', key: '力量', value: 10 });
  dice.length = 0;
  dice.push(12, 3);
  const t = await p.runPcAttack('哥布林 匕首', A);
  assert.match(t, /（敏捷）/, t);
  assert.match(t, /\+5/, '敏捷+3、熟练+2 = +5');
});

await check('回合推进：走满一圈进入下一轮', async () => {
  const before = combatState();
  const n = before.combatants.length;
  const round0 = Number(before.round) || 1;
  const index0 = Number(before.index) || 0;
  for (let i = 0; i < n; i += 1) await p.runPcCombatNext(A);
  const after = combatState();
  assert.equal(Number(after.index), index0, '走满一圈应回到同一个人');
  assert.equal(Number(after.round), round0 + 1, '走满一圈应该进下一轮');
});

await check('结束战斗后状态清空', async () => {
  assert.match(await p.runPcCombatEnd(A), /战斗结束/);
  assert.equal(combatState(), null);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n战斗系统 v2：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);

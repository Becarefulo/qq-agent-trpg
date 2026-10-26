// 初始装备（PHB 职业起步包）回归
//
// 规则：定职业时发一套（物品 + 金币 + 自动装备主武器），每个角色只发一次。
//
// 运行：node test/trpg-kit-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-kit-'));
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
const card = (uid) => tools.providers['trpg.character-get']({ chatKey, userId: uid });
const setProfile = (uid, clazz, name) => tools.providers['trpg.character-profile']({ chatKey, userId: uid, clazz, level: 1, name });

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

await check('战士：发长剑/盾牌/皮甲 + 20 金，并自动装备长剑', async () => {
  const c = setProfile('111', '战士', '张三');
  assert.deepEqual(c.items, ['长剑', '盾牌', '皮甲']);
  assert.equal(c.gold, 20);
  assert.equal(c.weapon, '长剑');
  assert.equal(c.kit, true);
});

await check('重复定同一个职业不会叠加', async () => {
  setProfile('111', '战士');
  setProfile('111', '战士');
  const c = card('111');
  assert.equal(c.gold, 20, '金币不该翻倍');
  assert.equal(c.items.length, 3, '物品不该重复');
});

await check('改职业不会发第二套（防刷）', async () => {
  setProfile('111', '法师');
  const c = card('111');
  assert.equal(c.gold, 20, '金币仍是 20');
  assert.deepEqual(c.items, ['长剑', '盾牌', '皮甲'], '还是原来那套');
  assert.equal(c.weapon, '长剑');
});

await check('盗贼：匕首/短剑/盗贼工具/皮甲 + 25 金，装备短剑', async () => {
  const c = setProfile('222', '盗贼', '李四');
  assert.deepEqual(c.items, ['匕首', '短剑', '盗贼工具', '皮甲']);
  assert.equal(c.gold, 25);
  assert.equal(c.weapon, '短剑');
});

await check('法师：法术书/匕首 + 15 金，装备匕首', async () => {
  const c = setProfile('333', '法师', '王五');
  assert.deepEqual(c.items, ['法术书', '匕首']);
  assert.equal(c.gold, 15);
  assert.equal(c.weapon, '匕首');
});

await check('没定职业时不发（先建卡后补职业才发）', async () => {
  tools.providers['trpg.character-set']({ chatKey, userId: '444', key: '力量', value: 12, name: '赵六' });
  const c = card('444');
  assert.equal(c.kit, undefined);
  assert.equal(c.gold, 0);
  assert.deepEqual(c.items, []);
});

await check('用 character-set 写职业也会发（GM 工具那条路）', async () => {
  tools.providers['trpg.character-set']({ chatKey, userId: '444', key: '职业', value: '野蛮人' });
  const c = card('444');
  assert.equal(c.class, '野蛮人');
  assert.deepEqual(c.items, ['大剑', '皮甲']);
  assert.equal(c.gold, 10);
  assert.equal(c.weapon, '大剑');
});

await check('清卡重来能再拿一次初始装备', async () => {
  tools.providers['trpg.character-clear']({ chatKey, userId: '111' });
  const c = setProfile('111', '游侠', '张三');
  assert.deepEqual(c.items, ['短弓', '短剑', '皮甲']);
  assert.equal(c.gold, 20);
  assert.equal(c.weapon, '短弓');
});

await check('拿到装备后直接能攻击（不用再买）', async () => {
  const ctx = { chatKey, chatId: '1', senderId: '222', kind: 'group' };
  tools.providers['trpg.character-set']({ chatKey, userId: '222', key: '力量', value: 14 });
  tools.providers['trpg.character-set']({ chatKey, userId: '222', key: 'hp', value: 10 });
  await p.runPcCombatStart(ctx);
  await p.runPcCombatAdd('哥布林 hp20 ac5 init99', ctx);
  // 把回合切到李四（队伍里可能还有别的卡）
  const c = tools.providers['trpg.combat-state']({ chatKey }).combat;
  c.index = c.combatants.findIndex((x) => String(x.userId) === '222');
  tools.providers['trpg.combat-state']({ chatKey, set: c });
  const t = await p.runPcAttack('哥布林', ctx);   // 不写武器，用装备的短剑
  assert.match(t, /用短剑攻击/, t);
});

await check('12 个职业都有起步包', async () => {
  const classes = ['战士', '圣武士', '野蛮人', '游侠', '盗贼', '牧师', '德鲁伊', '吟游诗人', '武僧', '邪术师', '术士', '法师'];
  for (const [i, clazz] of classes.entries()) {
    const c = setProfile(`9${i}`, clazz, `测试${i}`);
    assert.ok(c.kit === true, `${clazz} 没发`);
    assert.ok((c.items || []).length > 0, `${clazz} 没给物品`);
    assert.ok(Number(c.gold) > 0, `${clazz} 没给金币`);
    assert.ok(c.weapon, `${clazz} 没装备武器`);
    assert.ok(c.items.includes(c.weapon), `${clazz} 装备的 ${c.weapon} 不在背包里`);
  }
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n初始装备：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);

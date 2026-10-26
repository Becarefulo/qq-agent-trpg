// DnD 检定的回归：d20 + 修正 vs DC、优势/劣势、天然 20/1
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-d20-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const tools = await import('../plugins/trpg-tools/index.js');
tools.setup({ config: () => ({}), log: () => {}, warn: () => {}, fetch });

const registered = new Map();
const api = {
  config: () => ({}), log: () => {}, warn: () => {}, fetch,
  capability: (name, args) => tools.providers[name]?.(args),
  hasCapability: (name) => typeof tools.providers[name] === 'function',
  registerTool: (def) => { registered.set(def.id, def); },
  registerProvider: () => {}, utils: {},
};
const gm = await import('../skills/trpg-gm/index.js');
gm.setup(api);

const rollD20 = registered.get('roll_d20');
assert.ok(rollD20, 'roll_d20 应注册');

// 造一张卡：敏捷16(+3)、察觉技能值 5（含熟练）、力量8(-1)
tools.providers['trpg.character-set']({ chatKey: 'group:1', userId: '111', key: '敏捷', value: 16, name: '张三' });
tools.providers['trpg.character-set']({ chatKey: 'group:1', userId: '111', key: '力量', value: 8 });
tools.providers['trpg.character-set']({ chatKey: 'group:1', userId: '111', key: '察觉', value: 5 });

const ctx = { chatKey: 'group:1', session: { trigger: [{ senderId: '111', senderName: '张三' }] } };

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

// 固定骰子：把 trpg.dice-roll 换成本地可预测的版本
function stubDice(values) {
  let i = 0;
  tools.providers['trpg.dice-roll'] = (() => ({
    ok: true,
    results: values.map((v) => ({ detail: `1d20 = ${v}` })),
    repeat: values.length,
  }));
}

await check('普通检定：技能值取卡上的数（察觉 5），总和 = d20 + 5', async () => {
  stubDice([12]);
  const r = await rollD20.execute(ctx, { skill: '察觉', dc: 15 });
  assert.ok(!r.isError, r.content);
  assert.match(r.content, /1d20 = 12/, r.content);
  assert.match(r.content, /察觉 \+5/, r.content);
  assert.match(r.content, /17 vs DC15/, r.content);
  assert.match(r.content, /成功/, r.content);
});

await check('卡上没有该技能时退回属性调整值（力量8 → -1）', async () => {
  stubDice([10]);
  const r = await rollD20.execute(ctx, { skill: '运动', dc: 10 });
  assert.match(r.content, /力量调整值/, r.content);
  assert.match(r.content, /-1/, r.content);
  assert.match(r.content, /9 vs DC10/, r.content);
  assert.match(r.content, /失败/, r.content);
});

await check('优势：掷两次取高', async () => {
  stubDice([7, 18]);
  const r = await rollD20.execute(ctx, { skill: '察觉', dc: 15, mode: 'advantage' });
  assert.match(r.content, /7 \/ 18/, r.content);
  assert.match(r.content, /取 18（优势）/, r.content);
  assert.match(r.content, /23 vs DC15/, r.content);
});

await check('劣势：掷两次取低', async () => {
  stubDice([19, 3]);
  const r = await rollD20.execute(ctx, { skill: '察觉', dc: 10, mode: 'disadvantage' });
  assert.match(r.content, /取 3（劣势）/, r.content);
  assert.match(r.content, /8 vs DC10/, r.content);
});

await check('天然 20 大成功（即使总和不够）', async () => {
  stubDice([20]);
  const r = await rollD20.execute(ctx, { skill: '察觉', dc: 30 });
  assert.match(r.content, /大成功/, r.content);
});

await check('天然 1 大失败（即使总和够）', async () => {
  stubDice([1]);
  const r = await rollD20.execute(ctx, { skill: '察觉', dc: 5 });
  assert.match(r.content, /大失败/, r.content);
});

await check('裸掷（不给 skill）', async () => {
  stubDice([11]);
  const r = await rollD20.execute(ctx, { dc: 12, bonus: 2 });
  assert.match(r.content, /裸掷/, r.content);
  assert.match(r.content, /额外\+2/, r.content);
  assert.match(r.content, /13 vs DC12/, r.content);
});

await check('中毒时自动劣势（不用模型自己写 mode）', async () => {
  const cc = registered.get('set_condition');
  assert.ok(cc, 'set_condition 应注册');
  await cc.execute(ctx, { condition: '中毒' });
  stubDice([18, 4]);
  const r = await rollD20.execute(ctx, { skill: '察觉', dc: 15 });
  assert.match(r.content, /取 4（劣势）/, r.content);
  assert.match(r.content, /中毒/, r.content);
  await cc.execute(ctx, { condition: '中毒', action: 'remove' });
});

await check('没有劣势状态时不强行劣势', async () => {
  stubDice([18, 4]);
  const r = await rollD20.execute(ctx, { skill: '察觉', dc: 15 });
  assert.match(r.content, /1d20 = 18/, r.content);
  assert.ok(!r.content.includes('劣势'), r.content);
});

await check('take_rest：短休回血、长休回满', async () => {
  const rest = registered.get('take_rest');
  assert.ok(rest, 'take_rest 应注册');
  tools.providers['trpg.character-set']({ chatKey: 'group:1', userId: '111', key: 'hp', value: 3 });
  const s = await rest.execute(ctx, { kind: 'short' });
  assert.match(s.content, /短休完毕/, s.content);
  const l = await rest.execute(ctx, { kind: 'long' });
  assert.match(l.content, /HP/, l.content);
  const card = tools.providers['trpg.character-get']({ chatKey: 'group:1', userId: '111' });
  assert.equal(card.hp, card.maxHp, '长休应回满');
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\nDnD 检定：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);

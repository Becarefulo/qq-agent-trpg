// 跑团 GM 的掷骰工具回归：reason 不能污染表达式。
//
// 真实故障（2026-10-26）：模型传 {expression:"6#4d6", reason:"DND 5e"}，
// 工具把 reason 拼成了 "6#4d6 DND 5e"，骰子引擎严格解析 → 「多余的记号：D5」，
// 连失败三次还在重试。根因在工具自己拼字符串，不在模型。
//
// 运行：node test/trpg-gm-roll-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-gm-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

// 真·trpg-tools 能力（不改数据，只掷骰）
const tools = await import('../plugins/trpg-tools/index.js');
tools.setup({ config: () => ({}), log: () => {}, warn: () => {}, fetch: fetch });

const registered = new Map();
const api = {
  config: () => ({}),
  log: () => {},
  warn: () => {},
  fetch,
  capability: (name, args) => tools.providers[name]?.(args),
  hasCapability: (name) => typeof tools.providers[name] === 'function',
  registerTool: (def) => { registered.set(def.id, def); },
  registerProvider: () => {},
  utils: {},
};
api.registerTool = (def) => { registered.set(def.id, def); };

const gm = await import('../skills/trpg-gm/index.js');
gm.setup(api);

const roll = registered.get('roll_dice');
assert.ok(roll, 'roll_dice 应该注册上了');

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

await check('带 reason 时不该污染表达式（6#4d6 + "DND 5e"）', async () => {
  const r = await roll.execute({}, { expression: '6#4d6', reason: 'DND 5e' });
  assert.ok(!r.isError, `不该失败：${r.content}`);
  assert.match(r.content, /6 次|共 6 次/, r.content);
  assert.match(r.content, /4d6 = \[/, '应真的掷出 6 组 4d6');
  assert.match(r.content, /DND 5e/, '用途应该出现在回执标题里');
});

await check('repeat 参数照旧可用', async () => {
  const r = await roll.execute({}, { expression: '1d100', repeat: 3 });
  assert.ok(!r.isError, r.content);
  assert.match(r.content, /共 3 次/);
});

await check('表达式里混了文字：给可读错误 + 写法提示', async () => {
  const r = await roll.execute({}, { expression: '6#4d6 DND 5e' });
  assert.equal(r.isError, true);
  assert.match(r.content, /多余的记号/);
  assert.match(r.content, /reason 参数/, '应告诉模型把用途放 reason 里');
});

await check('空表达式：明确要参数', async () => {
  const r = await roll.execute({}, {});
  assert.equal(r.isError, true);
  assert.match(r.content, /缺少 expression/);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\nGM 掷骰工具：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);

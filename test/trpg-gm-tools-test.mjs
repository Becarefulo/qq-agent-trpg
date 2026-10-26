// 跑团 GM 工具回归（二）：update_character 的文本字段。
//
// 真实故障（2026-10-26）：模型传 {key:"种族", value:"侏儒"}，
// 工具层 schema 把 value 写死成 number、execute 里又无差别 Number()，
// 于是报「value 必须是数字」——而插件的能力其实早就支持文本字段了。
//
// 运行：node test/trpg-gm-tools-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-gmtools-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const tools = await import('../plugins/trpg-tools/index.js');
tools.setup({ config: () => ({}), log: () => {}, warn: () => {}, fetch });

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

const gm = await import('../skills/trpg-gm/index.js');
gm.setup(api);

const update = registered.get('update_character');
const getCard = registered.get('get_character');
assert.ok(update && getCard, '工具应注册');

// 模拟"张三在群里说话"
const ctx = {
  chatKey: 'group:456',
  session: { trigger: [{ senderId: '111', senderName: '张三' }] },
};

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

await check('写文本字段：种族 = 侏儒（原来是「value 必须是数字」）', async () => {
  const r = await update.execute(ctx, { key: '种族', value: '侏儒' });
  assert.ok(!r.isError, `不该失败：${r.content}`);
  assert.match(r.content, /已记录：种族 = 侏儒/, r.content);
  const card = tools.providers['trpg.character-get']({ chatKey: 'group:456', userId: '111' });
  assert.equal(card.race, '侏儒');
});

await check('写文本字段：职业 = 法师', async () => {
  const r = await update.execute(ctx, { key: '职业', value: '法师' });
  assert.ok(!r.isError, r.content);
  const card = tools.providers['trpg.character-get']({ chatKey: 'group:456', userId: '111' });
  assert.equal(card.class, '法师');
});

await check('写文本字段：名字 = 小明', async () => {
  const r = await update.execute(ctx, { key: '名字', value: '小明' });
  assert.ok(!r.isError, r.content);
  const card = tools.providers['trpg.character-get']({ chatKey: 'group:456', userId: '111' });
  assert.equal(card.name, '小明');
});

await check('数值字段照旧：力量 14（字符串 "14" 也能收）', async () => {
  const r = await update.execute(ctx, { key: '力量', value: '14' });
  assert.ok(!r.isError, r.content);
  const card = tools.providers['trpg.character-get']({ chatKey: 'group:456', userId: '111' });
  assert.equal(card.attrs['力量'], 14);
});

await check('技能照旧：侦查 45 进 skills', async () => {
  await update.execute(ctx, { key: '侦查', value: 45 });
  const card = tools.providers['trpg.character-get']({ chatKey: 'group:456', userId: '111' });
  assert.equal(card.skills['侦查'], 45);
});

await check('数值字段给了文字：可读错误 + 指向正确写法', async () => {
  const r = await update.execute(ctx, { key: '力量', value: '很强' });
  assert.equal(r.isError, true);
  assert.match(r.content, /必须是数字/, r.content);
  assert.match(r.content, /种族/, '应提示种族这类要传文字');
});

await check('等级走 character-set 也不会变成技能', async () => {
  await update.execute(ctx, { key: '等级', value: 3 });
  const card = tools.providers['trpg.character-get']({ chatKey: 'group:456', userId: '111' });
  assert.equal(card.level, 3);
  assert.ok(!('等级' in (card.skills || {})), '等级不该进技能');
});

await check('get_character 回执里能看出出身和等级', async () => {
  const r = await getCard.execute(ctx, {});
  assert.match(r.content, /身份：侏儒 · 法师 · Lv\.3/, r.content);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\nGM 人物卡工具：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);

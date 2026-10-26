// 金币 / 商店 / 地图 回归
//
// 这三个是 2026-10-27 新补的（原来是"工具在、能力没有"的假可用）。
// 重点验证：金币不许为负、买东西钱不够要拒、治疗药水真回血、地图只能走出口。
//
// 运行：node test/trpg-shop-map-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-shop-'));
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
const ctx = { chatKey: 'group:1', chatId: '1', senderId: '111', kind: 'group' };
const chatKey = 'group:1';
const getCard = () => tools.providers['trpg.character-get']({ chatKey, userId: '111' });

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

// 建卡：战士、体质14、HP 12/12
tools.providers['trpg.character-set']({ chatKey, userId: '111', key: '体质', value: 14, name: '张三' });
tools.providers['trpg.character-profile']({ chatKey, userId: '111', clazz: '战士', level: 1 });
tools.providers['trpg.character-set']({ chatKey, userId: '111', key: 'hp', value: 12 });

await check('金币：初始 0，加钱、扣钱、不许为负', async () => {
  assert.equal(Number(getCard().gold) || 0, 0, '新卡金币应为 0');
  await p.runPcGold('+120', ctx);
  assert.equal(getCard().gold, 120);
  await p.runPcGold('-30', ctx);
  assert.equal(getCard().gold, 90);
  await p.runPcGold('-999', ctx);
  assert.equal(getCard().gold, 0, '扣到负数要夹到 0');
});

await check('金币：查看回执带余额和写法', async () => {
  const t = await p.runPcGold('', ctx);
  assert.match(t, /金币：0/, t);
  assert.match(t, /\.pc 金币 \+50/, t);
});

await check('商店：列价目表，价钱是正数', async () => {
  const t = await p.runPcShop(ctx);
  assert.match(t, /【商店】/, t);
  assert.match(t, /治疗药水 — 50 金/, t);
  const r = tools.providers['trpg.shop-list']();
  assert.ok(r.items.length >= 8, '默认应该有 8 件以上');
  for (const it of r.items) assert.ok(it.price >= 0 && it.name, `商品不合法：${JSON.stringify(it)}`);
});

await check('买：钱不够时拒绝，且不扣钱、不进背包', async () => {
  tools.providers['trpg.character-set']({ chatKey, userId: '111', key: '金币', value: 10 });
  const t = await p.runPcBuy('法术书', ctx);
  assert.match(t, /买不了/, t);
  assert.match(t, /金币不够/, t);
  assert.equal(getCard().gold, 10, '失败不该扣钱');
  assert.ok(!(getCard().items || []).includes('法术书'), '失败不该进背包');
});

await check('买：物资类进背包并扣钱', async () => {
  tools.providers['trpg.character-set']({ chatKey, userId: '111', key: '金币', value: 100 });
  const t = await p.runPcBuy('火把', ctx);
  assert.match(t, /买下了/, t);
  assert.equal(getCard().gold, 98, '火把 2 金');
  assert.ok((getCard().items || []).some((x) => String(x).includes('火把')), '应进背包');
});

await check('买：治疗药水真回血', async () => {
  // 让 HP 处于受伤状态（maxHp 已经是 12）
  tools.providers['trpg.character-hp']({ chatKey, userId: '111', delta: -8 });
  assert.equal(getCard().hp, 4);
  const t = await p.runPcBuy('治疗药水', ctx);
  assert.match(t, /HP 4 → 12/, t);
  assert.equal(getCard().hp, 12);
});

await check('买：不存在的商品给可读错误', async () => {
  const t = await p.runPcBuy('宇宙飞船', ctx);
  assert.match(t, /商店里没有/, t);
});

await check('地图：没建图时给提示', async () => {
  const t = await p.runPcMap(ctx);
  assert.match(t, /还没有地图/, t);
});

await check('地图：建图后能看、能走、不能乱走', async () => {
  tools.providers['trpg.map-set']({
    chatKey,
    title: '小镇',
    current: '广场',
    places: {
      广场: { desc: '喷泉在滴水', exits: ['酒馆', '仓库'] },
      酒馆: { desc: '有人在打牌', exits: ['广场'] },
      仓库: { desc: '门锁着', exits: ['广场'] },
    },
  });

  const view = await p.runPcMap(ctx);
  assert.match(view, /【小镇】/, view);
  assert.match(view, /你在：广场/, view);
  assert.match(view, /酒馆、仓库/, view);

  const go = await p.runPcGo('酒馆', ctx);
  assert.match(go, /你来到「酒馆」/, go);
  assert.equal(tools.providers['trpg.map-get']({ chatKey }).map.current, '酒馆');

  // 酒馆只能回广场，不能直接去仓库
  const bad = await p.runPcGo('仓库', ctx);
  assert.match(bad, /过不去/, bad);
  assert.equal(tools.providers['trpg.map-get']({ chatKey }).map.current, '酒馆', '被拒时位置不该变');

  const unknown = await p.runPcGo('月亮', ctx);
  assert.match(unknown, /地图上没有/, unknown);
});

await check('卡面：金币显示出来', async () => {
  const text = p.renderStatus(getCard(), { maxSkills: 12, showItems: true });
  assert.match(text, /金币：\d+/, text);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n金币/商店/地图：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);

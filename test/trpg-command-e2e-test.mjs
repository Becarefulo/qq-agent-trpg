// 点指令端到端：消息 → before-incoming 钩子 → 插件处理 → 回复 → 不唤醒模型。
//
// 这段是核心新增的接线（src/app.js 的 ingestMessage），必须验证：
//   ① `.pc 建卡 …` 真的会被插件接走，群里收到卡面
//   ② 这一条**不产生 LLM 调用**（零 token 是这套设计的意义）
//   ③ 消息被标已读（不留在未读里）
//   ④ 普通消息仍然走原来的触发链路（钩子没破坏别的路）
//
// 运行：node test/trpg-command-e2e-test.mjs
import assert from 'node:assert/strict';
import { bootApp, sleep, waitFor } from './_harness.mjs';

const env = await bootApp({
  config: {
    // 4 档：所有消息都会进触发判定 —— 这样才能验证"静默闸"确实拦住了噪音，
    // 而不是靠档位随机没抽中。
    store: { contextSliderPos: 100, unifiedTier: true },
    // 只留跑团相关的插件；其它会自己开长连接的都在 harness 里默认关了
    skills: {
      'bot-schedule': { enabled: false },
      'mood-qzone': { enabled: false },
      'file-inbox': { enabled: false },
      'silence-ping': { enabled: false }
    }
  }
});
const { app, pushGroupMsg, llm, onebotHttp } = env;

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

const unread = () => app.store.getChatMeta('group:456').unread;
const sends = () => (onebotHttp.state.sends || []).filter((s) => s.action === 'send_group_msg');
const textOf = (s) => (s.body?.message || []).map((seg) => (seg.type === 'text' ? seg.data.text : '')).join('');

await check('.pc 建卡：不调模型、群里收到卡面、消息标已读', async () => {
  const before = llm.state.requests.length;
  pushGroupMsg(111, '张三', '.pc 建卡 名字 张三 力量60 敏捷50 体质55 侦查45', 8801);
  await waitFor(() => sends().length > 0, 8000, '卡面回复');
  await sleep(300);

  const last = sends().at(-1);
  assert.match(textOf(last), /【人物卡】/, `回复里应有卡面：${textOf(last)}`);
  assert.match(textOf(last), /力量60/);
  assert.match(textOf(last), /侦查45/);
  assert.equal(unread(), 0, '指令消息应被标已读');
  assert.equal(llm.state.requests.length, before, '点指令不该产生任何 LLM 调用');
});

await check('.pc 看：同一张卡读回来', async () => {
  const before = sends().length;
  pushGroupMsg(111, '张三', '.pc', 8802);
  await waitFor(() => sends().length > before, 8000, '再看一次');
  const t = textOf(sends().at(-1));
  assert.match(t, /【人物卡】/);
  assert.match(t, /敏捷50/);
  assert.equal(unread(), 0);
});

await check('.pc 队伍：卡册有这个人', async () => {
  const before = sends().length;
  pushGroupMsg(112, '李四', '.pc 队伍', 8803);
  await waitFor(() => sends().length > before, 8000, '卡册');
  const t = textOf(sends().at(-1));
  assert.match(t, /队伍卡册/);
  assert.match(t, /张三/);
});

await check('.pc 名字 XX：回执带原名字，卡面跟着变', async () => {
  let before = sends().length;
  pushGroupMsg(111, '张三', '.pc 名字 张四', 8810);
  await waitFor(() => sends().length > before, 8000, '改名');
  const r = textOf(sends().at(-1));
  assert.match(r, /改好了/, r);
  assert.match(r, /张四/);

  before = sends().length;
  pushGroupMsg(111, '张三', '.pc', 8811);
  await waitFor(() => sends().length > before, 8000, '改名后看卡');
  const card = textOf(sends().at(-1));
  assert.match(card, /【人物卡】张四/, card);
  assert.match(card, /力量60/, '改名不该动属性');
});

await check('.mod：剧本库列表', async () => {
  const before = sends().length;
  pushGroupMsg(111, '张三', '.mod', 8804);
  await waitFor(() => sends().length > before, 8000, '剧本库');
  const t = textOf(sends().at(-1));
  assert.ok(/剧本库|空的/.test(t), `应回剧本库或空库提示：${t}`);
});

await check('.pc roll：自动掷一套属性并写卡（也不调模型）', async () => {
  const before = sends().length;
  const beforeLlm = llm.state.requests.length;
  pushGroupMsg(113, '王五', '.pc roll 名字 王五', 8806);
  await waitFor(() => sends().length > before, 10000, '掷卡回复');
  const t = textOf(sends().at(-1));
  assert.match(t, /DnD 5e/, t);
  assert.match(t, /力量\d+/, t);
  assert.match(t, /HP\d+/, t);
  assert.match(t, /AC\d+/, t);
  assert.equal(llm.state.requests.length, beforeLlm, '掷卡不该调模型');
});

await check('.pc 种族/职业：改完卡面能看出来', async () => {
  let before = sends().length;
  pushGroupMsg(113, '王五', '.pc 种族 矮人', 8812);
  await waitFor(() => sends().length > before, 8000, '改种族');
  assert.match(textOf(sends().at(-1)), /种族改成「矮人」/);

  before = sends().length;
  pushGroupMsg(113, '王五', '.pc 职业 战士', 8813);
  await waitFor(() => sends().length > before, 8000, '改职业');
  assert.match(textOf(sends().at(-1)), /职业改成「战士」/);

  before = sends().length;
  pushGroupMsg(113, '王五', '.pc', 8814);
  await waitFor(() => sends().length > before, 8000, '看卡');
  assert.match(textOf(sends().at(-1)), /（矮人 · .*战士）/, '卡面标题应带出身');
});

await check('.pc 升级：里程碑式提一级，卡面显示 Lv', async () => {
  let before = sends().length;
  pushGroupMsg(113, '王五', '.pc 升级', 8815);
  await waitFor(() => sends().length > before, 8000, '升级');
  const r = textOf(sends().at(-1));
  assert.match(r, /升级！Lv\.1 → Lv\.2/, r);
  assert.match(r, /HP/, r);

  before = sends().length;
  pushGroupMsg(113, '王五', '.pc', 8816);
  await waitFor(() => sends().length > before, 8000, '看卡');
  const card = textOf(sends().at(-1));
  assert.match(card, /Lv\.2/, '升级后卡面标题应带 Lv.2');
});

await check('.pc 技能：车卡后能看到职业给的技能熟练', async () => {
  const before = sends().length;
  pushGroupMsg(113, '王五', '.pc 技能', 8830);
  await waitFor(() => sends().length > before, 8000, '技能清单');
  const t = textOf(sends().at(-1));
  assert.match(t, /【技能 · 共 \d+ 项】/, t);
  assert.match(t, /熟练加值 \+2/, t);
});

await check('.pc 出身：卡片里能看出背景，技能跟着对上', async () => {
  let before = sends().length;
  pushGroupMsg(113, '王五', '.pc 出身 士兵', 8831);
  await waitFor(() => sends().length > before, 8000, '改背景');
  assert.match(textOf(sends().at(-1)), /背景改成「士兵」/);

  before = sends().length;
  pushGroupMsg(113, '王五', '.pc', 8832);
  await waitFor(() => sends().length > before, 8000, '看卡');
  const card = textOf(sends().at(-1));
  assert.match(card, /士兵/, '卡面标题应带背景');
});

await check('.战 开：钩子能接住战斗指令（不是发给了模型）', async () => {
  const before = sends().length;
  const llmBefore = llm.state.requests.length;
  pushGroupMsg(113, '王五', '.战 开', 8833);
  await waitFor(() => sends().length > before, 8000, '开战回复');
  const t = textOf(sends().at(-1));
  assert.match(t, /战斗开始|没有人物卡|还没有战斗/, t);
  assert.equal(llm.state.requests.length, llmBefore, '战斗指令不该唤醒模型');
});

await check('.攻击：没回合时先拦回合（不是沉默）', async () => {
  const before = sends().length;
  pushGroupMsg(113, '王五', '.攻击 空气 长剑', 8834);
  await waitFor(() => sends().length > before, 8000, '攻击回复');
  // 回合约束优先：不是自己的回合就拦，且必须给明确回复（不能没反应）
  assert.match(textOf(sends().at(-1)), /没有战斗|战场上没有|还没到你|轮到/, textOf(sends().at(-1)));
});

await check('.pc 清卡：先警告、确认后整张删掉', async () => {
  let before = sends().length;
  pushGroupMsg(113, '王五', '.pc 清卡', 8807);
  await waitFor(() => sends().length > before, 8000, '清卡警告');
  assert.match(textOf(sends().at(-1)), /整张删掉/, textOf(sends().at(-1)));

  before = sends().length;
  pushGroupMsg(113, '王五', '.pc 清卡 确认', 8808);
  await waitFor(() => sends().length > before, 8000, '清卡确认');
  assert.match(textOf(sends().at(-1)), /已清空/, textOf(sends().at(-1)));

  before = sends().length;
  pushGroupMsg(113, '王五', '.pc', 8809);
  await waitFor(() => sends().length > before, 8000, '清空后看卡');
  assert.match(textOf(sends().at(-1)), /还没有人物卡/, '删完应该读不到卡');
});

await check('跑团静默：GM 开着时噪音不唤醒模型，玩家行动照常', async () => {
  // 先开 GM 模式（这条是指令，会被钩子接走）
  let before = sends().length;
  pushGroupMsg(111, '张三', '.gm on', 8820);
  await waitFor(() => sends().length > before, 8000, '开 GM');
  assert.match(textOf(sends().at(-1)), /跑团模式已开/, textOf(sends().at(-1)));

  // 4 档下一条"哈哈哈哈"本该唤醒模型，被静默闸吞掉
  const llmBefore = llm.state.requests.length;
  const sendBefore = sends().length;
  pushGroupMsg(112, '李四', '哈哈哈哈', 8821);
  await sleep(500);
  assert.equal(llm.state.requests.length, llmBefore, '噪音不该唤醒模型');
  assert.equal(sends().length, sendBefore, '噪音也不该收到任何回复');
  assert.equal(unread(), 0, '被吞的消息要标已读');

  // 玩家的角色行动照常走模型
  pushGroupMsg(112, '李四', '我推开门，先听一下里面的动静', 8822);
  await waitFor(() => llm.state.requests.length > llmBefore, 10000, '行动应触发模型');
});

await check('普通消息仍走模型（钩子没破坏触发链路）', async () => {
  const before = llm.state.requests.length;
  pushGroupMsg(111, '张三', '@覆盖Bot 在吗', 8805);
  await waitFor(() => llm.state.requests.length > before, 10000, '正常触发');
});

await env.teardown();

console.log(`\n点指令端到端：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);

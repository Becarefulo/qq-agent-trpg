// 「卡面与指令」回归：补 trpg.panel-* 面板能力 + .pc/.mod/.gm 点指令。
//
// 盯住三件事：
//   ① 卡面渲染：属性能出来、没有卡时给的是"怎么建"而不是空白
//   ② 指令解析：`.pc` / `。pc` / `.mod load` / `.gm on` 都认；普通聊天不认领
//   ③ 认领语义：处理成功要返回 { handled:true }（核心据此标已读、不唤醒模型）；
//      回复发不出去时必须返回 undefined，把消息还给模型兜底，不能吞掉
//
// 卡面与指令已并入 trpg-tools（plugins/trpg-tools/cards.js），这里直接测那个模块。
// 运行：node test/trpg-cards-test.mjs
import assert from 'node:assert/strict';

const plugin = await import('../plugins/trpg-tools/cards.js');
const { parseCommand, parsePc, parsePairs, renderStatus, renderParty, runPc, runPcRoll, runPcRollDnd, runPcClear, runPcRename, runPcProfile, runPcLevelUp, runPcSkills, findRace, findClass, pickClassSkills, skillBonus, CLASS_SKILLS, SKILL_ABILITY, BACKGROUNDS, findBackground, isNoiseMessage, isTrpgRelevant, RACES, CLASSES, runMod, runGm } = plugin.__internals;

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

// ── 指令解析 ───────────────────────────────────────────────────────────────
await check('认 .pc / 。pc / ．mod / .GM（大小写）', () => {
  assert.deepEqual(parseCommand('.pc'), { cmd: 'pc', rest: '' });
  assert.deepEqual(parseCommand('。pc 建卡 力量60'), { cmd: 'pc', rest: '建卡 力量60' });
  assert.equal(parseCommand('．mod load 蝗金岛').cmd, 'mod');
  assert.equal(parseCommand('.GM on').cmd, 'gm');
});

await check('普通聊天不认领（交给模型）', () => {
  for (const t of ['我想建卡', 'pc 是什么', '.p 哈', '。', '.pcn']) {
    assert.equal(parseCommand(t), null, `不该认领：${t}`);
  }
});

await check('.pc 子命令：看卡 / 队伍 / 建卡 / 掷卡', () => {
  assert.equal(parsePc('').action, 'show');
  assert.equal(parsePc('看').action, 'show');
  assert.equal(parsePc('队伍').action, 'party');
  assert.equal(parsePc('roll').action, 'roll');
  assert.equal(parsePc('掷').action, 'roll');
  assert.equal(parsePc('重掷 名字 张三').action, 'roll');
  assert.equal(parsePc('重掷 名字 张三').name, '张三');
  const set = parsePc('建卡 力量60 敏捷:50 侦查 45');
  assert.equal(set.action, 'set');
  assert.deepEqual(set.attrs, { 力量: 60, 敏捷: 50, 侦查: 45 });
});

await check('建卡能带名字（名字不算属性）', () => {
  const set = parsePc('建卡 名字 张三 力量60');
  assert.equal(set.name, '张三');
  assert.deepEqual(Object.keys(set.attrs), ['力量']);
});

await check('键值对容忍冒号与空格', () => {
  assert.deepEqual(parsePairs('力量60 敏捷:50 体质 45 智力=70'), { 力量: 60, 敏捷: 50, 体质: 45, 智力: 70 });
});

// ── 卡面渲染 ───────────────────────────────────────────────────────────────
await check('卡面：属性 / 生命 / 技能 / 随身都出来', () => {
  const text = renderStatus({
    userId: '111', name: '张三',
    attrs: { 力量: 60, 敏捷: 50 }, skills: { 侦查: 45, 图书馆: 60 },
    hp: 12, san: 55, items: ['手电筒', { name: '笔记本' }]
  }, { maxSkills: 12, showItems: true });
  assert.match(text, /【人物卡】张三/);
  assert.match(text, /力量60/);
  assert.match(text, /HP12/);
  assert.match(text, /侦查45/);
  assert.match(text, /手电筒/);
  assert.match(text, /笔记本/);
});

await check('卡面：技能按数值从高到低 + 有条数上限', () => {
  const skills = { a: 10, b: 90, c: 50, d: 70 };
  const text = renderStatus({ name: 'x', attrs: {}, skills }, { maxSkills: 2, showItems: false });
  const line = text.split('\n').find((l) => l.startsWith('技能：')) || '';
  assert.match(line, /b90、d70/);
  assert.ok(!line.includes('c50'), '超出上限的技能不该出现');
});

await check('卡面：没有卡时给的是"怎么建"', () => {
  const t = renderStatus(null, { maxSkills: 12, showItems: true });
  assert.match(t, /还没有人物卡/);
  assert.match(t, /\.pc 建卡/);
});

await check('卡册：列表编号 + 空卡册提示', () => {
  const t = renderParty({ list: [{ userId: '1', name: '张三', brief: '力量60' }, { userId: '2', name: '李四' }] });
  assert.match(t, /队伍卡册 · 2 人/);
  assert.match(t, /1\. 张三 · 力量60/);
  assert.match(renderParty({ list: [] }), /还没有人物卡/);
});

// ── 指令执行（用桩能力） ───────────────────────────────────────────────────
const card = { userId: '111', name: '张三', attrs: { 力量: 60 }, skills: {}, hp: 12, items: [] };
const calls = [];
function makeApi(overrides = {}) {
  const state = { set: {} };
  return {
    state,
    config: () => ({ prefix: '.', showItems: true, maxSkills: 12, ...overrides }),
    log: () => {}, warn: () => {},
    hasCapability: () => true,
    capability: (name, args) => {
      calls.push([name, args]);
      switch (name) {
        case 'trpg.character-set': state.set[args.key] = args.value; return { userId: args.userId };
        case 'trpg.character-get': return { ...card, attrs: { ...card.attrs }, skills: { ...state.set } };
        case 'trpg.character-public': return { list: [{ userId: '111', name: '张三', brief: '力量60' }] };
        case 'trpg.character-clear': state.cleared = args.userId; return true;
        case 'trpg.module-list': return { ok: true, modules: [{ id: 'mod-1', name: '蝗金岛', system: 'COC 7e', acts: [{ index: 1, title: '第一幕' }] }] };
        case 'trpg.scene-set': return { module: args.module, sceneIndex: args.sceneIndex };
        case 'trpg.gm-get': return true;
        case 'trpg.gm-set': return args.enabled;
        default: return undefined;
      }
    }
  };
}

const ctx = { kind: 'group', chatId: '456', chatKey: 'group:456', senderId: '111', senderName: '张三' };

await check('runPc 建卡：逐项写入并回卡面', async () => {
  calls.length = 0;
  plugin.setupApi(makeApi());
  const text = await runPc('建卡 力量60 敏捷50', ctx);
  const sets = calls.filter(([n]) => n === 'trpg.character-set');
  assert.equal(sets.length, 2, `应写两次，实际 ${sets.length}`);
  assert.match(text, /记下了 2 项/);
  assert.match(text, /力量60/);
});

await check('runPcRollDnd：4d6 取高 3、算调整值/HP/AC', async () => {
  // 每项都掷出 [6,5,4,1] → 取 6+5+4 = 15 → 调整值 +2
  const api = makeApi();
  const baseCap = api.capability;
  api.capability = (name, args) => {
    if (name === 'trpg.dice-roll') {
      assert.equal(args.expression, '4d6', 'DnD 应该掷 4d6（trpg-tools 不认 4d6k3）');
      return { ok: true, results: [{ detail: '4d6 = [6,5,4,1] = 16' }] };
    }
    return baseCap(name, args);
  };
  plugin.setupApi(api);

  const text = runPcRollDnd('张三', ctx);
  assert.match(text, /DnD 5e/, text);
  // 种族是随机的，属性会被种族加值改掉，所以这里断言"结构 + 公式自洽"而不是写死数字
  assert.match(text, /力量\d+\(\+?\d+\)/, `应显示属性+调整值：\n${text}`);
  assert.match(text, /感知\d+/, 'DnD 的第六项是感知');
  assert.match(text, /种族 \S+（/, '应写出种族');
  const hitDie = Number(/生命骰 d(\d+)/.exec(text)?.[1]);
  const con = Number(/体质(\d+)/.exec(text)?.[1]);
  const hp = Number(/HP(\d+)/.exec(text)?.[1]);
  assert.ok(hitDie >= 6 && hitDie <= 12, `生命骰应在 d6~d12：${hitDie}`);
  assert.equal(hp, Math.max(1, hitDie + Math.floor((con - 10) / 2)), `HP 应等于 生命骰+体质调整值（生命骰 d${hitDie}，体质 ${con}）`);
  const dex = Number(/敏捷(\d+)/.exec(text)?.[1]);
  // 职业给的起始技能：数量要等于该职业的 count，数值要等于 属性调整值 + 2
  const skillLine = /技能熟练：(.+?)（/.exec(text);
  assert.ok(skillLine, `应写出职业技能：\n${text}`);
  const picked = skillLine[1].split('、').map((s) => s.trim()).filter(Boolean);
  const clsName = /职业 (\S+)（生命骰/.exec(text)[1];
  const bgName = /背景 (\S+)（/.exec(text)[1];
  const bgDef = BACKGROUNDS.find((b) => b.name === bgName);
  assert.ok(bgDef, `背景应在表里：${bgName}`);
  const classCount = CLASS_SKILLS[clsName].count;
  // 技能 = 职业 ∪ 背景（重叠去重），所以数量在 [较大者, 两者之和]
  assert.ok(picked.length >= Math.max(classCount, bgDef.skills.length),
    `${clsName}(${classCount}) ∪ ${bgName}(${bgDef.skills.length}) 至多 ${picked.length} 项，太少了`);
  assert.ok(picked.length <= classCount + bgDef.skills.length,
    `${clsName} ∪ ${bgName} 最多 ${classCount + bgDef.skills.length} 项，实际 ${picked.length}`);
  for (const sk of bgDef.skills) {
    assert.ok(picked.some((line) => line.startsWith(sk)), `背景技能 ${sk} 应出现在卡上`);
  }
  // 种族自带的技能熟练（精灵察觉 / 半兽人威吓 / 半精灵任选 2）
  const raceName = /种族 (\S+)（/.exec(text)[1];
  const raceDef = RACES.find((r) => r.name === raceName);
  if (Array.isArray(raceDef?.skills) && raceDef.skills.length) {
    for (const sk of raceDef.skills) {
      assert.ok(picked.some((line) => line.startsWith(sk)), `种族技能 ${sk} 应出现在卡上`);
    }
  }
  const attrOf = (name) => Number(new RegExp(name + '(\\d+)').exec(text.slice(0, text.indexOf('HP')))?.[1]);
  for (const item of picked) {
    const m = /^(\S+?)([+-]\d+)$/.exec(item);
    assert.ok(m, `技能行格式不对：${item}`);
    const [, sk, val] = m;
    const ability = SKILL_ABILITY[sk];
    assert.ok(ability, `${sk} 应该能映射到属性`);
    const expect = Math.floor((attrOf(ability) - 10) / 2) + 2;
    assert.equal(Number(val), expect, `${sk} 应为 属性调整值+2 = ${expect}，实际 ${val}`);
  }
  assert.equal(Number(/AC(\d+)/.exec(text)?.[1]), 10 + Math.floor((dex - 10) / 2), 'AC = 10 + 敏捷调整值');
});

await check('.pc roll 只走 DnD（COC 已删除）', async () => {
  const api = makeApi();
  const baseCap = api.capability;
  api.capability = (name, args) => {
    if (name === 'trpg.dice-roll') return { ok: true, results: [{ detail: '4d6 = [5,4,3,2] = 14' }] };
    return baseCap(name, args);
  };
  plugin.setupApi(api);
  assert.match(runPcRoll('', ctx), /DnD 5e/, '默认应为 DnD');
  assert.equal(parsePc('roll coc').action, 'show', 'COC 已经不再支持，按普通看卡处理');
  assert.equal(parsePc('roll dnd').system, 'dnd5e');
});

await check('runPcRoll：掷骰能力缺失时给人话', () => {
  const api = makeApi();
  api.hasCapability = (name) => name !== 'trpg.dice-roll';
  plugin.setupApi(api);
  assert.match(runPcRoll('', ctx), /缺 trpg\.dice-roll/);
});

await check('runMod：列出剧本 + 载入按名字匹配', () => {
  plugin.setupApi(makeApi());
  assert.match(runMod('', ctx), /剧本库 · 1 本/);
  const loaded = runMod('load 蝗金岛', ctx);
  assert.match(loaded, /已载入《蝗金岛》/);
  assert.match(loaded, /第 1 幕：第一幕/);
  assert.match(runMod('load 不存在的本', ctx), /没有「不存在的本」/);
});

await check('runGm：查询 / 切换', () => {
  plugin.setupApi(makeApi());
  assert.match(runGm('', ctx), /现在是开的/);
  assert.match(runGm('off', ctx), /已关/);
  assert.match(runGm('乱写', ctx), /写法/);
});

// ── 钩子语义 ───────────────────────────────────────────────────────────────
await checkAsync('钩子：认领 .pc 并回复，返回 handled', async () => {
  const sent = [];
  const api = makeApi();
  api.fetch = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    return { ok: true };
  };
  plugin.setupApi(api);
  const out = await plugin.hooks['before-incoming']({ ...ctx, text: '.pc' });
  assert.deepEqual(out, { handled: true });
  assert.equal(sent.length, 1, '应该发一条回复');
  assert.match(sent[0].url, /\/api\/chats\/group_456\/test-send$/);
  assert.match(sent[0].body.text, /【人物卡】/);
});

await check('.pc 名字 XX：只动名字，载体字段原值回写', async () => {
  calls.length = 0;
  const api = makeApi();
  plugin.setupApi(api);
  const text = runPcRename('李四', ctx);
  assert.match(text, /改好了/, text);
  assert.match(text, /李四/);
  assert.match(text, /张三/, '回执里应带上原名字');
  const sets = calls.filter(([n]) => n === 'trpg.character-set');
  assert.equal(sets.length, 1, `应只写一次载体，实际 ${sets.length}`);
  const args = sets[0][1];
  assert.equal(args.name, '李四');
  assert.ok(Number.isFinite(Number(args.value)), '载体值必须是数字，否则 character-set 会整条丢掉');
  assert.equal(args.key, '力量', '应挑一个已存在的属性当载体');
  assert.equal(Number(args.value), 60, '载体字段要原值回写（等于没改）');
});

await check('.pc 名字 XX：没有卡时让人先建卡', () => {
  const api = makeApi();
  const base = api.capability;
  api.capability = (n, a) => (n === 'trpg.character-get' ? null : base(n, a));
  plugin.setupApi(api);
  assert.match(runPcRename('李四', ctx), /还没有人物卡/);
});

await check('种族/职业：能按名字找，也能模糊找', () => {
  assert.equal(findRace('矮人').name, '矮人');
  assert.equal(findRace('矮').name, '矮人');
  assert.equal(findRace('火星人'), null);
  assert.equal(findClass('战士').hitDie, 10);
  assert.equal(findClass('法').name, '法师');
  assert.equal(findClass('不存在'), null);
  assert.ok(RACES.length >= 9, 'DnD 核心种族至少 9 个');
  assert.ok(CLASSES.every((c) => c.hitDie >= 6 && c.hitDie <= 12), '生命骰应在 d6~d12');
});

await check('.pc roll 会 roll 出种族和职业，HP 按职业生命骰算', async () => {
  const api = makeApi();
  const baseCap = api.capability;
  const profile = [];
  api.hasCapability = () => true;
  api.capability = (name, args) => {
    if (name === 'trpg.dice-roll') return { ok: true, results: [{ detail: '4d6 = [6,5,4,1] = 16' }] };
    if (name === 'trpg.character-profile') { profile.push(args); return { userId: args.userId }; }
    return baseCap(name, args);
  };
  plugin.setupApi(api);
  const text = runPcRollDnd('王五', ctx);
  const race = /种族 (\S+)（/.exec(text);
  const klass = /职业 (\S+)（生命骰 d(\d+)）/.exec(text);
  assert.ok(race, `应该写出种族：\n${text}`);
  assert.ok(klass, `应该写出职业和生命骰：\n${text}`);
  assert.ok(RACES.some((r) => r.name === race[1]), `种族应在表里：${race[1]}`);
  assert.ok(CLASSES.some((c) => c.name === klass[1]), `职业应在表里：${klass[1]}`);
  assert.equal(profile.length, 1, '应该把种族/职业写进卡');
  assert.equal(profile[0].race, race[1]);
  assert.equal(profile[0].clazz, klass[1]);
});

await check('.pc 种族 X：认不出时给候选，认得出就改', () => {
  const api = makeApi();
  plugin.setupApi(api);
  assert.match(runPcProfile('race', '火星人', ctx), /没认出/, '未知种族应拒绝');
  assert.match(runPcProfile('race', '火星人', ctx), /矮人/);
  const ok = runPcProfile('race', '矮人', ctx);
  assert.match(ok, /种族改成「矮人」/, ok);
  assert.match(ok, /不会自动重算/, '要说明属性不重算');
  const job = runPcProfile('clazz', '战士', ctx);
  assert.match(job, /职业改成「战士」/, job);
  assert.match(job, /d10/);
});

await check('卡面：种族职业显示在标题里', () => {
  const text = renderStatus({ name: '王五', race: '矮人', class: '战士', attrs: { 力量: 12, 感知: 10 }, hp: 12 }, { maxSkills: 12, showItems: true });
  assert.match(text, /【人物卡】王五（矮人 · 战士）/, text);
});

await check('.pc 升级：里程碑式，等级+1、HP 按生命骰涨、熟练加值跟着涨', () => {
  const api = makeApi();
  const base = api.capability;
  const callsSeen = [];
  api.hasCapability = () => true;
  api.capability = (name, args) => {
    if (name === 'trpg.character-get') return { userId: '111', name: '张三', class: '战士', level: 3, attrs: { 体质: 16 }, hp: 20 };
    if (name === 'trpg.character-levelup') {
      callsSeen.push(args);
      // 战士 d10、体质16(+3) → 平均血量 5+1+3 = 9
      return { ok: true, level: 4, prevLevel: 3, maxed: false, gainHp: 9, prevHp: 20, hp: 29, hitDie: 10 };
    }
    return base(name, args);
  };
  plugin.setupApi(api);
  const text = runPcLevelUp(ctx);
  assert.match(text, /Lv\.3 → Lv\.4/, text);
  assert.match(text, /HP 20 → 29（\+9）/, text);
  assert.match(text, /熟练加值 \+2/, text);
  assert.equal(callsSeen.length, 1, '应调用一次升级能力');
  assert.equal(callsSeen[0].userId, '111');
});

await check('.pc 升级：满级时不再升', () => {
  const api = makeApi();
  const base = api.capability;
  api.hasCapability = () => true;
  api.capability = (name, args) => {
    if (name === 'trpg.character-get') return { userId: '111', name: '张三', class: '战士', level: 20, attrs: {}, hp: 99 };
    if (name === 'trpg.character-levelup') return { ok: true, level: 20, prevLevel: 20, maxed: true, gainHp: 0, hp: 99 };
    return base(name, args);
  };
  plugin.setupApi(api);
  assert.match(runPcLevelUp(ctx), /满级/);
});

await check('卡面：等级和熟练加值显示出来（没有经验条）', () => {
  const text = renderStatus({
    name: '王五', race: '矮人', class: '战士', level: 3,
    attrs: { 力量: 16, 感知: 11 }, hp: 20
  }, { maxSkills: 12, showItems: true });
  assert.match(text, /【人物卡】王五（矮人 · 战士 · Lv\.3）/, text);
  assert.ok(!text.includes('经验'), '不该再有经验条');
  assert.match(text, /Lv\.3  熟练 \+2/, text);
});

await check('静默闸：噪音判定（表情包/语气词/纯标点）', () => {
  for (const s of ['', '[图片]', '[表情]', '哈哈哈哈', '草', '666', '？', '……', 'awsl']) {
    assert.equal(isNoiseMessage(s), true, `应判为噪音：「${s}」`);
  }
  for (const s of ['我推开门', '投个侦查', '今天天气不错', '这把稳了兄弟们']) {
    assert.equal(isNoiseMessage(s), false, `不该判成噪音：「${s}」`);
  }
});

await check('静默闸：跑团相关判定（strict 档用）', () => {
  for (const s of ['我推开门', '投个侦查', '攻击那个哥布林', '我的力量够吗', '过个聆听', '先攻怎么算']) {
    assert.equal(isTrpgRelevant(s, false), true, `应判为相关：「${s}」`);
  }
  for (const s of ['今天天气不错', '哈哈哈哈', '[图片]', '这电影好看吗']) {
    assert.equal(isTrpgRelevant(s, false), false, `应判为无关：「${s}」`);
  }
  assert.equal(isTrpgRelevant('随便说点啥', true), true, '@ 了就算相关');
});

await checkAsync('静默闸：GM 开着时噪音被吞（不回复、零 token）', async () => {
  const sent = [];
  const api = makeApi();
  api.fetch = async (url, opts) => { sent.push(opts); return { ok: true }; };
  api.capability = (name, args) => (name === 'trpg.gm-get' ? true : api.__base(name, args));
  const base = makeApi();
  api.__base = base.capability;
  plugin.setupApi(api);
  const out = await plugin.hooks['before-incoming']({ ...ctx, text: '哈哈哈哈' });
  assert.deepEqual(out, { handled: true }, '应吞掉并标已读');
  assert.equal(sent.length, 0, '吞掉就不该发任何消息');
});

await checkAsync('静默闸：GM 开着时玩家行动照常走模型', async () => {
  const api = makeApi();
  const base = makeApi();
  api.capability = (name, args) => (name === 'trpg.gm-get' ? true : base.capability(name, args));
  plugin.setupApi(api);
  const out = await plugin.hooks['before-incoming']({ ...ctx, text: '我推开门' });
  assert.equal(out, undefined, '行动不该被吞，要交给模型');
});

await checkAsync('静默闸：GM 关着时什么都不吞（闲聊照常）', async () => {
  const api = makeApi();
  const base = makeApi();
  api.capability = (name, args) => (name === 'trpg.gm-get' ? false : base.capability(name, args));
  plugin.setupApi(api);
  assert.equal(await plugin.hooks['before-incoming']({ ...ctx, text: '哈哈哈哈' }), undefined);
});

await checkAsync('静默闸：@ 了机器人就不装死', async () => {
  const api = makeApi();
  const base = makeApi();
  api.capability = (name, args) => (name === 'trpg.gm-get' ? true : base.capability(name, args));
  plugin.setupApi(api);
  assert.equal(await plugin.hooks['before-incoming']({ ...ctx, text: '哈哈哈哈', atMe: true }), undefined);
});

await check('.pc 技能：列出全部技能（不受卡面截断影响）', () => {
  const api = makeApi();
  const base = api.capability;
  api.hasCapability = () => true;
  api.capability = (name, args) => {
    if (name === 'trpg.character-get') {
      return {
        userId: '111', name: '张三', level: 5,
        attrs: { 力量: 14 },
        skills: { 侦查: 45, 图书馆: 60, 潜行: 30, 话术: 50 }
      };
    }
    return base(name, args);
  };
  plugin.setupApi(api);
  const text = runPcSkills(ctx);
  assert.match(text, /技能 · 共 4 项/, text);
  assert.match(text, /图书馆 60/, text);
  assert.match(text, /侦查 45/, text);
  assert.ok(text.indexOf('图书馆 60') < text.indexOf('侦查 45'), '应按数值降序');
  assert.match(text, /熟练加值 \+3/, 'Lv.5 → 熟练 +3');
});

await check('.pc 技能：没登记时给写法', () => {
  const api = makeApi();
  const base = api.capability;
  api.hasCapability = () => true;
  api.capability = (name, args) => (name === 'trpg.character-get'
    ? { userId: '111', name: '张三', attrs: { 力量: 14 }, skills: {} }
    : base(name, args));
  plugin.setupApi(api);
  const text = runPcSkills(ctx);
  assert.match(text, /还没有登记任何技能/);
  assert.match(text, /.pc 侦查45/, '应给出写法');
});

await check('职业技能表：数量/范围来自 5e 数据', () => {
  assert.equal(CLASS_SKILLS['战士'].count, 2);
  assert.equal(CLASS_SKILLS['盗贼'].count, 4);
  assert.equal(CLASS_SKILLS['游侠'].count, 3);
  assert.equal(CLASS_SKILLS['吟游诗人'].from, null, '吟游诗人是任意 3 项');
  for (const [cls, def] of Object.entries(CLASS_SKILLS)) {
    const picked = pickClassSkills(cls);
    assert.equal(picked.length, def.count, `${cls} 应挑 ${def.count} 项`);
    assert.equal(new Set(picked).size, picked.length, '不该重复挑同一个技能');
    if (def.from) {
      for (const sk of picked) assert.ok(def.from.includes(sk), `${cls} 的技能 ${sk} 不在允许列表里`);
    }
    for (const sk of picked) assert.ok(SKILL_ABILITY[sk], `${sk} 缺属性映射`);
  }
});

await check('技能值 = 属性调整值 + 熟练加值', () => {
  assert.equal(skillBonus('察觉', { 感知: 14 }, 1), 2 + 2);     // +2 mod +2 熟练
  assert.equal(skillBonus('察觉', { 感知: 14 }, 5), 2 + 3);     // Lv.5 熟练 +3
  assert.equal(skillBonus('运动', { 力量: 8 }, 1), -1 + 2);
  assert.equal(skillBonus('不存在', { 力量: 8 }, 1), null);
});

await check('背景表：13 个 PHB 核心背景，技能都能映射到属性', () => {
  assert.equal(BACKGROUNDS.length, 13);
  for (const b of BACKGROUNDS) {
    assert.equal(b.skills.length, 2, `${b.name} 应该给 2 项技能`);
    for (const sk of b.skills) assert.ok(SKILL_ABILITY[sk], `${sk} 缺属性映射`);
  }
  assert.equal(findBackground('士兵').name, '士兵');
  assert.equal(findBackground('兵').name, '士兵');
  assert.equal(findBackground('火星人'), null);
});

await check('.pc 出身：改背景，认不出给候选', () => {
  assert.deepEqual(parsePc('出身 士兵'), { action: 'profile', field: 'bg', value: '士兵' });
  assert.deepEqual(parsePc('背景 智者'), { action: 'profile', field: 'bg', value: '智者' });

  const api = makeApi();
  api.hasCapability = () => true;
  api.capability = (name, args) => (name === 'trpg.character-get'
    ? { userId: '111', name: '张三' }
    : (name === 'trpg.character-profile' ? { userId: '111' } : undefined));
  plugin.setupApi(api);
  const ok = runPcProfile('bg', '士兵', ctx);
  assert.match(ok, /背景改成「士兵」/, ok);
  assert.match(ok, /运动、威吓/);
  const bad = runPcProfile('bg', '火星人', ctx);
  assert.match(bad, /没认出/, bad);
  assert.match(bad, /流浪儿/, '应列出候选');
});

await check('种族表：加值/自选/技能都对得上 5e 数据', () => {
  const byName = Object.fromEntries(RACES.map((r) => [r.name, r]));
  assert.deepEqual(byName['精灵'].bonus, { 敏捷: 2 });
  assert.deepEqual(byName['精灵'].skills, ['察觉'], '精灵自带察觉');
  assert.deepEqual(byName['半兽人'].skills, ['威吓'], '半兽人自带威吓');
  assert.deepEqual(byName['半精灵'].skills, { any: 2 }, '半精灵任选 2 项技能');
  assert.equal(byName['半精灵'].pick.count, 2, '半精灵任选两项 +1');
  assert.deepEqual(byName['龙裔'].bonus, { 力量: 2, 魅力: 1 });
  assert.deepEqual(byName['侏儒'].bonus, { 智力: 2 });
  assert.deepEqual(byName['提夫林'].bonus, { 魅力: 2, 智力: 1 });
  assert.deepEqual(byName['人类'].bonus, { 力量: 1, 敏捷: 1, 体质: 1, 智力: 1, 感知: 1, 魅力: 1 });
  for (const r of RACES) {
    for (const sk of (Array.isArray(r.skills) ? r.skills : [])) {
      assert.ok(SKILL_ABILITY[sk], `${r.name} 的 ${sk} 缺属性映射`);
    }
  }
});

await check('.pc 清卡：第一次只警告，带「确认」才真删', async () => {
  const api = makeApi();
  plugin.setupApi(api);
  const warnText = runPcClear(false, '', ctx);
  assert.match(warnText, /整张删掉/, warnText);
  assert.match(warnText, /\.pc 清卡 确认/);
  assert.equal(api.state.cleared, undefined, '没确认就不该删');

  const done = runPcClear(true, '', ctx);
  assert.match(done, /已清空/, done);
  assert.match(done, /张三/, '应带上被删掉的名字');
  assert.equal(api.state.cleared, '111');
});

await check('.pc 清卡：本来没卡就说没什么可清', async () => {
  const api = makeApi();
  const baseCap = api.capability;
  api.capability = (name, args) => (name === 'trpg.character-clear' ? false : baseCap(name, args));
  plugin.setupApi(api);
  assert.match(runPcClear(true, '', ctx), /没什么可清/);
});

await checkAsync('钩子：普通聊天不认领（返回 undefined）', async () => {  const api = makeApi();
  api.fetch = async () => ({ ok: true });
  plugin.setupApi(api);
  assert.equal(await plugin.hooks['before-incoming']({ ...ctx, text: '今天天气不错' }), undefined);
});

await checkAsync('钩子：回复发不出去 → 不认领，让消息回到模型', async () => {
  const api = makeApi();
  api.fetch = async () => ({ ok: false, status: 500 });
  plugin.setupApi(api);
  assert.equal(await plugin.hooks['before-incoming']({ ...ctx, text: '.pc' }), undefined);
});

await checkAsync('钩子：插件关掉后完全不插手', async () => {
  const api = makeApi({ enabled: false });
  api.fetch = async () => { throw new Error('不该发消息'); };
  plugin.setupApi(api);
  assert.equal(await plugin.hooks['before-incoming']({ ...ctx, text: '.pc' }), undefined);
});

// ── 面板能力 ───────────────────────────────────────────────────────────────
await check('面板能力：status 有卡出卡面 / 无卡给错误', () => {
  plugin.setupApi(makeApi());
  const ok = plugin.cardsProviders['trpg.panel-status']({ chatKey: 'group:456', userId: '111' });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /【人物卡】/);

  const api = makeApi();
  api.capability = (name) => (name === 'trpg.character-get' ? null : undefined);
  plugin.setupApi(api);
  const none = plugin.cardsProviders['trpg.panel-status']({ chatKey: 'group:456', userId: '111' });
  assert.equal(none.ok, false);
});

await check('面板能力：party 出卡册', () => {
  plugin.setupApi(makeApi());
  const r = plugin.cardsProviders['trpg.panel-party']({ chatKey: 'group:456' });
  assert.equal(r.ok, true);
  assert.match(r.text, /队伍卡册 · 1 人/);
});

await check('卡面：属性原样显示（不再做 COC 字段过滤）', async () => {
  const text = renderStatus({
    name: '玩家4251',
    attrs: { 力量: 9, 敏捷: 15, 体质: 13, 魅力: 9, 智力: 11, 感知: 10 },
    skills: { 侦查: 45 }, hp: 11, maxHp: 11
  }, { maxSkills: 12, showItems: true });
  assert.match(text, /感知10/, text);
  assert.match(text, /力量9/);
  assert.match(text, /HP11\/11/, 'HP 应显示 当前/上限');
  assert.match(text, /侦查45/);
});

await check('感知只在技能里时：救回属性位并清掉技能副本', async () => {
  const text = renderStatus({ name: 'x', attrs: { 力量: 10 }, skills: { 感知: 12 }, hp: 5 }, { maxSkills: 12, showItems: true });
  assert.match(text, /感知12/, text);
  assert.ok(!/技能：[^\n]*感知/.test(text), '技能里不该再有感知');
});

console.log(`\n卡面与指令：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);

// 卡面与指令（确定性型插件）
//
// ── 它补的两个缺口 ─────────────────────────────────────────────────────────
// ① 面板能力：trpg-gm 的 get_status / get_party 要 trpg.panel-status /
//    trpg.panel-party，而 trpg-tools 明确「面板未实现」→ 工具只会回
//    「面板功能还没装好」。这里把人物卡渲染成文本卡面，补上这两个能力。
//
// ② 点指令：模型在被叫到时才会动，玩家打「.pc 建卡」以前什么都不会发生
//    （skills/trpg-gm 里那句「用 .pc 建卡」只是报错文案，全项目没有解析器）。
//    现在核心新增了 before-incoming 钩子：消息入库之后、触发判定之前先把
//    这条交给插件。插件认领并处理 → 标已读、不唤醒模型（零 token、确定行为）；
//    不认领 → 原样走原来的触发链路。
//
// ── 为什么数据不自己存 ─────────────────────────────────────────────────────
// 人物卡、剧本库、跑团开关全部由 trpg-tools 持有（data/trpg-tools/state.json）。
// 本插件只通过 capability 读写，所以卸掉它不会丢卡，也不会和 trpg-tools 抢数据。

import { getConfig } from '../../src/config.js';

let api = null;
let cfg = () => ({});
let log = () => {};
let warn = () => {};

/** 由 index.js 的 setup() 调用：把插件 API 和当前配置接进来。 */
export function setupApi(a) {
  api = a;
  cfg = typeof a?.config === 'function' ? a.config : () => ({});
  log = typeof a?.log === 'function' ? a.log : () => {};
  warn = typeof a?.warn === 'function' ? a.warn : log;
}

const DEFAULTS = { enabled: true, prefix: '.', showItems: true, maxSkills: 12, gmQuiet: 'noise' };

function settings() {
  const raw = (typeof cfg === 'function' ? cfg() : null) || {};
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const quiet = String(raw.gmQuiet || DEFAULTS.gmQuiet).toLowerCase();
  return {
    enabled: raw.enabled !== false,
    prefix: String(raw.prefix || DEFAULTS.prefix),
    showItems: raw.showItems !== false,
    maxSkills: Math.min(40, Math.max(1, n(raw.maxSkills, DEFAULTS.maxSkills))),
    gmQuiet: quiet === 'off' ? 'off' : (quiet === 'strict' ? 'strict' : 'noise')
  };
}

function cap(name, args) {
  try {
    return api && typeof api.capability === 'function' ? api.capability(name, args) : undefined;
  } catch { return undefined; }
}

function hasCap(name) {
  try {
    return Boolean(api && typeof api.hasCapability === 'function' && api.hasCapability(name));
  } catch { return false; }
}

// ── 卡面渲染 ───────────────────────────────────────────────────────────────

const VITALS = [['hp', 'HP'], ['mp', 'MP'], ['san', 'SAN'], ['douqi', '斗气']];

/** 人物卡 → 一段能直接发群里的文本。 */
function renderStatus(card, s) {
  if (!card || typeof card !== 'object') {
    return '你还没有人物卡。发这样一条就能建：\n.pc roll   （DnD 5e 自动掷）\n或 .pc 建卡 力量14 敏捷16 体质13 智力11 感知12 魅力9';
  }
  const identity = [card.race, card.bg, card.class].filter(Boolean).join(' · ');
  const lv = Number(card.level) || 1;
  const title = [identity, lv > 1 ? `Lv.${lv}` : ''].filter(Boolean).join(' · ');
  const lines = [`【人物卡】${card.name || card.userId || '无名'}${title ? `（${title}）` : ''}`];

  const attrsObj = { ...(card.attrs || {}) };
  const skillsObj = { ...(card.skills || {}) };
  if (skillsObj.感知 !== undefined) {
    // 属性位没有就搬过去；属性位已经有了（后来的掷卡写进 attrs）就以 attrs 为准，
    // 无论哪种都别让「感知」在技能列表里再出现一次。
    if (attrsObj.感知 === undefined) attrsObj.感知 = skillsObj.感知;
    delete skillsObj.感知;
  }

  const attrs = Object.entries(attrsObj).filter(([k, v]) =>
    v !== null && v !== undefined);
  if (attrs.length) lines.push(attrs.map(([k, v]) => `${k}${v}`).join('  '));
  const vitals = VITALS
    .filter(([k]) => card[k] !== null && card[k] !== undefined)
    .map(([k, label]) => (k === 'hp' && Number(card.maxHp) > 0 ? `${label}${card[k]}/${card.maxHp}` : `${label}${card[k]}`));
  if (vitals.length) lines.push(vitals.join('  '));
  // 熟练加值：里程碑升级（不记经验），所以只有等级，没有经验条
  {
    lines.push(`Lv.${lv}  熟练 +${2 + Math.floor((lv - 1) / 4)}`);
  }
  const skills = Object.entries(skillsObj)
    .filter(([, v]) => Number.isFinite(Number(v)))
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, s.maxSkills);
  if (skills.length) lines.push(`技能：${skills.map(([k, v]) => `${k}${v}`).join('、')}`);
  if (s.showItems && Array.isArray(card.items) && card.items.length) {
    const names = card.items.map((it) => (typeof it === 'string' ? it : (it && (it.name || it.title)) || '')).filter(Boolean);
    if (names.length) lines.push(`随身：${names.slice(0, 10).join('、')}`);
  }
  if (Number(card.slotsMax) > 0) lines.push(`法术位：${Number(card.slots) || 0}/${card.slotsMax}`);
  if (Array.isArray(card.conditions) && card.conditions.length) lines.push(`状态：${card.conditions.join('、')}`);
  if (card.background) lines.push(`背景：${String(card.background).slice(0, 60)}`);
  return lines.join('\n');
}

/** 队伍名册 → 文本卡册。 */
function renderParty(roster) {
  const list = Array.isArray(roster?.list) ? roster.list : [];
  if (!list.length) return '本群还没有人物卡。每人发一条 `.pc 建卡 力量60 敏捷50 …` 就能进卡册。';
  const lines = [`【队伍卡册 · ${list.length} 人】`];
  list.slice(0, 20).forEach((p, i) => {
    lines.push(`${i + 1}. ${p.name || p.userId}${p.brief ? ` · ${p.brief}` : ''}`);
  });
  if (list.length > 20) lines.push(`（还有 ${list.length - 20} 人没显示）`);
  return lines.join('\n');
}

// ── 指令解析 ───────────────────────────────────────────────────────────────

/**
 * 识别「.pc / .mod / .gm」开头的指令。
 * 中文句号也认（手机输入法打出来就是「。」）。
 * 不是这三类 → 返回 null（不认领，交给模型）。
 */
function parseCommand(text, prefix = '.') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const heads = [prefix, '.', '。', '．'].filter(Boolean);
  const head = heads.find((p) => raw.startsWith(p));
  if (!head) return null;
  const body = raw.slice(head.length).trim();
  if (!body) return null;
  const m = /^(pc|mod|gm)(?=$|\s|[:：])([\s\S]*)$/i.exec(body);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), rest: String(m[2] || '').trim() };
}

/** 从「力量60 敏捷:50 侦查 45」里抽出键值对。 */
function parsePairs(s) {
  const out = {};
  const re = /([\u4e00-\u9fa5A-Za-z_]{1,8})\s*[:：=]?\s*(\d{1,3})/g;
  let m;
  while ((m = re.exec(String(s || '')))) out[m[1]] = Number(m[2]);
  return out;
}

/** `.pc` 的语义：看卡 / 掷卡 / 建卡 / 改名 / 看队伍。 */
function parsePc(rest) {
  const s = String(rest || '').trim();
  if (!s) return { action: 'show' };

  // 改名：`.pc 名字 张三` / `.pc 改名 李四`。
  // 必须走在「抽名字」之前 —— 否则 `.pc 名字 张三` 里的「名字 张三」会被
  // 当成建卡参数抽走，剩下空串，最后落到"看卡"。
  // 只认**恰好一个词**：带了属性（`.pc 名字 张三 力量60`）就走下面的建卡。
  const rename = /^(?:改名|改名子|改叫|换个名字|名字|rename)\s*[:：]?\s*(\S{1,12})$/.exec(s);
  if (rename) return { action: 'rename', name: rename[1] };

  // 背包：`.pc 物品` 查看 / `.pc 拿 火把` / `.pc 丢 火把`
  if (/^(物品|背包|装备|items?|inventory)$/i.test(s)) return { action: 'items' };
  const takeHit = /^(拿|拾取|获得|捡起|take|add)\s*(.+)$/i.exec(s);
  if (takeHit) return { action: 'item-add', value: takeHit[2].trim() };
  const dropHit = /^(丢|扔掉|丢弃|放下|drop|remove)\s*(.+)$/i.exec(s);
  if (dropHit) return { action: 'item-remove', value: dropHit[2].trim() };

  // 先攻：`.pc 先攻` 掷全队 / `.pc 下一个`
  if (/^(先攻|先攻顺序|投先攻|initiative)$/i.test(s)) return { action: 'initiative' };
  if (/^(下一个|下一位|next|轮到谁)$/i.test(s)) return { action: 'initiative-next' };

  // 法术位：`.pc 法术位` 查看 / `.pc 法术位 3` 设为 3 / `.pc 法术位 -1` 消耗 1 / `.pc 法术位 2/4`
  const slotHit = /^(法术位|slots?)\s*(.*)$/i.exec(s);
  if (slotHit) return { action: 'slots', value: slotHit[2].trim() };

  // 受伤 / 治疗
  const dmgHit = /^(受伤|扣血|掉血|damage)\s*[:：]?\s*(\d{1,4})$/i.exec(s);
  if (dmgHit) return { action: 'hp', delta: -Number(dmgHit[2]) };
  const healHit = /^(治疗|回血|加血|heal)\s*[:：]?\s*(\d{1,4})$/i.exec(s);
  if (healHit) return { action: 'hp', delta: Number(healHit[2]) };

  // 状态：`.pc 状态` 查看 / `.pc 状态 中毒` 加 / `.pc 状态 -中毒` 去掉
  const condHit = /^(状态|condition)\s*(.*)$/i.exec(s);
  if (condHit) {
    const rest = condHit[2].trim();
    if (!rest) return { action: 'conditions' };
    const remove = rest.startsWith('-') || rest.startsWith('－');
    return { action: 'condition', value: remove ? rest.slice(1).trim() : rest, remove };
  }

  // 休息：`.pc 短休` / `.pc 长休`
  if (/^(短休|小休|short ?rest)$/i.test(s)) return { action: 'rest', kind: 'short' };
  if (/^(长休|大休|long ?rest)$/i.test(s)) return { action: 'rest', kind: 'long' };

  // 技能清单：`.pc 技能`（卡面只显示前 N 个，这里列全）
  if (/^(技能|技能表|技能清单|skills?|sk)$/i.test(s)) return { action: 'skills' };

  // 出身：`.pc 种族 矮人` / `.pc 职业 战士`
  const profHit = /^(种族|职业|出身|背景)\s*[:：]?\s*(\S{1,10})$/.exec(s);
  if (profHit) {
    const field = profHit[1] === '种族' ? 'race' : (profHit[1] === '职业' ? 'clazz' : 'bg');
    return { action: 'profile', field, value: profHit[2] };
  }

  // 里程碑升级（不记经验）：`.pc 升级`
  if (/^(升级|升一级|levelup|level up)$/i.test(s)) return { action: 'levelup' };
  // 老习惯可能还打经验：明确告诉他们改成里程碑了，而不是默默显示卡面
  if (/^(经验|exp|xp)(?=\s|[:：]|$)/i.test(s)) return { action: 'expgone' };

  // 「名字」单独抽出来，避免被当成属性
  let name = '';
  const nm = /名字\s*[:：=]?\s*([^\s\d]{1,10})/.exec(s);
  if (nm) name = nm[1];
  const rest2 = s.replace(/名字\s*[:：=]?\s*[^\s\d]{1,10}/, '').trim();

  const clearHit = /^(清卡|删卡|重置|reset|clear)\s*(确认|confirm|是|yes)?$/i.exec(rest2);
  if (clearHit) return { action: 'clear', confirmed: Boolean(clearHit[2]), name };

  const rollHit = /^(掷|掷骰|roll|dice|随机|生成|新卡|重掷)\s*(dnd5e|dnd|5e)?$/i.exec(rest2);
  if (rollHit) {
    return { action: 'roll', name, system: 'dnd5e' };
  }
  if (/^(看|卡|我的|我|查看)$/.test(s)) return { action: 'show' };
  if (/^(队|队伍|卡册|队伍卡册|名册)$/.test(s)) return { action: 'party' };

  // `.pc 建卡 名字 张三`：名字被抽走、剩下「建卡」两个字 —— 交给 runPc 当改名处理
  if (name && /^(建卡|新建|创建|设|设置|改)?$/.test(rest2)) {
    return { action: 'set', attrs: {}, name, raw: rest2 };
  }

  const attrs = parsePairs(rest2);
  if (Object.keys(attrs).length > 0) {
    // 「建卡」「设」这些词只是口头语，抽掉不影响解析
    const bare = rest2.replace(/^(建卡|新建|创建|设|设置|改)\s*/, '');
    return { action: 'set', attrs, name, raw: bare };
  }
  return { action: 'show' };
}

// ── 发消息（插件拿不到 ctx.sender，只能走本地控制台接口）─────────────────

async function reply(kind, chatId, text) {
  const c = (() => { try { return getConfig(); } catch { return {}; } })();
  const port = Number(c?.server?.port) || 3210;
  const token = String(c?.server?.token || '');
  const url = `http://127.0.0.1:${port}/api/chats/${kind}_${encodeURIComponent(chatId)}/test-send`;
  const res = await api.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-console-token': token } : {}) },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`发送失败 HTTP ${res.status}`);
}

// ── 指令执行 ───────────────────────────────────────────────────────────────

/** 掷一次并把总数从 detail 里抠出来（能力只回 "3d6*5 = 50（3d6[3,3,4]）" 这种字符串）。 */
function rollExpr(expr) {
  const r = cap('trpg.dice-roll', { expression: expr });
  if (!r || r.ok !== true) return null;
  const detail = String(r.results?.[0]?.detail || '');
  const m = /=\s*(-?\d+)/.exec(detail);
  return m ? { value: Number(m[1]), detail } : null;
}

/** DnD 5e：4d6 取高 3（trpg-tools 不认 `4d6k3`，那就自己从明细里挑）。 */
function roll4d6DropLowest() {
  const r = cap('trpg.dice-roll', { expression: '4d6' });
  if (!r || r.ok !== true) return null;
  const detail = String(r.results?.[0]?.detail || '');
  const m = /\[([\d,\s]+)\]/.exec(detail);
  if (!m) return null;
  const dice = m[1].split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));
  if (dice.length < 4) return null;
  const kept = [...dice].sort((a, b) => b - a).slice(0, 3);
  return { total: kept.reduce((a, b) => a + b, 0), dice, kept };
}

/** DnD 调整值：floor((属性-10)/2)。 */
function abilityMod(score) {
  return Math.floor((Number(score) - 10) / 2);
}

const DND_ATTRS = ['力量', '敏捷', '体质', '智力', '感知', '魅力'];

/**
 * DnD 5e 的种族（属性加值按 PHB 精简版）。
 * 只有 5e 那九个核心种族；加值写成对象，方便算完直接乘到属性上。
 */
const RACES = [
  // 本地表，数值对照 5e.kiwee.top 的 races.json（PHB）。
  //   bonus  固定属性加值
  //   pick   自选加值（半精灵：任选两项各 +1）
  //   skills 种族自带的技能熟练（数组=固定；{ any: n }=任选 n 项）
  { name: '人类', bonus: { 力量: 1, 敏捷: 1, 体质: 1, 智力: 1, 感知: 1, 魅力: 1 }, skills: [] },
  { name: '精灵', bonus: { 敏捷: 2 }, skills: ['察觉'] },
  { name: '矮人', bonus: { 体质: 2 }, skills: [] },
  { name: '半身人', bonus: { 敏捷: 2 }, skills: [] },
  { name: '龙裔', bonus: { 力量: 2, 魅力: 1 }, skills: [] },
  { name: '侏儒', bonus: { 智力: 2 }, skills: [] },
  { name: '半精灵', bonus: { 魅力: 2 }, pick: { from: ['力量', '敏捷', '体质', '智力', '感知'], count: 2, each: 1 }, skills: { any: 2 } },
  { name: '半兽人', bonus: { 力量: 2, 体质: 1 }, skills: ['威吓'] },
  { name: '提夫林', bonus: { 魅力: 2, 智力: 1 }, skills: [] }
];

/** DnD 5e 的职业（生命骰决定 1 级 HP）。 */
const CLASSES = [
  { name: '战士', hitDie: 10 },
  { name: '野蛮人', hitDie: 12 },
  { name: '圣武士', hitDie: 10 },
  { name: '游侠', hitDie: 10 },
  { name: '盗贼', hitDie: 8 },
  { name: '牧师', hitDie: 8 },
  { name: '德鲁伊', hitDie: 8 },
  { name: '吟游诗人', hitDie: 8 },
  { name: '武僧', hitDie: 8 },
  { name: '邪术师', hitDie: 8 },
  { name: '术士', hitDie: 6 },
  { name: '法师', hitDie: 6 }
];

/**
 * DnD 5e 的 18 项技能 → 对应属性（用于算"技能值 = 属性调整值 + 熟练加值"）。
 * 数据来源：5e.kiwee.top（5etools 中文版）的职业技能表。
 */
const SKILL_ABILITY = {
  特技: '敏捷', 驯兽: '感知', 奥秘: '智力', 运动: '力量', 欺瞒: '魅力', 历史: '智力',
  洞悉: '感知', 威吓: '魅力', 调查: '智力', 医药: '感知', 自然: '智力', 察觉: '感知',
  表演: '魅力', 劝说: '魅力', 宗教: '智力', 巧手: '敏捷', 隐匿: '敏捷', 生存: '感知'
};

/**
 * 各职业的起始技能熟练：从 from 里选 count 个（吟游诗人是"任意 3 项"）。
 * from 为 null 表示任意。数据来自 5e.kiwee.top 的职业 JSON（choose.from / any）。
 */
const CLASS_SKILLS = {
  战士: { count: 2, from: ['特技', '驯兽', '运动', '历史', '洞悉', '威吓', '劝说', '察觉', '生存'] },
  野蛮人: { count: 2, from: ['驯兽', '运动', '威吓', '自然', '察觉', '生存'] },
  圣武士: { count: 2, from: ['运动', '洞悉', '威吓', '医药', '劝说', '宗教'] },
  游侠: { count: 3, from: ['驯兽', '运动', '洞悉', '调查', '自然', '察觉', '隐匿', '生存'] },
  盗贼: { count: 4, from: ['特技', '运动', '欺瞒', '洞悉', '威吓', '调查', '察觉', '劝说', '巧手', '隐匿'] },
  牧师: { count: 2, from: ['历史', '洞悉', '医药', '劝说', '宗教'] },
  德鲁伊: { count: 2, from: ['奥秘', '驯兽', '洞悉', '医药', '自然', '察觉', '宗教', '生存'] },
  吟游诗人: { count: 3, from: null },
  武僧: { count: 2, from: ['特技', '运动', '历史', '洞悉', '宗教', '隐匿'] },
  邪术师: { count: 2, from: ['奥秘', '欺瞒', '历史', '威吓', '调查', '自然', '宗教'] },
  术士: { count: 2, from: ['奥秘', '欺瞒', '洞悉', '威吓', '劝说', '宗教'] },
  法师: { count: 2, from: ['奥秘', '历史', '洞悉', '调查', '医药', '自然', '宗教'] }
};

/** 按职业随机挑出该有的起始技能（吟游诗人从全部 18 项里挑）。 */
function pickClassSkills(className, rng = Math.random) {
  const def = CLASS_SKILLS[String(className || '').trim()];
  if (!def) return [];
  const pool = (def.from || Object.keys(SKILL_ABILITY)).slice();
  const want = Math.min(def.count, pool.length);
  const picked = [];
  for (let i = 0; i < want; i += 1) {
    const idx = Math.floor(rng() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

/** 技能值 = 对应属性的调整值 + 熟练加值。 */
function skillBonus(skill, attrs, level) {
  const ability = SKILL_ABILITY[skill];
  if (!ability) return null;
  const score = Number(attrs[ability]);
  if (!Number.isFinite(score)) return null;
  const prof = 2 + Math.floor(((Number(level) || 1) - 1) / 4);
  return abilityMod(score) + prof;
}

/**
 * PHB 核心 13 个背景 → 固定技能熟练（背景不像职业那样"选 M 项"，是直接给）。
 * 数据来自 5e.kiwee.top 的 backgrounds.json（skillProficiencies）。
 * 与职业技能重叠时只算一次（5e 规则：重复就再选一个，这里简化成去重）。
 */
const BACKGROUNDS = [
  { name: '侍僧', skills: ['洞悉', '宗教'] },
  { name: '骗子', skills: ['欺瞒', '巧手'] },
  { name: '罪犯', skills: ['欺瞒', '隐匿'] },
  { name: '艺人', skills: ['特技', '表演'] },
  { name: '平民英雄', skills: ['驯兽', '生存'] },
  { name: '公会工匠', skills: ['洞悉', '劝说'] },
  { name: '隐士', skills: ['医药', '宗教'] },
  { name: '贵族', skills: ['历史', '劝说'] },
  { name: '化外之民', skills: ['运动', '生存'] },
  { name: '智者', skills: ['奥秘', '历史'] },
  { name: '水手', skills: ['运动', '察觉'] },
  { name: '士兵', skills: ['运动', '威吓'] },
  { name: '流浪儿', skills: ['巧手', '隐匿'] }
];

function findBackground(word) {
  const w = String(word || '').trim();
  if (!w) return null;
  return BACKGROUNDS.find((b) => b.name === w) || BACKGROUNDS.find((b) => b.name.includes(w)) || null;
}

/** 把种族加值拼成人话："体质 +2"、"魅力 +2、敏捷 +1" */
function describeBonus(bonus = {}) {
  return Object.entries(bonus).map(([k, v]) => `${k} +${v}`).join('、') || '无加值';
}

/** 按种族中文名找定义（找不到返回 null）。 */
function findRace(word) {
  const w = String(word || '').trim();
  if (!w) return null;
  return RACES.find((r) => r.name === w) || RACES.find((r) => r.name.includes(w) || w.includes(r.name)) || null;
}

/** 按职业中文名找定义（找不到返回 null）。 */
function findClass(word) {
  const w = String(word || '').trim();
  if (!w) return null;
  const exact = CLASSES.find((c) => c.name === w);
  if (exact) return exact;
  // 「法师」和「术士」都含「法」/「士」，只做包含匹配容易串，所以退一步按前缀
  return CLASSES.find((c) => c.name.includes(w)) || null;
}

/** `.pc roll dnd`：DnD 5e 掷六属性 + 随机种族/职业 + 算调整值/HP/AC + 写卡。 */
function runPcRollDnd(name, ctx) {
  if (!hasCap('trpg.dice-roll')) return '跑团插件没装好（缺 trpg.dice-roll），掷不了属性。';
  const rolled = [];
  for (const key of DND_ATTRS) {
    const r = roll4d6DropLowest();
    if (!r) return `掷「${key}」失败了，再试一次 \`.pc roll\`。`;
    rolled.push([key, r.total]);
  }

  // 种族/职业随机定：种族给属性加值，职业决定生命骰
  const race = RACES[Math.floor(Math.random() * RACES.length)];
  const klass = CLASSES[Math.floor(Math.random() * CLASSES.length)];
  const bg = BACKGROUNDS[Math.floor(Math.random() * BACKGROUNDS.length)];
  const attr = Object.fromEntries(rolled);
  for (const [k, v] of Object.entries(race.bonus)) {
    if (attr[k] !== undefined) attr[k] += v;
  }
  // 半精灵这类"任选两项 +1"：随机挑，且不和固定加值重复
  const pickedBonus = [];
  if (race.pick) {
    const pool = race.pick.from.filter((k) => attr[k] !== undefined);
    for (let i = 0; i < (race.pick.count || 0) && pool.length; i += 1) {
      const idx = Math.floor(Math.random() * pool.length);
      const key = pool.splice(idx, 1)[0];
      attr[key] += race.pick.each || 1;
      pickedBonus.push(`${key}+${race.pick.each || 1}`);
    }
  }
  // 种族自带的技能熟练（精灵察觉、半兽人威吓、半精灵任选 2）
  const raceSkills = [];
  if (Array.isArray(race.skills)) raceSkills.push(...race.skills);
  else if (race.skills && race.skills.any) {
    const pool = Object.keys(SKILL_ABILITY);
    for (let i = 0; i < race.skills.any && pool.length; i += 1) {
      raceSkills.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
  }

  const hp = Math.max(1, klass.hitDie + abilityMod(attr.体质));
  const ac = 10 + abilityMod(attr.敏捷);
  const init = abilityMod(attr.敏捷);

  // 职业给的起始技能熟练：按 5e 的"从 N 项选 M 项"随机挑，
  // 技能值 = 对应属性调整值 + 熟练加值（1 级 +2），直接能拿去掷 1d20。
  const learned = [...new Set([...pickClassSkills(klass.name), ...bg.skills, ...raceSkills])];
  const skillValues = {};
  for (const sk of learned) {
    const v = skillBonus(sk, attr, 1);
    if (v !== null) skillValues[sk] = v;
  }

  let ok = 0;
  for (const [k, v] of Object.entries(attr)) {
    const args = { chatKey: ctx.chatKey, userId: ctx.senderId, key: k, value: v };
    if (name) args.name = name;
    if (cap('trpg.character-set', args)) ok++;
  }
  for (const [k, v] of Object.entries(skillValues)) {
    cap('trpg.character-set', { chatKey: ctx.chatKey, userId: ctx.senderId, key: k, value: v });
  }
  // 顺手把 HP 也写进卡（DnD 的 HP 才是真会掉的那个值）
  cap('trpg.character-set', { chatKey: ctx.chatKey, userId: ctx.senderId, key: 'hp', value: hp, ...(name ? { name } : {}) });
  // 写 hp 时能力会把 maxHp 一起补上（新卡上限就是初始血量）
  // 种族 / 职业 / 等级 / 经验写进卡（字符串与等级字段，走单独的能力）
  if (hasCap('trpg.character-profile')) {
    cap('trpg.character-profile', {
      chatKey: ctx.chatKey, userId: ctx.senderId,
      race: race.name, clazz: klass.name, bg: bg.name,
      level: 1,                        // 新卡从 1 级开始（里程碑升级，不记经验）
      ...(name ? { name } : {})
    });
  }

  const fmt = (n) => `${n >= 0 ? '+' : ''}${n}`;
  const list = DND_ATTRS.map((k) => `${k}${attr[k]}(${fmt(abilityMod(attr[k]))})`).join('  ');
  const skillLine = Object.entries(skillValues)
    .map(([k, v]) => `${k}${fmt(v)}`)
    .join('、');
  return [
    `掷好了（DnD 5e · 4d6 取高 3）${name ? `，${name}` : ''}：`,
    `种族 ${race.name}（${describeBonus(race.bonus)}${pickedBonus.length ? `，另选 ${pickedBonus.join("、")}` : ""}${raceSkills.length ? `；${raceSkills.join("、")}` : ""}）  背景 ${bg.name}（${bg.skills.join("、")}）  职业 ${klass.name}（生命骰 d${klass.hitDie}）`,
    list,
    `HP${hp}（d${klass.hitDie}+体质）  AC${ac}（无甲）  先攻${fmt(init)}  熟练+2`,
    skillLine ? `技能熟练：${skillLine}（已算好，检定直接掷 1d20 加这个）` : '',
    `（写入 ${ok} 项属性 + HP + 出身 + 职业熟练。不满意就再 \`.pc roll\` 重掷；想微调：\`.pc 力量14\` / \`.pc 种族 矮人\` / \`.pc 职业 战士\`）`
  ].filter(Boolean).join('\n');
}

/** `.pc 清卡`：整张删掉（`character-set` 只能覆盖不能删，换规则体系时要整张重来）。 */
function runPcClear(confirmed, name, ctx) {
  if (!confirmed) {
    return [
      '这会**整张删掉**你的人物卡：属性、技能、随身物品、已知线索全都会没，删了不能恢复。',
      `确定就发：\`.pc 清卡 确认\``
    ].join('\n');
  }
  if (!hasCap('trpg.character-clear')) return '跑团插件没装好（缺 trpg.character-clear），清不了卡。';
  const old = cap('trpg.character-get', { chatKey: ctx.chatKey, userId: ctx.senderId });
  const ok = cap('trpg.character-clear', { chatKey: ctx.chatKey, userId: ctx.senderId });
  if (ok !== true) return '你还没有人物卡，没什么可清的。';
  const who = old?.name ? `「${old.name}」` : '';
  return `已清空${who}的人物卡。想重建就发 .pc roll。`;
}

/**
 * `.pc 名字 张三`：只改名字，不动别的字段。
 *
 * 为什么绕这一下：trpg-tools 的 character-set 一进门就
 * `if (!Number.isFinite(Number(value))) return null`，而名字是字符串 ——
 * 唯一入口是它那个独立的 `name` 参数（putCard 建卡时用），而且**只有顺带写
 * 某个数字字段时才会被带进去**。所以这里借一个**已存在的**数字字段当载体，
 * 原值回写（等于没改），纯粹为了把 name 递进去。
 */
function runPcRename(newName, ctx) {
  const name = String(newName || '').trim().slice(0, 20);
  if (!name) return '要改成什么名字？写法：`.pc 名字 张三`';
  if (!hasCap('trpg.character-set')) return '跑团插件没装好（缺 trpg.character-set），改不了名字。';
  const card = cap('trpg.character-get', { chatKey: ctx.chatKey, userId: ctx.senderId });
  if (!card) return '你还没有人物卡，先 `.pc roll`（DnD）或 `.pc 建卡 …` 建一张再改名。';

  const attrs = card.attrs && typeof card.attrs === 'object' ? card.attrs : {};
  const carrierKey = Object.keys(attrs).find((k) => Number.isFinite(Number(attrs[k]))) || '力量';
  const carrierVal = Number.isFinite(Number(attrs[carrierKey]))
    ? Number(attrs[carrierKey])
    : (Number.isFinite(Number(card.hp)) ? Number(card.hp) : 10);

  const r = cap('trpg.character-set', {
    chatKey: ctx.chatKey, userId: ctx.senderId, key: carrierKey, value: carrierVal, name
  });
  if (!r) return '改名没成功（插件没接住），再试一次。';
  const old = card.name ? `原名字「${card.name}」` : '原来没有名字';
  return `改好了：${old} → 「${name}」。`;
}

/** `.pc 种族 矮人` / `.pc 职业 战士`：改出身标签。 */
function runPcProfile(field, value, ctx) {
  const card = cap('trpg.character-get', { chatKey: ctx.chatKey, userId: ctx.senderId });
  if (!card) return '你还没有人物卡，先 `.pc roll` 建一张再改出身。';
  if (!hasCap('trpg.character-profile')) return '跑团插件没装好（缺 trpg.character-profile），改不了出身。';

  if (field === 'bg') {
    const bg = findBackground(value);
    if (!bg) return `没认出「${value}」这个背景。可选：${BACKGROUNDS.map((b) => b.name).join('、')}`;
    cap('trpg.character-profile', { chatKey: ctx.chatKey, userId: ctx.senderId, bg: bg.name });
    return `背景改成「${bg.name}」（${bg.skills.join('、')}）。\n技能不会自动重算——想按新背景重来就 \`.pc roll\`。`;
  }
  if (field === 'race') {
    const race = findRace(value);
    if (!race) return `没认出「${value}」这个种族。可选：${RACES.map((r) => r.name).join('、')}`;
    cap('trpg.character-profile', { chatKey: ctx.chatKey, userId: ctx.senderId, race: race.name });
    return `种族改成「${race.name}」（${describeBonus(race.bonus)}）。\n属性不会自动重算——种族加值只在 \`.pc roll\` 时加过一次；想按新种族重来就 \`.pc roll\`。`;
  }
  const klass = findClass(value);
  if (!klass) return `没认出「${value}」这个职业。可选：${CLASSES.map((c) => c.name).join('、')}`;
  cap('trpg.character-profile', { chatKey: ctx.chatKey, userId: ctx.senderId, clazz: klass.name });
  return `职业改成「${klass.name}」（生命骰 d${klass.hitDie}）。\nHP 不会自动重算——想按新职业重算就 \`.pc roll\`。`;
}

/** `.pc 物品`：看背包。 */
function runPcItems(ctx) {
  const card = cap('trpg.character-get', { chatKey: ctx.chatKey, userId: ctx.senderId });
  if (!card) return `你还没有人物卡，先 .pc roll 建一张。`;
  const items = Array.isArray(card.items) ? card.items : [];
  const lines = [];
  if (items.length) lines.push(`【背包】${items.join('、')}`);
  else lines.push('背包是空的。\n拿东西：`.pc 拿 火把`；丢东西：`.pc 丢 火把`。');
  const slots = Number(card.slots);
  const slotsMax = Number(card.slotsMax);
  if (Number.isFinite(slotsMax) && slotsMax > 0) lines.push(`法术位：${Number.isFinite(slots) ? slots : 0}/${slotsMax}`);
  return lines.join('\n');
}

/** `.pc 拿 X` / `.pc 丢 X` */
function runPcItemChange(value, remove, ctx) {
  const item = String(value || '').trim();
  if (!item) return remove ? '要丢什么？写法：`.pc 丢 火把`' : '要拿什么？写法：`.pc 拿 火把`';
  if (!hasCap('trpg.character-items')) return '跑团插件没装好（缺 trpg.character-items）。';
  const card = cap('trpg.character-get', { chatKey: ctx.chatKey, userId: ctx.senderId });
  if (!card) return '你还没有人物卡，先 `.pc roll` 建一张。';
  const r = cap('trpg.character-items', { chatKey: ctx.chatKey, userId: ctx.senderId, text: item, remove });
  if (!r || r.ok !== true) return `${remove ? '丢' : '拿'}不了：${r?.error || '未知错误'}`;
  if (!remove && r.added === false) return `没放进背包：${r.reason || '背包满了'}`;
  if (remove && r.removed === false) return `背包里没有「${item}」。`;
  return `${remove ? '丢掉了' : '收进背包'}「${item}」。\n${runPcItems(ctx)}`;
}

/** `.pc 法术位 [n|-n|a/b]` */
function runPcSlots(value, ctx) {
  const card = cap('trpg.character-get', { chatKey: ctx.chatKey, userId: ctx.senderId });
  if (!card) return '你还没有人物卡，先 `.pc roll` 建一张。';
  const cur = Number.isFinite(Number(card.slots)) ? Number(card.slots) : 0;
  const max = Number.isFinite(Number(card.slotsMax)) ? Number(card.slotsMax) : 0;
  const v = String(value || '').trim();
  if (!v) return `法术位：${cur}/${max}。\n设置：\`.pc 法术位 3\`；消耗：\`.pc 法术位 -1\`；设上限：\`.pc 法术位 2/4\`。`;
  const pair = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(v);
  if (pair) {
    cap('trpg.character-set', { chatKey: ctx.chatKey, userId: ctx.senderId, key: '法术位上限', value: Number(pair[2]) });
    const r = cap('trpg.character-set', { chatKey: ctx.chatKey, userId: ctx.senderId, key: '法术位', value: Number(pair[1]) });
    if (!r) return '设置失败。';
    return `法术位设为 ${pair[1]}/${pair[2]}。`;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return '写法：`.pc 法术位 3` / `.pc 法术位 -1` / `.pc 法术位 2/4`';
  const next = Math.max(0, cur + n);
  const r = cap('trpg.character-set', { chatKey: ctx.chatKey, userId: ctx.senderId, key: '法术位', value: next });
  if (!r) return '设置失败。';
  const after = Number.isFinite(Number(card.slotsMax)) ? Number(card.slotsMax) : next;
  return `法术位：${cur}/${max} → ${next}/${after}`;
}

/** `.pc 受伤 8` / `.pc 治疗 8` */
function runPcHp(delta, ctx) {
  if (!hasCap('trpg.character-hp')) return '跑团插件没装好（缺 trpg.character-hp）。';
  const r = cap('trpg.character-hp', { chatKey: ctx.chatKey, userId: ctx.senderId, delta });
  if (!r || r.ok !== true) return '你还没有人物卡，先 `.pc roll` 建一张。';
  const head = delta < 0 ? `受到 ${-delta} 点伤害。` : `回复 ${delta} 点生命。`;
  const line = `HP ${r.before}/${r.maxHp} → ${r.hp}/${r.maxHp}`;
  const extra = r.down ? '\n⚠️ 血量归零，已标记「倒地」。治疗或短休后会自动解除。' : '';
  return `${head}\n${line}${extra}`;
}

/** `.pc 先攻`：全队掷 1d20 + 敏捷调整值，排好顺序存起来。 */
function runPcInitiative(ctx) {
  if (!hasCap('trpg.dice-roll')) return '跑团插件没装好（缺 trpg.dice-roll）。';
  const roster = cap('trpg.character-public', { chatKey: ctx.chatKey });
  const list = Array.isArray(roster?.list) ? roster.list : [];
  if (!list.length) return '本群还没有人物卡，没法投先攻。';
  const rows = [];
  for (const p of list) {
    const card = cap('trpg.character-get', { chatKey: ctx.chatKey, userId: p.userId });
    const dex = Number(card?.attrs?.['敏捷']);
    const mod = Number.isFinite(dex) ? Math.floor((dex - 10) / 2) : 0;
    const r = cap('trpg.dice-roll', { expression: `1d20` });
    const m = /=\s*(\d+)/.exec(String(r?.results?.[0]?.detail || ``));
    const die = m ? Number(m[1]) : 10;
    rows.push({ userId: p.userId, name: p.name || p.userId, roll: die, mod, total: die + mod });
  }
  rows.sort((a, b) => b.total - a.total);
  cap('trpg.initiative-set', { chatKey: ctx.chatKey, list: rows });
  const lines = rows.map((r, i) => `${i + 1}. ${r.name} ${r.total}（d20 ${r.roll} ${r.mod >= 0 ? `+` : ``}${r.mod}）`);
  return `【先攻顺序】\n${lines.join('\n')}\n轮到谁发 \`.pc 下一个\`。`;
}

/** `.pc 下一个` */
function runPcInitiativeNext(ctx) {
  if (!hasCap('trpg.initiative-next')) return '跑团插件没装好（缺 trpg.initiative-next）。';
  const r = cap('trpg.initiative-next', { chatKey: ctx.chatKey });
  const st = cap('trpg.initiative-get', { chatKey: ctx.chatKey }) || r;
  if (!r || !Array.isArray(r.list) || !r.list.length) return '还没有先攻顺序，先发 `.pc 先攻`。';
  const src = (st && Array.isArray(st.list) && st.list.length) ? st : r;
  const li = ((Number(src.index) % src.list.length) + src.list.length) % src.list.length;
  const cur = src.list[li];
  const next = src.list[(li + 1) % src.list.length];
  return `现在轮到：${cur.name}（第 ${li + 1}/${src.list.length} 位）\n下一个：${next.name}`;
}

/** `.pc 状态`：查看当前状态。 */
function runPcConditions(ctx) {
  const card = cap('trpg.character-get', { chatKey: ctx.chatKey, userId: ctx.senderId });
  if (!card) return '你还没有人物卡，先 `.pc roll` 建一张。';
  const list = Array.isArray(card.conditions) ? card.conditions : [];
  if (!list.length) return '你身上没有异常状态。\n加一个：`.pc 状态 中毒`；去掉：`.pc 状态 -中毒`。';
  return `【当前状态】${list.join('、')}` + String.fromCharCode(10) + `（去掉：.pc 状态 -${list[0]}）`;
}

/** `.pc 状态 中毒` / `.pc 状态 -中毒` */
function runPcCondition(value, remove, ctx) {
  const v = String(value || '').trim();
  if (!v) return '要加还是去什么状态？写法：`.pc 状态 中毒` / `.pc 状态 -中毒`';
  if (!hasCap('trpg.character-conditions')) return '跑团插件没装好（缺 trpg.character-conditions）。';
  const card = cap('trpg.character-get', { chatKey: ctx.chatKey, userId: ctx.senderId });
  if (!card) return '你还没有人物卡，先 `.pc roll` 建一张。';
  const r = cap('trpg.character-conditions', remove
    ? { chatKey: ctx.chatKey, userId: ctx.senderId, remove: [v] }
    : { chatKey: ctx.chatKey, userId: ctx.senderId, add: [v] });
  if (!r || r.ok !== true) return '状态没改成功，再试一次。';
  const list = r.conditions || [];
  const head = remove ? `已去掉「${v}」。` : `记上了「${v}」。`;
  return `${head}\n当前状态：${list.length ? list.join('、') : '无'}`;
}

/** `.pc 短休` / `.pc 长休` */
function runPcRest(kind, ctx) {
  if (!hasCap('trpg.character-rest')) return '跑团插件没装好（缺 trpg.character-rest）。';
  const card = cap('trpg.character-get', { chatKey: ctx.chatKey, userId: ctx.senderId });
  if (!card) return '你还没有人物卡，先 `.pc roll` 建一张。';
  const r = cap('trpg.character-rest', { chatKey: ctx.chatKey, userId: ctx.senderId, kind });
  if (!r || r.ok !== true) return '休息没成功，再试一次。';
  const label = r.kind === 'short' ? '短休' : '长休';
  if (r.healed <= 0) return `${label}完毕。血量本来就是满的（${r.hp}/${r.maxHp}）。`;
  return `${label}完毕。HP ${r.hp - r.healed}/${r.maxHp} → ${r.hp}/${r.maxHp}（+${r.healed}）`;
}

/**
 * `.pc 技能`：把卡上登记的所有技能列全（卡面按 maxSkills 截断，这里不截）。
 * 只列"卡上登记过的数值"，不包含 DnD 的职业熟练（那套没建模）。
 */
function runPcSkills(ctx) {
  const card = cap('trpg.character-get', { chatKey: ctx.chatKey, userId: ctx.senderId });
  if (!card) return '你还没有人物卡，先 `.pc roll` 或 `.pc 建卡 力量14 敏捷16`。';
  const entries = Object.entries(card.skills || {})
    .filter(([, v]) => Number.isFinite(Number(v)))
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!entries.length) {
    return [
      '你还没有登记任何技能。',
      '写法：`.pc 侦查45 图书馆50 话术40`（属性同理：`.pc 力量14`）',
      '也可以直接跟 GM 说"我侦查很在行"，它会帮你写进去。'
    ].join('\n');
  }
  const lv = Number(card.level) || 1;
  const prof = 2 + Math.floor((lv - 1) / 4);
  const lines = entries.map(([k, v]) => `${k} ${v}`).join('、');
  return `【技能 · 共 ${entries.length} 项】\n${lines}\n熟练加值 +${prof}（Lv.${lv}）。`;
}

/**
 * `.pc 升级`：里程碑式升级（不记经验）。
 * 逻辑全在 trpg-tools 的 trpg.character-levelup 里（等级 +1、按生命骰加血），
 * 这里只负责说人话。
 */
function runPcLevelUp(ctx) {
  const card = cap('trpg.character-get', { chatKey: ctx.chatKey, userId: ctx.senderId });
  if (!card) return '你还没有人物卡，先 `.pc roll` 建一张。';
  if (!hasCap('trpg.character-levelup')) return '跑团插件没装好（缺 trpg.character-levelup），升不了级。';
  const r = cap('trpg.character-levelup', { chatKey: ctx.chatKey, userId: ctx.senderId });
  if (!r || r.ok !== true) return '升级没成功（插件没接住），再试一次。';
  if (r.maxed) return '已经是 Lv.20 满级了。';
  const prof = 2 + Math.floor((r.level - 1) / 4);
  return `升级！Lv.${r.prevLevel} → Lv.${r.level}，HP ${r.prevHp} → ${r.hp}（+${r.gainHp}），熟练加值 +${prof}。`;
}

/** `.pc roll`：DnD 5e 掷卡。 */
function runPcRoll(name, ctx) {
  return runPcRollDnd(name, ctx);
}

async function runPc(rest, ctx) {
  const s = settings();
  const parsed = parsePc(rest);
  if (parsed.action === 'rename') return runPcRename(parsed.name, ctx);
  if (parsed.action === 'profile') return runPcProfile(parsed.field, parsed.value, ctx);
  if (parsed.action === 'levelup') return runPcLevelUp(ctx);
  if (parsed.action === 'skills') return runPcSkills(ctx);
  if (parsed.action === 'items') return runPcItems(ctx);
  if (parsed.action === 'item-add') return runPcItemChange(parsed.value, false, ctx);
  if (parsed.action === 'item-remove') return runPcItemChange(parsed.value, true, ctx);
  if (parsed.action === 'initiative') return runPcInitiative(ctx);
  if (parsed.action === 'initiative-next') return runPcInitiativeNext(ctx);
  if (parsed.action === 'slots') return runPcSlots(parsed.value, ctx);
  if (parsed.action === 'hp') return runPcHp(parsed.delta, ctx);
  if (parsed.action === 'conditions') return runPcConditions(ctx);
  if (parsed.action === 'condition') return runPcCondition(parsed.value, parsed.remove, ctx);
  if (parsed.action === 'rest') return runPcRest(parsed.kind, ctx);
  if (parsed.action === 'expgone') return '经验值已经取消了——现在是**里程碑升级**：打完一段剧情、GM 说要升级，就发 `.pc 升级`。';
  if (parsed.action === 'clear') return runPcClear(parsed.confirmed === true, parsed.name, ctx);
  if (parsed.action === 'roll') return runPcRoll(parsed.name, ctx);
  if (parsed.action === 'party') {
    const r = cap('trpg.character-public', { chatKey: ctx.chatKey });
    return renderParty(r);
  }
  if (parsed.action === 'set') {
    if (!hasCap('trpg.character-set')) return '跑团插件没装好（缺 trpg.character-set），建不了卡。';
    const writes = Object.entries(parsed.attrs || {});
    // `.pc 建卡 名字 张三`（只给名字、没属性）→ 当成改名，别回一句"没看出要设什么"
    if (!writes.length && parsed.name) return runPcRename(parsed.name, ctx);
    if (!writes.length) return '没看出要设什么。格式：`.pc 建卡 名字 张三 力量14 敏捷16`';
    let ok = 0;
    const failed = [];
    for (const [k, v] of writes) {
      // ⚠️ 名字**不能**用 key='name' 写：trpg-tools 的 character-set 一开始就
      //    `if (!Number.isFinite(Number(value))) return null`，字符串名字会被
      //    直接丢掉（那段 `k === 'name'` 分支是死代码）。它真正认的是**独立的
      //    name 参数**（传给 putCard 建卡时用），所以这里每次带上 name。
      const args = { chatKey: ctx.chatKey, userId: ctx.senderId, key: k, value: v };
      if (parsed.name) args.name = parsed.name;
      const r = cap('trpg.character-set', args);
      if (r) ok++; else failed.push(k);
    }
    const card = cap('trpg.character-get', { chatKey: ctx.chatKey, userId: ctx.senderId });
    const head = `记下了 ${ok} 项${failed.length ? `（这几项没认出来：${failed.join('、')}）` : ''}。`;
    return `${head}\n${renderStatus(card, s)}`;
  }
  // show
  if (!hasCap('trpg.character-get')) return '跑团插件没装好（缺 trpg.character-get），读不到人物卡。';
  const card = cap('trpg.character-get', { chatKey: ctx.chatKey, userId: ctx.senderId });
  return renderStatus(card, s);
}

function runMod(rest, ctx) {
  const s = String(rest || '').trim();
  const list = cap('trpg.module-list');
  const mods = Array.isArray(list?.modules) ? list.modules : [];
  if (!s || /^(列表|list|ls|全部)$/i.test(s)) {
    if (!mods.length) return '剧本库是空的。可以让 GM 用「找个本」去魔都搜，或者把 md 放进 data/trpg-tools/modules/。';
    const lines = [`【剧本库 · ${mods.length} 本】`];
    mods.slice(0, 15).forEach((m, i) => {
      lines.push(`${i + 1}. ${m.name}${m.system ? `（${m.system}）` : ''}${m.acts?.length ? ` · ${m.acts.length} 幕` : ''}`);
    });
    if (mods.length > 15) lines.push(`（还有 ${mods.length - 15} 本没显示）`);
    lines.push('载入：`.mod load <名字或id>`');
    return lines.join('\n');
  }
  const name = s.replace(/^(load|载入|加载)\s*/i, '').trim();
  if (!name) return '写法：`.mod load 蝗金岛`';
  const hit = mods.find((m) => String(m.id) === name)
    || mods.find((m) => String(m.name) === name)
    || mods.find((m) => String(m.name).includes(name) || String(m.id).includes(name));
  if (!hit) {
    const near = mods.filter((m) => String(m.name).includes(name.slice(0, 2))).slice(0, 5).map((m) => m.name);
    return `剧本库里没有「${name}」。${near.length ? `相近的有：${near.join('、')}` : '发 `.mod` 看全部。'}`;
  }
  if (!hasCap('trpg.scene-set')) return '跑团插件没装好（缺 trpg.scene-set），载入不了。';
  cap('trpg.scene-set', { chatKey: ctx.chatKey, module: hit.name, sceneIndex: 1 });
  return `已载入《${hit.name}》${hit.system ? `（${hit.system}）` : ''}，共 ${hit.acts?.length || 0} 幕。\n第 1 幕：${hit.acts?.[0]?.title || '（无标题）'}`;
}

function runGm(rest, ctx) {
  const s = String(rest || '').trim().toLowerCase();
  const cur = cap('trpg.gm-get', { chatKey: ctx.chatKey });
  if (!s) return `跑团模式现在是${cur ? '开' : '关'}的。用 \`.gm on\` / \`.gm off\` 切换。`;
  if (!/^(on|off|开|关|1|0|true|false)$/.test(s)) return '写法：`.gm on` 或 `.gm off`';
  const want = /^(on|开|1|true)$/.test(s);
  cap('trpg.gm-set', { chatKey: ctx.chatKey, enabled: want });
  return want ? '跑团模式已开。' : '跑团模式已关。';
}

// ── 跑团静默闸 ─────────────────────────────────────────────────────────────
//
// 问题：跑团时要开 4 档（每条都响应），否则玩家说「我推开门」会被随机吞掉；
// 但 4 档下群友随口闲聊、发表情包、哈哈哈，它也会用 GM 的语气插一句 ——
// 一局跑团被切成碎片。
//
// 解法：GM 模式开着的时候，在**唤醒模型之前**做一道确定性闸门。
// 判定为"和团无关"的消息直接标已读、不唤醒、不回复（零 token），
// 但仍然留在群里和存档里 —— 模型下一轮跑起来照样能在历史里看到。

/** 去掉 CQ 码和一些渲染占位，只看人话部分。 */
function plainText(text) {
  return String(text || '').replace(/\[CQ:[^\]]+\]/g, '').trim();
}

/** 纯噪音：表情包/图片、纯标点、极短语气词。 */
function isNoiseMessage(text) {
  const s = plainText(text);
  if (!s) return true;
  if (/^\[(图片|表情|动画表情|语音|视频|文件|卡片消息|回复|聊天记录|链接)\]$/.test(s)) return true;
  const core = s.replace(/[\s\p{P}\p{S}]/gu, '');
  if (!core) return true;
  if (core.length <= 5 && /^(哈+|草+|6+|233+|awa|awsl|哦+|嗯+|啊+|呜+|好耶|笑死|绝了|牛+|可以|？+|！+)$/i.test(core)) return true;
  return false;
}

/** 跑团相关：@、骰点/检定、属性技能词、第一人称行动。 */
const TRPG_HINT = /(投|掷|骰|检定|对抗|先攻|回合|行动|攻击|伤害|命中|施法|豁免|开锁|潜行|侦查|聆听|图书馆|话术|说服|恐吓|急救|医学|母语|力量|敏捷|体质|智力|感知|魅力|HP|SAN|理智|装备|背包|线索|模组|剧本|战斗|地图|推门|翻找|搜查|npc|GM)/i;

function isTrpgRelevant(text, atMe) {
  if (atMe) return true;
  const s = plainText(text);
  const core = s.replace(/[\s\p{P}\p{S}]/gu, '');
  if (!core) return false;
  if (TRPG_HINT.test(s)) return true;
  if (/^(我|咱|俺)(要|想|去|来|先|再|试着|准备|直接|已经|这就|马上)?/.test(core)) return true;
  return false;
}

/**
 * 返回 'swallow' 表示"这条不要叫醒模型"，'pass' 表示照常走触发链路。
 * 只在 GM 模式开着时生效。
 */
function gmQuietGate(ctx, silent) {
  if (silent === 'off') return 'pass';
  const gm = cap('trpg.gm-get', { chatKey: ctx.chatKey });
  if (gm !== true) return 'pass';
  if (ctx.atMe) return 'pass';                       // 被点名了就别装死
  if (silent === 'strict') return isTrpgRelevant(ctx.text, ctx.atMe) ? 'pass' : 'swallow';
  return isNoiseMessage(ctx.text) ? 'swallow' : 'pass';
}

// ── 钩子 ───────────────────────────────────────────────────────────────────

export const hooks = {
  /**
   * 消息入库后、触发判定前。认领 .pc/.mod/.gm，处理完直接回复；
   * 返回 { handled: true } 让核心标已读、不再唤醒模型。
   */
  async 'before-incoming'(ctx = {}) {
    const s = settings();
    if (!s.enabled) return undefined;
    if (ctx.kind !== 'group' && ctx.kind !== 'private') return undefined;
    const parsed = parseCommand(ctx.text, s.prefix);
    if (!parsed) {
      // 不是指令 → 过一遍跑团静默闸（GM 模式下吞掉噪音/闲聊）
      if (gmQuietGate(ctx, s.gmQuiet) === 'swallow') {
        log(`跑团静默：吞掉一条与团无关的消息（${ctx.chatKey}）`);
        return { handled: true };                      // 标已读、不唤醒、不回复
      }
      return undefined;
    }

    let text = '';
    try {
      if (parsed.cmd === 'pc') text = await runPc(parsed.rest, ctx);
      else if (parsed.cmd === 'mod') text = runMod(parsed.rest, ctx);
      else text = runGm(parsed.rest, ctx);
    } catch (error) {
      text = `指令执行失败：${String(error?.message ?? error).slice(0, 120)}`;
    }
    if (!text) return undefined;

    try {
      await reply(ctx.kind, ctx.chatId, text.slice(0, 1800));
    } catch (error) {
      warn(`指令回复发送失败：${String(error?.message ?? error)}`);
      return undefined;   // 发不出去就别吞掉这条消息，交给模型兜底
    }
    log(`指令 ${parsed.cmd} 已处理（${ctx.chatKey}）`);
    return { handled: true };
  }
};

// ── 能力 ───────────────────────────────────────────────────────────────────

const providers = {
  'trpg.panel-status': ({ chatKey, userId } = {}) => {
    const r = cap('trpg.character-get', { chatKey, userId });
    if (!r) return { ok: false, error: '这个人还没有人物卡' };
    return { ok: true, text: renderStatus(r, settings()) };
  },
  'trpg.panel-party': ({ chatKey } = {}) => {
    const r = cap('trpg.character-public', { chatKey });
    return { ok: true, text: renderParty(r) };
  }
};

export const cardsProviders = providers;

/**
 * 由 trpg-tools 的 setup() 调用：把 api 交进来（本文件所有能力读写都靠它）。
 * 单独一个入口是为了让 index.js 只加三行接线，不必了解这里的细节。
 */
export function initCards(a) {
  setupApi(a);
  log('卡面与指令已就绪：.pc 看 / .pc roll [dnd] / .pc 建卡 / .pc 名字 / .pc 种族 / .pc 职业 / .pc 升级 / .pc 队伍 / .pc 清卡 / .mod [load] / .gm on|off');
}

export const cardsHooks = hooks;

export const __internals = {
  settings, parseCommand, parsePc, parsePairs, renderStatus, renderParty,
  runPc, runPcRoll, runPcRollDnd, runPcClear, runPcRename, runPcProfile, runPcLevelUp, runPcSkills, runPcItems, runPcItemChange, runPcSlots, runPcHp, runPcInitiative, runPcInitiativeNext, runPcConditions, runPcCondition, runPcRest, runMod, runGm, rollExpr,
  roll4d6DropLowest, abilityMod, DND_ATTRS, RACES, CLASSES, findRace, findClass, describeBonus, pickClassSkills, skillBonus, CLASS_SKILLS, SKILL_ABILITY, BACKGROUNDS, findBackground,
  isNoiseMessage, isTrpgRelevant, gmQuietGate
};

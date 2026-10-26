// 跑团工具箱（确定性型插件 / 放在 plugins/）
//
// ── 它是谁的零件 ──────────────────────────────────────────────────────────
// 这个插件本身**不注册任何工具**，它只是给 skills/trpg-gm（跑团 GM 技能）提供
// 底层能力（providers）。trpg-gm 全程用 api.hasCapability() 软依赖探测，所以
// 我们**少提供某个能力**不会让它崩，只会让对应工具回一句"还没装好"。
//
// ── 为什么做成插件（确定性型）──────────────────────────────────────────────
// 这些操作都是"给定参数就必须算出确定结果"的管道逻辑：掷骰、读某一幕正文、
// 写人物卡字段、算传闻可信度。没有一处需要模型判断"要不要做"——模型只负责
// 决定"什么时候调 trpg-gm 的工具"，具体怎么算由这里写死。
//
// ── 数据放哪 ──────────────────────────────────────────────────────────────
//   data/trpg-tools/state.json          每群状态：跑团开关、进度、人物卡、情报
//   data/trpg-tools/modules/<id>/       剧本库：module.json + 各幕正文 .md
// 全部是本地文件，删了就等于重置，不写注册表、不联网（除了 import 网页剧本）。
//
// ── 返回值的形状从哪来 ────────────────────────────────────────────────────
// **不能自创**：入参/返回由消费方（skills/trpg-gm/index.js 的 40 处 capOf 调用）
// 约定。每个能力开头都注明了消费方怎么用它，改之前先去看那边的调用点，否则
// 就是"不报错、就是没反应"的静默失效。
//
// ── 本版没做的能力（trpg-gm 会自动降级）────────────────────────────────────
//   trpg.panel-*（面板）  trpg.map-*（地图）  trpg.wallet-* / trpg.shop-*（钱包商店）
//   trpg.doc-*（文档收件箱，依赖 plugins/file-inbox）
// 这些能力**不要**写进 manifest.capabilities —— 声明了却没实现会被审计抓出来。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from '../../src/config.js';
// 卡面与点指令（原 plugins/trpg-cards，2026-10-26 并入）
import { cardsProviders, cardsHooks, initCards } from './cards.js';

const ROOT_DIR = path.join(DATA_DIR, 'trpg-tools');
const STATE_FILE = path.join(ROOT_DIR, 'state.json');
const DEFAULT_MODULES_DIR = path.join(ROOT_DIR, 'modules');

let cfg = () => ({});
let log = () => {};
let warn = () => {};
let fetchImpl = null;

// ── 设置读取（每次现取，改配置立即生效，不用重载）──────────────────────────

function settings() {
  const c = cfg() || {};
  const num = (v, d, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(max, Math.max(min, n));
  };
  return {
    maxDicePerRoll: num(c.maxDicePerRoll, 100, 1, 1000),
    sectionMaxChars: num(c.sectionMaxChars, 6000, 500, 30000),
    intelHalfLifeHours: num(c.intelHalfLifeHours, 24, 1, 720),
    modulesDir: String(c.modulesDir || '').trim() || DEFAULT_MODULES_DIR,
    allowWebImport: c.allowWebImport !== false,
    defaultSeries: String(c.defaultSeries || '').trim() || '本地剧本',
  };
}

function modulesDir() {
  return settings().modulesDir;
}

// ── 状态读写：先写 .tmp 再 rename，避免掉电/崩溃留下半个 JSON ────────────────

function ensureDirs() {
  try {
    fs.mkdirSync(ROOT_DIR, { recursive: true });
    fs.mkdirSync(modulesDirSafe(), { recursive: true });
  } catch (error) {
    warn(`创建目录失败：${error?.message ?? error}`);
  }
}

function modulesDirSafe() {
  try {
    return modulesDir();
  } catch {
    return DEFAULT_MODULES_DIR;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadState() {
  const s = readJson(STATE_FILE, null);
  if (!s || typeof s !== 'object') return { chats: {} };
  if (!s.chats || typeof s.chats !== 'object') s.chats = {};
  return s;
}

function saveState(state) {
  writeJson(STATE_FILE, state);
}

/**
 * 取某个会话的状态；不存在就建一条并落盘。
 * 所有能力都通过它拿 chatKey 作用域，避免"不同群串味"。
 */
function chatState(state, chatKey) {
  const key = String(chatKey || '').trim();
  if (!key) return null;
  if (!state.chats[key] || typeof state.chats[key] !== 'object') {
    state.chats[key] = {
      gm: false,
      scene: { module: '', sceneIndex: 0 },
      moduleId: '',
      actIndex: 0,
      characters: {},
      intel: [],
    };
  }
  const c = state.chats[key];
  if (!c.scene || typeof c.scene !== 'object') c.scene = { module: '', sceneIndex: 0 };
  if (!c.characters || typeof c.characters !== 'object') c.characters = {};
  if (!Array.isArray(c.intel)) c.intel = [];
  if (typeof c.gm !== 'boolean') c.gm = false;
  if (!c.moduleId) c.moduleId = '';
  if (!Number.isFinite(Number(c.actIndex))) c.actIndex = 0;
  return c;
}

// ── 掷骰引擎 ──────────────────────────────────────────────────────────────
//
// 支持：N d M、纯数字、加减乘除、括号、比较符（<= >= < > =）、前置 N# 表示重复。
// 不支持函数与变量 —— 需要"看情况"的判定交给模型去叙述，这里只保证数字不会算错。

const DICE_TOKEN = /(\d*\s*d\s*\d+|\d+\.?\d*|<=|>=|[<>+=*/()\-])/gi;

function tokenizeExpression(text) {
  const tokens = [];
  const src = String(text || '');
  let m;
  DICE_TOKEN.lastIndex = 0;
  while ((m = DICE_TOKEN.exec(src))) {
    const raw = m[1].replace(/\s+/g, '');
    tokens.push(raw);
  }
  return tokens;
}

function parseDiceTerm(token) {
  const m = /^(\d*)d(\d+)$/i.exec(token);
  if (!m) return null;
  const count = m[1] === '' ? 1 : Number(m[1]);
  const faces = Number(m[2]);
  return { count, faces };
}

/**
 * 表达式求值。返回 { ok, total, compare, rolls, text }，失败时 { ok:false, error }。
 * compare 形如 { op:'<=', value:60 }，没有则 null。
 */
function evaluateExpression(text, { maxDice, repeat = 1 } = {}) {
  const tokens = tokenizeExpression(text);
  if (!tokens.length) return { ok: false, error: '没识别到骰子或数字，写法例如 3d6 / 1d20>=15' };

  // 比较符只允许出现一次，且必须在最后（1d20>=15）
  let compare = null;
  const cmpIndex = tokens.findIndex((t) => ['<=', '>=', '<', '>', '='].includes(t));
  let exprTokens = tokens;
  if (cmpIndex >= 0) {
    const op = tokens[cmpIndex];
    const rhs = tokens[cmpIndex + 1];
    if (!/^\d+\.?\d*$/.test(String(rhs || ''))) return { ok: false, error: '比较符右侧必须是数字' };
    compare = { op, value: Number(rhs) };
    exprTokens = tokens.slice(0, cmpIndex);
  }
  if (!exprTokens.length) return { ok: false, error: '缺少骰子表达式' };

  let pos = 0;
  let diceRolled = 0;
  const trace = [];   // [{ tok, values }] 每个骰子项的逐颗点数，最后拼成人话

  const peek = () => exprTokens[pos];
  const next = () => exprTokens[pos++];

  function parseFactor() {
    if (peek() === '(') {
      next();
      const inner = parseExpr();
      if (peek() === ')') next();
      return inner;
    }
    if (peek() === '-') {
      next();
      return -parseFactor();
    }
    const tok = next();
    if (tok === undefined) throw new Error('表达式不完整');
    const dice = parseDiceTerm(tok);
    if (dice) {
      if (dice.count < 1) throw new Error('骰子数量必须 ≥ 1');
      if (dice.faces < 2 || dice.faces > 1000) throw new Error('骰面必须在 2~1000');
      diceRolled += dice.count;
      if (diceRolled > maxDice) throw new Error(`单次最多 ${maxDice} 个骰子`);
      const values = [];
      for (let i = 0; i < dice.count; i += 1) values.push(1 + Math.floor(Math.random() * dice.faces));
      trace.push({ tok, values });
      return values.reduce((a, b) => a + b, 0);
    }
    if (/^\d+\.?\d*$/.test(tok)) return Number(tok);
    throw new Error(`无法识别的记号：${tok}`);
  }

  function parseTerm() {
    let value = parseFactor();
    for (;;) {
      const op = peek();
      if (op !== '*' && op !== '/') break;
      next();
      const rhs = parseFactor();
      if (op === '*') value *= rhs;
      else {
        if (!rhs) throw new Error('除数为 0');
        value /= rhs;
      }
    }
    return value;
  }

  function parseExpr() {
    let value = parseTerm();
    for (;;) {
      const op = peek();
      if (op !== '+' && op !== '-') break;
      next();
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  let total;
  try {
    total = parseExpr();
    if (pos < exprTokens.length) throw new Error(`多余的记号：${exprTokens.slice(pos).join(' ')}`);
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
  if (!Number.isFinite(total)) return { ok: false, error: '结果不是有效数字' };
  total = Math.round(total);

  // 拼给模型看的一行：单骰直接给点数，多骰给逐颗明细，混合表达式再补括号说明
  const exprText = exprTokens.join('');
  let text0;
  if (trace.length === 1 && exprTokens.length === 1) {
    const v = trace[0].values;
    text0 = v.length === 1 ? `${exprText} = ${v[0]}` : `${exprText} = [${v.join(',')}] = ${total}`;
  } else if (trace.length === 0) {
    text0 = `${exprText} = ${total}`;
  } else {
    const breakdown = trace.map((t) => `${t.tok}[${t.values.join(',')}]`).join(' ');
    text0 = `${exprText} = ${total}（${breakdown}）`;
  }
  return { ok: true, total, compare, rolls: trace, text: text0, repeat };
}

/** 把比较结果翻译成一句话。 */
function describeCompare(total, compare) {
  if (!compare) return '';
  const { op, value } = compare;
  let ok;
  if (op === '<=') ok = total <= value;
  else if (op === '<') ok = total < value;
  else if (op === '>=') ok = total >= value;
  else if (op === '>') ok = total > value;
  else ok = total === value;
  return `${ok ? '✅ 达成' : '❌ 未达成'}（${op} ${value}）`;
}

/** 奖励骰/惩罚骰：多掷几个十位，取最小的（奖励）或最大的（惩罚）。 */

// ── 人物卡 ────────────────────────────────────────────────────────────────

// 本地补丁（2026-10-25）：加了「感知」。
// DnD 5e 的六属性里 WIS 就是感知，原来的表只有 COC 那套（意志/教育/体型…），
// 不补这个词的话 `character-set 感知 12` 会被当成**技能**存进 skills，
// 卡面上就变成"技能：感知12"，DnD 角色卡直接错位。
const ATTR_KEYS = new Set(['力量', '敏捷', '体质', '智力', '意志', '魅力', '幸运', '教育', '体型', '外貌', '感知']);
const VITAL_KEYS = new Map([['hp', 'hp'], ['HP', 'hp'], ['mp', 'mp'], ['MP', 'mp'], ['san', 'san'], ['SAN', 'san'], ['斗气', 'douqi'], ['douqi', 'douqi']]);

// 各职业的生命骰（升级加血用；未知职业按 d8）
const CLASS_HIT_DIE = {
  战士: 10, 野蛮人: 12, 圣武士: 10, 游侠: 10,
  盗贼: 8, 牧师: 8, 德鲁伊: 8, 吟游诗人: 8, 武僧: 8, 邪术师: 8,
  术士: 6, 法师: 6
};

// 起始装备（PHB 各职业初始装备的简化版）：首次定职业时发一次。
// weapon 是"自动装备"的那把（必须在 items 里）。
const CLASS_KIT = {
  战士: { items: ['长剑', '盾牌', '皮甲'], gold: 20, weapon: '长剑' },
  圣武士: { items: ['长剑', '盾牌', '皮甲'], gold: 20, weapon: '长剑' },
  野蛮人: { items: ['大剑', '皮甲'], gold: 10, weapon: '大剑' },
  游侠: { items: ['短弓', '短剑', '皮甲'], gold: 20, weapon: '短弓' },
  盗贼: { items: ['匕首', '短剑', '盗贼工具', '皮甲'], gold: 25, weapon: '短剑' },
  牧师: { items: ['战锤', '盾牌', '皮甲'], gold: 15, weapon: '战锤' },
  德鲁伊: { items: ['木棒', '皮甲'], gold: 10, weapon: '木棒' },
  吟游诗人: { items: ['短剑', '皮甲'], gold: 15, weapon: '短剑' },
  武僧: { items: ['短剑'], gold: 5, weapon: '短剑' },
  邪术师: { items: ['短剑', '皮甲'], gold: 15, weapon: '短剑' },
  术士: { items: ['匕首', '皮甲'], gold: 15, weapon: '匕首' },
  法师: { items: ['法术书', '匕首'], gold: 15, weapon: '匕首' },
};

/** 发初始装备（每个角色只发一次，靠 card.kit 标记）。返回 true=发了 */
function grantKit(card) {
  if (!card || card.kit === true) return false;
  const clazz = String(card.class || '').trim();
  if (!clazz) return false;
  const kit = CLASS_KIT[clazz];
  if (!kit) return false;
  if (!Array.isArray(card.items)) card.items = [];
  for (const it of kit.items) {
    if (card.items.length >= 12) break;
    if (!card.items.includes(it)) card.items.push(it);
  }
  card.gold = Math.max(0, Math.trunc(Number(card.gold) || 0)) + kit.gold;
  if (!card.weapon && kit.weapon && card.items.includes(kit.weapon)) card.weapon = kit.weapon;
  card.kit = true;
  return true;
}

function blankCard(userId, name) {
  return {
    userId: String(userId || ''),
    name: String(name || '').trim() || `玩家${String(userId || '').slice(-4)}`,
    // 本地补丁（2026-10-26）：种族 / 职业 / 等级。人物卡原来是纯数值的，
    // 这几个塞不进 attrs（character-set 只收数字，未知键会被当成**技能**），
    // 也不该挤进 background（那是剧情背景，模型写东西会互相覆盖）。
    // 因此给它们独立字段，由 trpg.character-profile / trpg.character-levelup 读写。
    race: '',
    class: '',
    bg: '',          // 背景（士兵/智者/流浪儿…），和 card.background（剧情背景故事）不是一回事
    level: 1,
    maxHp: null,     // 血量上限（休息回血要用；hp 是当前值）
    weapon: '',      // 当前装备的武器名（必须在 items 里）
    gold: 0,         // 金币（剧本外货币，跨本通用）
    slots: null,     // 法术位/资源：当前
    slotsMax: null,  // 法术位/资源：上限
    conditions: [],  // 状态：中毒/倒地/恐惧/束缚…（字符串数组）
    attrs: {},
    skills: {},
    hp: null,
    mp: null,
    san: null,
    douqi: null,
    background: '',
    secret: '',
    known: [],
    items: [],
  };
}

function getCard(chat, userId) {
  const key = String(userId || '');
  if (!key) return null;
  const card = chat.characters[key];
  return card && typeof card === 'object' ? card : null;
}

function putCard(chat, userId, name) {
  const key = String(userId || '');
  if (!chat.characters[key]) chat.characters[key] = blankCard(key, name);
  const card = chat.characters[key];
  if (name) card.name = String(name);
  if (!Array.isArray(card.known)) card.known = [];
  if (!Array.isArray(card.items)) card.items = [];
  return card;
}

// ── 剧本库 ────────────────────────────────────────────────────────────────

function moduleIdOf(name) {
  const base = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (base.replace(/-/g, '').length >= 3) return base.slice(0, 40);
  // 中文名 → 用内容哈希，保证同名总是同一个 id（重复导入才能覆盖而不是复制一份）
  const hash = createHash('sha1').update(String(name || '').trim() || String(Date.now())).digest('hex').slice(0, 8);
  return `mod-${hash}`;
}

function listModuleDirs() {
  const dir = modulesDirSafe();
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function loadModuleById(id) {
  const dir = path.join(modulesDirSafe(), String(id || ''));
  const meta = readJson(path.join(dir, 'module.json'), null);
  if (!meta || typeof meta !== 'object') return null;
  return { ...meta, dir };
}

function loadAllModules() {
  const out = [];
  for (const dir of listModuleDirs()) {
    const meta = readJson(path.join(dir, 'module.json'), null);
    if (meta && typeof meta === 'object') out.push({ ...meta, dir });
  }
  out.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh'));
  return out;
}

/** 按 id / 名字 / 文件名找模组。 */
function findModule(ref) {
  const key = String(ref || '').trim();
  if (!key) return null;
  const all = loadAllModules();
  return all.find((m) => m.id === key)
    || all.find((m) => String(m.name || '') === key)
    || all.find((m) => String(m.name || '').includes(key))
    || null;
}

function currentModule(chat) {
  const byId = chat?.moduleId ? loadModuleById(chat.moduleId) : null;
  if (byId) return byId;
  const byName = chat?.scene?.module ? findModule(chat.scene.module) : null;
  return byName || null;
}

function readSectionFile(mod, file) {
  if (!mod?.dir || !file) return '';
  try {
    return fs.readFileSync(path.join(mod.dir, file), 'utf8');
  } catch {
    return '';
  }
}

function actsOf(mod) {
  return Array.isArray(mod?.acts) ? mod.acts : [];
}

// ── 文本 → 幕的切分（导入用）──────────────────────────────────────────────

const ACT_HEADING = /^\s*(?:#{1,3}\s*)?(第\s*[0-9零一二三四五六七八九十百]+\s*[幕章]|act\s*\d+|scene\s*\d+|part\s*\d+)\b/i;

function splitIntoActs(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  const lines = raw.split('\n');
  const acts = [];
  let cur = null;
  for (const line of lines) {
    if (ACT_HEADING.test(line)) {
      cur = { title: line.replace(/^#+\s*/, '').trim().slice(0, 60), body: [] };
      acts.push(cur);
      continue;
    }
    if (!cur) {
      cur = { title: '开场', body: [] };
      acts.push(cur);
    }
    cur.body.push(line);
  }
  const cleaned = acts
    .map((a) => ({ title: a.title || '正文', body: a.body.join('\n').trim() }))
    .filter((a) => a.body.length > 0);
  if (cleaned.length) return cleaned;
  return [{ title: '正文', body: raw }];
}

/** 极简 HTML → 纯文本：够用于把网页剧本抓下来，不做完整解析。 */
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── 能力实现 ──────────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = (...args) => api.log(...args);
  warn = (...args) => api.warn(...args);
  fetchImpl = typeof api.fetch === 'function' ? api.fetch : null;
  ensureDirs();
  log(`trpg-tools 就绪，剧本库目录：${modulesDirSafe()}`);
  // 卡面与点指令（原 plugins/trpg-cards，2026-10-26 并入本插件）
  initCards(api);
}

const coreProviders = {
  // ── 掷骰 ────────────────────────────────────────────────────────────────
  // 消费方：trpg-gm__roll_dice。它读 result.results[].detail 与 result.repeat。
  'trpg.dice-roll': ({ expression, repeat } = {}) => {
    const s = settings();
    const raw = String(expression || '').trim();
    if (!raw) return { ok: false, error: '缺少表达式' };

    // 前置 "3#1d6" 也当重复次数
    let body = raw;
    let times = Number(repeat) || 0;
    const hash = /^(\d{1,2})\s*#\s*(.+)$/.exec(raw);
    if (hash) {
      times = times || Number(hash[1]);
      body = hash[2];
    }
    const count = Math.min(20, Math.max(1, times || 1));

    const results = [];
    for (let i = 0; i < count; i += 1) {
      const r = evaluateExpression(body, { maxDice: s.maxDicePerRoll });
      if (!r.ok) return { ok: false, error: r.error };
      const cmpText = describeCompare(r.total, r.compare);
      results.push({ detail: `${r.text}${cmpText ? ` → ${cmpText}` : ''}` });
    }
    return { ok: true, results, repeat: count };
  },

  // ── 跑团模式开关 ────────────────────────────────────────────────────────
  // 消费方：gm_mode 工具（返回 undefined 视为失败）、promptSections（严格 === true）。
  'trpg.gm-get': ({ chatKey } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    return chat ? chat.gm === true : false;
  },
  'trpg.gm-set': ({ chatKey, enabled } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat) return undefined;
    chat.gm = enabled === true;
    saveState(state);
    return chat.gm;
  },

  // ── 剧情进度 ────────────────────────────────────────────────────────────
  'trpg.scene-get': ({ chatKey } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat) return { module: '', sceneIndex: 0 };
    return { module: String(chat.scene.module || ''), sceneIndex: Number(chat.scene.sceneIndex) || 0 };
  },
  'trpg.scene-set': ({ chatKey, module, sceneIndex } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat) return null;
    const name = String(module || '').trim();
    const idx = Math.max(0, Math.trunc(Number(sceneIndex) || 0));
    chat.scene = { module: name || chat.scene.module || '', sceneIndex: idx || chat.scene.sceneIndex || 0 };
    // 顺便把「当前模组」绑上，module-get 和动态提示词才读得到正文
    if (name) {
      const mod = findModule(name);
      if (mod) chat.moduleId = mod.id;
    }
    if (idx > 0) chat.actIndex = idx;
    saveState(state);
    return { module: chat.scene.module, sceneIndex: chat.scene.sceneIndex };
  },

  // ── 人物卡 ──────────────────────────────────────────────────────────────
  'trpg.character-get': ({ chatKey, userId } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat) return null;
    return getCard(chat, userId);
  },
  'trpg.character-set': ({ chatKey, userId, key, value, name } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat || !userId) return null;
    const k = String(key || '').trim();
    if (!k) return null;
    const card = putCard(chat, userId, name);

    // 本地补丁（2026-10-26）：把「等级 / 种族 / 职业」这些非数值字段认出来。
    // 之前它们在 ATTR_KEYS / VITAL_KEYS 里都没有，会掉进最后那个 `else` 变成
    // **技能** —— 实测模型调 update_character(等级,1) 之后卡面上多了一行
    // 「技能：等级1」，而真正的 level 还是 1（看起来像"升了级又没升"）。
    if (k === '等级' || k === '级别' || /^lv$|^level$/i.test(k)) {
      const lv = Number(value);
      if (!Number.isFinite(lv)) return null;
      card.level = Math.min(20, Math.max(1, Math.trunc(lv)));
      saveState(state);
      return card;
    }
    if (k === '种族' || /^race$/i.test(k)) {
      card.race = String(value ?? '').trim().slice(0, 20);
      saveState(state);
      return card;
    }
    if (k === '金币' || /^gold$/i.test(k)) {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      card.gold = Math.max(0, Math.trunc(n));
      saveState(state);
      return card;
    }
    if (k === '法术位' || k === 'slots') {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      card.slots = Math.max(0, Math.trunc(n));
      if (card.slotsMax === null || card.slotsMax === undefined || card.slotsMax < card.slots) card.slotsMax = card.slots;
      saveState(state);
      return card;
    }
    if (k === '法术位上限' || k === 'slotsMax') {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      card.slotsMax = Math.max(0, Math.trunc(n));
      saveState(state);
      return card;
    }
    if (k === '出身' || k === '背景' || /^bg$|^origin$/i.test(k)) {
      card.bg = String(value ?? '').trim().slice(0, 20);
      saveState(state);
      return card;
    }
    if (k === '职业' || /^class$|^clazz$/i.test(k)) {
      card.class = String(value ?? '').trim().slice(0, 20);
      grantKit(card);
      saveState(state);
      return card;
    }
    // 名字也是字符串，同样要放在数字校验之前（原来它排在 num 之后，永远走不到）
    if (k === '名字' || /^name$/i.test(k)) {
      const nm = String(value ?? '').trim().slice(0, 20);
      if (nm) card.name = nm;
      saveState(state);
      return card;
    }

    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    if (ATTR_KEYS.has(k)) card.attrs[k] = num;
    else if (VITAL_KEYS.has(k)) {
      card[VITAL_KEYS.get(k)] = num;
      // 第一次写 hp 时把上限也记下来（否则休息不知道回到多少）
      if (VITAL_KEYS.get(k) === 'hp' && (card.maxHp === null || card.maxHp === undefined)) card.maxHp = num;
    }
    else card.skills[k] = num;
    saveState(state);
    return card;
  },
  // 本地补丁（2026-10-26）：读写种族 / 职业 / 等级（字符串与数字字段）。
  // 消费方：plugins/trpg-cards 的 `.pc roll`（随机 roll 出身）和 `.pc 种族 X`。
  'trpg.character-profile': ({ chatKey, userId, race, clazz, bg, level, name } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat || !userId) return null;
    const card = putCard(chat, userId, name);
    if (race !== undefined) card.race = String(race || '').trim().slice(0, 20);
    if (clazz !== undefined) card.class = String(clazz || '').trim().slice(0, 20);
    if (bg !== undefined) card.bg = String(bg || '').trim().slice(0, 20);
    if (level !== undefined && Number.isFinite(Number(level))) card.level = Math.min(20, Math.max(1, Math.trunc(Number(level))));
    grantKit(card);
    saveState(state);
    return card;
  },
  // 本地补丁（2026-10-26）：升一级（里程碑式，不看经验）。
  // 消费方：trpg-gm 的 level_up 工具、plugins/trpg-cards 的 `.pc 升级`。
  // 加血规则：生命骰取平均（floor(die/2)+1）+ 体质调整值，至少 +1 —— 和常见
  // 的"固定血量"变体一致，避免升级时掷骰掷出 1 点让人心态爆炸。
  'trpg.character-levelup': ({ chatKey, userId, name } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat || !userId) return null;
    const card = putCard(chat, userId, name);
    const lv = Math.min(20, Math.max(1, Math.trunc(Number(card.level) || 1)));
    if (lv >= 20) return { ok: true, level: 20, maxed: true, prevLevel: 20, gainHp: 0, hp: card.hp };
    const die = CLASS_HIT_DIE[String(card.class || '').trim()] || 8;
    const con = Number(card.attrs?.体质);
    const conMod = Number.isFinite(con) ? Math.floor((con - 10) / 2) : 0;
    const gainHp = Math.max(1, Math.floor(die / 2) + 1 + conMod);
    const prevHp = Math.max(1, Math.trunc(Number(card.hp) || 1));
    card.level = lv + 1;
    card.hp = prevHp + gainHp;
    card.maxHp = Math.max(1, Math.trunc(Number(card.maxHp) || prevHp)) + gainHp;
    saveState(state);
    return { ok: true, level: lv + 1, prevLevel: lv, maxed: false, gainHp, hp: card.hp, prevHp, hitDie: die };
  },
  // 本地补丁（2026-10-27）：初始装备。定职业时自动发；这个能力用于手动补发。
  'trpg.character-kit': ({ chatKey, userId, name, force } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat || !userId) return { ok: false, error: '缺少会话或玩家' };
    const card = putCard(chat, userId, name);
    if (force === true) card.kit = false;
    const granted = grantKit(card);
    saveState(state);
    return {
      ok: true,
      granted,
      class: card.class || '',
      items: card.items || [],
      weapon: card.weapon || '',
      gold: Math.max(0, Math.trunc(Number(card.gold) || 0)),
    };
  },

  // 本地补丁（2026-10-27）：装备武器。必须在背包里才能装；空字符串=卸下。
  'trpg.character-equip': ({ chatKey, userId, weapon, name } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat || !userId) return { ok: false, error: '缺少会话或玩家' };
    const card = putCard(chat, userId, name);
    const want = String(weapon ?? '').trim();
    const items = Array.isArray(card.items) ? card.items : [];
    if (!want) {
      card.weapon = '';
      saveState(state);
      return { ok: true, weapon: '', card };
    }
    const hit = items.find((x) => x === want)
      || items.find((x) => String(x).includes(want) || want.includes(String(x)));
    if (!hit) {
      return { ok: false, error: '背包里没有「' + want + '」', items };
    }
    card.weapon = String(hit);
    saveState(state);
    return { ok: true, weapon: card.weapon, card };
  },

  // 本地补丁（2026-10-27）：宝箱数（每群一份）。打完一场战斗 +1，开箱 -1。
  'trpg.chests': ({ chatKey, add, take } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat) return { ok: false, error: '缺少会话' };
    const before = Math.max(0, Math.trunc(Number(chat.chests) || 0));
    let after = before;
    if (Number.isFinite(Number(add))) after += Math.trunc(Number(add));
    if (take === true) after -= 1;
    after = Math.max(0, after);
    chat.chests = after;
    saveState(state);
    return { ok: true, before, chests: after };
  },

  // 本地补丁（2026-10-27）：战斗状态（每群一份）。
  // 结构：{ active, round, index, combatants: [{ id, name, kind, userId?, hp, maxHp, ac, init }] }
  // 逻辑（命中/伤害/回合推进）在 plugins/trpg-tools/cards.js，这里只负责存取。
  'trpg.combat-state': ({ chatKey, set } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat) return { ok: false, error: '缺少会话' };
    if (set !== undefined) {
      chat.combat = set || null;
      saveState(state);
      return { ok: true, combat: chat.combat };
    }
    return { ok: true, combat: chat.combat || null };
  },

  // 本地补丁（2026-10-27）：金币。剧本外货币，跨本通用（挂在卡上）。
  // 消费方：trpg-gm 的 wallet / grant_gold 工具、cards.js 的 `.pc 金币`。
  'trpg.character-gold': ({ chatKey, userId, delta, set, name } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat || !userId) return null;
    const card = putCard(chat, userId, name);
    const before = Math.max(0, Math.trunc(Number(card.gold) || 0));
    let after = before;
    if (set !== undefined && Number.isFinite(Number(set))) after = Math.trunc(Number(set));
    else if (Number.isFinite(Number(delta))) after = before + Math.trunc(Number(delta));
    after = Math.max(0, after);
    card.gold = after;
    saveState(state);
    return { ok: true, before, gold: after, delta: after - before };
  },

  // 本地补丁（2026-10-27）：商店。价目表先看 data/trpg-tools/shop.json，
  // 没有就用内置的默认表（DnD 5e PHB 常见装备价格）。
  'trpg.shop-list': () => {
    return { ok: true, items: loadShop() };
  },
  'trpg.shop-buy': ({ chatKey, userId, sku, name } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat || !userId) return { ok: false, error: '缺少会话或玩家' };
    const key = String(sku || '').trim();
    if (!key) return { ok: false, error: '要买哪一件？' };
    const item = loadShop().find((x) => x.sku === key || x.name === key || String(x.name).includes(key));
    if (!item) return { ok: false, error: `商店里没有「${key}」` };

    const card = putCard(chat, userId, name);
    const gold = Math.max(0, Math.trunc(Number(card.gold) || 0));
    if (gold < item.price) return { ok: false, error: `金币不够：要 ${item.price}，你只有 ${gold}` };

    // 扣钱 + 生效
    card.gold = gold - item.price;
    const applied = [];
    if (item.kind === 'heal') {
      const maxHp = Math.max(1, Math.trunc(Number(card.maxHp) || Number(card.hp) || 1));
      const before = Math.max(0, Math.trunc(Number(card.hp) || 0));
      card.hp = Math.min(maxHp, before + (Number(item.amount) || 0));
      applied.push(`HP ${before} → ${card.hp}`);
    } else if (item.kind === 'cure' && item.condition) {
      if (Array.isArray(card.conditions)) {
        const had = card.conditions.includes(item.condition);
        card.conditions = card.conditions.filter((c) => c !== item.condition);
        applied.push(had ? `解除了「${item.condition}」` : `（本来就没有${item.condition}）`);
      }
    } else {
      // 默认当物资
      if (!Array.isArray(card.items)) card.items = [];
      if (card.items.length >= 12) {
        card.gold = gold;   // 退钱
        return { ok: false, error: '携带位满了（12 件），先丢点东西' };
      }
      if (!card.items.includes(item.name)) card.items.push(item.name);
      applied.push('已放进背包');
    }
    saveState(state);
    return { ok: true, item: { sku: item.sku, name: item.name, price: item.price }, gold: card.gold, applied };
  },

  // 本地补丁（2026-10-27）：地图。每群一份，结构 { title, current, places: {名字: {desc, exits: []}} }。
  'trpg.map-set': ({ chatKey, title, places, current } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat) return { ok: false, error: '缺少会话' };
    const map = { title: String(title || '地图').slice(0, 30), current: String(current || '').slice(0, 30), places: {} };
    for (const [name, info] of Object.entries(places || {})) {
      const key = String(name).trim().slice(0, 30);
      if (!key) continue;
      map.places[key] = {
        desc: String(info?.desc || '').slice(0, 300),
        exits: Array.isArray(info?.exits) ? info.exits.map((x) => String(x).slice(0, 30)) : [],
      };
    }
    if (!map.current) map.current = Object.keys(map.places)[0] || '';
    chat.map = map;
    saveState(state);
    return { ok: true, map };
  },
  'trpg.map-get': ({ chatKey } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    const map = chat?.map;
    if (!map || !map.places || !Object.keys(map.places).length) return { ok: false, error: '本群还没有地图' };
    return { ok: true, map };
  },
  'trpg.map-move': ({ chatKey, place } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    const map = chat?.map;
    if (!map || !map.places) return { ok: false, error: '本群还没有地图' };
    const want = String(place || '').trim();
    const name = Object.keys(map.places).find((k) => k === want)
      || Object.keys(map.places).find((k) => k.includes(want) || want.includes(k));
    if (!name) return { ok: false, error: `地图上没有「${want}」。有的地方：${Object.keys(map.places).join('、')}` };
    const here = map.current ? map.places[map.current] : null;
    if (here && Array.isArray(here.exits) && here.exits.length && !here.exits.includes(name) && name !== map.current) {
      return { ok: false, error: `从「${map.current}」过不去「${name}」，能去的是：${here.exits.join('、')}` };
    }
    map.current = name;
    saveState(state);
    return { ok: true, current: name, info: map.places[name], map };
  },

  // 本地补丁（2026-10-26）：扣血 / 回血，HP 归 0 自动挂「倒地」。
  // 消费方：trpg-gm 的 apply_damage 工具、plugins/trpg-tools/cards.js 的 `.pc 受伤 8`。
  'trpg.character-hp': ({ chatKey, userId, delta = 0, name } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat || !userId) return null;
    const card = putCard(chat, userId, name);
    const maxHp = Math.max(1, Math.trunc(Number(card.maxHp) || Number(card.hp) || 1));
    if (card.maxHp === null || card.maxHp === undefined) card.maxHp = maxHp;
    const before = Math.max(0, Math.trunc(Number(card.hp) || 0));
    const d = Math.trunc(Number(delta) || 0);
    const after = Math.max(0, Math.min(maxHp, before + d));
    card.hp = after;
    if (!Array.isArray(card.conditions)) card.conditions = [];
    let down = false;
    if (after === 0 && !card.conditions.includes('倒地')) {
      card.conditions.push('倒地');
      down = true;
    }
    // 被治回 1 血以上就不再算倒地（原版规则要稳定后才能行动，这里简化）
    if (after > 0 && card.conditions.includes('倒地')) {
      card.conditions = card.conditions.filter((c) => c !== '倒地');
    }
    saveState(state);
    return { ok: true, before, hp: after, maxHp, delta: after - before, down, conditions: card.conditions };
  },
  // 本地补丁（2026-10-26）：先攻顺序（每个会话一份）。
  // 消费方：plugins/trpg-tools/cards.js 的 `.pc 先攻` / `.pc 下一个`。
  'trpg.initiative-set': ({ chatKey, list } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat) return null;
    chat.initiative = { list: Array.isArray(list) ? list : [], index: 0 };
    saveState(state);
    return chat.initiative;
  },
  'trpg.initiative-get': ({ chatKey } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat || !chat.initiative) return { list: [], index: 0 };
    return chat.initiative;
  },
  'trpg.initiative-next': ({ chatKey } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat || !chat.initiative || !chat.initiative.list.length) return null;
    chat.initiative.index = (Number(chat.initiative.index) || 0) + 1;
    saveState(state);
    return chat.initiative;
  },
  // 本地补丁（2026-10-26）：状态（中毒/倒地/恐惧…）。
  // 消费方：plugins/trpg-tools/cards.js 的 `.pc 状态 中毒`、trpg-gm 的 apply_condition 工具。
  'trpg.character-conditions': ({ chatKey, userId, add, remove, set, name } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat || !userId) return null;
    const card = putCard(chat, userId, name);
    if (!Array.isArray(card.conditions)) card.conditions = [];
    const norm = (s) => String(s || '').trim().slice(0, 12);
    if (Array.isArray(set)) card.conditions = [...new Set(set.map(norm).filter(Boolean))];
    for (const c of (Array.isArray(add) ? add : (add ? [add] : []))) {
      const v = norm(c);
      if (v && !card.conditions.includes(v)) card.conditions.push(v);
    }
    for (const c of (Array.isArray(remove) ? remove : (remove ? [remove] : []))) {
      const v = norm(c);
      card.conditions = card.conditions.filter((x) => x !== v);
    }
    saveState(state);
    return { ok: true, conditions: card.conditions };
  },
  // 本地补丁（2026-10-26）：短休 / 长休。
  //   短休：回一个生命骰（平均血量 floor(die/2)+1 + 体质调整值），不超过上限
  //   长休：血量回满
  // 消费方：plugins/trpg-tools/cards.js 的 `.pc 短休 / .pc 长休`、trpg-gm 的 rest 工具。
  'trpg.character-rest': ({ chatKey, userId, kind = 'long', name } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat || !userId) return null;
    const card = putCard(chat, userId, name);
    const maxHp = Math.max(1, Math.trunc(Number(card.maxHp) || Number(card.hp) || 1));
    if (card.maxHp === null || card.maxHp === undefined) card.maxHp = maxHp;
    const hp = Math.max(0, Math.trunc(Number(card.hp) || 0));
    const die = CLASS_HIT_DIE[String(card.class || '').trim()] || 8;
    const con = Number(card.attrs?.体质);
    const conMod = Number.isFinite(con) ? Math.floor((con - 10) / 2) : 0;
    const perDie = Math.max(1, Math.floor(die / 2) + 1 + conMod);
    const wantShort = String(kind).toLowerCase().startsWith('s');
    const after = wantShort ? Math.min(maxHp, hp + perDie) : maxHp;
    card.hp = after;
    saveState(state);
    return { ok: true, kind: wantShort ? 'short' : 'long', hp: after, maxHp, healed: after - hp, hitDie: die };
  },
  // 本地补丁（2026-10-25）：删掉一张人物卡。
  // 消费方：plugins/trpg-cards 的 `.pc 清卡` —— 换规则体系（COC↔DnD）时，
  // 同一张卡会同时残留两套字段，而 character-set 只能覆盖不能删除，只能整张清掉重来。
  'trpg.character-clear': ({ chatKey, userId } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat || !userId) return false;
    const key = String(userId);
    if (!chat.characters || !chat.characters[key]) return false;
    delete chat.characters[key];
    saveState(state);
    return true;
  },
  'trpg.character-background': ({ chatKey, userId, text, name } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat || !userId) return null;
    const card = putCard(chat, userId, name);
    card.background = String(text || '').trim().slice(0, 2000);
    saveState(state);
    return card;
  },
  // 消费方：get_own_secret。带 text = 追加一条线索；不带 text = 读取全部线索。
  'trpg.character-known': ({ chatKey, userId, text } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat || !userId) return [];
    const card = putCard(chat, userId, '');
    const line = String(text || '').trim();
    if (line) {
      if (!card.known.includes(line)) card.known.push(line.slice(0, 300));
      saveState(state);
    }
    return card.known;
  },
  // 消费方：get_party（无 panel-party 时的退路）。读 {list:[{name,userId,brief}]}。
  'trpg.character-public': ({ chatKey } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat) return { list: [] };
    const list = Object.values(chat.characters).map((card) => {
      const attrs = Object.entries(card.attrs || {}).map(([k, v]) => `${k}${v}`).join('/');
      const vitals = ['hp', 'mp', 'san'].filter((k) => card[k] !== null && card[k] !== undefined).map((k) => `${k.toUpperCase()}${card[k]}`).join(' ');
      // 种族/职业也算公开信息（本地补丁）：卡册里能看出这人是什么出身
      const tags = [card.race, card.class].filter(Boolean).join('·');
      return {
        userId: card.userId,
        name: card.name || card.userId,
        brief: [tags ? `[${tags}]` : '', attrs, vitals].filter(Boolean).join(' ') || '还没登记属性',
      };
    });
    return { list };
  },
  // 消费方：update_character 之外的物资工具，读 {ok, added|removed, count}。
  'trpg.character-items': ({ chatKey, userId, text, remove, name } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat || !userId) return { ok: false, error: '缺少会话或玩家' };
    const card = putCard(chat, userId, name);
    const item = String(text || '').trim().slice(0, 120);
    if (!item) return { ok: false, error: '缺少物资名' };
    if (remove) {
      const i = card.items.indexOf(item);
      if (i < 0) return { ok: true, removed: false, count: card.items.length, reason: `没有「${item}」` };
      card.items.splice(i, 1);
      saveState(state);
      return { ok: true, removed: true, count: card.items.length };
    }
    if (card.items.length >= 12) return { ok: true, added: false, count: card.items.length, reason: '携带位已满（12 件）' };
    if (!card.items.includes(item)) card.items.push(item);
    saveState(state);
    return { ok: true, added: true, count: card.items.length };
  },

  // ── 情报传播 ────────────────────────────────────────────────────────────
  // 消费方：record_event / check_knowledge。按"重要度 × 时间衰减"算可信度。
  'trpg.intel-record': ({ chatKey, text, place, importance } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat) return { ok: false, error: '缺少会话' };
    const body = String(text || '').trim();
    if (!body) return { ok: false, error: '缺少事件描述' };
    const imp = Math.max(1, Math.min(3, Math.trunc(Number(importance) || 2)));
    const where = String(place || '').trim();
    chat.intel.push({ text: body.slice(0, 200), place: where, importance: imp, at: Date.now() });
    // 只留最近 200 条，防状态文件无限长大
    if (chat.intel.length > 200) chat.intel.splice(0, chat.intel.length - 200);
    saveState(state);
    return { ok: true, place: where };
  },
  'trpg.intel-known': ({ chatKey, place, hours } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat) return { ok: false, error: '缺少会话' };
    const s = settings();
    const where = String(place || '').trim();
    const now = Date.now();
    const givenHours = Number(hours);
    const events = chat.intel
      .map((e) => {
        const elapsed = Number.isFinite(givenHours) && givenHours >= 0
          ? givenHours
          : Math.max(0, (now - (Number(e.at) || now)) / 3600000);
        const decay = Math.pow(0.5, elapsed / s.intelHalfLifeHours);
        const base = (Number(e.importance) || 2) / 3;
        // 不在同一地点的传闻要再打一折：这里是"本地没有地图数据"时的保守估算
        const samePlace = !where || !e.place || e.place === where;
        const certainty = Math.max(0, Math.min(1, base * decay * (samePlace ? 1 : 0.6)));
        return {
          text: e.text,
          place: e.place,
          certainty: Math.round(certainty * 100) / 100,
          certain: certainty >= 0.6,
        };
      })
      .filter((e) => e.certainty > 0.05)
      .sort((a, b) => b.certainty - a.certainty)
      .slice(0, 12);
    return { ok: true, events };
  },

  // ── 剧本库 ──────────────────────────────────────────────────────────────
  // 消费方：list_modules。有 module-series 就优先走它（按系列分组）。
  'trpg.module-series': () => {
    const all = loadAllModules();
    const groups = new Map();
    for (const mod of all) {
      const series = String(mod.series || '').trim() || settings().defaultSeries;
      if (!groups.has(series)) groups.set(series, []);
      groups.get(series).push(mod);
    }
    const series = [...groups.entries()].map(([name, mods]) => ({
      series: name,
      count: mods.length,
      modules: mods.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        system: m.system || '',
        actCount: actsOf(m).length,
        needsDownload: m.needsDownload === true,
      })),
    }));
    return { ok: true, dir: modulesDirSafe(), series };
  },
  'trpg.module-list': () => {
    const all = loadAllModules();
    return {
      ok: true,
      dir: modulesDirSafe(),
      modules: all.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        series: m.series || '',
        system: m.system || '',
        acts: actsOf(m).map((a) => ({ index: a.index, title: a.title, file: a.file })),
      })),
    };
  },
  // 消费方：promptSections 的动态提示词。必须返回 {module, state:{actIndex}}。
  'trpg.module-get': ({ chatKey } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    if (!chat) return { module: null, state: { actIndex: 0 } };
    const mod = currentModule(chat);
    if (!mod) return { module: null, state: { actIndex: 0 } };
    const actIndex = Number(chat.actIndex) || Number(chat.scene.sceneIndex) || 0;
    return { module: { ...mod, dir: undefined }, state: { actIndex } };
  },
  // 消费方：read_module。section 取值：'rules' / 'act:N' / 'meta'。
  'trpg.module-section': ({ chatKey, section, module } = {}) => {
    const state = loadState();
    const chat = chatState(state, chatKey);
    const mod = (String(module || '').trim() ? findModule(module) : null) || (chat ? currentModule(chat) : null);
    if (!mod) return { ok: false, error: '本群还没有载入剧本。先用 set_scene 指定模组名，或让管理员把剧本放进剧本库。' };

    const s = settings();
    const sec = String(section || '').trim();
    const cap = (content, title, file) => {
      const text = String(content || '').trim();
      if (!text) return { ok: false, error: `剧本「${mod.name || mod.id}」里没有 ${sec} 这一段` };
      const truncated = text.length > s.sectionMaxChars;
      return {
        ok: true,
        title,
        file,
        content: truncated ? text.slice(0, s.sectionMaxChars) : text,
        truncated,
      };
    };

    if (sec === 'rules' || sec === 'rule') {
      if (mod.rulesSummary) return cap(mod.rulesSummary, '规则速查', '');
      return cap(readSectionFile(mod, 'rules.md'), '规则速查', 'rules.md');
    }
    if (sec === 'meta') {
      const acts = actsOf(mod).map((a) => `第 ${a.index} 幕：${a.title || '未命名'}${a.goal ? `（目标：${a.goal}）` : ''}`);
      return cap([`名称：${mod.name || mod.id}`, `系列：${mod.series || '未标'}`, `规则：${mod.system || '未标'}`, '', ...acts].join('\n'), '模组信息', '');
    }
    const actMatch = /^act[:\-]?\s*(\d+)$/i.exec(sec);
    if (actMatch) {
      const index = Number(actMatch[1]);
      const acts = actsOf(mod);
      const act = acts.find((a) => Number(a.index) === index) || acts[index - 1];
      if (!act) return { ok: false, error: `剧本「${mod.name || mod.id}」没有第 ${index} 幕（共 ${acts.length} 幕）` };
      const body = readSectionFile(mod, act.file);
      const meta = [
        act.summary ? `概要：${act.summary}` : '',
        act.goal ? `目标：${act.goal}` : '',
        Array.isArray(act.checks) && act.checks.length ? `判定点：${act.checks.join('；')}` : '',
        act.battle ? `战斗：${act.battle}` : '',
      ].filter(Boolean).join('\n');
      return cap(meta ? `${meta}\n\n${body}` : body, act.title || `第 ${index} 幕`, act.file || '');
    }
    // 兜底：当成文件名读
    return cap(readSectionFile(mod, sec), sec, sec);
  },
  // 消费方：find_module。本地库里按关键词搜（不依赖外部站点，断网也能用）。
  'trpg.module-search': ({ keyword, page, pageSize } = {}) => {
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw) return { ok: false, error: '缺少关键词' };
    const p = Math.max(1, Math.trunc(Number(page) || 1));
    const size = Math.min(20, Math.max(1, Math.trunc(Number(pageSize) || 8)));
    const hits = loadAllModules().filter((m) => {
      const hay = [m.id, m.name, m.series, m.system, m.summary, m.description].map((x) => String(x || '')).join(' ').toLowerCase();
      return hay.includes(kw);
    });
    const items = hits.slice((p - 1) * size, p * size).map((m) => ({
      keyId: m.id,
      title: m.name || m.id,
      system: m.system || '',
      players: m.players || '',
      duration: m.duration || '',
      author: m.author || '',
      releaseDate: m.releaseDate || '',
      blurb: String(m.summary || m.description || '').slice(0, 120),
      needsDownload: m.needsDownload === true,
    }));
    return { ok: true, source: '本地剧本库', page: p, items };
  },
};

/**
 * 对外能力表 = 数据能力 + 卡面能力。
 * 卡面那部分（trpg.panel-status / trpg.panel-party）原来在独立插件
 * plugins/trpg-cards 里，2026-10-26 并进来——它们本来就是"同一张卡的两面"：
 * 一个存数据，一个渲染给人看，拆成两个插件反而容易版本错位。
 */
export const providers = { ...coreProviders, ...cardsProviders };

/** 点指令钩子（.pc / .mod / .gm）：消息入库后、触发判定前认领，零 token。 */
export const hooks = cardsHooks;

// 兜底：setup 之前有人调用能力时，至少不要把进程搞挂
export function available() {
  return { ok: true };
}

// 默认商店（DnD 5e PHB 常见价格）；data/trpg-tools/shop.json 存在时以它为准。
const DEFAULT_SHOP = [
  { sku: 'potion-heal', name: '治疗药水', price: 50, kind: 'heal', amount: 10, desc: '喝下回复 10 点 HP' },
  { sku: 'potion-antidote', name: '解毒剂', price: 40, kind: 'cure', condition: '中毒', desc: '解除中毒' },
  { sku: 'rope', name: '绳索（50 尺）', price: 5, kind: 'item', desc: '攀爬、捆绑都用得上' },
  { sku: 'torch', name: '火把×5', price: 2, kind: 'item', desc: '照明 1 小时' },
  { sku: 'dagger', name: '匕首', price: 10, kind: 'item' },
  { sku: 'shortsword', name: '短剑', price: 30, kind: 'item' },
  { sku: 'longsword', name: '长剑', price: 60, kind: 'item' },
  { sku: 'leather-armor', name: '皮甲', price: 45, kind: 'item' },
  { sku: 'shield', name: '盾牌', price: 40, kind: 'item' },
  { sku: 'thieves-tool', name: '盗贼工具', price: 25, kind: 'item' },
  { sku: 'spellbook', name: '法术书', price: 80, kind: 'item' },
  { sku: 'healer-kit', name: '医疗包', price: 15, kind: 'item' },
  // 其余武器（战斗系统里认的都要能买到）
  { sku: 'greatsword', name: '大剑', price: 50, kind: 'item' },
  { sku: 'warhammer', name: '战锤', price: 15, kind: 'item' },
  { sku: 'longspear', name: '长枪', price: 10, kind: 'item' },
  { sku: 'club', name: '木棒', price: 1, kind: 'item' },
  { sku: 'shortbow', name: '短弓', price: 25, kind: 'item' },
  { sku: 'longbow', name: '长弓', price: 50, kind: 'item' },
  { sku: 'handcrossbow', name: '手弩', price: 75, kind: 'item' }
];

function loadShop() {
  const custom = readJson(path.join(DATA_DIR, 'trpg-tools', 'shop.json'), null);
  const list = Array.isArray(custom) ? custom : (Array.isArray(custom?.items) ? custom.items : null);
  if (list && list.length) {
    return list
      .filter((x) => x && x.name)
      .map((x, i) => ({
        sku: String(x.sku || `item-${i + 1}`),
        name: String(x.name),
        price: Math.max(0, Math.trunc(Number(x.price) || 0)),
        kind: String(x.kind || 'item'),
        amount: Number(x.amount) || undefined,
        condition: x.condition ? String(x.condition) : undefined,
        desc: x.desc ? String(x.desc) : undefined,
      }));
  }
  return DEFAULT_SHOP;
}

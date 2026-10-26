/**
 * 动态提示词里的「模组段落」：规则速查 + 当前幕摘要。
 *
 * 设计要点（对应 00-设计蓝图.md 第五节 4）：
 *   · 只在「GM 模式已开」且「本群已载入模组」时由 index.js 生成这两段；
 *   · 规则段硬上限 900 字，超出截断并补「…（详见规则书）」；
 *   · 当前幕段硬上限 700 字；
 *   · 两段末尾都带同一句「需要更多细节时调用 read_module，别自己编设定。」；
 *   · 上限把末尾提示句也算进去，保证最终 content.length ≤ 上限；
 *   · 本文件**纯函数**（不读文件、不碰 api），方便自测直接 import。
 */

/** 规则速查段的硬上限（含末尾提示句）。 */
export const RULES_LIMIT = 900;
/** 当前幕摘要段的硬上限（含末尾提示句）。 */
export const ACT_LIMIT = 700;
/** 两段末尾都要加的提醒。 */
export const MODULE_HINT = '需要更多细节时调用 `read_module`，别自己编设定。';

/**
 * 内置的 GMR 房规速查（模组没提供 rulesSummary、也读不到规则文件时的兜底）。
 * 内容取自 00-设计蓝图.md §2。
 */
export const BUILTIN_RULES = [
  '【GMR 规则速查】',
  '· 属性 1d100；HP=(体质+力量)÷10+8；MP=(意志+智力)÷10（成年后不再增长）；斗气值=意志÷10+2。',
  '· 判定 1d100 roll-under：大成功=1；极难≤目标/5；困难≤目标/2；成功≤目标；大失败=100（目标<50 时 96-100 也算）。',
  '· 修正：±10/±20/±30 平调，不引入新骰。',
  '· 魔术七级表（咏唱回合数 / MP）：初级 1/1、中级 1/2、高级 2/3、圣级 3/5、王级 4/7、帝级 5/10、神级 6/15；咏唱被打断则魔术溃散并扣掉一半 MP。',
  '· 无咏唱：判定 -30。',
  '· MP 恢复：清醒时每小时回复 MP 上限的 1/10。',
  '· 斗气：消耗 1 点使命中 +10 或伤害 +1 档；圣级以上可消耗 2 点瞬发一击。',
  '· 伤害：短剑 1d6 / 长剑 1d8 / 大剑·斧 1d10 / 长枪 1d8 / 徒手 1d3；斗气强化再 +1 档。',
].join('\n');

/** 取当前生效的那一幕；找不到返回 null。 */
export function pickActiveAct(mod, actIndex) {
  const acts = Array.isArray(mod?.acts) ? mod.acts : [];
  if (!acts.length) return null;
  const n = Math.trunc(Number(actIndex) || 0);
  if (n > 0) {
    const hit = acts.find((a) => a.index === n) || acts[n - 1];
    if (hit) return hit;
  }
  return acts[0];
}

/**
 * 规则速查正文：模组自带的 rulesSummary 优先，其次规则文件的正文，
 * 最后兜底到内置的 GMR 房规。
 */
export function composeRulesText(mod, rulesFileContent) {
  const summary = String(mod?.rulesSummary ?? '').trim();
  if (summary) return summary;
  const file = String(rulesFileContent ?? '').trim();
  if (file) return file;
  return BUILTIN_RULES;
}

/**
 * 当前幕正文：目标 + 判定点 + 战斗块；
 * 这些元数据都缺、但幕有正文文件时，退回该幕正文（会被截到 700 字）。
 */
export function composeActText(mod, act, actFileContent) {
  if (!act) return '（这个模组还没有登记任何幕。）';
  const lines = [];
  const part = act.part ? `${act.part} · ` : '';
  lines.push(`当前幕：第 ${act.index} 幕 · ${part}${act.title || '（未命名）'}`);
  if (act.summary) lines.push(`概要：${act.summary}`);
  if (act.goal) lines.push(`本幕目标：${act.goal}`);
  if (Array.isArray(act.checks) && act.checks.length) {
    lines.push(`判定点：${act.checks.join('；')}`);
  }
  if (act.battle) lines.push(`战斗块：${act.battle}`);
  const hasMeta = Boolean(act.goal || act.battle || (act.checks && act.checks.length) || act.summary);
  if (!hasMeta) {
    const file = String(actFileContent ?? '').trim();
    if (file) lines.push(file);
  }
  return lines.join('\n');
}

/**
 * 把正文压到上限以内：截断时补一个 tail 标记，末尾必定是 MODULE_HINT。
 * 返回的字符串长度严格 ≤ limit（limit 默认取规则段的 900）。
 */
export function capSection(body, limit, tail = '…（详见规则书）') {
  const max = Math.max(40, Math.trunc(Number(limit) || RULES_LIMIT));
  const hint = `\n${MODULE_HINT}`;
  const text = String(body ?? '').trim();
  const full = `${text}${hint}`;
  if (full.length <= max) return full;
  const marker = String(tail ?? '');
  // 截断后总长 = 正文 + marker + hint ≤ max
  const room = Math.max(0, max - marker.length - hint.length - 1);
  const cut = text.slice(0, room).replace(/\s+$/, '');
  return `${cut}${cut ? '\n' : ''}${marker}${hint}`;
}

/**
 * 生成两段动态 section。module 为空时返回空数组（调用方据此"不注入"）。
 * @returns {Array<{id:string,title:string,priority:number,content:string}>}
 */
export function buildDynamicSections({ state, module, rulesFileContent, actFileContent, priority } = {}) {
  if (!module) return [];
  const raw = Number(priority);
  const base = Number.isFinite(raw) && raw > 0 ? Math.min(99, raw) : 45;
  const act = pickActiveAct(module, state?.actIndex);
  const actIndex = act ? act.index : (Number(state?.actIndex) || 0);
  const rules = capSection(composeRulesText(module, rulesFileContent), RULES_LIMIT, '…（详见规则书）');
  const actText = capSection(
    composeActText(module, act, actFileContent),
    ACT_LIMIT,
    '…（详见当前幕正文）',
  );
  return [
    {
      id: 'trpg-gm-module-rules',
      title: `模组规则速查（${module.name || module.id}）`,
      priority: Math.max(1, base - 1),
      content: rules,
    },
    {
      id: 'trpg-gm-module-act',
      title: `当前幕摘要（第 ${actIndex} 幕）`,
      priority: Math.max(1, base - 2),
      content: actText,
    },
  ];
}

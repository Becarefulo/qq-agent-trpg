/**
 * 把人物卡 / 掷骰结果渲染成给模型看的纯文本。
 *
 * 单独抽出来是为了让 index.js 保持清爽，也方便自测脚本直接 import 做断言。
 */

/** 人物卡 -> 多行文本 */
export function renderCharacter(card) {
  if (!card || typeof card !== 'object') return '（还没有人物卡）';
  const lines = [`人物卡：${card.name || card.userId || '无名'}（QQ:${card.userId || '?'}）`];
  // 种族/职业/等级（本地补丁 2026-10-26）：trpg-tools 的卡现在带这些字段。
  // 升级是里程碑式的（不记经验），所以这里只显示等级，没有经验行。
  const identity = [card.race, card.bg, card.class].filter(Boolean).join(' · ');
  const lv = Number(card.level) || 1;
  if (identity) lines.push(`身份：${identity} · Lv.${lv}`);
  else if (lv > 1) lines.push(`等级：Lv.${lv}`);
  const attrs = Object.entries(card.attrs || {});
  if (attrs.length) lines.push(`属性：${attrs.map(([key, value]) => `${key} ${value}`).join(' / ')}`);
  const skills = Object.entries(card.skills || {});
  if (skills.length) lines.push(`技能：${skills.map(([key, value]) => `${key} ${value}`).join(' / ')}`);
  const vitals = [];
  if (card.hp !== null && card.hp !== undefined) {
    vitals.push(Number(card.maxHp) > 0 ? `HP ${card.hp}/${card.maxHp}` : `HP ${card.hp}`);
  }
  if (card.mp !== null && card.mp !== undefined) vitals.push(`MP ${card.mp}`);
  if (card.san !== null && card.san !== undefined) vitals.push(`SAN ${card.san}`);
  if (vitals.length) lines.push(vitals.join(' · '));
  if (Array.isArray(card.conditions) && card.conditions.length) lines.push(`状态：${card.conditions.join('、')}`);
  if (card.background) lines.push(`背景：${card.background}`);
  if (lines.length === 1) lines.push('（这张卡还是空的，可以用 update_character 添加）');
  return lines.join('\n');
}

/** 掷骰结果条目 -> 一行文本（detail 里已经完整包含表达式、点数与判定档位） */
export function renderRollDetail(item) {
  if (!item || typeof item !== 'object') return '';
  return String(item.detail ?? '');
}

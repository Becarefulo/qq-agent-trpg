// 跑团文档桥（确定性型插件 / 纯能力，不注册工具）
//
// ── 它补的是哪一环 ─────────────────────────────────────────────────────────
// trpg-gm 有三个工具：查收到的文档 / 读收到的文档 / 把文档转成本地剧本。
// 它们分别要 trpg.doc-list / trpg.doc-read / trpg.doc-import 三个能力。
// 而 trpg-tools 明确「本版未提供」这三个（README 里写着依赖 file-inbox），
// 市场里的 file-inbox 实际只提供 file.inbox —— 能力名对不上，
// 于是那三个工具永远回「功能还没装好」。本插件就是那个缺失的适配层：
//
//   data/documents/ 里的文件 → 抽出正文 → 按「第X幕/序幕/尾声」切幕
//   → 写进 data/trpg-tools/modules/<id>/{module.json, act-N.md}
//
// ── 为什么全同步 ───────────────────────────────────────────────────────────
// trpg-gm 里是 `const r = capOf('trpg.doc-list')` —— **没有 await**。
// 能力返回 Promise 的话 `r.ok` 是 undefined，工具会直接报「查文档失败：未知错误」。
// 所以这里：
//   · 读文件用 readFileSync
//   · docx/pptx 的 ZIP 解压自己实现（zlib.inflateRawSync，同步）
//   · PDF 用 execFileSync 调 pdftotext
// 一个 Promise 都不许出现。
//
// ── PDF 的现实 ─────────────────────────────────────────────────────────────
// 不自己解析 PDF：中文 PDF 基本是子集字体内嵌，raw Tj 里是字形编号，硬解出来是乱码。
// 只走 pdftotext（poppler）：PATH 里找 → _tools/poppler/bin/pdftotext.exe → 设置里指定。
// 都没有就**明确报错**，不返回垃圾文本。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DATA_DIR } from '../../src/config.js';

const SUPPORTED = new Set(['pdf', 'docx', 'pptx', 'txt', 'md', 'markdown']);
// 列表里也显示这些，但读的时候会给出"不支持"的人话提示（比"文件不存在"更好懂）
const LIST_ONLY = new Set(['doc', 'ppt', 'xls', 'xlsx', 'rtf', 'odt', 'wps', 'zip', 'rar', '7z']);

let api = null;
let cfg = () => ({});

const DEFAULTS = {
  enabled: true,
  dir: '',
  modulesDir: '',
  maxChars: 6000,
  maxFileMB: 100,
  pdftotextPath: '',
  pdfExtractor: ''
};

function settings() {
  const raw = (typeof cfg === 'function' ? cfg() : null) || {};
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled: raw.enabled !== false,
    dir: inboxDir(String(raw.dir || '').trim()),
    modulesDir: String(raw.modulesDir || '').trim() || path.join(DATA_DIR, 'trpg-tools', 'modules'),
    maxChars: Math.min(20000, Math.max(500, n(raw.maxChars, DEFAULTS.maxChars))),
    maxFileMB: Math.min(2000, Math.max(1, n(raw.maxFileMB, DEFAULTS.maxFileMB))),
    pdftotextPath: String(raw.pdftotextPath || '').trim(),
    pdfExtractor: String(raw.pdfExtractor || '').trim()
  };
}

/**
 * 收件箱目录：设置里填了就用它；否则**问 file-inbox 它把文件存哪**。
 *
 * 这不只是"顺手用一下"：file-inbox 的保存目录是可配置的（设置里能改成绝对路径），
 * 硬编码 data/documents 会在用户改过目录后指向一个空文件夹 —— 表现为"收件箱里
 * 明明有文件，list_documents 却说没有"。
 * 没装 file-inbox 时就退回默认目录（手动把文件丢进去一样能用）。
 */
function inboxDir(explicit) {
  if (explicit) return path.resolve(explicit);
  try {
    const r = api && typeof api.capability === 'function' ? api.capability('file.inbox') : null;
    const dir = r && typeof r.saveDir === 'string' ? r.saveDir.trim() : '';
    if (dir) return dir;
  } catch { /* 没装 / 取不到，用默认 */ }
  return path.join(DATA_DIR, 'documents');
}

// ── ZIP（docx / pptx 都是 ZIP，Office 用的是 deflate） ────────────────────

/** 读 ZIP 中央目录，返回 Map<条目名, Buffer>（只解出需要的条目）。 */
function readZip(file) {
  const buf = fs.readFileSync(file);
  // EOCD 在文件尾部，签名 0x06054b50；后面可能跟注释（<65535 字节）
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 Office 文件（ZIP 结构损坏，可能是旧版 .doc/.ppt）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (compSize === 0 || localOffset + 30 > buf.length) continue;   // 目录项 / 空文件
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, Math.min(buf.length, start + compSize));
    try {
      entries.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
    } catch { /* 单个条目坏了不影响其它 */ }
  }
  return entries;
}

/** OOXML 片段 → 纯文本。 */
function xmlToText(xml) {
  return String(xml)
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\s*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractDocx(file) {
  const zip = readZip(file);
  const doc = zip.get('word/document.xml');
  if (!doc) throw new Error('这个 docx 里没有 word/document.xml（文件可能损坏）');
  return xmlToText(doc.toString('utf8'));
}

function extractPptx(file) {
  const zip = readZip(file);
  const slides = [...zip.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  if (!slides.length) throw new Error('这个 pptx 里没有幻灯片');
  return slides.map((k, i) => `【第 ${i + 1} 页】\n${xmlToText(zip.get(k).toString('utf8'))}`).join('\n\n');
}

/** 找 pdftotext：设置 → 项目内便携版 → PATH。 */
function findPdftotext(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const local = path.join(process.cwd(), '_tools', 'poppler', 'bin', 'pdftotext.exe');
  if (fs.existsSync(local)) return local;
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore', timeout: 5000 });
    return 'pdftotext';
  } catch { /* PATH 里没有 */ }
  return '';
}

/**
 * 找纯 JS 的 PDF 提取器（不需要装 poppler）。
 *
 * 来源是用户自己的 `_pdftool/pdf2txt_cid_v2.mjs`：它处理 Type0/CIDFontType2 +
 * ToUnicode CMap + 空口令 AES 解密 —— 中文跑团模组 PDF 基本都是这种。
 * 项目里放了一份副本（_tools/pdf/），离线也能用；外部原路径作为兜底。
 */
function findPdfExtractor(explicit) {
  const cands = [
    explicit,
    path.join(process.cwd(), '_tools', 'pdf', 'pdf2txt_cid_v2.mjs'),
    path.join(process.cwd(), '..', '_pdftool', 'pdf2txt_cid_v2.mjs'),
    'D:/study/_pdftool/pdf2txt_cid_v2.mjs'
  ].filter(Boolean);
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || '';
}

/**
 * 「这段文字像不像字体没映射出来的乱码」。
 *
 * 实测样本（凡戴尔的失落矿坑.pdf）：9841 字里中文 0 个，有效字符（中英数字）
 * 只占 27%，其余全是 `!$%&=` 这类符号。这种内容入库比不入库更糟 ——
 * 模型会拿一堆乱码当剧本读。所以宁可明确报错，让人去 OCR。
 */
function looksLikeGarbage(text) {
  const s = String(text || '');
  if (s.length < 200) return false;
  const good = (s.match(/[A-Za-z0-9\u4e00-\u9fa5]/g) || []).length;
  return good / s.length < 0.5;
}

function extractPdf(file, s) {
  let text = '';
  const bin = findPdftotext(s.pdftotextPath);
  if (bin) {
    const out = execFileSync(bin, ['-layout', '-enc', 'UTF-8', file, '-'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120000,
      windowsHide: true
    });
    text = String(out || '').replace(/\r\n/g, '\n').trim();
  }
  if (!text) {
    const script = findPdfExtractor(s.pdfExtractor);
    if (script) {
      const tmp = path.join(os.tmpdir(), `trpg-doc-${process.pid}-${Date.now()}.txt`);
      try {
        execFileSync(process.execPath, [script, file, tmp], {
          encoding: 'utf8',
          timeout: 180000,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true
        });
        text = fs.readFileSync(tmp, 'utf8').replace(/\r\n/g, '\n').trim();
      } catch (error) {
        const first = String(error?.stderr || error?.message || error).split('\n')[0].slice(0, 160);
        throw new Error(`PDF 提取器执行失败：${first}`);
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
    }
  }
  if (!text) {
    throw new Error('读不了这个 PDF：既没有 pdftotext（poppler），也没找到 _tools/pdf/pdf2txt_cid_v2.mjs 提取器');
  }
  if (looksLikeGarbage(text)) {
    const pct = Math.round(((text.match(/[A-Za-z0-9\u4e00-\u9fa5]/g) || []).length / text.length) * 100);
    throw new Error(`提取出来的内容像是字体没映射的乱码（有效字符只占 ${pct}%）：这份 PDF 多半是扫描件，需要 OCR；换一份文字版 PDF/Word 也行`);
  }
  return text;
}

// ── 文件定位与正文抽取 ─────────────────────────────────────────────────────

function safeBase(name) {
  const s = String(name ?? '').trim();
  if (!s) return '';
  if (/[\\/]/.test(s) || s === '.' || s === '..') return '';
  return s;
}

function listFiles(s) {
  try {
    const names = fs.readdirSync(s.dir);
    const out = [];
    for (const file of names) {
      const full = path.join(s.dir, file);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile()) continue;
      const ext = path.extname(file).slice(1).toLowerCase();
      if (!SUPPORTED.has(ext) && !LIST_ONLY.has(ext)) continue;
      out.push({ file, ext, size: st.size, mtime: st.mtimeMs });
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  } catch {
    return [];
  }
}

/** 把用户给的名字解析成收件箱里的真实文件（容忍省略扩展名 / 大小写差异）。 */
function resolveFile(name, s) {
  const base = safeBase(name);
  if (!base) return null;
  const all = listFiles(s);
  const lower = base.toLowerCase();
  return all.find((f) => f.file.toLowerCase() === lower)
    || all.find((f) => f.file.toLowerCase() === `${lower}.${f.ext}`)
    || all.find((f) => path.basename(f.file, path.extname(f.file)).toLowerCase() === lower)
    || null;
}

function extractText(hit, s) {
  const full = path.join(s.dir, hit.file);
  const sizeMB = hit.size / 1048576;
  if (sizeMB > s.maxFileMB) throw new Error(`文件 ${sizeMB.toFixed(1)}MB，超过 ${s.maxFileMB}MB 上限`);
  switch (hit.ext) {
    case 'txt':
    case 'md':
    case 'markdown':
      return fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').trim();
    case 'docx':
      return extractDocx(full);
    case 'pptx':
      return extractPptx(full);
    case 'pdf':
      return extractPdf(full, s);
    case 'doc':
    case 'ppt':
      throw new Error(`老版 .${hit.ext} 是二进制格式，解析不了；请另存为 .docx / .pptx 再导入`);
    default:
      throw new Error(`.${hit.ext} 这种格式不支持`);
  }
}

// ── 切幕 ───────────────────────────────────────────────────────────────────

const ACT_HEAD = /^\s*(?:第\s*([一二三四五六七八九十百零两0-9]+)\s*[幕章节回]|(序幕|序章|楔子|尾声|终章|后日谈)|Act\s*([0-9]+))[^\n]{0,30}$/i;

/** 按标题行切幕；切不出来就按篇幅切块（保证导进来的本能读）。 */
function splitActs(text, { chunkChars = 8000 } = {}) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const acts = [];
  let cur = null;
  for (const line of lines) {
    const m = ACT_HEAD.exec(line);
    if (m) {
      if (cur) acts.push(cur);
      cur = { title: line.trim().replace(/^#+\s*/, '').slice(0, 40), lines: [] };
      continue;
    }
    if (!cur) cur = { title: '开场', lines: [] };
    cur.lines.push(line);
  }
  if (cur) acts.push(cur);
  const real = acts.filter((a) => a.lines.join('').trim().length > 0);
  if (real.length >= 2) return real.map((a) => ({ title: a.title, body: a.lines.join('\n').trim() }));

  // 兜底：按 Markdown 一级/二级标题切
  const md = String(text || '').split(/\n(?=#{1,2}\s)/).map((chunk) => {
    const first = chunk.split('\n')[0].replace(/^#+\s*/, '').trim();
    return { title: (first || '正文').slice(0, 40), body: chunk.trim() };
  }).filter((a) => a.body);
  if (md.length >= 2) return md;

  // 再兜底：按字数分块，每块给个可读的标题
  const all = String(text || '').trim();
  const out = [];
  for (let i = 0, n = 1; i < all.length; i += chunkChars, n++) {
    out.push({ title: `第 ${n} 节`, body: all.slice(i, i + chunkChars) });
  }
  return out.length ? out : [{ title: '正文', body: all }];
}

/** 生成不与现有模组冲突的 id（同名同大小 → 同一个 id，重复导入是幂等的）。 */
function moduleIdFor(hit) {
  return 'doc-' + crypto.createHash('md5').update(`${hit.file}:${hit.size}`).digest('hex').slice(0, 8);
}

function readJsonOr(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// ── 能力实现（全部同步！） ─────────────────────────────────────────────────

function docList() {
  const s = settings();
  if (!s.enabled) return { ok: false, error: '文档桥已在设置里关掉' };
  const files = listFiles(s);
  return {
    ok: true,
    count: files.length,
    dir: s.dir,
    files: files.map((f) => ({
      name: path.basename(f.file, path.extname(f.file)),
      ext: f.ext,
      size: f.size,
      updatedAt: new Date(f.mtime).toLocaleString('sv-SE').slice(5, 16)
    }))
  };
}

function docRead({ name, offset = 0, limit = null } = {}) {
  const s = settings();
  if (!s.enabled) return { ok: false, error: '文档桥已在设置里关掉' };
  const hit = resolveFile(name, s);
  if (!hit) return { ok: false, error: `收件箱（${s.dir}）里没有「${name}」，先 list_documents 看文件名` };
  let text;
  try { text = extractText(hit, s); } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
  const total = text.length;
  const start = Math.max(0, Math.min(total, Number(offset) || 0));
  const size = Math.min(s.maxChars, Math.max(500, Number(limit) || s.maxChars));
  const piece = text.slice(start, start + size);
  const end = start + piece.length;
  const y = /\.(docx|doc)$/i.test(hit.file);
  return {
    ok: true,
    text: piece || '（这里已经是结尾了）',
    note: `${hit.file} · 全文 ${total} 字，本次 ${start + 1}~${end} 字${y ? '' : ''}`,
    hint: end < total ? `还有 ${total - end} 字，继续读就带 offset=${end}` : '已经读完了'
  };
}

function docImport({ name, title = '', system = '', force = false } = {}) {
  const s = settings();
  if (!s.enabled) return { ok: false, error: '文档桥已在设置里关掉' };
  const hit = resolveFile(name, s);
  if (!hit) return { ok: false, error: `收件箱（${s.dir}）里没有「${name}」，先 list_documents 看文件名` };

  let text;
  try { text = extractText(hit, s); } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
  if (!text.trim()) return { ok: false, error: '这个文件里没有提取到文字' };

  const id = moduleIdFor(hit);
  const target = path.join(s.modulesDir, id);
  const metaFile = path.join(target, 'module.json');
  if (fs.existsSync(metaFile)) {
    const old = readJsonOr(metaFile, {});
    if (!force) {
      return {
        ok: true, id, name: String(old.name || title || hit.file), chars: 0,
        acts: Array.isArray(old.acts) ? old.acts.length : 0,
        sections: [], hint: '这个文件之前已经导入过（同一个 id），没有重复写入；想重导就带 force'
      };
    }
  }

  const acts = splitActs(text);
  const name2 = String(title || path.basename(hit.file, path.extname(hit.file))).trim().slice(0, 60) || '未命名剧本';
  try {
    fs.mkdirSync(target, { recursive: true });
    const actMeta = [];
    acts.forEach((a, i) => {
      const file = `act-${i + 1}.md`;
      fs.writeFileSync(path.join(target, file), `# ${a.title}\n\n${a.body}\n`, 'utf8');
      actMeta.push({
        index: i + 1,
        title: a.title,
        file,
        summary: a.body.replace(/\s+/g, ' ').slice(0, 120),
        goal: '',
        checks: [],
        battle: ''
      });
    });
    const meta = {
      id,
      name: name2,
      series: '文档导入',
      system: String(system || '').trim(),
      summary: text.replace(/\s+/g, ' ').slice(0, 200),
      source: '文档导入（trpg-doc-bridge）',
      createdAt: new Date().toISOString(),
      needsDownload: false,
      rulesSummary: '',
      acts: actMeta
    };
    fs.writeFileSync(path.join(target, 'module.json'), JSON.stringify(meta, null, 2), 'utf8');
    return {
      ok: true,
      id,
      name: name2,
      chars: text.length,
      acts: acts.length,
      sections: acts.map((a) => a.title).slice(0, 8),
      hint: '幕是按标题行猜的，导入后建议逐幕核对（read_module act:1）'
    };
  } catch (error) {
    return { ok: false, error: `写入剧本库失败：${String(error?.message ?? error)}` };
  }
}

// ── 插件出口 ───────────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
  cfg = typeof a?.config === 'function' ? a.config : () => ({});
  const log = typeof a?.log === 'function' ? a.log : () => {};
  try {
    const s = settings();
    const n = listFiles(s).length;
    log(`文档桥就绪：收件箱 ${s.dir}（${n} 个文件）→ 剧本库 ${s.modulesDir}`);
    if (!findPdftotext(s.pdftotextPath)) {
      const js = findPdfExtractor(s.pdfExtractor);
      log(js
        ? `没有 pdftotext，PDF 改用 JS 提取器：${js}`
        : '提示：既没有 pdftotext 也没有 _tools/pdf/pdf2txt_cid_v2.mjs，PDF 读不了（Word/txt/md 不受影响）');
    }
  } catch { /* 只影响日志 */ }
}

export const providers = {
  'trpg.doc-list': () => docList(),
  'trpg.doc-read': (args) => docRead(args || {}),
  'trpg.doc-import': (args) => docImport(args || {})
};

export const __internals = {
  settings, splitActs, resolveFile, listFiles, extractText, xmlToText, readZip,
  findPdftotext, findPdfExtractor, looksLikeGarbage, moduleIdFor
};

// 「跑团文档桥」回归：补上 trpg.doc-* 三个能力。
//
// 为什么需要它：trpg-gm 的 list/read/import_document 要 trpg.doc-list/doc-read/doc-import，
// 但 trpg-tools 不提供、file-inbox 只提供 file.inbox —— 能力名对不上，工具一直报「没装好」。
//
// 这个测试盯住三件最容易坏的事：
//   ① 能力必须**同步返回**（trpg-gm 里 capOf() 没有 await，返回 Promise 就会变成"未知错误"）
//   ② 切幕/分块要能兜住没有「第X幕」标题的文档
//   ③ 写进剧本库的 module.json 结构必须和 trpg-tools 认的一致
//
// 运行：node test/trpg-doc-bridge-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trpg-doc-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const docs = path.join(tmp, 'documents');
const mods = path.join(tmp, 'trpg-tools', 'modules');
fs.mkdirSync(docs, { recursive: true });
fs.mkdirSync(mods, { recursive: true });

const plugin = await import('../plugins/trpg-doc-bridge/index.js');
const { splitActs, resolveFile, listFiles, moduleIdFor } = plugin.__internals;

plugin.setup({ config: () => ({ dir: docs, modulesDir: mods, maxChars: 1000 }) });
const cap = (name, args) => plugin.providers[name](args);

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
};

// ── 最小的 ZIP 打包器（store 不压缩），用来造一个假 docx ──────────────────
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(0, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(0, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

// ── 一、切幕 ───────────────────────────────────────────────────────────────
check('按「第X幕 / 序幕 / 尾声」切幕', () => {
  const text = [
    '序幕', '船靠岸了。',
    '第一幕 下船', '玩家们走下舷梯。',
    '第二幕 仓库', '仓库的门开着。',
    '尾声', '一切结束。'
  ].join('\n');
  const acts = splitActs(text);
  assert.equal(acts.length, 4, `应切出 4 幕，实际 ${acts.length}：${acts.map((a) => a.title).join(' / ')}`);
  assert.match(acts[1].title, /第一幕/);
  assert.ok(acts[1].body.includes('舷梯'));
});

check('没有幕标题时按 Markdown 标题切', () => {
  const text = '# 第一章\n内容一\n\n## 第二章\n内容二\n\n## 第三章\n内容三';
  const acts = splitActs(text);
  assert.ok(acts.length >= 2, `应切出多块，实际 ${acts.length}`);
});

check('连标题都没有时按篇幅切块（保证能导入）', () => {
  const acts = splitActs('啊'.repeat(20000), { chunkChars: 8000 });
  assert.equal(acts.length, 3, `20000 字按 8000 切应得 3 块，实际 ${acts.length}`);
  assert.match(acts[0].title, /第 1 节/);
});

// ── 二、能力必须同步 ───────────────────────────────────────────────────────
check('三个能力都同步返回（不能是 Promise）', () => {
  fs.writeFileSync(path.join(docs, 'a.md'), '# 第一幕\n内容\n# 第二幕\n内容', 'utf8');
  for (const [name, args] of [['trpg.doc-list', undefined], ['trpg.doc-read', { name: 'a' }], ['trpg.doc-import', { name: 'a' }]]) {
    const r = cap(name, args);
    assert.ok(r && typeof r.then !== 'function', `${name} 返回了 Promise —— trpg-gm 会报"未知错误"`);
    assert.equal(r.ok, true, `${name} 失败：${r.error || ''}`);
  }
});

// ── 三、列目录 / 读 / 分页 ────────────────────────────────────────────────
check('列目录：只列支持的类型，且不带扩展名给名字', () => {
  fs.writeFileSync(path.join(docs, 'b.txt'), '纯文本剧本', 'utf8');
  fs.writeFileSync(path.join(docs, 'ignore.exe'), 'x', 'utf8');
  const r = cap('trpg.doc-list');
  assert.equal(r.ok, true);
  assert.equal(r.count, 2, `应列出 2 个，实际 ${r.count}`);
  const names = r.files.map((f) => f.name).sort();
  assert.deepEqual(names, ['a', 'b']);
});

check('读文档：分页 + 续读提示', () => {
  const long = '甲'.repeat(2500);
  fs.writeFileSync(path.join(docs, 'long.md'), long, 'utf8');
  const p1 = cap('trpg.doc-read', { name: 'long', offset: 0, limit: 1000 });
  assert.equal(p1.ok, true);
  assert.equal(p1.text.length, 1000);
  assert.match(p1.note, /全文 2500 字/);
  assert.match(p1.hint, /offset=1000/);
  const p2 = cap('trpg.doc-read', { name: 'long', offset: 1000, limit: 1000 });
  assert.equal(p2.text.length, 1000);
  const p3 = cap('trpg.doc-read', { name: 'long', offset: 2000, limit: 1000 });
  assert.equal(p3.text.length, 500);
  assert.match(p3.hint, /读完了/);
});

check('读文档：文件名可以省略扩展名 / 大小写无关', () => {
  fs.writeFileSync(path.join(docs, 'Mixed.MD'), '# 一幕\n内容', 'utf8');
  assert.equal(cap('trpg.doc-read', { name: 'mixed' }).ok, true);
  assert.equal(cap('trpg.doc-read', { name: 'Mixed.MD' }).ok, true);
});

check('读文档：路径穿越被拒绝', () => {
  assert.equal(resolveFile('../../data/config.json', { dir: docs }), null);
  const r = cap('trpg.doc-read', { name: '../../data/config.json' });
  assert.equal(r.ok, false);
});

check('读文档：不存在的文件给可读错误', () => {
  const r = cap('trpg.doc-read', { name: '根本没有这个文件' });
  assert.equal(r.ok, false);
  assert.match(r.error, /没有/);
});

// ── 四、导入 ───────────────────────────────────────────────────────────────
check('导入：写出 module.json + 各幕正文，结构能被 trpg-tools 认', () => {
  // force:true —— 上面「三个能力都同步」那条已经把这个文件导过一次了，
  // 重复导入是幂等的（保留旧名字），这里要看的是"真的写盘"这条路径。
  const r = cap('trpg.doc-import', { name: 'a', title: '测试剧本', system: 'COC 7e', force: true });
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.acts, 2, `应切出 2 幕，实际 ${r.acts}`);
  const dir = path.join(mods, r.id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8'));
  assert.equal(meta.id, r.id);
  assert.equal(meta.name, '测试剧本');
  assert.equal(meta.system, 'COC 7e');
  assert.equal(meta.acts.length, 2);
  for (const act of meta.acts) {
    assert.ok(fs.existsSync(path.join(dir, act.file)), `缺少正文文件 ${act.file}`);
    assert.equal(typeof act.index, 'number');
    assert.equal(typeof act.title, 'string');
  }
});

check('导入：同一个文件再导一次是幂等的（不重复写）', () => {
  const first = cap('trpg.doc-import', { name: 'a' });
  const again = cap('trpg.doc-import', { name: 'a' });
  assert.equal(again.ok, true);
  assert.equal(again.id, first.id);
  assert.equal(again.chars, 0, '第二次不应重新解析');
});

check('id 稳定：同名同大小 → 同一个 id', () => {
  const hit = { file: 'x.md', size: 100 };
  assert.equal(moduleIdFor(hit), moduleIdFor({ ...hit }));
  assert.notEqual(moduleIdFor(hit), moduleIdFor({ file: 'y.md', size: 100 }));
});

// ── 五、docx（自己实现的 ZIP 解压） ───────────────────────────────────────
check('docx：能从 ZIP 里抽出 document.xml 的正文', () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>第一幕</w:t></w:r></w:p><w:p><w:r><w:t>码头很冷</w:t></w:r></w:p></w:body></w:document>';
  const zip = makeZip({ 'word/document.xml': xml, '[Content_Types].xml': '<Types/>' });
  fs.writeFileSync(path.join(docs, 'script.docx'), zip);
  const r = cap('trpg.doc-read', { name: 'script' });
  assert.equal(r.ok, true, r.error || '');
  assert.ok(r.text.includes('第一幕'), `正文里应有「第一幕」：${r.text.slice(0, 80)}`);
  assert.ok(r.text.includes('码头很冷'));
});

check('docx：坏文件给出人话错误，不抛异常', () => {
  fs.writeFileSync(path.join(docs, 'broken.docx'), 'this is not a zip');
  const r = cap('trpg.doc-read', { name: 'broken' });
  assert.equal(r.ok, false);
  assert.match(r.error, /ZIP|Office/i);
});

// ── 六、PDF：没有可用提取器时明确拒绝 / 乱码要拦下来 ─────────────────────
check('PDF：假文件走不到文本，给出可读错误（不会静默返回空）', () => {
  fs.writeFileSync(path.join(docs, 'book.pdf'), '%PDF-1.4 fake');
  const r = cap('trpg.doc-read', { name: 'book' });
  assert.equal(r.ok, false, '假 PDF 不该读成功');
  assert.match(r.error, /PDF|pdftotext|提取/i, `错误信息要能指向 PDF：${r.error}`);
});

check('乱码检测：符号噪音占多数 → 判定为乱码（需 OCR）', () => {
  const garbage = '!!$%! "45=!7/5:8,;<6!=>!56<=!58<5!56<=!9@8!55<>!5><>!<8!6>5>!!5>>!B/!!!!'.repeat(4);
  assert.equal(plugin.__internals.looksLikeGarbage(garbage), true);
});

check('乱码检测：正常中英文不误判', () => {
  const okText = '第一幕 下船\n玩家们走下舷梯，码头很冷。（还有一段 English text here.）'.repeat(3);
  assert.equal(plugin.__internals.looksLikeGarbage(okText), false);
});

check('PDF 提取器路径能被发现（项目内副本或 _pdftool）', () => {
  const script = plugin.__internals.findPdfExtractor();
  assert.ok(script, '应能找到 pdf2txt_cid_v2.mjs');
  assert.match(script.replace(/\\/g, '/'), /pdf2txt_cid_v2\.mjs$/);
});

check('老式 .doc 给出"另存为 docx"的提示', () => {
  fs.writeFileSync(path.join(docs, 'old.doc'), 'binary');
  const r = cap('trpg.doc-read', { name: 'old' });
  assert.equal(r.ok, false);
  assert.match(r.error, /docx|另存/i);
});

check('关掉插件后能力返回明确错误', () => {
  plugin.setup({ config: () => ({ enabled: false, dir: docs, modulesDir: mods }) });
  const r = cap('trpg.doc-list');
  assert.equal(r.ok, false);
  assert.match(r.error, /关掉/);
  // 复原，免得影响后面的手工排查
  plugin.setup({ config: () => ({ dir: docs, modulesDir: mods }) });
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n跑团文档桥：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);

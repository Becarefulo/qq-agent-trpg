// PDF 文本提取器（中文 CID 字体 + ToUnicode CMap + 空口令 AES-128 解密）
//
// 为什么自己写：这台机器没有 pdftotext/pandoc，Python 也没装 PDF 库；
// _pdftool/pdftext2.py 是按 CNKI 论文结构写的，对这批跑团模组报 "0 文本块"。
//
// 这批 PDF 的特征：Type0 / CIDFontType2 / Identity-H，字体子集内嵌、带 ToUnicode；
// 其中两个还带加密（R=4 AESV2，空用户口令）。流程：
//   解密流 → 解压 → 解析 ToUnicode 得 CID→Unicode → 按 /FTxx Tf 逐串解码
//
// 用法：node pdf2txt_cid_v2.mjs <输入.pdf> <输出.txt>

import fs from 'node:fs';
import zlib from 'node:zlib';
import { readEncryption, fileKeyForR4, decryptStream } from './pdfdecrypt.mjs';

function inflateMaybe(raw) {
  try { return zlib.inflateSync(raw); } catch {
    try { return zlib.inflateRawSync(raw); } catch { return raw; }
  }
}

function parseObjects(s) {
  const objs = new Map();
  const re = /(\d+)\s+0\s+obj([\s\S]*?)endobj/g;
  let m;
  while ((m = re.exec(s))) objs.set(Number(m[1]), m[2]);
  return objs;
}

/** 取对象里的流：先解密（如果 PDF 加密），再解压 */
function streamOf(objs, num, decCtx = null) {
  const body = objs.get(num);
  if (!body) return null;
  const i = body.indexOf('stream');
  if (i < 0) return null;
  let ds = i + 6;
  if (body[ds] === '\r') ds++;
  if (body[ds] === '\n') ds++;
  const e = body.lastIndexOf('endstream');
  if (e < 0) return null;
  let raw = Buffer.from(body.slice(ds, e), 'latin1');
  if (decCtx) raw = decryptStream(raw, { fileKey: decCtx.fileKey, objNum: num, variant: decCtx.variant });
  return inflateMaybe(raw);
}

function parseToUnicode(text) {
  const map = new Map();
  if (!text) return map;
  const hex = (h) => {
    let out = '';
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return out;
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(pair[1], 16), hex(pair[2]));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const r of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(r[1], 16);
      const hi = parseInt(r[2], 16);
      const dst = hex(r[3]);
      const base = dst.length ? dst.charCodeAt(dst.length - 1) : 0;
      for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, String.fromCharCode(base + (c - lo)));
    }
    for (const r of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(r[1], 16);
      const items = [...r[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => hex(x[1]));
      items.forEach((ch, i) => map.set(lo + i, ch));
    }
  }
  return map;
}

function collectFonts(objs, decCtx = null) {
  const byObj = new Map();
  for (const [num, body] of objs) {
    if (!/\/Type\s*\/Font/.test(body)) continue;
    const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(body);
    if (!tu) continue;
    const data = streamOf(objs, Number(tu[1]), decCtx);
    if (!data) continue;
    const map = parseToUnicode(data.toString('latin1'));
    if (map.size) byObj.set(num, map);
  }
  const byName = new Map();
  for (const body of objs.values()) {
    for (const dict of body.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) {
      for (const pair of dict[1].matchAll(/\/([A-Za-z0-9]+)\s+(\d+)\s+0\s+R/g)) {
        const num = Number(pair[2]);
        if (byObj.has(num) && !byName.has(pair[1])) byName.set(pair[1], byObj.get(num));
      }
    }
  }
  return { byObj, byName };
}

function decodeHexString(hexStr, map) {
  if (!map) return '';
  const step = hexStr.length % 4 === 0 ? 4 : hexStr.length % 2 === 0 ? 2 : hexStr.length;
  let s = '';
  for (let i = 0; i + step <= hexStr.length; i += step) {
    s += map.get(parseInt(hexStr.slice(i, i + step), 16)) ?? '';
  }
  return s;
}

function decodeContent(content, fonts) {
  let out = '';
  let cur = null;
  const tokens = content.split(/\r\n|\r|\n/);
  for (const line of tokens) {
    const tf = /\/\s*([A-Za-z0-9]+)\s+[\d.]+\s+Tf/.exec(line);
    if (tf) { cur = fonts.byName.get(tf[1]) || null; continue; }
    if (/\b(TD|Td|T\*)\b/.test(line) && out && !out.endsWith('\n')) out += '\n';
    for (const m of line.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out += decodeHexString(m[1], cur);
    for (const arr of line.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
      for (const m of arr[1].matchAll(/<([0-9A-Fa-f]+)>/g)) out += decodeHexString(m[1], cur);
    }
    for (const m of line.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)) out += m[1].replace(/\\([()\\])/g, '$1');
  }
  return out;
}

function main() {
  const [src, dst] = process.argv.slice(2);
  if (!src || !dst) { console.error('用法: node pdf2txt_cid_v2.mjs <输入.pdf> <输出.txt>'); process.exit(1); }

  const s = fs.readFileSync(src).toString('latin1');
  const objs = parseObjects(s);
  console.error('[pdf2txt] 对象 ' + objs.size + ' 个');

  let decCtx = null;
  const enc = readEncryption(s);
  if (enc) {
    console.error('[pdf2txt] 加密：R=' + enc.R + ' V=' + enc.V + ' 变体=' + enc.variant);
    if (enc.R <= 4 && enc.variant !== 'aes256') {
      try {
        decCtx = { fileKey: fileKeyForR4(enc), variant: enc.variant };
        console.error('[pdf2txt] 空口令解密已启用');
      } catch (e) {
        console.error('[pdf2txt] 密钥推导失败：' + (e && e.message));
      }
    } else {
      console.error('[pdf2txt] AES-256/R6 暂不支持');
    }
  }

  const fonts = collectFonts(objs, decCtx);
  console.error('[pdf2txt] 带 ToUnicode 的字体 ' + fonts.byObj.size + ' 个，资源名 ' + fonts.byName.size + ' 个');

  let text = '';
  for (const [num, body] of objs) {
    if (!/\/Type\s*\/Page\b/.test(body) || /\/Type\s*\/Pages\b/.test(body)) continue;
    const refs = [];
    const single = /\/Contents\s+(\d+)\s+0\s+R/.exec(body);
    if (single) refs.push(Number(single[1]));
    const multi = /\/Contents\s*\[([\s\S]*?)\]/.exec(body);
    if (multi) for (const m of multi[1].matchAll(/(\d+)\s+0\s+R/g)) refs.push(Number(m[1]));
    for (const r of refs) {
      const data = streamOf(objs, r, decCtx);
      if (data) text += decodeContent(data.toString('latin1'), fonts) + '\n';
    }
  }

  if (!text.trim()) {
    console.error('[pdf2txt] 没匹配到页对象，退化为扫描全部内容流');
    for (const [num, body] of objs) {
      if (!/stream/.test(body)) continue;
      const data = streamOf(objs, num, decCtx);
      if (!data) continue;
      const t = data.toString('latin1');
      if (!/BT[\s\S]{0,2000}(Tj|TJ)/.test(t)) continue;
      text += decodeContent(t, fonts) + '\n';
    }
  }

  const cleaned = text.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  fs.writeFileSync(dst, cleaned, 'utf8');
  console.error('[pdf2txt] 输出 ' + cleaned.length + ' 字 → ' + dst);
}

main();

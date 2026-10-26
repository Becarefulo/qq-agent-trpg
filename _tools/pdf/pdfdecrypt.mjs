// PDF 流解密（Standard Security Handler，空用户口令）
//
// 两个跑团模组是加密 PDF：
//   (5E)巫马未来-小马宝莉之潮起潮落  → R=4 / V=4 / AESV2（AES-128）
//   月谷-红酿                    → R=6 / V=5 / AESV3（AES-256）
// 两者用户口令都为空（任何阅读器都能直接打开），所以密钥可以本地推导出来。
//
// 这里实现 R=4（AES-128）。R=6 需要 Algorithm 2.B 的迭代哈希，暂未实现 ——
// 而且月谷那份连 ToUnicode 和嵌入字体都没有，即使解密也拿不到文字。

import crypto from 'node:crypto';

const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

const md5 = (...bufs) => {
  const h = crypto.createHash('md5');
  for (const b of bufs) h.update(b);
  return h.digest();
};

/** 从十六进制字面量取 Buffer（PDF 里 /O /U 都是 <hex>） */
export function hexToBuf(raw) {
  const s = String(raw || '').replace(/[<>\s]/g, '');
  if (!/^[0-9A-Fa-f]*$/.test(s)) return null;
  return Buffer.from(s, 'hex');
}

/**
 * 解析 PDF 字面量字符串（\\ddd 八进制、\\n \\r \\t \\b \\f \\( \\) \\\\ 转义）。
 * /O /U 常见是 (....) 形式而不是 <hex>，两种都得支持。
 */
export function literalToBuf(body, start) {
  if (body[start] !== '(') return null;
  const out = [];
  let depth = 1;
  let i = start + 1;
  while (i < body.length && depth > 0) {
    const ch = body[i];
    if (ch === '\\') {
      const nx = body[i + 1];
      if (nx >= '0' && nx <= '7') {
        let oct = '';
        let k = i + 1;
        while (k < body.length && oct.length < 3 && body[k] >= '0' && body[k] <= '7') { oct += body[k]; k++; }
        out.push(parseInt(oct, 8) & 0xff);
        i = k;
        continue;
      }
      const map = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
      out.push(map[nx] ?? (nx ? nx.charCodeAt(0) : 0));
      i += 2;
      continue;
    }
    if (ch === '(') { depth++; out.push(40); i++; continue; }
    if (ch === ')') { depth--; if (depth === 0) break; out.push(41); i++; continue; }
    out.push(ch.charCodeAt(0) & 0xff);
    i++;
  }
  return Buffer.from(out);
}

/** 纯 JS RC4（OpenSSL 3 默认不提供 RC4，Node 里 createDecipheriv('rc4') 会抛） */
export function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    const t = S[i]; S[i] = S[j]; S[j] = t;
  }
  const out = Buffer.alloc(data.length);
  let a = 0, b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 0xff;
    b = (b + S[a]) & 0xff;
    const t = S[a]; S[a] = S[b]; S[b] = t;
    out[k] = data[k] ^ S[(S[a] + S[b]) & 0xff];
  }
  return out;
}

/**
 * 解析加密字典与文件 ID。
 * @returns {null|{R:number,V:number,keyLen:number,O:Buffer,U:Buffer,P:number,encryptMetadata:boolean,fileId:Buffer,variant:string}}
 */
export function readEncryption(pdfLatin1) {
  const s = pdfLatin1;
  const encRef = /\/Encrypt\s+(\d+)\s+0\s+R/.exec(s);
  if (!encRef) return null;
  const objNum = Number(encRef[1]);
  const objMatch = new RegExp(`(?:^|[^0-9])${objNum}\\s+0\\s+obj([\\s\\S]*?)endobj`).exec(s);
  const dict = objMatch ? objMatch[1] : '';
  const num = (key, dflt) => {
    const m = new RegExp(`\\/${key}\\s+(-?\\d+)`).exec(dict);
    return m ? Number(m[1]) : dflt;
  };
  const hexField = (key) => {
    const m = new RegExp(`\\/${key}\\s*<([0-9A-Fa-f\\s]+)>`).exec(dict);
    if (m) return hexToBuf(m[1]);
    // /O /U 常常是字面量字符串：(....)
    const p = new RegExp(`\\/${key}\\s*\\(`).exec(dict);
    return p ? literalToBuf(dict, p.index + p[0].length - 1) : null;
  };
  const R = num('R', 0);
  const V = num('V', 0);
  const P = num('P', 0);
  // /Length 在字典里可能出现两次：顶层是"位"（128/256），/CF 子字典里是"字节"（16/32）。
  // 抓到小的那个会把密钥长度算错（曾因此得出 keyLen=5，解密全废）。
  const lengthMatches = [...dict.matchAll(/\/Length\s+(\d+)/g)].map((m) => Number(m[1]));
  const bitsOrBytes = lengthMatches.length
    ? (lengthMatches.find((v) => v >= 40) ?? lengthMatches[0])
    : 40;
  const keyLen = bitsOrBytes >= 40 ? Math.round(bitsOrBytes / 8) : bitsOrBytes;
  const O = hexField('O');
  const U = hexField('U');
  // 过滤体：V4+ 用 /StmF 指向 /CF，看是不是 AESV2
  const stmF = (/\/StmF\s*\/([A-Za-z0-9]+)/.exec(dict) || [])[1] || 'Identity';
  let variant = 'rc4';
  if (V >= 4) {
    const cf = new RegExp(`\\/${stmF}\\s*<<([\\s\\S]*?)>>`).exec(dict);
    const cfm = cf ? (/\/CFM\s*\/([A-Za-z0-9]+)/.exec(cf[1]) || [])[1] : '';
    if (cfm === 'AESV2') variant = 'aes128';
    else if (cfm === 'AESV3') variant = 'aes256';
    else if (cfm === 'V2') variant = 'rc4';
  }
  const idMatch = /\/ID\s*\[\s*<([0-9A-Fa-f\s]+)>/.exec(s);
  const fileId = idMatch ? hexToBuf(idMatch[1]) : null;
  const encryptMetadata = !/\/EncryptMetadata\s+false/.test(dict);
  if (!O || !U || !fileId || !R) return null;
  return { R, V, P, keyLen: Math.max(5, Math.min(16, keyLen)) || 16, O, U, fileId, variant, encryptMetadata, dict };
}

/** Algorithm 2：由空口令推导文件密钥（仅 R<=4 有效） */
export function fileKeyForR4(info) {
  const { R, O, P, fileId, keyLen, encryptMetadata } = info;
  const pBuf = Buffer.alloc(4);
  pBuf.writeInt32LE(P | 0, 0);
  const parts = [PAD, O.subarray(0, 32), pBuf, fileId.subarray(0, Math.min(fileId.length, 16) || 0)];
  if (R >= 4 && !encryptMetadata) parts.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));
  let K = md5(...parts);
  if (R >= 3) {
    for (let i = 0; i < 50; i++) K = md5(K.subarray(0, keyLen));
  }
  return K.subarray(0, R === 2 ? 5 : keyLen);
}

/** Algorithm 1：每个对象一把钥匙 */
export function objectKey(fileKey, objNum, genNum, aes) {
  const numBuf = Buffer.from([objNum & 0xff, (objNum >> 8) & 0xff, (objNum >> 16) & 0xff, genNum & 0xff, (genNum >> 8) & 0xff]);
  const parts = [fileKey, numBuf];
  if (aes) parts.push(Buffer.from('sAlT', 'latin1'));
  const k = md5(...parts);
  return k.subarray(0, Math.min(fileKey.length + 5, 16));
}

/**
 * 解密一个流。
 * @param {Buffer} raw 原始流字节
 * @param {{fileKey:Buffer, objNum:number, genNum:number, variant:string}} opt
 * @returns {Buffer}
 */
export function decryptStream(raw, { fileKey, objNum, genNum = 0, variant }) {
  if (variant === 'aes128') {
    if (raw.length <= 16) return raw;
    const iv = raw.subarray(0, 16);
    const data = raw.subarray(16);
    try {
      const d = crypto.createDecipheriv('aes-128-cbc', objectKey(fileKey, objNum, genNum, true), iv);
      return Buffer.concat([d.update(data), d.final()]);
    } catch {
      return raw;
    }
  }
  if (variant === 'rc4') {
    // 自己实现 RC4：Node 的 OpenSSL 3 默认不带这个算法
    return rc4(objectKey(fileKey, objNum, genNum, false), raw);
  }
  return raw;
}

/**
 * 纯 TypeScript 同步摘要与 HMAC 实现（MD5 / SHA-1 / SHA-256 / SHA-512）
 *
 * 声明式插件运行在渲染进程中，拿不到 Node 的 crypto 与 Buffer；
 * WebCrypto 只有异步接口且不支持 MD5。需要「边输入边出结果」的插件统一使用本模块。
 * 本文件是唯一源码，构建前由各插件复制到自己的 src/ 目录（与 shared/native-ipc.ts 相同的做法）。
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export function utf8ToBytes(text) {
    return encoder.encode(text ?? "");
}
/** 严格 UTF-8 解码，遇到非法字节抛错，避免把损坏数据静默显示成乱码 */
export function bytesToUtf8(bytes) {
    return decoder.decode(bytes);
}
export function bytesToHex(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i++)
        out += bytes[i].toString(16).padStart(2, "0");
    return out;
}
export function hexToBytes(hex) {
    const clean = (hex ?? "").trim();
    if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean))
        throw new Error("不是合法的十六进制字符串");
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
}
export function bytesToBase64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return btoa(bin);
}
/** 严格 Base64 解码：兼容 URL-safe 字符与缺省填充，其余非法字符直接报错 */
export function base64ToBytes(base64) {
    let clean = (base64 ?? "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean))
        throw new Error("不是合法的 Base64 字符串");
    clean = clean.replace(/=+$/, "");
    if (clean.length % 4 === 1)
        throw new Error("Base64 长度不正确");
    clean += "=".repeat((4 - (clean.length % 4)) % 4);
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i);
    return out;
}
function toBytes(data) {
    return typeof data === "string" ? utf8ToBytes(data) : data;
}
// ---------- MD5 (RFC 1321) ----------
const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
function md5(msg) {
    const bitLen = msg.length * 8;
    const padLen = (((msg.length + 8) >> 6) + 1) * 64;
    const buf = new Uint8Array(padLen);
    buf.set(msg);
    buf[msg.length] = 0x80;
    const view = new DataView(buf.buffer);
    view.setUint32(padLen - 8, bitLen >>> 0, true);
    view.setUint32(padLen - 4, Math.floor(bitLen / 2 ** 32), true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let off = 0; off < padLen; off += 64) {
        let a = a0, b = b0, c = c0, d = d0;
        for (let i = 0; i < 64; i++) {
            let f, g;
            if (i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            }
            else if (i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) % 16;
            }
            else if (i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) % 16;
            }
            else {
                f = c ^ (b | ~d);
                g = (7 * i) % 16;
            }
            const tmp = d;
            d = c;
            c = b;
            const sum = (a + f + MD5_K[i] + view.getUint32(off + g * 4, true)) >>> 0;
            b = (b + ((sum << MD5_S[i]) | (sum >>> (32 - MD5_S[i])))) >>> 0;
            a = tmp;
        }
        a0 = (a0 + a) >>> 0;
        b0 = (b0 + b) >>> 0;
        c0 = (c0 + c) >>> 0;
        d0 = (d0 + d) >>> 0;
    }
    const out = new Uint8Array(16);
    const ov = new DataView(out.buffer);
    [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
    return out;
}
// ---------- 大端 32 位分组公共填充 ----------
function padBigEndian(msg, blockSize) {
    const lenBytes = blockSize === 64 ? 8 : 16;
    const total = Math.ceil((msg.length + 1 + lenBytes) / blockSize) * blockSize;
    const buf = new Uint8Array(total);
    buf.set(msg);
    buf[msg.length] = 0x80;
    const view = new DataView(buf.buffer);
    const bitLen = msg.length * 8;
    view.setUint32(total - 4, bitLen >>> 0, false);
    view.setUint32(total - 8, Math.floor(bitLen / 2 ** 32), false);
    return { buf, view };
}
const rotl = (x, n) => (x << n) | (x >>> (32 - n));
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
// ---------- SHA-1 (FIPS 180-4) ----------
function sha1(msg) {
    const { buf, view } = padBigEndian(msg, 64);
    const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    const w = new Uint32Array(80);
    for (let off = 0; off < buf.length; off += 64) {
        for (let i = 0; i < 16; i++)
            w[i] = view.getUint32(off + i * 4, false);
        for (let i = 16; i < 80; i++)
            w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        let [a, b, c, d, e] = h;
        for (let i = 0; i < 80; i++) {
            let f, k;
            if (i < 20) {
                f = (b & c) | (~b & d);
                k = 0x5a827999;
            }
            else if (i < 40) {
                f = b ^ c ^ d;
                k = 0x6ed9eba1;
            }
            else if (i < 60) {
                f = (b & c) | (b & d) | (c & d);
                k = 0x8f1bbcdc;
            }
            else {
                f = b ^ c ^ d;
                k = 0xca62c1d6;
            }
            const t = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
            e = d;
            d = c;
            c = rotl(b, 30) >>> 0;
            b = a;
            a = t;
        }
        h[0] = (h[0] + a) >>> 0;
        h[1] = (h[1] + b) >>> 0;
        h[2] = (h[2] + c) >>> 0;
        h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0;
    }
    const out = new Uint8Array(20);
    const ov = new DataView(out.buffer);
    h.forEach((v, i) => ov.setUint32(i * 4, v, false));
    return out;
}
// ---------- SHA-256 (FIPS 180-4) ----------
const K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];
function sha256(msg) {
    const { buf, view } = padBigEndian(msg, 64);
    const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Uint32Array(64);
    for (let off = 0; off < buf.length; off += 64) {
        for (let i = 0; i < 16; i++)
            w[i] = view.getUint32(off + i * 4, false);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            hh = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }
        h[0] = (h[0] + a) >>> 0;
        h[1] = (h[1] + b) >>> 0;
        h[2] = (h[2] + c) >>> 0;
        h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0;
        h[5] = (h[5] + f) >>> 0;
        h[6] = (h[6] + g) >>> 0;
        h[7] = (h[7] + hh) >>> 0;
    }
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    h.forEach((v, i) => ov.setUint32(i * 4, v, false));
    return out;
}
// ---------- SHA-512 (FIPS 180-4)，64 位运算用 BigInt 保证正确性 ----------
const K512 = [
    "428a2f98d728ae22", "7137449123ef65cd", "b5c0fbcfec4d3b2f", "e9b5dba58189dbbc", "3956c25bf348b538", "59f111f1b605d019", "923f82a4af194f9b", "ab1c5ed5da6d8118",
    "d807aa98a3030242", "12835b0145706fbe", "243185be4ee4b28c", "550c7dc3d5ffb4e2", "72be5d74f27b896f", "80deb1fe3b1696b1", "9bdc06a725c71235", "c19bf174cf692694",
    "e49b69c19ef14ad2", "efbe4786384f25e3", "0fc19dc68b8cd5b5", "240ca1cc77ac9c65", "2de92c6f592b0275", "4a7484aa6ea6e483", "5cb0a9dcbd41fbd4", "76f988da831153b5",
    "983e5152ee66dfab", "a831c66d2db43210", "b00327c898fb213f", "bf597fc7beef0ee4", "c6e00bf33da88fc2", "d5a79147930aa725", "06ca6351e003826f", "142929670a0e6e70",
    "27b70a8546d22ffc", "2e1b21385c26c926", "4d2c6dfc5ac42aed", "53380d139d95b3df", "650a73548baf63de", "766a0abb3c77b2a8", "81c2c92e47edaee6", "92722c851482353b",
    "a2bfe8a14cf10364", "a81a664bbc423001", "c24b8b70d0f89791", "c76c51a30654be30", "d192e819d6ef5218", "d69906245565a910", "f40e35855771202a", "106aa07032bbd1b8",
    "19a4c116b8d2d0c8", "1e376c085141ab53", "2748774cdf8eeb99", "34b0bcb5e19b48a8", "391c0cb3c5c95a63", "4ed8aa4ae3418acb", "5b9cca4f7763e373", "682e6ff3d6b2b8a3",
    "748f82ee5defb2fc", "78a5636f43172f60", "84c87814a1f0ab72", "8cc702081a6439ec", "90befffa23631e28", "a4506cebde82bde9", "bef9a3f7b2c67915", "c67178f2e372532b",
    "ca273eceea26619c", "d186b8c721c0c207", "eada7dd6cde0eb1e", "f57d4f7fee6ed178", "06f067aa72176fba", "0a637dc5a2c898a6", "113f9804bef90dae", "1b710b35131c471b",
    "28db77f523047d84", "32caab7b40c72493", "3c9ebe0a15c9bebc", "431d67c49c100d4c", "4cc5d4becb3e42b6", "597f299cfc657e2a", "5fcb6fab3ad6faec", "6c44198c4a475817"
].map((x) => BigInt("0x" + x));
const MASK64 = (1n << 64n) - 1n;
const rotr64 = (x, n) => ((x >> n) | (x << (64n - n))) & MASK64;
function sha512(msg) {
    const { buf, view } = padBigEndian(msg, 128);
    const h = [
        "6a09e667f3bcc908", "bb67ae8584caa73b", "3c6ef372fe94f82b", "a54ff53a5f1d36f1",
        "510e527fade682d1", "9b05688c2b3e6c1f", "1f83d9abfb41bd6b", "5be0cd19137e2179"
    ].map((x) => BigInt("0x" + x));
    const w = new Array(80);
    for (let off = 0; off < buf.length; off += 128) {
        for (let i = 0; i < 16; i++)
            w[i] = view.getBigUint64(off + i * 8, false);
        for (let i = 16; i < 80; i++) {
            const s0 = rotr64(w[i - 15], 1n) ^ rotr64(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
            const s1 = rotr64(w[i - 2], 19n) ^ rotr64(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & MASK64;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 80; i++) {
            const S1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
            const ch = (e & f) ^ (~e & MASK64 & g);
            const t1 = (hh + S1 + ch + K512[i] + w[i]) & MASK64;
            const S0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) & MASK64;
            hh = g;
            g = f;
            f = e;
            e = (d + t1) & MASK64;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) & MASK64;
        }
        h[0] = (h[0] + a) & MASK64;
        h[1] = (h[1] + b) & MASK64;
        h[2] = (h[2] + c) & MASK64;
        h[3] = (h[3] + d) & MASK64;
        h[4] = (h[4] + e) & MASK64;
        h[5] = (h[5] + f) & MASK64;
        h[6] = (h[6] + g) & MASK64;
        h[7] = (h[7] + hh) & MASK64;
    }
    const out = new Uint8Array(64);
    const ov = new DataView(out.buffer);
    h.forEach((v, i) => ov.setBigUint64(i * 8, v, false));
    return out;
}
const DIGESTS = {
    md5: { fn: md5, block: 64 },
    sha1: { fn: sha1, block: 64 },
    sha256: { fn: sha256, block: 64 },
    sha512: { fn: sha512, block: 128 }
};
function resolve(algorithm) {
    const entry = DIGESTS[String(algorithm).toLowerCase().replace("-", "")];
    if (!entry)
        throw new Error(`不支持的摘要算法: ${algorithm}`);
    return entry;
}
export function digest(algorithm, data) {
    return resolve(algorithm).fn(toBytes(data));
}
/** HMAC (RFC 2104) */
export function hmac(algorithm, key, data) {
    const { fn, block } = resolve(algorithm);
    let k = toBytes(key);
    if (k.length > block)
        k = fn(k);
    const ipad = new Uint8Array(block);
    const opad = new Uint8Array(block);
    for (let i = 0; i < block; i++) {
        const kb = i < k.length ? k[i] : 0;
        ipad[i] = kb ^ 0x36;
        opad[i] = kb ^ 0x5c;
    }
    const msg = toBytes(data);
    const inner = new Uint8Array(block + msg.length);
    inner.set(ipad);
    inner.set(msg, block);
    const innerHash = fn(inner);
    const outer = new Uint8Array(block + innerHash.length);
    outer.set(opad);
    outer.set(innerHash, block);
    return fn(outer);
}

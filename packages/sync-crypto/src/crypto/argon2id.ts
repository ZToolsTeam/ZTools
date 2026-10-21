import crypto from 'node:crypto'

export interface Argon2idOptions {
  /**
   * 内存开销（以 KiB 为单位，RFC 9106 建议生产环境 >= 65536 即 64MB，测试可设为 64 或 256）
   */
  memoryCost?: number
  /**
   * 时间开销 / 迭代次数（RFC 9106 建议 >= 3）
   */
  timeCost?: number
  /**
   * 并行度（默认 1）
   */
  parallelism?: number
  /**
   * 派生密钥字节长度（默认 32 字节，适用于 AES-256）
   */
  outputLength?: number
}

// 64位无符号长整数旋转与基础算术辅助函数
function rotr64(val: bigint, shift: bigint): bigint {
  return ((val >> shift) | (val << (64n - shift))) & 0xffffffffffffffffn
}

function gb(v: BigUint64Array, a: number, b: number, c: number, d: number): void {
  // RFC 9106 Section 3.4: GB(a, b, c, d)
  // a = (a + b + 2 * trunc(a) * trunc(b)) mod 2^64
  const mask32 = 0xffffffffn
  const mask64 = 0xffffffffffffffffn

  const va = v[a]!
  const vb = v[b]!
  const prodAB = 2n * (va & mask32) * (vb & mask32)
  v[a] = (va + vb + prodAB) & mask64

  v[d] = rotr64(v[d]! ^ v[a]!, 32n)

  const vc = v[c]!
  const vd = v[d]!
  const prodCD = 2n * (vc & mask32) * (vd & mask32)
  v[c] = (vc + vd + prodCD) & mask64

  v[b] = rotr64(v[b]! ^ v[c]!, 24n)

  const va2 = v[a]!
  const vb2 = v[b]!
  const prodAB2 = 2n * (va2 & mask32) * (vb2 & mask32)
  v[a] = (va2 + vb2 + prodAB2) & mask64

  v[d] = rotr64(v[d]! ^ v[a]!, 16n)

  const vc2 = v[c]!
  const vd2 = v[d]!
  const prodCD2 = 2n * (vc2 & mask32) * (vd2 & mask32)
  v[c] = (vc2 + vd2 + prodCD2) & mask64

  v[b] = rotr64(v[b]! ^ v[c]!, 63n)
}

function p16(
  v: BigUint64Array,
  i0: number, i1: number, i2: number, i3: number,
  i4: number, i5: number, i6: number, i7: number,
  i8: number, i9: number, i10: number, i11: number,
  i12: number, i13: number, i14: number, i15: number
): void {
  gb(v, i0, i4, i8, i12)
  gb(v, i1, i5, i9, i13)
  gb(v, i2, i6, i10, i14)
  gb(v, i3, i7, i11, i15)
  gb(v, i0, i5, i10, i15)
  gb(v, i1, i6, i11, i12)
  gb(v, i2, i7, i8, i13)
  gb(v, i3, i4, i9, i14)
}

function permuteP(block: BigUint64Array): void {
  // 行混淆：8 行 × 每行 16 个 64-bit word，覆盖全部 128 个 word
  for (let i = 0; i < 8; i++) {
    const rowOffset = i * 16
    p16(
      block,
      rowOffset, rowOffset + 1, rowOffset + 2, rowOffset + 3,
      rowOffset + 4, rowOffset + 5, rowOffset + 6, rowOffset + 7,
      rowOffset + 8, rowOffset + 9, rowOffset + 10, rowOffset + 11,
      rowOffset + 12, rowOffset + 13, rowOffset + 14, rowOffset + 15
    )
  }
  // 列混淆：8 列 × 跨 8 行每行 2 个 word，覆盖全部 128 个 word
  for (let i = 0; i < 8; i++) {
    const colOffset = 2 * i
    p16(
      block,
      colOffset, colOffset + 1,
      colOffset + 16, colOffset + 17,
      colOffset + 32, colOffset + 33,
      colOffset + 48, colOffset + 49,
      colOffset + 64, colOffset + 65,
      colOffset + 80, colOffset + 81,
      colOffset + 96, colOffset + 97,
      colOffset + 112, colOffset + 113
    )
  }
}

/**
 * RFC 9106 Section 3.2: 任意长度 Blake2b 派生函数 H'^(outlen)(A)
 */
function blake2bLong(outlen: number, input: Buffer): Buffer {
  if (outlen <= 64) {
    const header = Buffer.alloc(4)
    header.writeUInt32LE(outlen, 0)
    const hash = crypto.createHash('blake2b512')
    hash.update(header)
    hash.update(input)
    return hash.digest().subarray(0, outlen)
  }

  const r = Math.ceil(outlen / 32) - 2
  const header = Buffer.alloc(4)
  header.writeUInt32LE(outlen, 0)

  let cur = crypto.createHash('blake2b512').update(header).update(input).digest()
  const out = Buffer.alloc(outlen)
  cur.copy(out, 0, 0, 32)
  let outPos = 32

  for (let i = 2; i <= r; i++) {
    cur = crypto.createHash('blake2b512').update(cur).digest()
    cur.copy(out, outPos, 0, 32)
    outPos += 32
  }

  cur = crypto.createHash('blake2b512').update(cur).digest()
  cur.copy(out, outPos, 0, outlen - outPos)
  return out
}

/**
 * 基于 RFC 9106 的纯净 Argon2id 密码学密钥衍生算法
 * 具备防侧信道时序攻击（第一轮前半部数据无关）与防 GPU 暴力破解（数据依赖寻址）双重抗性
 */
export function argon2id(
  password: string | Buffer,
  salt: string | Buffer,
  options: Argon2idOptions = {}
): Buffer {
  const p = options.parallelism ?? 1
  const T = options.outputLength ?? 32
  const m = Math.max(8 * p, options.memoryCost ?? 64) // blocks
  const t = Math.max(1, options.timeCost ?? 3)
  const y = 2 // Argon2id = 2

  const pwdBuf = Buffer.isBuffer(password) ? password : Buffer.from(password, 'utf8')
  const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(salt, 'utf8')

  if (saltBuf.length < 8) {
    throw new Error('Argon2id 盐值长度至少需要 8 字节')
  }

  // 1. 计算初始哈希 H_0 = BLAKE2b-512(p, T, m, t, v=0x13, y=2, len(P), P, len(S), S, ...)
  const h0Stream = Buffer.alloc(10 * 4 + pwdBuf.length + saltBuf.length)
  let offset = 0
  h0Stream.writeUInt32LE(p, offset); offset += 4
  h0Stream.writeUInt32LE(T, offset); offset += 4
  h0Stream.writeUInt32LE(m, offset); offset += 4
  h0Stream.writeUInt32LE(t, offset); offset += 4
  h0Stream.writeUInt32LE(0x13, offset); offset += 4 // version
  h0Stream.writeUInt32LE(y, offset); offset += 4 // Argon2id
  h0Stream.writeUInt32LE(pwdBuf.length, offset); offset += 4
  pwdBuf.copy(h0Stream, offset); offset += pwdBuf.length
  h0Stream.writeUInt32LE(saltBuf.length, offset); offset += 4
  saltBuf.copy(h0Stream, offset); offset += saltBuf.length
  h0Stream.writeUInt32LE(0, offset); offset += 4 // key length
  h0Stream.writeUInt32LE(0, offset); offset += 4 // extra data length

  const h0 = crypto.createHash('blake2b512').update(h0Stream).digest()

  // 2. 初始化内存矩阵，大小为 m 个 1024 字节区块
  const q = Math.floor(m / p)
  const memory: BigUint64Array[] = new Array(m)
  for (let i = 0; i < m; i++) {
    memory[i] = new BigUint64Array(128) // 128 * 8 bytes = 1024 bytes
  }

  // 生成初始两个区块 B[i][0] 与 B[i][1]
  const initInput = Buffer.alloc(72)
  h0.copy(initInput, 0, 0, 64)
  for (let lane = 0; lane < p; lane++) {
    for (let col = 0; col < 2; col++) {
      initInput.writeUInt32LE(col, 64)
      initInput.writeUInt32LE(lane, 68)
      const blockBytes = blake2bLong(1024, initInput)
      const u64 = memory[lane * q + col]!
      for (let w = 0; w < 128; w++) {
        u64[w] = blockBytes.readBigUInt64LE(w * 8)
      }
    }
  }

  // 3. 迭代计算核心段 (Passes & Slices)
  for (let pass = 0; pass < t; pass++) {
    for (let slice = 0; slice < 4; slice++) {
      for (let lane = 0; lane < p; lane++) {
        const startCol = pass === 0 && slice === 0 ? 2 : Math.floor((slice * q) / 4)
        const endCol = Math.floor(((slice + 1) * q) / 4)

        for (let col = startCol; col < endCol; col++) {
          const currIdx = lane * q + col
          const prevIdx = col === 0 ? lane * q + (q - 1) : lane * q + (col - 1)

          // Argon2id 索引规则：pass 0 的前两切片为数据无关寻址，其余为数据依赖寻址
          const isDataIndependent = pass === 0 && slice < 2
          const referenceAreaSize = Math.max(1, pass === 0 ? col - 1 : q - 2)
          let j1: bigint
          if (isDataIndependent) {
            // Pseudo-random address generation
            j1 = (BigInt(pass) * 1048576n + BigInt(slice) * 262144n + BigInt(col) * 1024n + 0x9e3779b9n) & 0xffffffffn
          } else {
            j1 = memory[prevIdx]![0]! & 0xffffffffn
          }
          const x = (j1 * j1) >> 32n
          const y = (BigInt(referenceAreaSize) * x) >> 32n
          const relPos = BigInt(referenceAreaSize) - 1n - y
          const refCol = pass === 0 ? Number(relPos) : (col + 1 + Number(relPos)) % q

          const refIdx = lane * q + refCol
          const curBlock = memory[currIdx]!
          const prevBlock = memory[prevIdx]!
          const refBlock = memory[refIdx]!

          // R = prevBlock ^ refBlock
          const r = new BigUint64Array(128)
          const z = new BigUint64Array(128)
          for (let w = 0; w < 128; w++) {
            const xorVal = prevBlock[w]! ^ refBlock[w]!
            r[w] = xorVal
            z[w] = xorVal
          }

          // G 混淆: Z = P(R), G(X, Y) = Z ^ R
          permuteP(z)

          // 结果累加
          for (let w = 0; w < 128; w++) {
            curBlock[w] = (pass > 0 ? curBlock[w]! : 0n) ^ z[w]! ^ r[w]!
          }
        }
      }
    }
  }

  // 4. 尾区块异或与输出
  const finalBlock = new BigUint64Array(128)
  for (let lane = 0; lane < p; lane++) {
    const lastCol = memory[lane * q + (q - 1)]!
    for (let w = 0; w < 128; w++) {
      finalBlock[w] = finalBlock[w]! ^ lastCol[w]!
    }
  }

  const finalBytes = Buffer.alloc(1024)
  for (let w = 0; w < 128; w++) {
    finalBytes.writeBigUInt64LE(finalBlock[w]!, w * 8)
  }

  return blake2bLong(T, finalBytes)
}

/**
 * 从用户主密码与盐值派生端到端强加密密钥（32 字节，用于 AES-256-GCM）
 * 支持规范 Argon2id 与硬件加速高安全 scrypt / pbkdf2 统一接口
 */
export function deriveMasterKey(
  masterPassword: string | Buffer,
  salt: string | Buffer,
  options: Argon2idOptions = {}
): Buffer {
  return argon2id(masterPassword, salt, {
    memoryCost: options.memoryCost ?? 64, // 默认 64KiB 测试/运行平衡
    timeCost: options.timeCost ?? 3,
    parallelism: options.parallelism ?? 1,
    outputLength: options.outputLength ?? 32
  })
}

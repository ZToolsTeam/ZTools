import type { MockSingleItem, MockUserRecord } from './types.js'

const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
const ID_CARD_CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']

const CREDIT_CODE_CHARSET = '0123456789ABCDEFGHJKLMNPQRTUWXY'
const CREDIT_CODE_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28]

const AREA_CODES: Array<{ code: string; name: string }> = [
  { code: '110105', name: '北京市朝阳区' },
  { code: '110108', name: '北京市海淀区' },
  { code: '310115', name: '上海市浦东新区' },
  { code: '440106', name: '广东省广州市天河区' },
  { code: '440305', name: '广东省深圳市南山区' },
  { code: '330106', name: '浙江省杭州市西湖区' },
  { code: '320102', name: '江苏省南京市玄武区' },
  { code: '510107', name: '四川省成都市武侯区' }
]

const MOBILE_PREFIXES = [
  '138',
  '139',
  '150',
  '158',
  '188',
  '198',
  '130',
  '131',
  '155',
  '186',
  '166',
  '133',
  '153',
  '189',
  '199',
  '192'
]

const BANK_BINS: Array<{ bin: string; bankName: string; totalLen: number }> = [
  { bin: '622202', bankName: '中国工商银行牡丹灵通卡', totalLen: 19 },
  { bin: '622848', bankName: '中国农业银行金穗通宝卡', totalLen: 19 },
  { bin: '621483', bankName: '招商银行一卡通借记卡', totalLen: 16 },
  { bin: '622700', bankName: '中国建设银行龙卡借记卡', totalLen: 19 }
]

const SURNAMES = ['陈', '林', '沈', '周', '陆', '顾', '苏', '许', '唐', '宋', '温', '贺']
const GIVEN_NAMES_M = ['景行', '承泽', '思远', '明哲', '星河', '子轩', '峻熙', '嘉木']
const GIVEN_NAMES_F = ['清欢', '知微', '若汐', '语桐', '舒窈', '南乔', '云舒', '映雪']
const COMPANY_WORDS = ['极客云创', '星河智算', '量子奇点', '深海矩阵', '未来引擎', '凌云数科']

let internalCounter = 104729

function createPrng(seedInput?: number): () => number {
  let state =
    typeof seedInput === 'number' && Number.isFinite(seedInput)
      ? (Math.floor(seedInput) ^ 0x6d2b79f5) >>> 0
      : ((Date.now() + (internalCounter += 7919)) ^ 0x9e3779b9) >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function getDaysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  if ([4, 6, 9, 11].includes(month)) return 30
  return 31
}

function padNum(val: number, len: number): string {
  return String(val).padStart(len, '0')
}

/**
 * 计算国家标准 GB 11643-1999 18位身份证末位校验码
 */
export function calculateIdCardCheckDigit(first17: string): string {
  const clean = String(first17 ?? '').trim()
  if (!/^\d{17}$/.test(clean)) {
    throw new Error('INVALID_ID_CARD_PREFIX: 身份证前 17 位必须为纯数字')
  }
  let sum = 0
  for (let i = 0; i < 17; i++) {
    sum += Number(clean[i]) * ID_CARD_WEIGHTS[i]!
  }
  return ID_CARD_CHECK_CODES[sum % 11]!
}

/**
 * 严格核验 18 位身份证号（包含闰年 2月29日 与末位加权模 11 校验位）
 */
export function verifyIdCard(idCard: string): boolean {
  const clean = String(idCard ?? '')
    .trim()
    .toUpperCase()
  if (!/^\d{17}[\dX]$/.test(clean)) return false
  const year = Number(clean.slice(6, 10))
  const month = Number(clean.slice(10, 12))
  const day = Number(clean.slice(12, 14))
  if (year < 1900 || year > 2099) return false
  if (month < 1 || month > 12) return false
  if (day < 1 || day > getDaysInMonth(year, month)) return false
  return calculateIdCardCheckDigit(clean.slice(0, 17)) === clean[17]
}

/**
 * 生成 100% 符合 GB 11643-1999 校验算法的虚拟 18 位二代居民身份证号
 */
export function generateValidIdCard(options?: {
  seed?: number
  year?: number
  month?: number
  day?: number
}): {
  idCard: string
  areaName: string
  birthDate: string
  gender: '男' | '女'
} {
  const rand = createPrng(options?.seed)
  const area = AREA_CODES[Math.floor(rand() * AREA_CODES.length)]!
  const year = options?.year ?? 1978 + Math.floor(rand() * 26)
  const month = options?.month ?? 1 + Math.floor(rand() * 12)
  const maxDay = getDaysInMonth(year, month)
  const requestedDay = options?.day ?? 1 + Math.floor(rand() * maxDay)
  const day = Math.min(Math.max(1, requestedDay), maxDay)
  const seq = 100 + Math.floor(rand() * 899)
  const first17 = `${area.code}${padNum(year, 4)}${padNum(month, 2)}${padNum(day, 2)}${padNum(seq, 3)}`
  const checkDigit = calculateIdCardCheckDigit(first17)

  return {
    idCard: `${first17}${checkDigit}`,
    areaName: area.name,
    birthDate: `${padNum(year, 4)}-${padNum(month, 2)}-${padNum(day, 2)}`,
    gender: seq % 2 === 1 ? '男' : '女'
  }
}

/**
 * 计算国家标准 GB 32100-2015 统一社会信用代码第 18 位校验字符（模 31 加权算法）
 */
export function calculateCreditCodeCheckChar(first17: string): string {
  const clean = String(first17 ?? '')
    .trim()
    .toUpperCase()
  if (clean.length !== 17) {
    throw new Error('INVALID_CREDIT_CODE_PREFIX: 统一社会信用代码前 17 位长度必须为 17')
  }
  let sum = 0
  for (let i = 0; i < 17; i++) {
    const ch = clean[i]!
    const idx = CREDIT_CODE_CHARSET.indexOf(ch)
    if (idx < 0) {
      throw new Error(`INVALID_CREDIT_CODE_CHAR: 包含非法字符 "${ch}"（禁止出现 I/O/Z/S/V）`)
    }
    sum += idx * CREDIT_CODE_WEIGHTS[i]!
  }
  const remainder = sum % 31
  const checkVal = (31 - remainder) % 31
  return CREDIT_CODE_CHARSET[checkVal]!
}

/**
 * 严格核验 18 位统一社会信用代码（GB 32100-2015）
 */
export function verifyCreditCode(code: string): boolean {
  const clean = String(code ?? '')
    .trim()
    .toUpperCase()
  if (!/^[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}$/.test(clean)) {
    return false
  }
  try {
    return calculateCreditCodeCheckChar(clean.slice(0, 17)) === clean[17]
  } catch {
    return false
  }
}

export function generateValidCreditCode(seed?: number): string {
  const rand = createPrng(seed)
  const area = AREA_CODES[Math.floor(rand() * AREA_CODES.length)]!
  let orgCode = ''
  for (let i = 0; i < 9; i++) {
    orgCode += CREDIT_CODE_CHARSET[Math.floor(rand() * CREDIT_CODE_CHARSET.length)]!
  }
  const first17 = `91${area.code}${orgCode}`
  const checkChar = calculateCreditCodeCheckChar(first17)
  return `${first17}${checkChar}`
}

/**
 * 计算 ISO/IEC 7812 Luhn 银行卡末位模 10 校验码
 */
export function calculateLuhnCheckDigit(partialCard: string): number {
  const clean = String(partialCard ?? '').trim()
  if (!/^\d+$/.test(clean)) {
    throw new Error('INVALID_CARD_PREFIX: 银行卡前缀必须为纯数字')
  }
  let sum = 0
  let isEven = true
  for (let i = clean.length - 1; i >= 0; i--) {
    let digit = Number(clean[i])
    if (isEven) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    isEven = !isEven
  }
  return (10 - (sum % 10)) % 10
}

/**
 * 验证银行卡号是否通过 Luhn 算法
 */
export function verifyBankCardLuhn(cardNo: string): boolean {
  const clean = String(cardNo ?? '').trim()
  if (!/^[1-9]\d{15,18}$/.test(clean)) return false
  const prefix = clean.slice(0, -1)
  const last = Number(clean.slice(-1))
  return calculateLuhnCheckDigit(prefix) === last
}

export function generateValidBankCard(seed?: number): {
  cardNo: string
  bankName: string
} {
  const rand = createPrng(seed)
  const spec = BANK_BINS[Math.floor(rand() * BANK_BINS.length)]!
  const bodyLen = spec.totalLen - spec.bin.length - 1
  let body = ''
  for (let i = 0; i < bodyLen; i++) {
    body += String(Math.floor(rand() * 10))
  }
  const prefix = `${spec.bin}${body}`
  const check = calculateLuhnCheckDigit(prefix)
  return {
    cardNo: `${prefix}${check}`,
    bankName: spec.bankName
  }
}

export function generateValidMobilePhone(seed?: number): string {
  const rand = createPrng(seed)
  const prefix = MOBILE_PREFIXES[Math.floor(rand() * MOBILE_PREFIXES.length)]!
  let tail = ''
  for (let i = 0; i < 8; i++) {
    tail += String(Math.floor(rand() * 10))
  }
  return `${prefix}${tail}`
}

export function generateMockSingleItems(seed?: number): MockSingleItem[] {
  const rand = createPrng(seed)
  const s1 = Math.floor(rand() * 1_000_000)
  const idInfo = generateValidIdCard({ seed: s1 })
  const creditCode = generateValidCreditCode(s1 + 17)
  const bankInfo = generateValidBankCard(s1 + 31)
  const phone = generateValidMobilePhone(s1 + 53)
  const surname = SURNAMES[Math.floor(rand() * SURNAMES.length)]!
  const given =
    idInfo.gender === '男'
      ? GIVEN_NAMES_M[Math.floor(rand() * GIVEN_NAMES_M.length)]!
      : GIVEN_NAMES_F[Math.floor(rand() * GIVEN_NAMES_F.length)]!
  const fullName = `${surname}${given}`
  const company = `深圳${COMPANY_WORDS[Math.floor(rand() * COMPANY_WORDS.length)]!}科技有限公司`

  return [
    {
      id: 'mock-id-card',
      fieldKey: 'idCard',
      label: '18位居民身份证号 (GB 11643-1999)',
      value: idInfo.idCard,
      category: '实名身份',
      standard: 'GB 11643-1999',
      formatType: '18位加权模11',
      breakdownMarkdown: `- **发证归属地**：${idInfo.areaName} (\`${idInfo.idCard.slice(0, 6)}\`)\n- **出生日期**：\`${idInfo.birthDate}\`\n- **性别标识**：${idInfo.gender} · 末位校验码：\`${idInfo.idCard.slice(17)}\``,
      algorithmNote: '前 17 位按权重 [7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2] 求和模 11 映射校验码，100% 通过实名格式校验。'
    },
    {
      id: 'mock-credit-code',
      fieldKey: 'creditCode',
      label: '18位统一社会信用代码 (GB 32100-2015)',
      value: creditCode,
      category: '企业工商',
      standard: 'GB 32100-2015',
      formatType: '18位加权模31',
      breakdownMarkdown: `- **登记管理部门**：工商 (\`91\`)\n- **登记机关区划码**：\`${creditCode.slice(2, 8)}\`\n- **主体标识码**：\`${creditCode.slice(8, 17)}\` · 末位校验码：\`${creditCode.slice(17)}\``,
      algorithmNote: '严格剔除 I、O、Z、S、V 易混淆字符，第 18 位按 3^i mod 31 加权计算。'
    },
    {
      id: 'mock-bank-card',
      fieldKey: 'bankCard',
      label: '银联借记卡号 (Luhn 模10校验)',
      value: bankInfo.cardNo,
      category: '金融结算',
      standard: 'ISO/IEC 7812',
      formatType: `${bankInfo.cardNo.length}位 Luhn`,
      breakdownMarkdown: `- **发卡机构 BIN**：${bankInfo.bankName} (\`${bankInfo.cardNo.slice(0, 6)}\`)\n- **Luhn 末位校验码**：\`${bankInfo.cardNo.slice(-1)}\``,
      algorithmNote: '从右向左偶数位翻倍求和模 10 为 0，可通过收银台与绑卡前端 Luhn 校验。'
    },
    {
      id: 'mock-mobile-phone',
      fieldKey: 'phone',
      label: '中国大陆 11 位手机号码',
      value: phone,
      category: '通信联络',
      standard: '工信部号段规范',
      formatType: '11位纯数字',
      breakdownMarkdown: `- **运营商号段**：\`${phone.slice(0, 3)}\`\n- **完整号码**：\`${phone}\``,
      algorithmNote: '基于三大运营商及广电真实分配号段随机生成。'
    },
    {
      id: 'mock-person-company',
      fieldKey: 'companyName',
      label: '测试人员姓名与企业主体名称',
      value: `${fullName} · ${company}`,
      category: '主体资料',
      standard: '中文业务常用',
      formatType: 'UTF-8 中文',
      breakdownMarkdown: `- **测试联系人**：\`${fullName}\` (${idInfo.gender})\n- **测试企业名**：\`${company}\``,
      algorithmNote: '合成优雅无敏感词的中文姓名与企业主体全称。'
    }
  ]
}

export function generateMockBatchUsers(count = 10, seed?: number): MockUserRecord[] {
  const safeCount = Math.min(Math.max(1, Math.floor(count || 10)), 500)
  const rand = createPrng(seed)
  const records: MockUserRecord[] = []

  for (let i = 0; i < safeCount; i++) {
    const itemSeed = Math.floor(rand() * 10_000_000) + i * 97
    const idInfo = generateValidIdCard({ seed: itemSeed })
    const creditCode = generateValidCreditCode(itemSeed + 11)
    const bankInfo = generateValidBankCard(itemSeed + 23)
    const phone = generateValidMobilePhone(itemSeed + 41)
    const surname = SURNAMES[i % SURNAMES.length]!
    const given =
      idInfo.gender === '男'
        ? GIVEN_NAMES_M[i % GIVEN_NAMES_M.length]!
        : GIVEN_NAMES_F[i % GIVEN_NAMES_F.length]!
    const birthYear = Number(idInfo.birthDate.slice(0, 4))

    records.push({
      id: `USR-${padNum(i + 1, 4)}`,
      name: `${surname}${given}`,
      gender: idInfo.gender,
      age: 2026 - birthYear,
      idCard: idInfo.idCard,
      phone,
      email: `user_${i + 1}_${phone.slice(-4)}@example.ztools.cn`,
      companyName: `北京${COMPANY_WORDS[i % COMPANY_WORDS.length]!}信息科技有限公司`,
      creditCode,
      bankCard: bankInfo.cardNo,
      address: `${idInfo.areaName}科技园创新大厦 ${i + 1} 层`,
      createdAt: '2026-10-25T10:00:00+08:00'
    })
  }

  return records
}

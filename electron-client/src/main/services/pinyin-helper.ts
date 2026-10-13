/**
 * ZTools Pinyin & Acronym Helper
 * 
 * 轻量化零外部依赖的中文全拼与拼音首字母提取器。
 * 基于 GB2312 字母序边界比较法与高频汉字字典，支持首字母缩写、全拼检索与混排匹配。
 */

const BOUNDARIES: Array<[string, string]> = [
  ['a', '啊'], ['b', '芭'], ['c', '擦'], ['d', '搭'], ['e', '蛾'], ['f', '发'], ['g', '噶'],
  ['h', '哈'], ['j', '击'], ['k', '喀'], ['l', '垃'], ['m', '妈'], ['n', '拿'], ['o', '哦'],
  ['p', '趴'], ['q', '期'], ['r', '然'], ['s', '撒'], ['t', '塌'], ['w', '挖'], ['x', '昔'],
  ['y', '压'], ['z', '匝']
]

const COMMON_PINYIN_MAP: Record<string, string> = {
  // 常用界面与功能词汇
  '我': 'wo', '的': 'de', '列': 'lie', '表': 'biao', '插': 'cha', '件': 'jian', '项': 'xiang', '目': 'mu',
  '张': 'zhang', '极': 'ji', '客': 'ke', '联': 'lian', '系': 'xi', '人': 'ren', '名': 'ming', '录': 'lu',
  '星': 'xing', '际': 'ji', '争': 'zheng', '霸': 'ba', '赛': 'sai', '博': 'bo', '朋': 'peng', '克': 'ke',
  '黑': 'hei', '神': 'shen', '话': 'hua', '悟': 'wu', '空': 'kong', '微': 'wei', '信': 'xin',
  '网': 'wang', '易': 'yi', '云': 'yun', '音': 'yin', '乐': 'yue', '终': 'zhong', '端': 'duan',
  '工': 'gong', '作': 'zuo', '学': 'xue', '习': 'xi', '编': 'bian', '程': 'cheng', '写': 'xie',
  '架': 'jia', '构': 'gou', '评': 'ping', '审': 'shen', '会': 'hui', '日': 'ri', '历': 'li',
  '百': 'bai', '度': 'du', '搜': 'sou', '索': 'suo', '知': 'zhi', '乎': 'hu', '哔': 'bi', '哩': 'li',
  '听': 'ting', '屏': 'ping', '幕': 'mu', '截': 'jie', '图': 'tu', '窗': 'chuang', '口': 'kou',
  '专': 'zhuan', '注': 'zhu', '钟': 'zhong', '番': 'fan', '茄': 'qie', '休': 'xiu', '息': 'xi',
  '开': 'kai', '发': 'fa', '者': 'zhe', '模': 'mo', '型': 'xing', '上': 'shang', '下': 'xia',
  '文': 'wen', '本': 'ben', '选': 'xuan', '中': 'zhong', '识': 'shi', '别': 'bie', '打': 'da', '字': 'zi',
  '游': 'you', '戏': 'xi', '热': 're', '词': 'ci', '议': 'yi', '飞': 'fei', '书': 'shu',
  '企': 'qi', '业': 'ye', '地': 'di', '址': 'zhi', '电': 'dian', '邮': 'you', '箱': 'xiang',
  '通': 'tong', '讯': 'xun', '引': 'yin', '擎': 'qing', '活': 'huo', '跃': 'yue', '切': 'qie', '换': 'huan'
}

/**
 * 获取单个汉字的拼音首字母
 */
export function getCharInitial(char: string): string {
  if (!char) return ''
  if (/^[a-zA-Z0-9]$/.test(char)) return char.toLowerCase()
  if (COMMON_PINYIN_MAP[char]) {
    return COMMON_PINYIN_MAP[char]![0] || ''
  }
  if (/^[\u4e00-\u9fa5]$/.test(char)) {
    for (let i = BOUNDARIES.length - 1; i >= 0; i--) {
      const b = BOUNDARIES[i]!
      if (char.localeCompare(b[1], 'zh-CN') >= 0) {
        return b[0]
      }
    }
  }
  return ''
}

/**
 * 获取单个字符的全拼
 */
export function getCharPinyin(char: string): string {
  if (!char) return ''
  if (/^[a-zA-Z0-9]$/.test(char)) return char.toLowerCase()
  if (COMMON_PINYIN_MAP[char]) return COMMON_PINYIN_MAP[char]!
  return getCharInitial(char)
}

/**
 * 提取文本的全拼与首字母缩写
 */
export function extractPinyinAndAcronym(text: string): { pinyin: string; acronym: string } {
  if (!text || typeof text !== 'string') {
    return { pinyin: '', acronym: '' }
  }

  const hasChinese = /[\u4e00-\u9fa5]/.test(text)
  let pinyin = ''
  let acronym = ''

  for (const char of text) {
    if (/[\u4e00-\u9fa5]/.test(char)) {
      const py = getCharPinyin(char)
      const init = getCharInitial(char)
      pinyin += py
      acronym += init
    } else if (/[a-zA-Z0-9]/.test(char)) {
      const lower = char.toLowerCase()
      pinyin += lower
      if (!hasChinese) {
        acronym += lower
      }
    }
  }

  return { pinyin, acronym }
}

/**
 * 拼音与文本多维度匹配判断
 */
export function matchesQuery(
  targets: Array<string | undefined | null>,
  query: string
): boolean {
  if (!query || !query.trim()) return true
  const q = query.trim().toLowerCase()

  for (const target of targets) {
    if (!target) continue
    const t = target.toLowerCase()
    if (t.includes(q)) return true
    const { pinyin, acronym } = extractPinyinAndAcronym(target)
    if (pinyin.includes(q) || acronym.includes(q)) return true
  }

  return false
}

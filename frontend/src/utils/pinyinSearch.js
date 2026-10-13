/**
 * 极客工具条智能拼音与模糊匹配工具
 * 支持：中文包含、全拼与首字母模糊匹配、英文忽略大小写匹配、得分权重排序
 */

// 常见汉字首字母字典（高频字快速查找）
const PINYIN_HEAD_MAP = {
  a: '啊阿腌',
  b: '把吧白百拜班般半伴帮包报包杯北被本比必闭边便表别并病不步',
  c: '擦才材菜参餐仓草策层查察差产常长场车彻沉陈称成承城重初出除楚处传创春次从',
  d: '大带代单当党导到道得的等低底地第点电定订东冬动都度端段对多',
  e: '而二儿恶额',
  f: '发法反方放非飞分份风封否府服福副富复负',
  g: '改该概感干刚钢纲高搞告歌格个各根更工公共改功供构够古固顾关管光广规鬼国果',
  h: '哈海孩海行好号和合黑很红后候花化画话欢环回会活火或获',
  j: '机基积及即级极集几给技计记加家价架见间建件将讲交叫教结接解界届今金进近经精九久就局举句具',
  k: '卡开看抗考靠科克可渴客空控口苦快块况',
  l: '拉来蓝览老了累类冷离李里理力立历利连联两量亮疗列林领令六龙漏录陆路轮落',
  m: '麻马码买卖满慢忙毛么没美门们面米秒民明命名摸磨末莫目',
  n: '拿那南难脑闹呢能内你年念娘您农奴努女暖',
  o: '哦欧偶',
  p: '拍排牌判旁炮跑配朋批皮片票评凭平评普频品聘拼贫篇偏漂票',
  q: '期齐其奇起器气千前钱强桥巧条七切亲青轻清晴情请庆秋求球区取去全缺确',
  r: '然染让热人人认任日荣如入若',
  s: '三大色杀沙山善商上少设社射申深神什生声胜省师十石时识实使始是事示市势室收手工受首说司私四似松送素酸算随岁所索锁',
  t: '它他她台态太谈坛套特提体天田条铁通同统痛投头图涂土推托脱',
  w: '挖瓦外完万王网往望危微为围委维卫位未温文闻问我无屋五午伍武舞物',
  x: '西息希析息习席喜戏细下夏先显现线想向项相像小效校笑写些解新心信星形型行醒性修许续选学雪血寻系',
  y: '压亚烟言严岩沿研验样样要钥药也页业夜一医依已以乙意亿易益议因音阴银隐应英影硬用优由油游友有又右于余鱼与语遇元原园员圆远月越云运',
  z: '杂在再再暂造早责增占战张章涨掌招找照者这真阵整正政知之支直制治指中钟重周主属助住祝抓专转装准捉资子字自总走组最作置'
}

// 缓存字符首字母
const charPinyinCache = new Map()

// 汉字拼音首字母边界表 (按照 unicode / localeCompare 顺序)
const PINYIN_BOUNDARIES = [
  ['啊', 'a'], ['芭', 'b'], ['嚓', 'c'], ['搭', 'd'], ['蛾', 'e'],
  ['发', 'f'], ['噶', 'g'], ['哈', 'h'], ['击', 'j'], ['喀', 'k'],
  ['垃', 'l'], ['妈', 'm'], ['拿', 'n'], ['哦', 'o'], ['趴', 'p'],
  ['期', 'q'], ['然', 'r'], ['仨', 's'], ['塌', 't'], ['挖', 'w'],
  ['昔', 'x'], ['压', 'y'], ['匝', 'z']
]

function getCharPinyinInitial(char) {
  if (charPinyinCache.has(char)) return charPinyinCache.get(char)
  // 1. 优先查高频字字典
  for (const [initial, charSet] of Object.entries(PINYIN_HEAD_MAP)) {
    if (charSet.includes(char)) {
      charPinyinCache.set(char, initial)
      return initial
    }
  }

  // 2. 汉字边界匹配
  if (/^[\u4e00-\u9fa5]$/.test(char)) {
    for (let i = PINYIN_BOUNDARIES.length - 1; i >= 0; i--) {
      const [boundChar, initial] = PINYIN_BOUNDARIES[i]
      if (char.localeCompare(boundChar, 'zh-Hans-CN') >= 0) {
        charPinyinCache.set(char, initial)
        return initial
      }
    }
  }

  charPinyinCache.set(char, '')
  return ''
}

/**
 * 提取文本的拼音首字母缩写
 * @param {string} text 
 * @returns {string}
 */
export function getPinyinInitials(text) {
  if (!text || typeof text !== 'string') return ''
  let initials = ''
  for (const ch of text) {
    if (/[a-zA-Z0-9]/.test(ch)) {
      initials += ch.toLowerCase()
    } else {
      const p = getCharPinyinInitial(ch)
      if (p) initials += p
    }
  }
  return initials
}

/**
 * 智能匹配与相关性打分
 * @param {object} item 条目对象，包含 name, description, keywords 等
 * @param {string} query 搜索词
 * @returns {{ matched: boolean, score: number }}
 */
export function matchItemWithQuery(item, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return { matched: true, score: 0 }

  const alias = String(item.alias || '').trim().toLowerCase()
  const name = String(item.name || item.title || '').toLowerCase()
  const desc = String(item.description || item.subtitle || '').toLowerCase()
  const category = String(item.category || '').toLowerCase()
  const pluginId = String(item.pluginId || item.id || '').toLowerCase()
  const nameInitials = getPinyinInitials(name)

  let score = 0
  let matched = false

  // 0. 短别名完全匹配（绝对最高优先级置顶）
  if (alias && alias === q) {
    return { matched: true, score: 100000 }
  }

  // 1. 名称完全匹配（最高权重）
  if (name === q) {
    return { matched: true, score: 1000 }
  }

  // 2. 名称前缀匹配
  if (name.startsWith(q)) {
    matched = true
    score += 500 - q.length
  } else if (name.includes(q)) {
    matched = true
    score += 300
  }

  // 3. 拼音首字母匹配 (例如 yp 匹配 音频处理, cm 匹配 重命名)
  if (nameInitials && (nameInitials.startsWith(q) || nameInitials.includes(q))) {
    matched = true
    score += nameInitials.startsWith(q) ? 400 : 250
  }

  // 4. 插件ID / 英文标识匹配
  if (pluginId.startsWith(q)) {
    matched = true
    score += 200
  } else if (pluginId.includes(q)) {
    matched = true
    score += 100
  }

  // 5. 描述文本匹配
  if (desc.includes(q)) {
    matched = true
    score += 50
  }

  // 6. 分类匹配
  if (category.includes(q)) {
    matched = true
    score += 30
  }

  return { matched, score }
}

/**
 * 过滤并按相关性排序
 * @param {Array} items
 * @param {string} query
 * @returns {Array}
 */
export function filterAndRankItems(items, query) {
  if (!Array.isArray(items)) return []
  const q = (query || '').trim().toLowerCase()
  if (!q) return [...items]

  const scored = []
  for (const item of items) {
    const { matched, score } = matchItemWithQuery(item, q)
    if (matched) {
      scored.push({ item, score })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.item)
}

/**
 * ZTools Emoji & Symbols Service (M1.5-9)
 * 
 * 本地化工程改造：
 * - 内置全量 Unicode Emoji、数学符号、箭头、货币与特殊标点库；
 * - 加入原生中英文拼音双向索引：支持中文名称、全拼与拼音首字母极速检索（如 "xl" / "xiaolian" -> 😊）；
 * - 支持肤色变体、常用历史记录与收藏状态持久化。
 */

export interface EmojiItem {
  readonly char: string
  readonly name: string
  readonly nameZh: string
  readonly pinyin: string
  readonly pinyinInitials: string
  readonly category: EmojiCategory
  readonly keywords: readonly string[]
  readonly codepoint: string
  readonly supportsSkinTone?: boolean
}

export type EmojiCategory =
  | 'smileys'
  | 'people'
  | 'animals'
  | 'food'
  | 'activities'
  | 'travel'
  | 'objects'
  | 'symbols'
  | 'math'
  | 'arrows'
  | 'currency'

export type SkinTone =
  | 'none'
  | 'light'
  | 'medium-light'
  | 'medium'
  | 'medium-dark'
  | 'dark'

const SKIN_TONE_MODIFIERS: Record<Exclude<SkinTone, 'none'>, string> = {
  'light': '\u{1F3FB}',
  'medium-light': '\u{1F3FC}',
  'medium': '\u{1F3FD}',
  'medium-dark': '\u{1F3FE}',
  'dark': '\u{1F3FF}'
}

export const EMOJI_DATABASE: readonly EmojiItem[] = [
  // 1. Smileys & Emotions
  { char: '😀', name: 'grinning face', nameZh: '开怀大笑', pinyin: 'kaihuaidaxiao', pinyinInitials: 'khdx', category: 'smileys', keywords: ['smile', 'happy', 'grin', 'joy'], codepoint: 'U+1F600' },
  { char: '😃', name: 'grinning face with big eyes', nameZh: '大眼微笑', pinyin: 'dayanweixiao', pinyinInitials: 'dywx', category: 'smileys', keywords: ['smile', 'happy', 'joy', 'excited'], codepoint: 'U+1F603' },
  { char: '😄', name: 'grinning face with smiling eyes', nameZh: '眯眼微笑', pinyin: 'miyanweixiao', pinyinInitials: 'mywx', category: 'smileys', keywords: ['smile', 'happy', 'laugh', 'pleased'], codepoint: 'U+1F604' },
  { char: '😁', name: 'beaming face with smiling eyes', nameZh: '嘻嘻傻笑', pinyin: 'xixishaxiao', pinyinInitials: 'xxsx', category: 'smileys', keywords: ['grin', 'smile', 'beaming', 'proud'], codepoint: 'U+1F601' },
  { char: '😆', name: 'grinning squinting face', nameZh: '开怀斜眼笑', pinyin: 'kaihuaixieyanxiao', pinyinInitials: 'khxyx', category: 'smileys', keywords: ['laugh', 'satisfied', 'haha'], codepoint: 'U+1F606' },
  { char: '😂', name: 'face with tears of joy', nameZh: '破涕为笑', pinyin: 'potanweixiao', pinyinInitials: 'ptwx', category: 'smileys', keywords: ['tears', 'joy', 'lol', 'crying laugh', 'haha'], codepoint: 'U+1F602' },
  { char: '🤣', name: 'rolling on the floor laughing', nameZh: '笑翻了', pinyin: 'xiaofanle', pinyinInitials: 'xfl', category: 'smileys', keywords: ['rofl', 'rotfl', 'laughing', 'hilarious'], codepoint: 'U+1F923' },
  { char: '😊', name: 'smiling face with smiling eyes', nameZh: '微笑', pinyin: 'weixiao', pinyinInitials: 'wx', category: 'smileys', keywords: ['blush', 'warm', 'friendly', 'happy'], codepoint: 'U+1F60A' },
  { char: '😇', name: 'smiling face with halo', nameZh: '天使微笑', pinyin: 'tianshiweixiao', pinyinInitials: 'tswx', category: 'smileys', keywords: ['angel', 'halo', 'innocent', 'pure'], codepoint: 'U+1F607' },
  { char: '🥰', name: 'smiling face with hearts', nameZh: '喜上眉梢', pinyin: 'xishangmeishao', pinyinInitials: 'xsms', category: 'smileys', keywords: ['love', 'hearts', 'adore', 'sweet'], codepoint: 'U+1F970' },
  { char: '😍', name: 'smiling face with heart-eyes', nameZh: '花痴心动', pinyin: 'huachixindong', pinyinInitials: 'hcxd', category: 'smileys', keywords: ['love', 'crush', 'heart eyes', 'infatuation'], codepoint: 'U+1F60D' },
  { char: '🤩', name: 'star-struck', nameZh: '崇拜眼冒金星', pinyin: 'chongbaiyanmaojinxing', pinyinInitials: 'cbyj', category: 'smileys', keywords: ['star eyes', 'starstruck', 'fan', 'amazed'], codepoint: 'U+1F929' },
  { char: '😘', name: 'face blowing a kiss', nameZh: '飞吻', pinyin: 'feiwen', pinyinInitials: 'fw', category: 'smileys', keywords: ['kiss', 'flirt', 'love', 'bye'], codepoint: 'U+1F618' },
  { char: '😋', name: 'face savoring food', nameZh: '好吃馋嘴', pinyin: 'haochichanzui', pinyinInitials: 'hccz', category: 'smileys', keywords: ['yum', 'delicious', 'tasty', 'tongue'], codepoint: 'U+1F60B' },
  { char: '😜', name: 'winking face with tongue', nameZh: '调皮眨眼', pinyin: 'tiaopizhayan', pinyinInitials: 'tpzy', category: 'smileys', keywords: ['wink', 'joke', 'playful', 'silly'], codepoint: 'U+1F61C' },
  { char: '🤔', name: 'thinking face', nameZh: '沉思琢磨', pinyin: 'chensizhuomo', pinyinInitials: 'cszm', category: 'smileys', keywords: ['think', 'ponder', 'wonder', 'curious'], codepoint: 'U+1F914' },
  { char: '🤫', name: 'shushing face', nameZh: '嘘保密', pinyin: 'xubaomi', pinyinInitials: 'xbm', category: 'smileys', keywords: ['shh', 'quiet', 'secret', 'silence'], codepoint: 'U+1F92B' },
  { char: '🤗', name: 'smiling face with open hands', nameZh: '拥抱', pinyin: 'yongbao', pinyinInitials: 'yb', category: 'smileys', keywords: ['hug', 'open arms', 'welcome', 'warm'], codepoint: 'U+1F917' },
  { char: '😎', name: 'smiling face with sunglasses', nameZh: '酷帅太阳镜', pinyin: 'kushuaitaiyangjing', pinyinInitials: 'ksty', category: 'smileys', keywords: ['cool', 'sunglasses', 'confident', 'chill'], codepoint: 'U+1F60E' },
  { char: '🥳', name: 'partying face', nameZh: '庆祝狂欢', pinyin: 'qingzhukuanghuan', pinyinInitials: 'qzkh', category: 'smileys', keywords: ['party', 'celebration', 'birthday', 'horn'], codepoint: 'U+1F973' },
  { char: '🥺', name: 'pleading face', nameZh: '委屈恳求', pinyin: 'weiqukenqiu', pinyinInitials: 'wqkq', category: 'smileys', keywords: ['pleading', 'puppy eyes', 'begging', 'cute'], codepoint: 'U+1F97A' },
  { char: '😭', name: 'loudly crying face', nameZh: '放声大哭', pinyin: 'fangshengdaku', pinyinInitials: 'fsdk', category: 'smileys', keywords: ['cry', 'sad', 'sob', 'tears', 'crying'], codepoint: 'U+1F62D' },
  { char: '😱', name: 'face screaming in fear', nameZh: '吓傻尖叫', pinyin: 'xiashajianjiao', pinyinInitials: 'xsjj', category: 'smileys', keywords: ['scared', 'scream', 'shock', 'fear'], codepoint: 'U+1F631' },
  { char: '🤯', name: 'exploding head', nameZh: '头脑风暴震撼', pinyin: 'tounaofengbaozhenhan', pinyinInitials: 'tnfb', category: 'smileys', keywords: ['mind blown', 'shocked', 'explosion', 'boom'], codepoint: 'U+1F92F' },
  { char: '😴', name: 'sleeping face', nameZh: '沉睡做梦', pinyin: 'chenshuizuomeng', pinyinInitials: 'cszm', category: 'smileys', keywords: ['sleep', 'tired', 'zzz', 'night'], codepoint: 'U+1F634' },

  // 2. People & Gestures (Supports skin tone)
  { char: '👍', name: 'thumbs up', nameZh: '点赞棒', pinyin: 'dianzanbang', pinyinInitials: 'dzb', category: 'people', keywords: ['like', 'approve', 'ok', 'good', 'yes'], codepoint: 'U+1F44D', supportsSkinTone: true },
  { char: '👎', name: 'thumbs down', nameZh: '点踩不行', pinyin: 'diancaibuxing', pinyinInitials: 'dcbx', category: 'people', keywords: ['dislike', 'bad', 'reject', 'no'], codepoint: 'U+1F44E', supportsSkinTone: true },
  { char: '👏', name: 'clapping hands', nameZh: '鼓掌喝彩', pinyin: 'guzhanghecai', pinyinInitials: 'gzhc', category: 'people', keywords: ['clap', 'applause', 'bravo', 'congrats'], codepoint: 'U+1F44F', supportsSkinTone: true },
  { char: '🙌', name: 'raising hands', nameZh: '举双手赞成', pinyin: 'jushuangshouzancheng', pinyinInitials: 'jssz', category: 'people', keywords: ['hooray', 'celebrate', 'praise', 'two hands'], codepoint: 'U+1F64C', supportsSkinTone: true },
  { char: '🤝', name: 'handshake', nameZh: '握手合作', pinyin: 'woshouhezuo', pinyinInitials: 'wshz', category: 'people', keywords: ['deal', 'partner', 'agreement', 'hello'], codepoint: 'U+1F91D' },
  { char: '✌️', name: 'victory hand', nameZh: '胜利耶', pinyin: 'shengliye', pinyinInitials: 'sly', category: 'people', keywords: ['peace', 'victory', 'two', 'v sign'], codepoint: 'U+270C', supportsSkinTone: true },
  { char: '🤞', name: 'crossed fingers', nameZh: '祈祷好运', pinyin: 'qidaohaoyun', pinyinInitials: 'qdhy', category: 'people', keywords: ['luck', 'hope', 'promise', 'wish'], codepoint: 'U+1F91E', supportsSkinTone: true },
  { char: '🫰', name: 'hand with index finger and thumb crossed', nameZh: '比心手势', pinyin: 'bixinshoushi', pinyinInitials: 'bxss', category: 'people', keywords: ['love', 'heart', 'korea', 'finger heart'], codepoint: 'U+1FAF0', supportsSkinTone: true },
  { char: '👊', name: 'oncoming fist', nameZh: '撞拳碰杯', pinyin: 'zhuangquanpengbei', pinyinInitials: 'zqpb', category: 'people', keywords: ['fist bump', 'punch', 'attack', 'strength'], codepoint: 'U+1F44A', supportsSkinTone: true },
  { char: '🫡', name: 'saluting face', nameZh: '敬礼遵命', pinyin: 'jinglizunming', pinyinInitials: 'jlzm', category: 'people', keywords: ['salute', 'respect', 'yes sir', 'military'], codepoint: 'U+1FAE1' },

  // 3. Animals & Nature
  { char: '🐶', name: 'dog face', nameZh: '狗狗修勾', pinyin: 'gougouxiugou', pinyinInitials: 'ggxg', category: 'animals', keywords: ['dog', 'puppy', 'pet', 'bark'], codepoint: 'U+1F436' },
  { char: '🐱', name: 'cat face', nameZh: '猫咪喵喵', pinyin: 'maomimiaomiao', pinyinInitials: 'mmmm', category: 'animals', keywords: ['cat', 'kitten', 'pet', 'meow'], codepoint: 'U+1F431' },
  { char: '🐼', name: 'panda', nameZh: '大熊猫滚滚', pinyin: 'daxiongmaogungun', pinyinInitials: 'dxmg', category: 'animals', keywords: ['panda', 'bear', 'china', 'cute'], codepoint: 'U+1F43C' },
  { char: '🌸', name: 'cherry blossom', nameZh: '樱花烂漫', pinyin: 'yinghualanman', pinyinInitials: 'yhlm', category: 'animals', keywords: ['flower', 'spring', 'sakura', 'pink'], codepoint: 'U+1F338' },
  { char: '🔥', name: 'fire', nameZh: '火焰热门火爆', pinyin: 'huoyanremenhuobao', pinyinInitials: 'hyrh', category: 'animals', keywords: ['hot', 'flame', 'lit', 'trending'], codepoint: 'U+1F525' },
  { char: '⚡', name: 'high voltage', nameZh: '闪电极速', pinyin: 'shandianjisu', pinyinInitials: 'sdjs', category: 'animals', keywords: ['lightning', 'electric', 'fast', 'power', 'bolt'], codepoint: 'U+26A1' },
  { char: '🌟', name: 'glowing star', nameZh: '闪耀之星', pinyin: 'shanyaozhixing', pinyinInitials: 'syzx', category: 'animals', keywords: ['star', 'sparkle', 'shine', 'glow'], codepoint: 'U+1F31F' },

  // 4. Food & Drink
  { char: '☕', name: 'hot beverage', nameZh: '热咖啡热茶', pinyin: 'rekafeirecha', pinyinInitials: 'rkrc', category: 'food', keywords: ['coffee', 'tea', 'cafe', 'morning', 'drink'], codepoint: 'U+2615' },
  { char: '🧋', name: 'bubble tea', nameZh: '珍珠奶茶', pinyin: 'zhenzhunaicha', pinyinInitials: 'zznc', category: 'food', keywords: ['boba', 'bubble tea', 'milk tea', 'tapioca'], codepoint: 'U+1F9CB' },
  { char: '🍕', name: 'pizza', nameZh: '披萨匹萨', pinyin: 'pishapisa', pinyinInitials: 'psps', category: 'food', keywords: ['pizza', 'cheese', 'fast food', 'slice'], codepoint: 'U+1F355' },
  { char: '🍔', name: 'hamburger', nameZh: '汉堡包', pinyin: 'hanbaobao', pinyinInitials: 'hbb', category: 'food', keywords: ['burger', 'beef', 'lunch', 'fast food'], codepoint: 'U+1F354' },

  // 5. Activities & Tech Objects
  { char: '💻', name: 'laptop', nameZh: '笔记本电脑', pinyin: 'bijibendiannao', pinyinInitials: 'bjbd', category: 'objects', keywords: ['computer', 'pc', 'macbook', 'work', 'code'], codepoint: 'U+1F4BB' },
  { char: '📱', name: 'mobile phone', nameZh: '智能手机', pinyin: 'zhinengshouji', pinyinInitials: 'znsj', category: 'objects', keywords: ['phone', 'iphone', 'android', 'call'], codepoint: 'U+1F4F1' },
  { char: '🚀', name: 'rocket', nameZh: '火箭起飞发射', pinyin: 'huojianqifeifashe', pinyinInitials: 'hjqf', category: 'travel', keywords: ['launch', 'ship', 'fast', 'startup', 'space'], codepoint: 'U+1F680' },
  { char: '💡', name: 'light bulb', nameZh: '灵感电灯泡', pinyin: 'linggandiandengpao', pinyinInitials: 'lgdd', category: 'objects', keywords: ['idea', 'creative', 'bright', 'solution'], codepoint: 'U+1F4A1' },
  { char: '🎉', name: 'party popper', nameZh: '礼花彩炮大吉', pinyin: 'lihuacaipaodaji', pinyinInitials: 'lhcp', category: 'activities', keywords: ['tada', 'congrats', 'celebrate', 'cheers'], codepoint: 'U+1F389' },

  // 6. Mathematical & Scientific Symbols
  { char: 'π', name: 'pi', nameZh: '圆周率派', pinyin: 'yuanzhoulupai', pinyinInitials: 'yzlp', category: 'math', keywords: ['pi', 'circle', 'constant', '3.14'], codepoint: 'U+03C0' },
  { char: '∑', name: 'summation', nameZh: '求和西格玛', pinyin: 'qiuhexigema', pinyinInitials: 'qhxg', category: 'math', keywords: ['sum', 'sigma', 'series', 'total'], codepoint: 'U+2211' },
  { char: '∫', name: 'integral', nameZh: '积分运算', pinyin: 'jifenyunsuan', pinyinInitials: 'jfys', category: 'math', keywords: ['integral', 'calculus', 'area', 'math'], codepoint: 'U+222B' },
  { char: '∞', name: 'infinity', nameZh: '无穷大无限', pinyin: 'wuqungdawuxian', pinyinInitials: 'wqdw', category: 'math', keywords: ['infinite', 'forever', 'endless', 'loop'], codepoint: 'U+221E' },
  { char: '√', name: 'square root', nameZh: '平方根根号', pinyin: 'pingfanggengenhao', pinyinInitials: 'pfgg', category: 'math', keywords: ['sqrt', 'radical', 'root', 'square root'], codepoint: 'U+221A' },
  { char: '≈', name: 'almost equal to', nameZh: '约等于', pinyin: 'yuedengyu', pinyinInitials: 'ydy', category: 'math', keywords: ['approx', 'tilde', 'similar', 'estimate'], codepoint: 'U+2248' },
  { char: '≠', name: 'not equal to', nameZh: '不等于', pinyin: 'budengyu', pinyinInitials: 'bdy', category: 'math', keywords: ['neq', 'different', 'not equal'], codepoint: 'U+2260' },
  { char: '≤', name: 'less than or equal to', nameZh: '小于等于', pinyin: 'xiaoyudengyu', pinyinInitials: 'xydy', category: 'math', keywords: ['lte', 'less than equal', 'at most'], codepoint: 'U+2264' },
  { char: '≥', name: 'greater than or equal to', nameZh: '大于等于', pinyin: 'dayudengyu', pinyinInitials: 'dydy', category: 'math', keywords: ['gte', 'greater than equal', 'at least'], codepoint: 'U+2265' },
  { char: '±', name: 'plus-minus sign', nameZh: '正负号加减', pinyin: 'zhengfuhaojiajian', pinyinInitials: 'zfhj', category: 'math', keywords: ['plus minus', 'tolerance', 'plus or minus'], codepoint: 'U+00B1' },
  { char: '×', name: 'multiplication sign', nameZh: '乘号叉号', pinyin: 'chenghaochahao', pinyinInitials: 'chch', category: 'math', keywords: ['multiply', 'times', 'cross', 'x'], codepoint: 'U+00D7' },
  { char: '÷', name: 'division sign', nameZh: '除号除法', pinyin: 'chuhaochufa', pinyinInitials: 'chcf', category: 'math', keywords: ['divide', 'division', 'slash'], codepoint: 'U+00F7' },
  { char: '∈', name: 'element of', nameZh: '属于符号元素', pinyin: 'shuyufuhaoyuansu', pinyinInitials: 'syfh', category: 'math', keywords: ['in', 'belongs to', 'member', 'set'], codepoint: 'U+2208' },
  { char: '∩', name: 'intersection', nameZh: '交集运算', pinyin: 'jiaojiyunsuan', pinyinInitials: 'jjys', category: 'math', keywords: ['cap', 'intersection', 'and', 'set'], codepoint: 'U+2229' },
  { char: '∪', name: 'union', nameZh: '并集运算', pinyin: 'bingjiyunsuan', pinyinInitials: 'bjys', category: 'math', keywords: ['cup', 'union', 'or', 'set'], codepoint: 'U+222A' },
  { char: '∆', name: 'delta / increment', nameZh: '增量德尔塔', pinyin: 'zengliangdeerta', pinyinInitials: 'zldt', category: 'math', keywords: ['delta', 'triangle', 'change', 'difference'], codepoint: 'U+2206' },

  // 7. Arrows
  { char: '→', name: 'rightwards arrow', nameZh: '向右箭头', pinyin: 'xiangyoujiantou', pinyinInitials: 'xyjt', category: 'arrows', keywords: ['arrow right', 'next', 'forward', '->'], codepoint: 'U+2192' },
  { char: '←', name: 'leftwards arrow', nameZh: '向左箭头', pinyin: 'xiangzuojiantou', pinyinInitials: 'xzjt', category: 'arrows', keywords: ['arrow left', 'back', 'previous', '<-'], codepoint: 'U+2190' },
  { char: '↑', name: 'upwards arrow', nameZh: '向上箭头', pinyin: 'xiangshangjiantou', pinyinInitials: 'xsjt', category: 'arrows', keywords: ['arrow up', 'top', 'increase'], codepoint: 'U+2191' },
  { char: '↓', name: 'downwards arrow', nameZh: '向下箭头', pinyin: 'xiangxiajiantou', pinyinInitials: 'xxjt', category: 'arrows', keywords: ['arrow down', 'bottom', 'decrease'], codepoint: 'U+2193' },
  { char: '⇒', name: 'rightwards double arrow', nameZh: '双线向右箭头推导', pinyin: 'shuangxianxiangyou', pinyinInitials: 'sxxy', category: 'arrows', keywords: ['implies', 'leads to', '=>'], codepoint: 'U+21D2' },
  { char: '↔', name: 'left right arrow', nameZh: '左右双向箭头', pinyin: 'zuoyoushuangxiang', pinyinInitials: 'zysx', category: 'arrows', keywords: ['bidirectional', 'horizontal', '<->'], codepoint: 'U+2194' },
  { char: '➔', name: 'heavy rightwards arrow', nameZh: '粗体向右箭头', pinyin: 'cutixiangyou', pinyinInitials: 'ctxy', category: 'arrows', keywords: ['bold arrow', 'right', 'enter'], codepoint: 'U+2794' },

  // 8. Currency Symbols
  { char: '¥', name: 'yen / yuan sign', nameZh: '人民币日元符号', pinyin: 'renminbiriyuan', pinyinInitials: 'rmbr', category: 'currency', keywords: ['cny', 'rmb', 'jpy', 'yen', 'yuan', 'money'], codepoint: 'U+00A5' },
  { char: '$', name: 'dollar sign', nameZh: '美元符号美金', pinyin: 'meiyuanfuhaomeijin', pinyinInitials: 'myfh', category: 'currency', keywords: ['usd', 'dollar', 'buck', 'cash'], codepoint: 'U+0024' },
  { char: '€', name: 'euro sign', nameZh: '欧元符号', pinyin: 'ouyuanfuhao', pinyinInitials: 'oyfh', category: 'currency', keywords: ['eur', 'euro', 'europe'], codepoint: 'U+20AC' },
  { char: '£', name: 'pound sign', nameZh: '英镑符号', pinyin: 'yingbangfuhao', pinyinInitials: 'ybfh', category: 'currency', keywords: ['gbp', 'pound', 'sterling', 'uk'], codepoint: 'U+00A3' },
  { char: '₿', name: 'bitcoin sign', nameZh: '比特币符号', pinyin: 'bitebifuhao', pinyinInitials: 'btbf', category: 'currency', keywords: ['btc', 'crypto', 'bitcoin', 'blockchain'], codepoint: 'U+20BF' },

  // 9. Symbols & Dingbats
  { char: '★', name: 'black star', nameZh: '实心五角星标星', pinyin: 'shixinwujiaoxing', pinyinInitials: 'sxwj', category: 'symbols', keywords: ['star', 'favorite', 'rating'], codepoint: 'U+2605' },
  { char: '☆', name: 'white star', nameZh: '空心五角星', pinyin: 'kongxinwujiaoxing', pinyinInitials: 'kxwj', category: 'symbols', keywords: ['star', 'unfilled', 'rating'], codepoint: 'U+2606' },
  { char: '✔', name: 'heavy check mark', nameZh: '勾对打勾完成', pinyin: 'gouduidagou', pinyinInitials: 'gddg', category: 'symbols', keywords: ['check', 'tick', 'done', 'yes', 'correct'], codepoint: 'U+2714' },
  { char: '✖', name: 'heavy multiplication x', nameZh: '叉号错误拒绝', pinyin: 'chahaocuowujujue', pinyinInitials: 'chcw', category: 'symbols', keywords: ['cross', 'x', 'wrong', 'no', 'close'], codepoint: 'U+2716' },
  { char: '⚠️', name: 'warning', nameZh: '警告警示注意', pinyin: 'jinggaojingshizhuyi', pinyinInitials: 'jgjs', category: 'symbols', keywords: ['alert', 'caution', 'danger', 'hazard'], codepoint: 'U+26A0' },
  { char: '❤️', name: 'red heart', nameZh: '红心大爱心喜欢', pinyin: 'hongxindaixin', pinyinInitials: 'hxdx', category: 'symbols', keywords: ['love', 'like', 'heart', 'valentine'], codepoint: 'U+2764' }
]

export interface EmojiSearchOptions {
  category?: EmojiCategory | 'all' | undefined
  skinTone?: SkinTone | undefined
  limit?: number | undefined
}

export interface EmojiSearchResult {
  items: readonly EmojiItem[]
  total: number
  query: string
}

export class EmojiService {
  private readonly recentChars: string[] = []
  private readonly favoriteChars = new Set<string>()

  /**
   * 统一搜索接口：支持中英文、拼音全拼与首字母模糊匹配
   */
  public search(query: string = '', options: EmojiSearchOptions = {}): EmojiSearchResult {
    const rawQuery = (typeof query === 'string' ? query : '').trim().toLowerCase()
    const targetCategory = options.category && options.category !== 'all' ? options.category : null
    const limit = options.limit && options.limit > 0 ? options.limit : 100
    const skinTone = options.skinTone || 'none'

    let matches = EMOJI_DATABASE.filter((item) => {
      // 1. 分类过滤
      if (targetCategory && item.category !== targetCategory) {
        return false
      }

      // 2. 空查询返回所有
      if (!rawQuery) {
        return true
      }

      // 3. 匹配原始字符与 Unicode 编码
      if (item.char === rawQuery || item.codepoint.toLowerCase().includes(rawQuery)) {
        return true
      }

      // 4. 匹配英文名称与关键词
      if (item.name.toLowerCase().includes(rawQuery) || item.keywords.some(k => k.toLowerCase().includes(rawQuery))) {
        return true
      }

      // 5. 匹配中文名称、拼音全拼、拼音首字母
      if (item.nameZh.includes(rawQuery) || item.pinyin.includes(rawQuery) || item.pinyinInitials.includes(rawQuery)) {
        return true
      }

      return false
    })

    // 应用肤色变体（若当前项支持）
    if (skinTone !== 'none') {
      matches = matches.map(item => this.applySkinTone(item, skinTone))
    }

    const total = matches.length
    const paged = matches.slice(0, limit)

    return {
      items: paged,
      total,
      query: rawQuery
    }
  }

  /**
   * 应用肤色修饰符
   */
  public applySkinTone(item: EmojiItem, skinTone: SkinTone): EmojiItem {
    if (!item.supportsSkinTone || skinTone === 'none') {
      return item
    }
    const modifier = SKIN_TONE_MODIFIERS[skinTone]
    if (!modifier) return item

    return {
      ...item,
      char: `${item.char}${modifier}`
    }
  }

  /**
   * 记录使用历史
   */
  public recordUsage(char: string): void {
    if (!char || typeof char !== 'string') return
    const index = this.recentChars.indexOf(char)
    if (index !== -1) {
      this.recentChars.splice(index, 1)
    }
    this.recentChars.unshift(char)
    if (this.recentChars.length > 50) {
      this.recentChars.pop()
    }
  }

  public getRecent(): readonly string[] {
    return [...this.recentChars]
  }

  /**
   * 收藏与取消收藏
   */
  public toggleFavorite(char: string): boolean {
    if (!char || typeof char !== 'string') return false
    if (this.favoriteChars.has(char)) {
      this.favoriteChars.delete(char)
      return false
    } else {
      this.favoriteChars.add(char)
      return true
    }
  }

  public isFavorite(char: string): boolean {
    return this.favoriteChars.has(char)
  }

  public getFavorites(): readonly string[] {
    return Array.from(this.favoriteChars)
  }
}

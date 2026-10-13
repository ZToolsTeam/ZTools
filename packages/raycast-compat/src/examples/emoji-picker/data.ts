import { EmojiCategory, CategoryInfo, EmojiItem } from "./types.js";

export const CATEGORIES: readonly CategoryInfo[] = [
  { id: "smileys", labelZh: "表情与情感", labelEn: "Smileys & Emotion", icon: "emoji" },
  { id: "people", labelZh: "人物与手势", labelEn: "People & Body", icon: "person" },
  { id: "nature", labelZh: "动物与自然", labelEn: "Animals & Nature", icon: "bird" },
  { id: "food", labelZh: "食物与饮品", labelEn: "Food & Drink", icon: "mug" },
  { id: "travel", labelZh: "旅游与地点", labelEn: "Travel & Places", icon: "airplane" },
  { id: "activities", labelZh: "活动与娱乐", labelEn: "Activities", icon: "game-controller" },
  { id: "objects", labelZh: "物件与工具", labelEn: "Objects", icon: "light-bulb" },
  { id: "symbols", labelZh: "符号与标点", labelEn: "Symbols", icon: "hashtag" },
  { id: "flags", labelZh: "旗帜", labelEn: "Flags", icon: "flag" }
];

export function getUnicodeHex(char: string): string {
  if (!char) return "";
  return Array.from(char)
    .map(c => "U+" + (c.codePointAt(0) || 0).toString(16).toUpperCase().padStart(4, "0"))
    .join(" ");
}

export function getHtmlEntity(char: string, hex = true): string {
  if (!char) return "";
  return Array.from(char)
    .map(c => {
      const code = c.codePointAt(0) || 0;
      return hex ? `&#x${code.toString(16).toUpperCase()};` : `&#${code};`;
    })
    .join("");
}

export function getCategoryLabel(category: EmojiCategory): string {
  const cat = CATEGORIES.find(c => c.id === category);
  return cat ? `${cat.labelZh} (${cat.labelEn})` : category;
}

export const EMOJI_DATABASE: readonly EmojiItem[] = [
  // 1. Smileys & Emotion (表情与情感)
  {
    char: "😀",
    name: "grinning face",
    nameZh: "开怀大笑",
    category: "smileys",
    keywords: ["xiao", "daxiao", "kaixin", "kuaile", "grin", "smile", "happy"]
  },
  {
    char: "😃",
    name: "grinning face with big eyes",
    nameZh: "大眼微笑",
    category: "smileys",
    keywords: ["xiao", "dayan", "kaixin", "smile", "big eyes", "joy"]
  },
  {
    char: "😄",
    name: "grinning face with smiling eyes",
    nameZh: "眯眼微笑",
    category: "smileys",
    keywords: ["xiao", "miyan", "kaixin", "weixiao", "grin", "laugh", "happy"]
  },
  {
    char: "😁",
    name: "beaming face with smiling eyes",
    nameZh: "露齿而笑",
    category: "smileys",
    keywords: ["xiao", "luchi", "xixi", "grin", "teeth", "excited"]
  },
  {
    char: "😆",
    name: "grinning squinting face",
    nameZh: "合眼狂笑",
    category: "smileys",
    keywords: ["xiao", "kuangxiao", "haoxiao", "laugh", "satisfied"]
  },
  {
    char: "😅",
    name: "grinning face with sweat",
    nameZh: "汗颜微笑",
    category: "smileys",
    keywords: ["hanyan", "liuhan", "ganxiao", "cold sweat", "relief", "nervous"]
  },
  {
    char: "🤣",
    name: "rolling on the floor laughing",
    nameZh: "笑得打滚",
    category: "smileys",
    keywords: ["xiao", "dagun", "baoxiao", "rofl", "lol", "laughing"]
  },
  {
    char: "😂",
    name: "face with tears of joy",
    nameZh: "喜极而泣",
    category: "smileys",
    keywords: ["xiao", "kulian", "xijierqi", "tears of joy", "cry laugh", "lol"]
  },
  {
    char: "🙂",
    name: "slightly smiling face",
    nameZh: "微笑",
    category: "smileys",
    keywords: ["xiao", "weixiao", "yukuai", "smile", "content"]
  },
  {
    char: "🙃",
    name: "upside-down face",
    nameZh: "倒脸讽刺",
    category: "smileys",
    keywords: ["daolian", "fengci", "wunai", "sarcasm", "irony", "silly"]
  },
  {
    char: "😉",
    name: "winking face",
    nameZh: "眨眼放电",
    category: "smileys",
    keywords: ["zhayan", "fangdian", "wink", "flirt"]
  },
  {
    char: "😊",
    name: "smiling face with smiling eyes",
    nameZh: "害羞微笑",
    category: "smileys",
    keywords: ["xiao", "haixiu", "weixiao", "blush", "warm", "friendly"]
  },
  {
    char: "😇",
    name: "smiling face with halo",
    nameZh: "天使光环",
    category: "smileys",
    keywords: ["tianshi", "guanghuan", "shanliang", "angel", "innocent", "halo"]
  },
  {
    char: "🥰",
    name: "smiling face with hearts",
    nameZh: "爱心环绕",
    category: "smileys",
    keywords: ["aixin", "xihuan", "tianmi", "love", "adore", "crush"]
  },
  {
    char: "😍",
    name: "smiling face with heart-eyes",
    nameZh: "色眯眯爱心眼",
    category: "smileys",
    keywords: ["aixin", "se", "huachi", "heart eyes", "love", "infatuation"]
  },
  {
    char: "🤩",
    name: "star-struck",
    nameZh: "眼冒金星崇拜",
    category: "smileys",
    keywords: ["chongbai", "jinxing", "star struck", "excited", "wow"]
  },
  {
    char: "😘",
    name: "face blowing a kiss",
    nameZh: "飞吻",
    category: "smileys",
    keywords: ["feiwen", "qinqin", "kiss", "love"]
  },
  {
    char: "🤔",
    name: "thinking face",
    nameZh: "托腮沉思",
    category: "smileys",
    keywords: ["siwei", "sikao", "chensi", "yiwen", "think", "wonder", "hmm"]
  },
  {
    char: "🤐",
    name: "zipper-mouth face",
    nameZh: "闭嘴拉链",
    category: "smileys",
    keywords: ["bizui", "baomi", "zipper", "secret", "silent"]
  },
  {
    char: "🤨",
    name: "face with raised eyebrow",
    nameZh: "挑眉怀疑",
    category: "smileys",
    keywords: ["tiaomei", "huaiyi", "distrust", "skeptical"]
  },
  {
    char: "😐",
    name: "neutral face",
    nameZh: "冷漠无表情",
    category: "smileys",
    keywords: ["lengmo", "wubiaoqing", "neutral", "meh"]
  },
  {
    char: "😏",
    name: "smirking face",
    nameZh: "得意坏笑",
    category: "smileys",
    keywords: ["huaixiao", "deyi", "smirk", "flirt", "clever"]
  },
  {
    char: "😒",
    name: "unamused face",
    nameZh: "不悦鄙视",
    category: "smileys",
    keywords: ["buyue", "bishi", "wunai", "unamused", "bored"]
  },
  {
    char: "🙄",
    name: "face with rolling eyes",
    nameZh: "翻白眼",
    category: "smileys",
    keywords: ["fanbaiyan", "wunai", "roll eyes", "annoyed"]
  },
  {
    char: "😴",
    name: "sleeping face",
    nameZh: "睡觉打鼾",
    category: "smileys",
    keywords: ["shuijiao", "kun", "dahan", "sleep", "zzz", "tired"]
  },
  {
    char: "😷",
    name: "face with medical mask",
    nameZh: "戴口罩",
    category: "smileys",
    keywords: ["kouzhao", "bing", "yisheng", "mask", "sick", "virus"]
  },
  {
    char: "🥵",
    name: "hot face",
    nameZh: "燥热发红",
    category: "smileys",
    keywords: ["re", "honglian", "fashao", "hot", "heat"]
  },
  {
    char: "🥶",
    name: "cold face",
    nameZh: "冻僵发蓝",
    category: "smileys",
    keywords: ["leng", "dong", "bing", "cold", "freezing"]
  },
  {
    char: "🤯",
    name: "exploding head",
    nameZh: "脑洞大开震撼",
    category: "smileys",
    keywords: ["zha", "naodong", "zhenhan", "mind blown", "shocked"]
  },
  {
    char: "😎",
    name: "smiling face with sunglasses",
    nameZh: "墨镜酷哥",
    category: "smileys",
    keywords: ["ku", "mojing", "shuai", "cool", "sunglasses"]
  },
  {
    char: "🥺",
    name: "pleading face",
    nameZh: "楚楚可怜祈求",
    category: "smileys",
    keywords: ["kelian", "qiqiu", "baiying", "pleading", "puppy eyes"]
  },
  {
    char: "😭",
    name: "loudly crying face",
    nameZh: "放声大哭",
    category: "smileys",
    keywords: ["ku", "tongku", "daku", "cry", "sob", "sad"]
  },
  {
    char: "😱",
    name: "face screaming in fear",
    nameZh: "惊恐尖叫",
    category: "smileys",
    keywords: ["jianjiao", "jingpa", "haipa", "scream", "scared", "fear"]
  },
  {
    char: "😡",
    name: "enraged face",
    nameZh: "狂怒发火",
    category: "smileys",
    keywords: ["fennu", "shengqi", "fahuo", "angry", "rage", "mad"]
  },
  {
    char: "🤡",
    name: "clown face",
    nameZh: "小丑",
    category: "smileys",
    keywords: ["xiaochou", "clown", "circus", "fool"]
  },

  // 2. People & Body (人物与手势)
  {
    char: "👍",
    name: "thumbs up",
    nameZh: "点赞赞许",
    category: "people",
    keywords: ["zan", "dianzan", "hao", "qiang", "thumbs up", "like", "approve"]
  },
  {
    char: "👎",
    name: "thumbs down",
    nameZh: "点踩反对",
    category: "people",
    keywords: ["cai", "fandui", "buxing", "thumbs down", "dislike"]
  },
  {
    char: "👏",
    name: "clapping hands",
    nameZh: "鼓掌喝彩",
    category: "people",
    keywords: ["guzhang", "hecai", "clap", "applause", "bravo"]
  },
  {
    char: "🙌",
    name: "raising hands",
    nameZh: "举双手庆祝",
    category: "people",
    keywords: ["jushou", "qingzhu", "celebrate", "hooray", "hands"]
  },
  {
    char: "🤝",
    name: "handshake",
    nameZh: "握手合作",
    category: "people",
    keywords: ["woshou", "hezuo", "xieyi", "handshake", "deal", "partner"]
  },
  {
    char: "🙏",
    name: "folded hands",
    nameZh: "双手合十祈祷",
    category: "people",
    keywords: ["qidao", "ganxie", "tuobi", "baitu", "pray", "thanks", "please"]
  },
  {
    char: "✌️",
    name: "victory hand",
    nameZh: "胜利手势耶",
    category: "people",
    keywords: ["shengli", "ye", "v", "peace", "victory", "two"]
  },
  {
    char: "🤞",
    name: "crossed fingers",
    nameZh: "祝好运手指交叉",
    category: "people",
    keywords: ["haoyun", "qifu", "luck", "cross fingers"]
  },
  {
    char: "👋",
    name: "waving hand",
    nameZh: "挥手打招呼",
    category: "people",
    keywords: ["huishou", "zaijian", "nihao", "wave", "hello", "bye"]
  },
  {
    char: "💪",
    name: "flexed biceps",
    nameZh: "肌肉加油力气",
    category: "people",
    keywords: ["jiayou", "jirou", "liliang", "muscle", "flex", "strong"]
  },
  {
    char: "👊",
    name: "oncoming fist",
    nameZh: "出拳碰撞",
    category: "people",
    keywords: ["quantou", "dianzan", "fist", "punch", "bump"]
  },
  {
    char: "👌",
    name: "OK hand",
    nameZh: "OK妥了",
    category: "people",
    keywords: ["ok", "tuole", "meiwenti", "fine", "perfect"]
  },
  {
    char: "👀",
    name: "eyes",
    nameZh: "双眼关注",
    category: "people",
    keywords: ["yanjing", "kan", "guanzhu", "eyes", "look", "see", "watch"]
  },
  {
    char: "🧑‍💻",
    name: "technologist",
    nameZh: "程序员攻城狮",
    category: "people",
    keywords: ["chengxuyuan", "kaifa", "diannao", "developer", "coder", "programmer"]
  },

  // 3. Animals & Nature (动物与自然)
  {
    char: "🐶",
    name: "dog face",
    nameZh: "小狗修勾",
    category: "nature",
    keywords: ["gou", "xiaogou", "wangcai", "dog", "puppy", "pet"]
  },
  {
    char: "🐱",
    name: "cat face",
    nameZh: "小猫喵喵",
    category: "nature",
    keywords: ["mao", "xiaomao", "miaomiao", "cat", "kitty", "kitten"]
  },
  {
    char: "🐼",
    name: "panda",
    nameZh: "大熊猫国宝",
    category: "nature",
    keywords: ["xiongmao", "guobao", "panda", "bear"]
  },
  {
    char: "🦊",
    name: "fox",
    nameZh: "狐狸敏捷",
    category: "nature",
    keywords: ["huli", "fox", "clever"]
  },
  {
    char: "🦁",
    name: "lion",
    nameZh: "狮子百兽之王",
    category: "nature",
    keywords: ["shizi", "lion", "king"]
  },
  {
    char: "🐯",
    name: "tiger face",
    nameZh: "老虎猛虎",
    category: "nature",
    keywords: ["laohu", "tiger", "brave"]
  },
  {
    char: "🐰",
    name: "rabbit face",
    nameZh: "兔子乖巧",
    category: "nature",
    keywords: ["tuzi", "rabbit", "bunny"]
  },
  {
    char: "🐵",
    name: "monkey face",
    nameZh: "猴子灵动",
    category: "nature",
    keywords: ["houzi", "monkey", "ape"]
  },
  {
    char: "🐧",
    name: "penguin",
    nameZh: "企鹅呆萌",
    category: "nature",
    keywords: ["qie", "qq", "penguin", "bird"]
  },
  {
    char: "🌲",
    name: "evergreen tree",
    nameZh: "松树常青",
    category: "nature",
    keywords: ["shu", "songshu", "senlin", "tree", "forest", "pine"]
  },
  {
    char: "🌸",
    name: "cherry blossom",
    nameZh: "樱花绽放",
    category: "nature",
    keywords: ["yinghua", "xianhua", "flower", "blossom", "spring"]
  },
  {
    char: "🍀",
    name: "four leaf clover",
    nameZh: "四叶草幸运",
    category: "nature",
    keywords: ["siyecao", "xingyun", "clover", "lucky", "green"]
  },

  // 4. Food & Drink (食物与饮品)
  {
    char: "🍎",
    name: "red apple",
    nameZh: "红苹果平安",
    category: "food",
    keywords: ["pingguo", "shuiguo", "apple", "fruit", "red"]
  },
  {
    char: "🍌",
    name: "banana",
    nameZh: "香蕉",
    category: "food",
    keywords: ["xiangjiao", "shuiguo", "banana", "fruit"]
  },
  {
    char: "🍉",
    name: "watermelon",
    nameZh: "西瓜吃瓜",
    category: "food",
    keywords: ["xigua", "chigua", "summer", "watermelon", "fruit"]
  },
  {
    char: "🍔",
    name: "hamburger",
    nameZh: "汉堡包",
    category: "food",
    keywords: ["hanbao", "kuaican", "burger", "hamburger", "fast food"]
  },
  {
    char: "🍟",
    name: "french fries",
    nameZh: "薯条",
    category: "food",
    keywords: ["shutiao", "kuaican", "fries", "potato"]
  },
  {
    char: "🍕",
    name: "pizza",
    nameZh: "披萨饼",
    category: "food",
    keywords: ["pisa", "pizza", "cheese"]
  },
  {
    char: "🍜",
    name: "steaming bowl",
    nameZh: "热气腾腾拉面",
    category: "food",
    keywords: ["mian", "lamian", "ramen", "noodles", "soup"]
  },
  {
    char: "🍣",
    name: "sushi",
    nameZh: "寿司日本料理",
    category: "food",
    keywords: ["shousi", "sushi", "japanese"]
  },
  {
    char: "☕",
    name: "hot beverage",
    nameZh: "热咖啡醒脑",
    category: "food",
    keywords: ["kafei", "kafeidou", "coffee", "tea", "drink"]
  },
  {
    char: "🧋",
    name: "bubble tea",
    nameZh: "珍珠奶茶快乐水",
    category: "food",
    keywords: ["naicha", "boba", "bubble tea", "milk tea"]
  },
  {
    char: "🍺",
    name: "beer mug",
    nameZh: "啤酒干杯",
    category: "food",
    keywords: ["pijiu", "ganbei", "beer", "drink", "pub"]
  },

  // 5. Travel & Places (旅游与地点)
  {
    char: "🚀",
    name: "rocket",
    nameZh: "火箭极速起飞",
    category: "travel",
    keywords: ["huojian", "qifei", "jisu", "rocket", "launch", "fast", "space"]
  },
  {
    char: "✈️",
    name: "airplane",
    nameZh: "飞机出行",
    category: "travel",
    keywords: ["feiji", "chuxing", "lvyou", "airplane", "flight", "travel"]
  },
  {
    char: "🚗",
    name: "automobile",
    nameZh: "小汽车自驾",
    category: "travel",
    keywords: ["qiche", "xiaoche", "car", "drive"]
  },
  {
    char: "🚅",
    name: "bullet train",
    nameZh: "高铁动车",
    category: "travel",
    keywords: ["gaotie", "dongche", "huoche", "bullet train", "rail"]
  },
  {
    char: "🚲",
    name: "bicycle",
    nameZh: "自行车低碳",
    category: "travel",
    keywords: ["zixingche", "danche", "bike", "bicycle"]
  },
  {
    char: "🏕️",
    name: "camping",
    nameZh: "野营帐篷",
    category: "travel",
    keywords: ["luying", "zhangpeng", "camping", "tent", "outdoors"]
  },
  {
    char: "🏖️",
    name: "beach with umbrella",
    nameZh: "沙滩度假",
    category: "travel",
    keywords: ["shatan", "dujia", "beach", "vacation"]
  },

  // 6. Activities (活动与娱乐)
  {
    char: "⚽",
    name: "soccer ball",
    nameZh: "足球绿茵",
    category: "activities",
    keywords: ["zuqiu", "tiqiu", "soccer", "football", "ball"]
  },
  {
    char: "🏀",
    name: "basketball",
    nameZh: "篮球",
    category: "activities",
    keywords: ["lanqiu", "basketball", "nba", "ball"]
  },
  {
    char: "🎮",
    name: "video game",
    nameZh: "游戏手柄掌机",
    category: "activities",
    keywords: ["youxi", "shoubing", "game", "gaming", "controller"]
  },
  {
    char: "🎉",
    name: "party popper",
    nameZh: "拉炮派对庆祝",
    category: "activities",
    keywords: ["qingzhu", "paidui", "lapao", "party", "celebration", "tada"]
  },
  {
    char: "🎨",
    name: "artist palette",
    nameZh: "调色板美术艺术",
    category: "activities",
    keywords: ["diaoseban", "yishu", "huihua", "art", "palette", "painting"]
  },
  {
    char: "🎵",
    name: "musical note",
    nameZh: "音符旋律",
    category: "activities",
    keywords: ["yinfu", "yinyue", "music", "song", "note"]
  },

  // 7. Objects (物件与工具)
  {
    char: "💻",
    name: "laptop",
    nameZh: "笔记本电脑计算机",
    category: "objects",
    keywords: ["diannao", "jisuanji", "bijiben", "mac", "pc", "laptop", "computer"]
  },
  {
    char: "📱",
    name: "mobile phone",
    nameZh: "智能手机",
    category: "objects",
    keywords: ["shouji", "dianhua", "iphone", "phone", "mobile"]
  },
  {
    char: "💡",
    name: "light bulb",
    nameZh: "灯泡灵感创意",
    category: "objects",
    keywords: ["dengpao", "linggan", "chuangyi", "light", "idea", "bulb"]
  },
  {
    char: "🔍",
    name: "magnifying glass tilted left",
    nameZh: "放大镜搜索检索",
    category: "objects",
    keywords: ["fangdajing", "sousuo", "jiansuo", "search", "find", "magnifier"]
  },
  {
    char: "📦",
    name: "package",
    nameZh: "包裹快递打包",
    category: "objects",
    keywords: ["kuaidi", "baoguo", "dabao", "package", "box", "shipping"]
  },
  {
    char: "🔑",
    name: "key",
    nameZh: "钥匙密码解密",
    category: "objects",
    keywords: ["yaoshi", "mima", "key", "password", "unlock"]
  },
  {
    char: "🔒",
    name: "locked",
    nameZh: "上锁安全加锁",
    category: "objects",
    keywords: ["suo", "anquan", "lock", "secure", "privacy"]
  },
  {
    char: "⚙️",
    name: "gear",
    nameZh: "齿轮系统设置",
    category: "objects",
    keywords: ["chilun", "shezhi", "peizhi", "gear", "settings", "config"]
  },
  {
    char: "🛠️",
    name: "hammer and wrench",
    nameZh: "工具箱维护修理",
    category: "objects",
    keywords: ["gongju", "weihu", "xiuli", "tools", "repair", "build"]
  },

  // 8. Symbols (符号与标点)
  {
    char: "❤️",
    name: "red heart",
    nameZh: "红心爱心喜欢",
    category: "symbols",
    keywords: ["aixin", "hongxin", "xihuan", "love", "heart", "favorite"]
  },
  {
    char: "🔥",
    name: "fire",
    nameZh: "火焰热门爆款",
    category: "symbols",
    keywords: ["huo", "huoyan", "remeng", "fire", "hot", "trending"]
  },
  {
    char: "⚡",
    name: "high voltage",
    nameZh: "高压闪电极速",
    category: "symbols",
    keywords: ["shandian", "jisu", "gaoya", "lightning", "fast", "electric"]
  },
  {
    char: "✅",
    name: "check mark button",
    nameZh: "绿色对勾完成确认",
    category: "symbols",
    keywords: ["duigou", "wancheng", "queren", "check", "done", "success"]
  },
  {
    char: "❌",
    name: "cross mark",
    nameZh: "叉号错误失败",
    category: "symbols",
    keywords: ["chahao", "cuowu", "shibai", "cross", "fail", "error"]
  },
  {
    char: "⚠️",
    name: "warning",
    nameZh: "警告提示注意",
    category: "symbols",
    keywords: ["jinggao", "zhuyi", "tishi", "warning", "caution", "alert"]
  },
  {
    char: "⭐",
    name: "star",
    nameZh: "星星收藏评分",
    category: "symbols",
    keywords: ["xingxing", "shoucang", "pingfen", "star", "fav", "favorite"]
  },
  {
    char: "✨",
    name: "sparkles",
    nameZh: "闪亮AI智能亮晶晶",
    category: "symbols",
    keywords: ["shanliang", "ai", "zhineng", "sparkles", "magic", "clean"]
  },

  // 9. Flags (旗帜)
  {
    char: "🇨🇳",
    name: "flag: China",
    nameZh: "中国国旗五星红旗",
    category: "flags",
    keywords: ["zhongguo", "guoqi", "wuxinghongqi", "china", "cn", "flag"]
  },
  {
    char: "🇺🇸",
    name: "flag: United States",
    nameZh: "美国国旗星条旗",
    category: "flags",
    keywords: ["meiguo", "guoqi", "xingtiaoqi", "usa", "us", "america", "flag"]
  },
  {
    char: "🇬🇧",
    name: "flag: United Kingdom",
    nameZh: "英国国旗米字旗",
    category: "flags",
    keywords: ["yingguo", "guoqi", "uk", "britain", "flag"]
  },
  {
    char: "🇯🇵",
    name: "flag: Japan",
    nameZh: "日本国旗",
    category: "flags",
    keywords: ["riben", "guoqi", "japan", "jp", "flag"]
  },
  {
    char: "🇩🇪",
    name: "flag: Germany",
    nameZh: "德国国旗",
    category: "flags",
    keywords: ["deguo", "guoqi", "germany", "de", "flag"]
  },
  {
    char: "🇫🇷",
    name: "flag: France",
    nameZh: "法国国旗",
    category: "flags",
    keywords: ["faguo", "guoqi", "france", "fr", "flag"]
  },
  {
    char: "🏁",
    name: "chequered flag",
    nameZh: "终点黑白方格旗",
    category: "flags",
    keywords: ["fanggeqi", "zhongdian", "racing", "flag", "finish"]
  }
];

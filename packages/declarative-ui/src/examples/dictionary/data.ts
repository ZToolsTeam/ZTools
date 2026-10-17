/**
 * 权威英汉/英英生词词库与智能检索算法
 * 对标 Raycast Dictionary & macOS Dictionary 官方数据模型
 */

import { DictWordEntry, DictExampleItem } from "./types.js";

export const BUILTIN_DICTIONARY: readonly DictWordEntry[] = Object.freeze([
  {
    word: "architecture",
    phoneticUs: "/ˈɑːrkɪtektʃər/",
    phoneticUk: "/ˈɑːkɪtektʃə/",
    pos: ["n."],
    definitionZh: "架构；体系结构；建筑学",
    definitionEn: "The complex or carefully designed structure of something; the art or practice of designing buildings.",
    definitions: [
      {
        partOfSpeech: "n.",
        definitionZh: "系统架构；软硬件体系结构",
        definitionEn: "The design and structure of a computer system or software framework.",
        synonyms: ["structure", "framework", "design", "organization"],
        antonyms: ["disorganization", "chaos"],
        examples: [
          { en: "ZTools adopts a decoupled host and native sidecar architecture.", zh: "ZTools 采用解耦的宿主与原生侧车架构。" },
          { en: "Microservice architecture provides better horizontal scalability.", zh: "微服务架构提供了更优越的水平扩展能力。" }
        ]
      }
    ],
    synonyms: ["structure", "framework", "composition", "construction"],
    antonyms: ["disorganization", "destruction"],
    examples: [
      { en: "ZTools adopts a decoupled host and native sidecar architecture.", zh: "ZTools 采用解耦的宿主与原生侧车架构。" }
    ],
    tags: ["CS", "CET6", "IELTS", "TECH"],
    frequencyRank: 5
  },
  {
    word: "algorithm",
    phoneticUs: "/ˈælɡərɪðəm/",
    phoneticUk: "/ˈælɡərɪðəm/",
    pos: ["n."],
    definitionZh: "算法；计算程序；解题规则",
    definitionEn: "A process or set of rules to be followed in calculations or other problem-solving operations, especially by a computer.",
    definitions: [
      {
        partOfSpeech: "n.",
        definitionZh: "计算机算法；执行计算的有限指令集",
        definitionEn: "A step-by-step procedure for solving a mathematical or computational problem in a finite number of steps.",
        synonyms: ["procedure", "process", "formula", "recipe", "method"],
        antonyms: ["randomness", "arbitrariness"],
        examples: [
          { en: "A hash table algorithm provides O(1) average lookup time.", zh: "哈希表算法提供 O(1) 的平均查找时间复杂度。" },
          { en: "The ranking algorithm weighs recency and frequency heavily.", zh: "排序算法对最近性和高频度赋予极高权重。" }
        ]
      }
    ],
    synonyms: ["procedure", "method", "formula", "protocol"],
    antonyms: ["randomness"],
    examples: [],
    tags: ["CS", "CET4", "CET6", "IELTS"],
    frequencyRank: 5
  },
  {
    word: "asynchronous",
    phoneticUs: "/eɪˈsɪŋkrənəs/",
    phoneticUk: "/eɪˈsɪŋkrənəs/",
    pos: ["adj."],
    definitionZh: "异步的；不同时的",
    definitionEn: "Not occurring at the same time; computing processes operating independently of the main program flow.",
    definitions: [
      {
        partOfSpeech: "adj.",
        definitionZh: "非阻塞异步调用的",
        definitionEn: "Occurring without a coordinated shared clock; non-blocking execution in computing.",
        synonyms: ["non-blocking", "concurrent", "parallel", "independent"],
        antonyms: ["synchronous", "blocking"],
        examples: [
          { en: "Asynchronous I/O prevents freezing the UI rendering pipeline.", zh: "异步 I/O 可防止冻结 UI 渲染管线。" }
        ]
      }
    ],
    synonyms: ["non-blocking", "independent"],
    antonyms: ["synchronous", "blocking"],
    examples: [],
    tags: ["CS", "CET6", "TECH"],
    frequencyRank: 4
  },
  {
    word: "clipboard",
    phoneticUs: "/ˈklɪpbɔːrd/",
    phoneticUk: "/ˈklɪpbɔːd/",
    pos: ["n."],
    definitionZh: "剪贴板；带夹写字板",
    definitionEn: "A temporary storage area in memory that stores copied or cut items; a small board with a clip at the top for holding papers.",
    definitions: [
      {
        partOfSpeech: "n.",
        definitionZh: "操作系统剪贴板",
        definitionEn: "A system-level storage buffer where text or media is held between copy and paste actions.",
        synonyms: ["pasteboard", "buffer", "scratchpad"],
        examples: [
          { en: "The item was copied to the clipboard with zero latency.", zh: "条目以零延迟复制到了剪贴板。" }
        ]
      }
    ],
    synonyms: ["pasteboard", "buffer"],
    antonyms: [],
    examples: [],
    tags: ["CS", "CET4", "TECH"],
    frequencyRank: 4
  },
  {
    word: "concurrent",
    phoneticUs: "/kənˈkɜːrənt/",
    phoneticUk: "/kənˈkʌrənt/",
    pos: ["adj."],
    definitionZh: "并发的；同时发生的；协作的",
    definitionEn: "Existing, happening, or done at the same time; shared in common.",
    definitions: [
      {
        partOfSpeech: "adj.",
        definitionZh: "并发处理的；多任务并行的",
        definitionEn: "Executing multiple operations during overlapping time periods without necessarily running simultaneously on separate cores.",
        synonyms: ["parallel", "simultaneous", "synchronous", "coexisting"],
        antonyms: ["sequential", "serialized", "consecutive"],
        examples: [
          { en: "The server handles thousands of concurrent connections efficiently.", zh: "服务器高效处理数千个并发连接。" }
        ]
      }
    ],
    synonyms: ["simultaneous", "parallel", "coincident"],
    antonyms: ["sequential", "serial"],
    examples: [],
    tags: ["CS", "CET6", "IELTS"],
    frequencyRank: 4
  },
  {
    word: "declarative",
    phoneticUs: "/dɪˈklærətɪv/",
    phoneticUk: "/dɪˈklærətɪv/",
    pos: ["adj."],
    definitionZh: "声明式的；陈述性的",
    definitionEn: "Denoting high-level programming paradigms that express logic without describing explicit control flow; asserting facts.",
    definitions: [
      {
        partOfSpeech: "adj.",
        definitionZh: "声明式编程范式的",
        definitionEn: "Describing what a program should accomplish rather than how it should operate.",
        synonyms: ["descriptive", "expressive", "functional"],
        antonyms: ["imperative", "procedural"],
        examples: [
          { en: "Declarative UI eliminates manual DOM manipulations and reduces regressions.", zh: "声明式 UI 消除了手动 DOM 操作并大幅降低了回归风险。" }
        ]
      }
    ],
    synonyms: ["descriptive", "assertive"],
    antonyms: ["imperative"],
    examples: [],
    tags: ["CS", "CET6", "TECH"],
    frequencyRank: 4
  },
  {
    word: "dictionary",
    phoneticUs: "/ˈdɪkʃəneri/",
    phoneticUk: "/ˈdɪkʃənri/",
    pos: ["n."],
    definitionZh: "词典；字典；字典映射数据结构",
    definitionEn: "A book or electronic resource listing words and giving their meaning, etymology, and pronunciation; a key-value data structure.",
    definitions: [
      {
        partOfSpeech: "n.",
        definitionZh: "电子/纸质词典",
        definitionEn: "A reference book or database containing alphabetical words and their definitions.",
        synonyms: ["lexicon", "thesaurus", "vocabulary", "glossary"],
        examples: [
          { en: "Look up the precise meaning of the term in the dictionary.", zh: "在词典中查找该术语的精准含义。" }
        ]
      },
      {
        partOfSpeech: "n.",
        definitionZh: "键值对映射表 (Key-Value Map)",
        definitionEn: "An associative array or collection of key-value pairs.",
        synonyms: ["map", "hashmap", "associative array"],
        examples: [
          { en: "The configuration is represented as a nested dictionary.", zh: "该配置项表示为嵌套字典结构。" }
        ]
      }
    ],
    synonyms: ["lexicon", "glossary", "thesaurus", "vocabulary"],
    antonyms: [],
    examples: [],
    tags: ["CET4", "CET6", "CS"],
    frequencyRank: 5
  },
  {
    word: "encryption",
    phoneticUs: "/ɪnˈkrɪpʃn/",
    phoneticUk: "/ɪnˈkrɪpʃn/",
    pos: ["n."],
    definitionZh: "加密；加密技术；明文编码为密文的过程",
    definitionEn: "The process of converting information or data into a code, especially to prevent unauthorized access.",
    definitions: [
      {
        partOfSpeech: "n.",
        definitionZh: "数据加密机制",
        definitionEn: "Cryptographic conversion of plain text into cipher text using mathematical keys.",
        synonyms: ["cryptography", "enciphering", "encoding", "ciphering"],
        antonyms: ["decryption", "deciphering", "decoding"],
        examples: [
          { en: "End-to-end encryption ensures only intended recipients can read the data.", zh: "端到端加密确保仅目标接收方可读取数据。" }
        ]
      }
    ],
    synonyms: ["encoding", "cipher", "security"],
    antonyms: ["decryption"],
    examples: [],
    tags: ["CS", "CET6", "TECH"],
    frequencyRank: 5
  },
  {
    word: "framework",
    phoneticUs: "/ˈfreɪmwɜːrk/",
    phoneticUk: "/ˈfreɪmwɜːk/",
    pos: ["n."],
    definitionZh: "框架；软件架构基座；准则体系",
    definitionEn: "A basic structure underlying a system, concept, or text; an abstraction in which software providing generic functionality can be selectively changed by additional user-written code.",
    definitions: [
      {
        partOfSpeech: "n.",
        definitionZh: "软件开发框架",
        definitionEn: "A reusable, universal platform providing built-in libraries and control flow.",
        synonyms: ["platform", "scaffolding", "structure", "foundation"],
        examples: [
          { en: "The declarative framework coordinates state changes with zero layout thrashing.", zh: "该声明式框架协调状态变更且零布局抖动。" }
        ]
      }
    ],
    synonyms: ["structure", "platform", "infrastructure"],
    antonyms: [],
    examples: [],
    tags: ["CS", "CET4", "TECH"],
    frequencyRank: 5
  },
  {
    word: "immutable",
    phoneticUs: "/ɪˈmjuːtəbl/",
    phoneticUk: "/ɪˈmjuːtəbl/",
    pos: ["adj."],
    definitionZh: "不可变的；永恒不变的",
    definitionEn: "Unchanging over time or unable to be changed.",
    definitions: [
      {
        partOfSpeech: "adj.",
        definitionZh: "不可变数据结构",
        definitionEn: "An object whose state cannot be modified after it is created.",
        synonyms: ["unchangeable", "constant", "fixed", "permanent"],
        antonyms: ["mutable", "variable", "changeable"],
        examples: [
          { en: "Immutable data structures eliminate race conditions in concurrent threads.", zh: "不可变数据结构消除了并发线程中的竞态条件。" }
        ]
      }
    ],
    synonyms: ["unchangeable", "constant", "static"],
    antonyms: ["mutable", "flexible"],
    examples: [],
    tags: ["CS", "CET6", "GRE"],
    frequencyRank: 4
  },
  {
    word: "latency",
    phoneticUs: "/ˈleɪtnsi/",
    phoneticUk: "/ˈleɪtnsi/",
    pos: ["n."],
    definitionZh: "延迟；潜伏期；等待时间",
    definitionEn: "The delay before a transfer of data begins following an instruction for its transfer.",
    definitions: [
      {
        partOfSpeech: "n.",
        definitionZh: "网络或计算延迟",
        definitionEn: "The elapsed time between a request and its fulfillment in a computer system.",
        synonyms: ["delay", "lag", "pause", "wait"],
        antonyms: ["immediacy", "speed"],
        examples: [
          { en: "Ultra-low latency indexing allows searching a million files within 10 milliseconds.", zh: "超低延迟索引技术使百万文件的检索能在 10 毫秒内完成。" }
        ]
      }
    ],
    synonyms: ["delay", "lag", "retardation"],
    antonyms: ["immediacy", "promptness"],
    examples: [],
    tags: ["CS", "TECH", "CET6"],
    frequencyRank: 4
  },
  {
    word: "middleware",
    phoneticUs: "/ˈmɪdlwer/",
    phoneticUk: "/ˈmɪdlweə/",
    pos: ["n."],
    definitionZh: "中间件；介于操作系统与应用之间的支撑软件",
    definitionEn: "Software that acts as a bridge between an operating system or database and applications, especially on a network.",
    definitions: [
      {
        partOfSpeech: "n.",
        definitionZh: "请求管道中间件",
        definitionEn: "Components assembled into an application pipeline to handle requests and responses.",
        synonyms: ["bridge", "intermediary", "adapter"],
        examples: [
          { en: "Authentication middleware verifies JSON Web Tokens before forwarding requests.", zh: "认证中间件在转发请求前校验 JWT 令牌。" }
        ]
      }
    ],
    synonyms: ["intermediary", "bridge"],
    antonyms: [],
    examples: [],
    tags: ["CS", "TECH"],
    frequencyRank: 4
  },
  {
    word: "optimization",
    phoneticUs: "/ˌɑːptɪməˈzeɪʃn/",
    phoneticUk: "/ˌɒptɪmaɪˈzeɪʃn/",
    pos: ["n."],
    definitionZh: "优化；最优化；最佳化",
    definitionEn: "The action of making the best or most effective use of a situation or resource.",
    definitions: [
      {
        partOfSpeech: "n.",
        definitionZh: "性能优化与资源调优",
        definitionEn: "Modifying a system to make features work more efficiently or use fewer resources.",
        synonyms: ["improvement", "refinement", "enhancement", "tuning"],
        antonyms: ["degradation", "deterioration"],
        examples: [
          { en: "Memory optimization reduced background consumption to under 150MB.", zh: "内存优化将后台常驻开销压降至 150MB 以下。" }
        ]
      }
    ],
    synonyms: ["enhancement", "improvement", "tuning"],
    antonyms: ["degradation"],
    examples: [],
    tags: ["CS", "CET6", "IELTS"],
    frequencyRank: 5
  },
  {
    word: "pipeline",
    phoneticUs: "/ˈpaɪplaɪn/",
    phoneticUk: "/ˈpaɪplaɪn/",
    pos: ["n.", "v."],
    definitionZh: "流水线；管道；管线系统",
    definitionEn: "A linear sequence of data processing elements where the output of each element is the input of the next.",
    definitions: [
      {
        partOfSpeech: "n.",
        definitionZh: "数据处理流水线",
        definitionEn: "A set of data processing elements connected in series.",
        synonyms: ["channel", "conduit", "assembly line", "workflow"],
        examples: [
          { en: "The CI/CD pipeline runs automated security scanning and unit tests.", zh: "CI/CD 流水线自动执行安全扫描与单元测试。" }
        ]
      }
    ],
    synonyms: ["channel", "workflow", "process"],
    antonyms: [],
    examples: [],
    tags: ["CS", "TECH", "CET4"],
    frequencyRank: 4
  },
  {
    word: "protocol",
    phoneticUs: "/ˈproʊtəkɑːl/",
    phoneticUk: "/ˈprəʊtəkɒl/",
    pos: ["n."],
    definitionZh: "协议；规约；通信标准",
    definitionEn: "A set of rules governing the exchange or transmission of data between devices.",
    definitions: [
      {
        partOfSpeech: "n.",
        definitionZh: "计算机通信协议",
        definitionEn: "A formal description of digital message formats and rules.",
        synonyms: ["standard", "specification", "convention", "agreement"],
        examples: [
          { en: "The Model Context Protocol establishes standardized tooling for language models.", zh: "模型上下文协议 (MCP) 为大语言模型建立了标准工具通道。" }
        ]
      }
    ],
    synonyms: ["convention", "standard", "code", "rule"],
    antonyms: [],
    examples: [],
    tags: ["CS", "CET4", "CET6"],
    frequencyRank: 5
  },
  {
    word: "resilience",
    phoneticUs: "/rɪˈzɪliəns/",
    phoneticUk: "/rɪˈzɪliəns/",
    pos: ["n."],
    definitionZh: "抗毁性；弹性；自愈容灾能力",
    definitionEn: "The capacity to withstand or to recover quickly from difficulties; toughness.",
    definitions: [
      {
        partOfSpeech: "n.",
        definitionZh: "系统抗毁容灾韧性",
        definitionEn: "The ability of a system to maintain acceptable service in the presence of faults or stress.",
        synonyms: ["fault-tolerance", "robustness", "elasticity", "adaptability", "toughness"],
        antonyms: ["fragility", "vulnerability", "weakness"],
        examples: [
          { en: "Chaos engineering tests validate cross-module resilience under unexpected crashes.", zh: "混沌工程测试验证了在非预期崩溃下的跨模块抗毁性。" },
          { en: "System resilience ensures seamless failover with zero data loss.", zh: "系统抗毁韧性确保了零数据丢失的无缝故障转移。" }
        ]
      }
    ],
    synonyms: ["robustness", "durability", "adaptability"],
    antonyms: ["fragility", "vulnerability"],
    examples: [],
    tags: ["CS", "CET6", "IELTS", "GRE"],
    frequencyRank: 4
  },
  {
    word: "sandbox",
    phoneticUs: "/ˈsændbɑːks/",
    phoneticUk: "/ˈsændbɒks/",
    pos: ["n.", "v."],
    definitionZh: "沙箱；安全隔离运行环境",
    definitionEn: "An isolated testing environment that enables users to run programs without affecting the application or system.",
    definitions: [
      {
        partOfSpeech: "n.",
        definitionZh: "软件安全沙箱",
        definitionEn: "A security mechanism for separating running programs to mitigate system failures or software vulnerabilities.",
        synonyms: ["isolation environment", "quarantine", "container"],
        examples: [
          { en: "Third-party plugins execute within a restricted sandbox environment.", zh: "第三方插件在受限沙箱环境中执行。" }
        ]
      }
    ],
    synonyms: ["container", "isolated environment"],
    antonyms: [],
    examples: [],
    tags: ["CS", "TECH"],
    frequencyRank: 4
  },
  {
    word: "sidecar",
    phoneticUs: "/ˈsaɪdkɑːr/",
    phoneticUk: "/ˈsaɪdkɑː/",
    pos: ["n."],
    definitionZh: "侧车；伴生工作进程；边车架构模式",
    definitionEn: "A secondary process or container running alongside a primary application to provide auxiliary capabilities.",
    definitions: [
      {
        partOfSpeech: "n.",
        definitionZh: "架构伴生进程 (Sidecar Process)",
        definitionEn: "A design pattern where an auxiliary process runs alongside the main host to isolate heavy operations.",
        synonyms: ["auxiliary process", "companion", "worker"],
        examples: [
          { en: "The indexer runs as a precompiled native Rust sidecar.", zh: "索引器作为预编译的原生 Rust 侧车独立运行。" }
        ]
      }
    ],
    synonyms: ["companion", "worker", "assistant"],
    antonyms: [],
    examples: [],
    tags: ["CS", "TECH"],
    frequencyRank: 4
  },
  {
    word: "transaction",
    phoneticUs: "/trænˈzækʃn/",
    phoneticUk: "/trænˈzækʃn/",
    pos: ["n."],
    definitionZh: "事务；交易；办理",
    definitionEn: "An instance of buying or selling something; a unit of work performed within a database management system.",
    definitions: [
      {
        partOfSpeech: "n.",
        definitionZh: "数据库原子事务",
        definitionEn: "A sequence of database operations treated as a single logical unit complying with ACID properties.",
        synonyms: ["operation", "deal", "exchange", "procedure"],
        examples: [
          { en: "The database rolled back the transaction to preserve consistency.", zh: "数据库回滚了该事务以维持数据一致性。" }
        ]
      }
    ],
    synonyms: ["deal", "negotiation", "operation"],
    antonyms: [],
    examples: [],
    tags: ["CS", "CET4", "CET6", "COMMERCE"],
    frequencyRank: 5
  },
  {
    word: "virtualization",
    phoneticUs: "/ˌvɜːrtʃuələˈzeɪʃn/",
    phoneticUk: "/ˌvɜːtʃuəlaɪˈzeɪʃn/",
    pos: ["n."],
    definitionZh: "虚拟化；虚拟机技术；视图列表虚拟滚动",
    definitionEn: "The creation of a virtual version of something, such as a hardware platform, storage device, or network resources.",
    definitions: [
      {
        partOfSpeech: "n.",
        definitionZh: "计算或视口虚拟化",
        definitionEn: "Rendering only visible DOM elements to maintain high performance with massive datasets.",
        synonyms: ["simulation", "emulation", "abstraction"],
        examples: [
          { en: "List virtualization ensures smooth 60fps scrolling across 100,000 items.", zh: "列表虚拟化确保十万条目下依然维持 60fps 平滑滚动。" }
        ]
      }
    ],
    synonyms: ["emulation", "simulation"],
    antonyms: [],
    examples: [],
    tags: ["CS", "TECH"],
    frequencyRank: 4
  }
]);

/**
 * 词形还原归一化（去除常见复数、过去式、进行时、形容词副词后缀）
 */
export function normalizeWord(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim().toLowerCase();
  // 简易词形还原规则
  if (trimmed.endsWith("ies") && trimmed.length > 4) return trimmed.slice(0, -3) + "y";
  if (trimmed.endsWith("ing") && trimmed.length > 5) {
    const stem = trimmed.slice(0, -3);
    // 处理双写，如 running -> run
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      return stem.slice(0, -1);
    }
    return stem;
  }
  if (trimmed.endsWith("ized") && trimmed.length > 5) return trimmed.slice(0, -1);
  if (trimmed.endsWith("ated") && trimmed.length > 5) return trimmed.slice(0, -1);
  if (trimmed.endsWith("ed") && trimmed.length > 4) return trimmed.slice(0, -2);
  if (trimmed.endsWith("es") && trimmed.length > 4) return trimmed.slice(0, -2);
  if (trimmed.endsWith("s") && !trimmed.endsWith("ss") && trimmed.length > 3) return trimmed.slice(0, -1);
  return trimmed;
}

/**
 * 计算编辑距离 (Levenshtein Distance) 用于 "Did you mean?" 拼写容错建议
 */
export function calculateLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      let val: number;
      if (a[i - 1] === b[j - 1]) {
        val = row[j - 1];
      } else {
        val = Math.min(row[j - 1] + 1, prev + 1, row[j] + 1);
      }
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

export interface DictSearchResult {
  readonly exactMatches: DictWordEntry[];
  readonly suggestions: DictWordEntry[];
  readonly guesses: DictWordEntry[]; // Did you mean?
}

/**
 * 智能查词检索：精准匹配 + 前缀匹配 + 编辑距离猜词
 */
export function lookupWord(query: string, dict: readonly DictWordEntry[] = BUILTIN_DICTIONARY): DictSearchResult {
  const clean = query.trim().toLowerCase();
  if (!clean) {
    return { exactMatches: [], suggestions: [], guesses: [] };
  }

  const normalized = normalizeWord(clean);

  const exactMatches: DictWordEntry[] = [];
  const prefixMatches: DictWordEntry[] = [];
  const otherMatches: DictWordEntry[] = [];
  const guessedList: { entry: DictWordEntry; dist: number }[] = [];

  for (const entry of dict) {
    const entryWord = entry.word.toLowerCase();
    if (entryWord === clean || entryWord === normalized) {
      exactMatches.push(entry);
    } else if (entryWord.startsWith(clean) || entryWord.startsWith(normalized)) {
      prefixMatches.push(entry);
    } else if (entryWord.includes(clean) || entry.definitionZh.includes(clean)) {
      otherMatches.push(entry);
    } else {
      // 容错距离计算
      const dist = calculateLevenshtein(clean, entryWord);
      if (dist <= 2 || (clean.length > 5 && dist <= 3)) {
        guessedList.push({ entry, dist });
      }
    }
  }

  guessedList.sort((a, b) => a.dist - b.dist);
  const guesses = guessedList.slice(0, 3).map(g => g.entry);

  return {
    exactMatches,
    suggestions: [...prefixMatches, ...otherMatches],
    guesses
  };
}

/**
 * 生成外部权威在线词典的 URL
 */
export function getOnlineDictionaryUrls(word: string): {
  cambridge: string;
  youdao: string;
  bing: string;
  wordReference: string;
} {
  const enc = encodeURIComponent(word.trim());
  return {
    cambridge: `https://dictionary.cambridge.org/dictionary/english-chinese-simplified/${enc}`,
    youdao: `https://dict.youdao.com/result?word=${enc}&lang=en`,
    bing: `https://cn.bing.com/dict/search?q=${enc}`,
    wordReference: `https://www.wordreference.com/enzh/${enc}`
  };
}

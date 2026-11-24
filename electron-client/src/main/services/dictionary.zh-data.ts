/**
 * ZTools 本地英汉双解词典静态词库数据（纯静态常量，严禁包含 UI 渲染逻辑或业务报错）。
 */

export interface DictionaryDefinition {
  readonly pos: string // 词性 (n., v., adj., adv., etc.)
  readonly meaningZh: string
  readonly meaningEn?: string
}

export interface DictionaryExample {
  readonly en: string
  readonly zh: string
}

export interface DictionaryEntry {
  readonly word: string
  readonly phonetic: string
  readonly definitions: readonly DictionaryDefinition[]
  readonly examples: readonly DictionaryExample[]
  readonly synonyms?: readonly string[]
  readonly antonyms?: readonly string[]
  readonly tags?: readonly string[]
}

export const LOCAL_DICTIONARY_ENTRIES: readonly DictionaryEntry[] = [
  {
    word: 'algorithm',
    phonetic: '/ˈælɡərɪðəm/',
    definitions: [
      { pos: 'n.', meaningZh: '算法；运算法则', meaningEn: 'A process or set of rules to be followed in calculations or problem-solving.' }
    ],
    examples: [
      { en: 'The search algorithm delivers results in milliseconds.', zh: '该搜索算法在数毫秒内返回结果。' }
    ],
    synonyms: ['procedure', 'formula', 'method']
  },
  {
    word: 'architecture',
    phonetic: '/ˈɑːrkɪtektʃər/',
    definitions: [
      { pos: 'n.', meaningZh: '架构；建筑体系结构', meaningEn: 'The complex or carefully designed structure of something.' }
    ],
    examples: [
      { en: 'ZTools adopts a decoupled host and sidecar architecture.', zh: 'ZTools 采用解耦的宿主与侧车架构。' }
    ],
    synonyms: ['structure', 'framework', 'design']
  },
  {
    word: 'buffer',
    phonetic: '/ˈbʌfər/',
    definitions: [
      { pos: 'n.', meaningZh: '缓冲区；缓冲存储区', meaningEn: 'A temporary memory area used to store data while it is being moved.' },
      { pos: 'v.', meaningZh: '缓冲；减震', meaningEn: 'Lessen or moderate the impact of something.' }
    ],
    examples: [
      { en: 'The ring buffer stores the most recent keystrokes.', zh: '环形缓冲区存储最近的击键记录。' }
    ]
  },
  {
    word: 'clipboard',
    phonetic: '/ˈklɪpbɔːrd/',
    definitions: [
      { pos: 'n.', meaningZh: '剪贴板；带夹写字板', meaningEn: 'A temporary storage area for copied or cut data.' }
    ],
    examples: [
      { en: 'The item was automatically copied to the clipboard.', zh: '该条目已被自动复制到剪贴板。' }
    ]
  },
  {
    word: 'concurrent',
    phonetic: '/kənˈkɜːrənt/',
    definitions: [
      { pos: 'adj.', meaningZh: '并发的；同时发生的', meaningEn: 'Existing, happening, or done at the same time.' }
    ],
    examples: [
      { en: 'The server handles thousands of concurrent connections.', zh: '该服务器同时处理数千个并发连接。' }
    ],
    synonyms: ['simultaneous', 'parallel', 'synchronous']
  },
  {
    word: 'declaration',
    phonetic: '/ˌdekləˈreɪʃn/',
    definitions: [
      { pos: 'n.', meaningZh: '声明；宣告；声明式定义', meaningEn: 'A formal or explicit statement or announcement.' }
    ],
    examples: [
      { en: 'Declarative UI eliminates manual DOM manipulations.', zh: '声明式 UI 消除了手动 DOM 操作。' }
    ],
    synonyms: ['statement', 'announcement', 'definition']
  },
  {
    word: 'dictionary',
    phonetic: '/ˈdɪkʃəneri/',
    definitions: [
      { pos: 'n.', meaningZh: '词典；字典', meaningEn: 'A book or electronic resource that lists words and gives their meaning.' }
    ],
    examples: [
      { en: 'Look up the definition of unfamiliar words in the dictionary.', zh: '在词典中查询陌生单词的释义。' }
    ],
    synonyms: ['lexicon', 'glossary', 'vocabulary']
  },
  {
    word: 'dispatch',
    phonetic: '/dɪˈspætʃ/',
    definitions: [
      { pos: 'v.', meaningZh: '调度；派遣；发送', meaningEn: 'Send off to a destination or for a purpose.' },
      { pos: 'n.', meaningZh: '快速发送；调度过程', meaningEn: 'The sending of someone or something to a destination.' }
    ],
    examples: [
      { en: 'Events are dispatched immediately across the IPC bridge.', zh: '事件通过 IPC 桥梁被立即调度分发。' }
    ],
    synonyms: ['send', 'forward', 'route']
  },
  {
    word: 'efficient',
    phonetic: '/ɪˈfɪʃnt/',
    definitions: [
      { pos: 'adj.', meaningZh: '高效的；效率高的', meaningEn: 'Achieving maximum productivity with minimum wasted effort.' }
    ],
    examples: [
      { en: 'The Rust sidecar provides an efficient file indexing engine.', zh: 'Rust 侧车提供了一个高效的文件索引引擎。' }
    ],
    synonyms: ['productive', 'effective', 'speedy']
  },
  {
    word: 'exception',
    phonetic: '/ɪkˈsepʃn/',
    definitions: [
      { pos: 'n.', meaningZh: '异常；例外', meaningEn: 'An abnormal event that interrupts the normal execution flow.' }
    ],
    examples: [
      { en: 'Every unhandled exception is caught and reported safely.', zh: '每个未捕获异常都会被妥善拦截与记录。' }
    ],
    synonyms: ['anomaly', 'irregularity', 'error']
  },
  {
    word: 'extension',
    phonetic: '/ɪkˈstenʃn/',
    definitions: [
      { pos: 'n.', meaningZh: '扩展；插件；延期', meaningEn: 'An application or program that extends host capabilities.' }
    ],
    examples: [
      { en: 'You can install community extensions from the catalog.', zh: '你可以从插件目录中安装社区扩展。' }
    ],
    synonyms: ['addon', 'plugin', 'module']
  },
  {
    word: 'performance',
    phonetic: '/pərˈfɔːrməns/',
    definitions: [
      { pos: 'n.', meaningZh: '性能；表现；执行效率', meaningEn: 'The capabilities of a machine or system in terms of speed and accuracy.' }
    ],
    examples: [
      { en: 'Hardware acceleration enhances rendering performance significantly.', zh: '硬件加速显著提升了渲染性能。' }
    ],
    synonyms: ['efficiency', 'speed', 'execution']
  },
  {
    word: 'pipeline',
    phonetic: '/ˈpaɪplaɪn/',
    definitions: [
      { pos: 'n.', meaningZh: '流水线；管线；管道', meaningEn: 'A series of processes that transform data continuously.' }
    ],
    examples: [
      { en: 'The rendering pipeline suspends when the window is hidden.', zh: '窗口隐藏时渲染管线主动挂起。' }
    ]
  },
  {
    word: 'protocol',
    phonetic: '/ˈproʊtəkɑːl/',
    definitions: [
      { pos: 'n.', meaningZh: '协议；规约', meaningEn: 'A set of rules governing the exchange of data.' }
    ],
    examples: [
      { en: 'ZTools communicates using the Model Context Protocol.', zh: 'ZTools 基于 Model Context Protocol 协议进行通信。' }
    ],
    synonyms: ['convention', 'standard', 'specification']
  },
  {
    word: 'reconcile',
    phonetic: '/ˈrekənsaɪl/',
    definitions: [
      { pos: 'v.', meaningZh: '协调；使一致；比较差异重调', meaningEn: 'Make one view or account consistent with another.' }
    ],
    examples: [
      { en: 'The virtual DOM reconciler diffs trees before updating the view.', zh: '虚拟 DOM 协调器在更新视图前计算视图树差异。' }
    ],
    synonyms: ['harmonize', 'align', 'resolve']
  },
  {
    word: 'resilience',
    phonetic: '/rɪˈzɪliəns/',
    definitions: [
      { pos: 'n.', meaningZh: '抗毁性；弹性；自愈容灾能力', meaningEn: 'The capacity to recover quickly from difficulties or crashes.' }
    ],
    examples: [
      { en: 'Chaos testing validates the cross-module resilience of the host.', zh: '混沌测试验证了宿主系统的跨模块抗毁性。' }
    ],
    synonyms: ['durability', 'robustness', 'elasticity']
  },
  {
    word: 'sidecar',
    phonetic: '/ˈsaɪdkɑːr/',
    definitions: [
      { pos: 'n.', meaningZh: '侧车；伴生工作进程', meaningEn: 'A secondary process that assists and offloads heavy work from the main host.' }
    ],
    examples: [
      { en: 'The indexer runs as an independent native sidecar.', zh: '索引器作为独立的原生侧车进程运行。' }
    ]
  },
  {
    word: 'snippet',
    phonetic: '/ˈsnɪpɪt/',
    definitions: [
      { pos: 'n.', meaningZh: '代码片段；常用文本摘要', meaningEn: 'A small piece or brief extract of text or code.' }
    ],
    examples: [
      { en: 'Type the keyword to expand the code snippet instantly.', zh: '输入关键字即可瞬间展开代码片段。' }
    ],
    synonyms: ['fragment', 'excerpt', 'template']
  },
  {
    word: 'terminal',
    phonetic: '/ˈtɜːrmɪnl/',
    definitions: [
      { pos: 'n.', meaningZh: '终端；控制台终端设备', meaningEn: 'A device or program enabling direct text interaction with a computer.' },
      { pos: 'adj.', meaningZh: '末端的；终点的', meaningEn: 'Occurring at or forming the end of a series or process.' }
    ],
    examples: [
      { en: 'Open the integrated terminal with a single shortcut.', zh: '使用单一快捷键即可打开集成终端。' }
    ],
    synonyms: ['console', 'shell', 'command line']
  },
  {
    word: 'translator',
    phonetic: '/trænzˈleɪtər/',
    definitions: [
      { pos: 'n.', meaningZh: '翻译器；译员；转换程序', meaningEn: 'A person or program that translates text from one language to another.' }
    ],
    examples: [
      { en: 'The quick translator instantly renders translations for selected text.', zh: '极速翻译器可为选中文本即时呈现译文。' }
    ],
    synonyms: ['interpreter', 'converter']
  }
]

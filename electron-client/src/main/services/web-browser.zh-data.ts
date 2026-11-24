/**
 * 网页搜索引擎中文显示名与检索别名静态数据（纯静态领域词库，无业务或渲染逻辑）
 */

export type SearchEngineKey = 'google' | 'baidu' | 'bing' | 'duckduckgo' | 'github' | 'bilibili' | 'zhihu' | 'mdn'

export interface SearchEngineMeta {
  key: SearchEngineKey
  name: string
  urlTemplate: string
  icon: string
  pinyin: string
}

export const SEARCH_ENGINES: Record<SearchEngineKey, SearchEngineMeta> = {
  baidu: { key: 'baidu', name: '百度搜索', urlTemplate: 'https://www.baidu.com/s?wd={query}', icon: 'paw', pinyin: 'baidusousuo' },
  bing: { key: 'bing', name: '微软必应', urlTemplate: 'https://www.bing.com/search?q={query}', icon: 'globe', pinyin: 'bing' },
  google: { key: 'google', name: 'Google 搜索', urlTemplate: 'https://www.google.com/search?q={query}', icon: 'google', pinyin: 'googlesousuo' },
  duckduckgo: { key: 'duckduckgo', name: 'DuckDuckGo', urlTemplate: 'https://duckduckgo.com/?q={query}', icon: 'shield', pinyin: 'duckduckgo' },
  github: { key: 'github', name: 'GitHub 代码库', urlTemplate: 'https://github.com/search?q={query}', icon: 'code', pinyin: 'githubdaimaku' },
  bilibili: { key: 'bilibili', name: '哔哩哔哩', urlTemplate: 'https://search.bilibili.com/all?keyword={query}', icon: 'video', pinyin: 'bilibili' },
  zhihu: { key: 'zhihu', name: '知乎', urlTemplate: 'https://www.zhihu.com/search?type=content&q={query}', icon: 'book', pinyin: 'zhihu' },
  mdn: { key: 'mdn', name: 'MDN Web 文档', urlTemplate: 'https://developer.mozilla.org/zh-CN/search?q={query}', icon: 'document', pinyin: 'mdnwendang' }
}

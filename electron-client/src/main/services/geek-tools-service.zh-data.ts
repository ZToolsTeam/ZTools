/**
 * 极客工具服务静态中文游戏名称与拼音检索词库（纯静态常量数据，不含业务逻辑或报错文案）。
 */
export interface SteamGameStaticEntry {
  id: string
  name: string
  platform: 'steam' | 'epic' | 'xbox' | 'custom'
  launchCommand: string
  pinyin: string
  acronym: string
  icon?: string
}

export const DEFAULT_STEAM_GAME_ENTRIES: readonly SteamGameStaticEntry[] = Object.freeze([
  { id: 'game-steam-730', name: 'Counter-Strike 2', platform: 'steam', launchCommand: 'steam://rungameid/730', pinyin: 'counterstrike2', acronym: 'cs2' },
  { id: 'game-steam-570', name: 'Dota 2', platform: 'steam', launchCommand: 'steam://rungameid/570', pinyin: 'dota2', acronym: 'd2' },
  { id: 'game-steam-1091500', name: '赛博朋克 2077', platform: 'steam', launchCommand: 'steam://rungameid/1091500', pinyin: 'saibopengke2077', acronym: 'sbpk' },
  { id: 'game-black-myth', name: '黑神话：悟空', platform: 'steam', launchCommand: 'steam://rungameid/2358720', pinyin: 'heishenhuawukong', acronym: 'hsh' }
])

export const CUSTOM_GAME_PINYIN_MAP: Readonly<Record<string, { pinyin: string; acronym: string }>> = Object.freeze({
  '星际争霸 2': { pinyin: 'xingjizhengba2', acronym: 'xjzb' },
  '星际争霸2': { pinyin: 'xingjizhengba2', acronym: 'xjzb' },
  '星际争霸': { pinyin: 'xingjizhengba', acronym: 'xjzb' }
})

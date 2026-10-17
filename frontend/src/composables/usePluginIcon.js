/**
 * 插件图标公共逻辑 - 列表页和详情页共用
 * 图标优先级：plugin.icon（远程URL）> localIconPath（本地）> FA图标
 */
import { computed, ref } from 'vue'
import { resolvePluginGlyph } from '@/utils/brandIcons'

// FA 图标映射表（列表页和详情页统一使用）
const FA_ICON_MAP = [
  // 品牌优先
  ['qq', 'fa-qq'],
  ['微信', 'fa-wechat'],
  // 具体插件名匹配
  ['硬件', 'fa-microchip'],
  ['定时关机', 'fa-clock-o'],
  ['关机', 'fa-power-off'],
  ['待办', 'fa-check-square-o'],
  ['备忘', 'fa-thumb-tack'],
  ['身份验证', 'fa-id-card-o'],
  ['验证器', 'fa-shield'],
  ['软件管理', 'fa-th-large'],
  ['右键管理', 'fa-mouse-pointer'],
  ['hosts', 'fa-sitemap'],
  ['base64', 'fa-file-code-o'],
  // 系统工具
  ['清理', 'fa-trash-o'],
  ['清除', 'fa-eraser'],
  ['垃圾', 'fa-recycle'],
  ['卸载', 'fa-times-circle'],
  ['管理', 'fa-cogs'],
  ['软件', 'fa-th-large'],
  ['系统', 'fa-desktop'],
  ['优化', 'fa-rocket'],
  ['加速', 'fa-bolt'],
  ['监控', 'fa-tachometer'],
  ['进程', 'fa-tasks'],
  ['内存', 'fa-microchip'],
  ['磁盘', 'fa-hdd-o'],
  ['硬盘', 'fa-database'],
  ['启动', 'fa-power-off'],
  ['服务', 'fa-server'],
  // 文件处理
  ['粉碎', 'fa-fire'],
  ['恢复', 'fa-undo'],
  ['备份', 'fa-cloud-upload'],
  ['同步', 'fa-refresh'],
  ['压缩', 'fa-file-archive-o'],
  ['重命名', 'fa-i-cursor'],
  ['搜索', 'fa-search'],
  ['查找', 'fa-binoculars'],
  ['文件', 'fa-file-o'],
  // 媒体处理
  ['截图', 'fa-scissors'],
  ['录屏', 'fa-video-camera'],
  ['录音', 'fa-microphone'],
  ['图片', 'fa-image'],
  ['图像', 'fa-picture-o'],
  ['视频', 'fa-film'],
  ['音频', 'fa-music'],
  ['音乐', 'fa-headphones'],
  ['转换', 'fa-exchange'],
  ['编辑', 'fa-edit'],
  ['pdf', 'fa-file-pdf-o'],
  // 网络工具
  ['网络', 'fa-wifi'],
  ['下载', 'fa-download'],
  ['代理', 'fa-globe'],
  ['测速', 'fa-dashboard'],
  // 安全工具
  ['安全', 'fa-shield'],
  ['加密', 'fa-key'],
  ['密码', 'fa-lock'],
  // 办公效率
  ['笔记', 'fa-sticky-note-o'],
  ['便签', 'fa-bookmark-o'],
  ['翻译', 'fa-language'],
  ['计算', 'fa-calculator'],
  ['剪贴板', 'fa-clipboard'],
  // 开发工具
  ['开发', 'fa-code'],
  ['代码', 'fa-terminal'],
  ['数据库', 'fa-database'],
  ['json', 'fa-code'],
  // 通用
  ['工具', 'fa-wrench'],
  ['设置', 'fa-cog'],
  ['插件', 'fa-puzzle-piece'],
  ['游戏', 'fa-gamepad']
]

/**
 * 根据插件名称匹配 FA 图标
 */
export function getPluginFaIcon(name) {
  const n = (name || '').toLowerCase()
  for (const [keyword, icon] of FA_ICON_MAP) {
    if (n.includes(keyword)) return icon
  }
  return 'fa-cube'
}

/**
 * 插件图标 composable
 * @param {import('vue').Ref|Function} pluginGetter - 返回插件对象的 getter
 */
export function usePluginIcon(pluginGetter) {
  const iconLoaded = ref(false)
  const iconFailed = ref(false)

  // FA 图标（最终 fallback）
  const pluginIcon = computed(() => {
    const plugin = typeof pluginGetter === 'function' ? pluginGetter() : pluginGetter.value
    return getPluginFaIcon(plugin?.name)
  })

  // 图标优先级：远程 icon URL > 本地 localIconPath > FA 图标
  const remoteIconUrl = computed(() => {
    const plugin = typeof pluginGetter === 'function' ? pluginGetter() : pluginGetter.value
    const icon = plugin?.icon || ''
    return icon.startsWith('http') ? icon : ''
  })
  const localIconPath = computed(() => {
    const plugin = typeof pluginGetter === 'function' ? pluginGetter() : pluginGetter.value
    return plugin?.localIconPath || ''
  })
  const displayIconUrl = computed(() => remoteIconUrl.value || localIconPath.value)
  // 官方插件统一使用品牌线性图形（设计规范：避免各插件自带图标风格不一）
  const pluginGlyph = computed(() => {
    const plugin = typeof pluginGetter === 'function' ? pluginGetter() : pluginGetter.value
    return resolvePluginGlyph(plugin)
  })
  const showImgOverlay = computed(() => !!displayIconUrl.value && iconLoaded.value && !iconFailed.value)

  const onIconLoad = () => { iconLoaded.value = true }
  const onIconError = () => { iconFailed.value = true }

  return {
    pluginIcon,
    pluginGlyph,
    displayIconUrl,
    iconLoaded,
    iconFailed,
    showImgOverlay,
    onIconLoad,
    onIconError
  }
}

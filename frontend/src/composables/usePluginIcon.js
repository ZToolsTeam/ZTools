/**
 * 插件图标公共逻辑 - 列表页和详情页共用
 * 图标优先级：官方品牌图形 > plugin.icon（远程URL）> localIconPath（本地）> 按名称关键词挑的线性图形 > 默认立方体
 */
import { computed, ref } from 'vue'
import { resolveKeywordGlyph, resolvePluginGlyph } from '@/utils/brandIcons'

/**
 * 插件图标 composable
 * @param {import('vue').Ref|Function} pluginGetter - 返回插件对象的 getter
 */
export function usePluginIcon(pluginGetter) {
  const iconLoaded = ref(false)
  const iconFailed = ref(false)

  // 图标优先级：远程 icon URL > 本地 localIconPath（都没有时由 RcSquircle 显示默认立方体）
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
  // 没有图标时按名称关键词挑一个同风格图形，避免一排都是同一个立方体
  const fallbackGlyph = computed(() => {
    const plugin = typeof pluginGetter === 'function' ? pluginGetter() : pluginGetter.value
    return resolveKeywordGlyph(plugin?.name || plugin?.title)
  })
  const showImgOverlay = computed(() => !!displayIconUrl.value && iconLoaded.value && !iconFailed.value)

  const onIconLoad = () => { iconLoaded.value = true }
  const onIconError = () => { iconFailed.value = true }

  return {
    pluginGlyph,
    fallbackGlyph,
    displayIconUrl,
    iconLoaded,
    iconFailed,
    showImgOverlay,
    onIconLoad,
    onIconError
  }
}

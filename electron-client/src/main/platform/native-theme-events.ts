export interface NativeThemeEvents {
  readonly shouldUseDarkColors: boolean
  on(event: 'updated', listener: () => void): unknown
  removeListener(event: 'updated', listener: () => void): unknown
}

/** Bridge actual Electron theme updates to the existing subscribed SDK envelope. */
export function bindNativeThemeEvents(
  nativeTheme: NativeThemeEvents,
  events: { publishHost(type: string, payload: unknown): unknown }
): () => void {
  let stopped = false
  let dark = nativeTheme.shouldUseDarkColors
  const updated = () => {
    if (stopped || dark === nativeTheme.shouldUseDarkColors) return
    dark = nativeTheme.shouldUseDarkColors
    events.publishHost('system.DarkModeChange', { isDark: dark })
  }
  nativeTheme.on('updated', updated)
  return () => {
    if (stopped) return
    stopped = true
    nativeTheme.removeListener('updated', updated)
  }
}

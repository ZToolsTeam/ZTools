/**
 * ZTools 固定主题色与明暗模式定义（单一信源）
 * 包含 6 款预设主题色：余烬橙、冰川蓝、松石翠、星云紫、绯樱红、钛金灰（不支持自定义取色器）
 */

export const THEME_MODES = ['system', 'light', 'dark']

export const DEFAULT_ACCENT = 'ember'

export const ACCENT_OPTIONS = [
  { value: 'ember', labelKey: 'settings.appearance.accents.ember' },
  { value: 'glacier', labelKey: 'settings.appearance.accents.glacier' },
  { value: 'jade', labelKey: 'settings.appearance.accents.jade' },
  { value: 'iris', labelKey: 'settings.appearance.accents.iris' },
  { value: 'crimson', labelKey: 'settings.appearance.accents.crimson' },
  { value: 'mono', labelKey: 'settings.appearance.accents.mono' }
]

export const ACCENT_THEMES = ACCENT_OPTIONS.map((item) => item.value)

/**
 * 校验并归一化主题色标识，非法值回退为默认「余烬橙」
 * @param {unknown} value
 * @returns {'ember' | 'glacier' | 'jade' | 'iris' | 'crimson' | 'mono'}
 */
export function normalizeAccent(value) {
  return typeof value === 'string' && ACCENT_THEMES.includes(value) ? value : DEFAULT_ACCENT
}

/**
 * Ant Design Vue ConfigProvider 所需具体色值映射（与 theme.css 严格对齐）
 */
export const ANTD_THEME_TOKENS = {
  ember: {
    light: {
      colorPrimary: '#f0582a',
      colorLink: '#c2410c',
      colorTextLightSolid: '#ffffff',
      colorBgBase: '#f4f3f0',
      colorBgContainer: '#ffffff',
      colorBgElevated: '#ffffff',
      colorBorder: '#dbd8d2',
      colorBorderSecondary: '#e7e5e0',
      colorTextBase: '#18181b'
    },
    dark: {
      colorPrimary: '#ec5a2d',
      colorLink: '#ff8a63',
      colorTextLightSolid: '#ffffff',
      colorBgBase: '#0b0b0c',
      colorBgContainer: '#141416',
      colorBgElevated: '#1a1a1d',
      colorBorder: '#2c2c31',
      colorBorderSecondary: '#202024',
      colorTextBase: '#f2f2f0'
    }
  },
  glacier: {
    light: {
      colorPrimary: '#2563eb',
      colorLink: '#1d4ed8',
      colorTextLightSolid: '#ffffff',
      colorBgBase: '#f2f5f8',
      colorBgContainer: '#ffffff',
      colorBgElevated: '#ffffff',
      colorBorder: '#cbd5e1',
      colorBorderSecondary: '#dce3ec',
      colorTextBase: '#0f172a'
    },
    dark: {
      colorPrimary: '#2563eb',
      colorLink: '#60a5fa',
      colorTextLightSolid: '#ffffff',
      colorBgBase: '#0a0d12',
      colorBgContainer: '#131922',
      colorBgElevated: '#19212d',
      colorBorder: '#2a3646',
      colorBorderSecondary: '#212b38',
      colorTextBase: '#f1f5f9'
    }
  },
  jade: {
    light: {
      colorPrimary: '#059669',
      colorLink: '#047857',
      colorTextLightSolid: '#ffffff',
      colorBgBase: '#f1f5f3',
      colorBgContainer: '#ffffff',
      colorBgElevated: '#ffffff',
      colorBorder: '#cad8d0',
      colorBorderSecondary: '#d8e4dd',
      colorTextBase: '#111c17'
    },
    dark: {
      colorPrimary: '#059669',
      colorLink: '#34d399',
      colorTextLightSolid: '#ffffff',
      colorBgBase: '#090e0c',
      colorBgContainer: '#121b17',
      colorBgElevated: '#17231e',
      colorBorder: '#283b32',
      colorBorderSecondary: '#1f2e27',
      colorTextBase: '#eef5f1'
    }
  },
  iris: {
    light: {
      colorPrimary: '#6d28d9',
      colorLink: '#6d28d9',
      colorTextLightSolid: '#ffffff',
      colorBgBase: '#f4f3f8',
      colorBgContainer: '#ffffff',
      colorBgElevated: '#ffffff',
      colorBorder: '#d2cde0',
      colorBorderSecondary: '#dfdbe9',
      colorTextBase: '#171426'
    },
    dark: {
      colorPrimary: '#7c3aed',
      colorLink: '#a78bfa',
      colorTextLightSolid: '#ffffff',
      colorBgBase: '#0b0a10',
      colorBgContainer: '#15131f',
      colorBgElevated: '#1c1929',
      colorBorder: '#302b46',
      colorBorderSecondary: '#252136',
      colorTextBase: '#f3f1f9'
    }
  },
  crimson: {
    light: {
      colorPrimary: '#be123c',
      colorLink: '#be123c',
      colorTextLightSolid: '#ffffff',
      colorBgBase: '#f5f3f4',
      colorBgContainer: '#ffffff',
      colorBgElevated: '#ffffff',
      colorBorder: '#d8d0d4',
      colorBorderSecondary: '#e5dfe2',
      colorTextBase: '#191517'
    },
    dark: {
      colorPrimary: '#e11d48',
      colorLink: '#fb7185',
      colorTextLightSolid: '#ffffff',
      colorBgBase: '#0c0a0b',
      colorBgContainer: '#171315',
      colorBgElevated: '#1f191c',
      colorBorder: '#342b2f',
      colorBorderSecondary: '#282124',
      colorTextBase: '#f5f1f3'
    }
  },
  mono: {
    light: {
      colorPrimary: '#18181b',
      colorLink: '#18181b',
      colorTextLightSolid: '#ffffff',
      colorBgBase: '#f4f4f5',
      colorBgContainer: '#ffffff',
      colorBgElevated: '#ffffff',
      colorBorder: '#d4d4d8',
      colorBorderSecondary: '#e4e4e7',
      colorTextBase: '#09090b'
    },
    dark: {
      colorPrimary: '#f4f4f5',
      colorLink: '#fafafa',
      colorTextLightSolid: '#09090b',
      colorBgBase: '#09090b',
      colorBgContainer: '#141417',
      colorBgElevated: '#1b1b1f',
      colorBorder: '#2e2e34',
      colorBorderSecondary: '#242429',
      colorTextBase: '#fafafa'
    }
  }
}

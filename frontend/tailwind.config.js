/** @type {import('tailwindcss').Config} */
export default {
  // 测试文件不参与扫描：内部仓库有只属于官方版的测试（开源导出时去掉），扫进来会让内部构建与「公开源码 + 闭源覆盖层」构建的 CSS 不一致
  content: [
    './index.html',
    './src/**/*.{vue,js,ts,jsx,tsx}',
    '!./src/**/__tests__/**',
    '!./src/**/*.{spec,test}.{vue,js,ts,jsx,tsx}'
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // 积木 Z × 余烬橙（与 theme.css 一致；组件内优先使用 var(--rc-*)）
        primary: '#ff6b3d',
        success: '#4b6a30',
        warning: '#8f5b00',
        error: '#b42318',
        info: '#38556f'
      }
    }
  },
  plugins: []
}

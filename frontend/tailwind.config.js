/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
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

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Ant Design 标准色
        primary: '#1677ff',
        success: '#52c41a',
        warning: '#faad14',
        error: '#ff4d4f',
        info: '#1677ff'
      }
    }
  },
  plugins: []
}

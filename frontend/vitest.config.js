import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import { existsSync } from 'fs'

// 与 vite.config.js 一致：有 src/commercial/edition.js 时测试官方版，否则测试开源版
const commercialEditionEntry = path.resolve(__dirname, 'src/commercial/edition.js')
const hasCommercialEdition = existsSync(commercialEditionEntry)
const editionEntry = hasCommercialEdition
  ? commercialEditionEntry
  : path.resolve(__dirname, 'src/edition-oss/index.js')

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1'
  },
  test: {
    globals: true,
    environment: 'jsdom',
    // 官方版测试使用相对路径的后台接口前缀（只是占位，不含真实地址）；开源版不连接任何后台，不注入
    env: hasCommercialEdition ? { VITE_API_BASE_URL: '/api' } : {},
    environmentOptions: {
      jsdom: {
        url: 'http://127.0.0.1/'
      }
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'frontend/src/pages/__tests__/']
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@edition': editionEntry,
      '@api': path.resolve(__dirname, './src/api'),
      '@components': path.resolve(__dirname, './src/components'),
      '@stores': path.resolve(__dirname, './src/stores'),
      '@composables': path.resolve(__dirname, './src/composables'),
      // 宿主专用入口（插件缓存作用域工厂等），必须写在包入口别名之前，否则会被前缀匹配成 dist/index.js/host
      '@ztools/declarative-ui/host': path.resolve(__dirname, '../packages/declarative-ui/dist/host/index.js'),
      '@ztools/declarative-ui': path.resolve(__dirname, '../packages/declarative-ui/dist/index.js'),
      '@ztools/raycast-compat': path.resolve(__dirname, '../packages/declarative-ui/dist/index.js')
    }
  }
})

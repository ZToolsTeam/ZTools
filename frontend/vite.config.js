import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import Components from 'unplugin-vue-components/vite'
import { AntDesignVueResolver } from 'unplugin-vue-components/resolvers'
import { existsSync, rmSync } from 'fs'

import cefIpcWatch from './vite-plugin-cef-ipc-watch.js'

// 版本能力入口 @edition：官方构建带有 src/commercial/edition.js 时用官方版，开源仓库没有该目录时用开源版
const commercialEditionEntry = path.resolve(__dirname, 'src/commercial/edition.js')
const hasCommercialEdition = existsSync(commercialEditionEntry)
const editionEntry = hasCommercialEdition
  ? commercialEditionEntry
  : path.resolve(__dirname, 'src/edition-oss/index.js')
const editionLocalesEntry = hasCommercialEdition
  ? path.resolve(__dirname, 'src/commercial/locales/index.js')
  : path.resolve(__dirname, 'src/edition-oss/locales.js')

/**
 * 开发服务器的 /api 代理目标：由 ZTOOLS_DEV_API_PROXY_TARGET 指定（环境变量或 .env.development，
 * 官方后台地址只在官方构建的 .env 文件里配置，源码不写死）；未配置时不设代理，开发版按单机模式运行。
 * 只有官方版访问后台，开源版不设代理
 */
function resolveDevProxy(mode) {
  if (!hasCommercialEdition) return undefined
  const env = loadEnv(mode, __dirname, 'ZTOOLS_')
  const target = String(process.env.ZTOOLS_DEV_API_PROXY_TARGET || env.ZTOOLS_DEV_API_PROXY_TARGET || '').trim()
  if (!/^https?:\/\//i.test(target)) return undefined
  return {
    '/api': {
      target,
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/api/, '')
    }
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [
    vue(),
    Components({
      // 前端为纯 JS 工程（无 tsconfig），类型声明文件没有用处，且每次构建都会留下未跟踪的 components.d.ts
      dts: false,
      resolvers: [
        AntDesignVueResolver({
          importStyle: false // Ant Design Vue 4.x uses CSS-in-JS
        })
      ]
    }),
    cefIpcWatch(),
    {
      name: 'cleanup-dist-js',
      closeBundle() {
        // 删除 dist/js 目录（public/js 是 cef-ipc 源码，打包无意义）
        const distJsDir = path.resolve(__dirname, 'dist/js')
        if (existsSync(distJsDir)) {
          rmSync(distJsDir, { recursive: true, force: true })
          console.log('🧹 已删除 dist/js 目录（cef-ipc 源码无需打包）')
        }
      }
    }
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // 词条别名必须在 @edition 之前，避免前缀匹配到 edition 入口并消除与 @/i18n 的循环依赖
      '@edition-locales': editionLocalesEntry,
      '@edition': editionEntry,
      // 宿主专用入口（插件缓存作用域工厂等），必须写在包入口别名之前，否则会被前缀匹配成 dist/index.js/host
      '@ztools/declarative-ui/host': path.resolve(__dirname, '../packages/declarative-ui/dist/host/index.js'),
      '@ztools/declarative-ui': path.resolve(__dirname, '../packages/declarative-ui/dist/index.js'),
      '@ztools/raycast-compat': path.resolve(__dirname, '../packages/declarative-ui/dist/index.js')
    }
  },
  optimizeDeps: {
    exclude: ['@ztools/declarative-ui', 'react']
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    sourcemap: true // 开启源码映射，方便调试
  },
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: resolveDevProxy(mode)
  }
}))

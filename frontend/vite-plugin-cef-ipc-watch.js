// Vite 插件: 监听 cef-ipc 源文件变化并自动重新构建
import { spawn } from 'child_process'
import { watch, existsSync, copyFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

export default function cefIpcWatch() {
  let watchers = []
  let buildTimeout = null
  let isBuilding = false

  return {
    name: 'cef-ipc-watch',
    configureServer(server) {
      // 监听 cef-ipc/src 目录
      const srcDir = resolve(__dirname, 'public/js/cef-ipc/src')
      const buildScript = resolve(__dirname, 'public/js/cef-ipc/build.cjs')

      // 检查目录是否存在
      if (!existsSync(srcDir)) {
        console.warn(`⚠️  cef-ipc 源目录不存在: ${srcDir}`)
        return
      }

      if (!existsSync(buildScript)) {
        console.warn(`⚠️  构建脚本不存在: ${buildScript}`)
        return
      }

      console.log('🔍 开始监听 cef-ipc 源文件变化...')
      console.log(`📁 监听目录: ${srcDir}`)

      // 执行构建的函数
      function runBuild() {
        if (isBuilding) {
          return
        }

        isBuilding = true
        console.log('🔨 正在重新构建 cef-ipc...\n')

        const buildProcess = spawn('node', [buildScript], {
          stdio: 'inherit',
          shell: false
        })

        buildProcess.on('close', (code) => {
          isBuilding = false
          if (code === 0) {
            console.log('✅ cef-ipc 重新构建完成\n')

            // 复制 SDK 文件到多个目录
            const sdkFiles = ['ztools-api.js', 'plugin-sdk.js']

            sdkFiles.forEach((filename) => {
              const sourceFile = resolve(__dirname, `public/sdk/${filename}`)

              if (existsSync(sourceFile)) {
                const copyTargets = [
                  // bin/WebResources/sdk 目录
                  {
                    path: resolve(
                      __dirname,
                      `../bin/WebResources/sdk/${filename}`
                    ),
                    desc: 'bin/WebResources/sdk'
                  },
                  // create-plugin/public/sdk 目录
                  {
                    path: resolve(
                      __dirname,
                      `../plugins/create-plugin/public/sdk/${filename}`
                    ),
                    desc: 'plugins/create-plugin/public/sdk'
                  }
                ]

                copyTargets.forEach((target) => {
                  try {
                    mkdirSync(resolve(target.path, '..'), { recursive: true })
                    copyFileSync(sourceFile, target.path)
                    console.log(`✅ 已同步 ${filename} 到 ${target.desc}`)
                  } catch (err) {
                    console.warn(
                      `⚠️ 复制 ${filename} 到 ${target.desc} 失败:`,
                      err.message
                    )
                  }
                })
              }
            })
            console.log('')

            // 触发 Vite HMR 重新加载
            if (server.ws) {
              server.ws.send({
                type: 'full-reload'
              })
            }
          } else {
            console.error(`❌ cef-ipc 构建失败，退出码: ${code}\n`)
          }
        })

        buildProcess.on('error', (err) => {
          isBuilding = false
          console.error('❌ 构建进程错误:', err)
        })
      }

      // 使用 fs.watch 递归监听目录
      function watchDirectory(dir) {
        try {
          const w = watch(dir, { recursive: true }, (eventType, filename) => {
            if (
              filename &&
              (filename.endsWith('.js') || filename.endsWith('.cjs'))
            ) {
              // 防抖: 500ms 内的多次变化只触发一次构建
              if (buildTimeout) {
                clearTimeout(buildTimeout)
              }

              buildTimeout = setTimeout(() => {
                console.log(`\n🔄 检测到 cef-ipc 文件变化: ${filename}`)
                runBuild()
              }, 500)
            }
          })

          w.on('error', (err) => {
            console.error('❌ 文件监听错误:', err)
          })

          return w
        } catch (err) {
          console.error('❌ 无法监听目录:', err)
          return null
        }
      }

      // 开始监听源目录
      const srcWatcher = watchDirectory(srcDir)
      if (srcWatcher) {
        watchers.push(srcWatcher)
      }

      // 监听构建脚本本身的变化
      const buildScriptWatcher = watch(buildScript, () => {
        console.log('\n🔄 检测到 build.cjs 变化')
        runBuild()
      })

      buildScriptWatcher.on('error', (err) => {
        console.error('❌ 构建脚本监听错误:', err)
      })

      watchers.push(buildScriptWatcher)

      // 清理函数
      const cleanup = () => {
        watchers.forEach((w) => {
          try {
            w.close()
          } catch (err) {
            // 忽略清理错误
          }
        })
        watchers = []
        if (buildTimeout) {
          clearTimeout(buildTimeout)
        }
      }

      server.httpServer?.once('close', cleanup)
    }
  }
}

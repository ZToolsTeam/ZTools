import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginConfig, TemplateType } from './types.js'

// 颜色工具函数 (无需外部依赖)
export const colors = {
  reset: (text: string) => `\x1b[0m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  dim: (text: string) => `\x1b[2m${text}\x1b[22m`,
  red: (text: string) => `\x1b[31m${text}\x1b[39m`,
  green: (text: string) => `\x1b[32m${text}\x1b[39m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[39m`,
  blue: (text: string) => `\x1b[34m${text}\x1b[39m`,
  magenta: (text: string) => `\x1b[35m${text}\x1b[39m`,
  cyan: (text: string) => `\x1b[36m${text}\x1b[39m`,
  gray: (text: string) => `\x1b[90m${text}\x1b[39m`
}

export const SUPPORTED_TEMPLATES: TemplateType[] = ['declarative', 'vue-vite', 'react-vite', 'preload-only']

/**
 * 校验插件 ID 规则 (必须以小写字母开头，只含小写字母、数字和连字符)
 */
export function validatePluginId(id: string): { valid: boolean; message?: string } {
  if (!id || typeof id !== 'string') {
    return { valid: false, message: '插件 ID 不能为空' }
  }
  const trimmed = id.trim()
  if (!/^[a-z][a-z0-9-]*$/.test(trimmed)) {
    return {
      valid: false,
      message: '插件 ID 必须以小写字母开头，且只能包含小写字母、数字和连字符 (如 my-tool)'
    }
  }
  return { valid: true }
}

/**
 * 替换模板占位符
 */
export function renderTemplateContent(content: string, config: PluginConfig): string {
  return content
    .replaceAll('{{ID}}', config.id)
    .replaceAll('{{NAME}}', config.name)
    .replaceAll('{{AUTHOR}}', config.author)
    .replaceAll('{{DESCRIPTION}}', config.description)
}

/**
 * 获取模板根目录路径
 */
export function getTemplatesDir(): string {
  // 兼顾在 src 源码目录运行与在 dist 编译目录运行
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const candidate1 = resolve(currentDir, '../templates')
  if (existsSync(candidate1)) {
    return candidate1
  }
  const candidate2 = resolve(currentDir, '../../templates')
  if (existsSync(candidate2)) {
    return candidate2
  }
  return candidate1
}

const TEXT_FILE_EXTENSIONS = new Set([
  '.json', '.js', '.ts', '.jsx', '.tsx', '.vue',
  '.html', '.css', '.md', '.svg', '.txt', '.yaml', '.yml'
])

/**
 * 递归复制并渲染模板目录
 */
export function copyAndRenderTemplate(
  sourceDir: string,
  targetDir: string,
  config: PluginConfig
): string[] {
  const generatedFiles: string[] = []

  function copyDir(currentSource: string, currentTarget: string) {
    if (!existsSync(currentTarget)) {
      mkdirSync(currentTarget, { recursive: true })
    }

    const entries = readdirSync(currentSource)
    for (const entry of entries) {
      const srcPath = join(currentSource, entry)
      const destPath = join(currentTarget, entry)
      const stats = statSync(srcPath)

      if (stats.isDirectory()) {
        copyDir(srcPath, destPath)
      } else {
        const ext = entry.includes('.') ? entry.slice(entry.lastIndexOf('.')).toLowerCase() : ''
        if (TEXT_FILE_EXTENSIONS.has(ext)) {
          let text = readFileSync(srcPath, 'utf8')
          text = renderTemplateContent(text, config)
          // 保持统一 LF 换行符
          text = text.replaceAll('\r\n', '\n')
          writeFileSync(destPath, text, 'utf8')
        } else {
          // 二进制文件直接复制
          const data = readFileSync(srcPath)
          writeFileSync(destPath, data)
        }
        generatedFiles.push(destPath)
      }
    }
  }

  copyDir(sourceDir, targetDir)
  return generatedFiles
}

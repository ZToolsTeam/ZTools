import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// 改版删变量时漏掉引用，浏览器不会报错，只会让间距、圆角、阴影悄悄变成 0；这里静态兜底
const SRC = path.resolve(__dirname, '../../..')
const EXT = /\.(vue|css|scss|js|ts)$/

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (EXT.test(entry.name)) out.push(full)
  }
  return out
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

function scan() {
  const defined = new Set()
  const used = new Map()
  for (const file of walk(SRC)) {
    const text = stripComments(fs.readFileSync(file, 'utf8'))
    for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1])
    for (const m of text.matchAll(/setProperty\(\s*['"](--[\w-]+)/g)) defined.add(m[1])
    // 带兜底值的 var(--x, …) 与模板拼接的动态名（如 --rc-h-${hue}）不算缺失
    for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*(,|\$|\))/g)) {
      if (m[2] !== ')' || m[1].endsWith('-')) continue
      if (!used.has(m[1])) used.set(m[1], new Set())
      used.get(m[1]).add(path.relative(SRC, file))
    }
  }
  return { defined, used }
}

describe('CSS 变量引用完整性', () => {
  it('每个无兜底值引用的 CSS 变量都有定义', () => {
    const { defined, used } = scan()
    const missing = [...used.entries()]
      .filter(([name]) => !defined.has(name))
      .map(([name, files]) => `${name} ← ${[...files].join(', ')}`)
    expect(missing).toEqual([])
  })

  it('改版恢复的间距尺度在亮色根作用域定义，暗色主题不需要重复', () => {
    const theme = fs.readFileSync(path.join(SRC, 'assets/css/theme.css'), 'utf8')
    for (const token of ['--spacing-xs', '--spacing-sm', '--spacing-md', '--spacing-lg', '--radius-xl', '--shadow-lg']) {
      expect(theme).toContain(`${token}:`)
    }
  })
})

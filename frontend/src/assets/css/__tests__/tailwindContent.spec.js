// @vitest-environment node
/**
 * Tailwind 扫描范围：测试文件不参与生成 CSS。
 * 内部仓库有只属于官方版的测试（开源导出时去掉），如果被扫进来，内部构建与「公开源码 + 闭源覆盖层」构建的 CSS 会不一致。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { afterEach, describe, expect, it } from 'vitest'
import config from '../../../../tailwind.config.js'

const tmpDirs = []
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** 在临时目录里按配置的扫描规则生成 utilities，返回 CSS 文本 */
async function buildUtilities(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-tailwind-content-'))
  tmpDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  // 配置里的路径相对 frontend 目录，这里换成临时目录下的同名路径
  const content = config.content.map((p) => (p.startsWith('!') ? `!${path.join(root, p.slice(1))}` : path.join(root, p)))
  const result = await postcss([tailwindcss({ ...config, content })]).process('@tailwind utilities;', { from: undefined })
  return result.css
}

describe('tailwind content', () => {
  it('配置排除 __tests__ 目录与 spec/test 文件', () => {
    expect(config.content).toContain('!./src/**/__tests__/**')
    expect(config.content.some((p) => p.startsWith('!') && p.includes('spec'))).toBe(true)
    expect(config.content.some((p) => p.startsWith('!') && p.includes('test}'))).toBe(true)
  })

  it('页面与组件里的类照常生成，测试文件里独有的类不生成', async () => {
    const css = await buildUtilities({
      'index.html': '<div class="grid"></div>',
      'src/App.vue': '<template><div class="flex"></div></template>',
      'src/utils/helper.js': "export const cls = 'italic'",
      'src/commercial/__tests__/only.spec.js': "const cls = '!relative'",
      'src/pages/__tests__/deep/nested.js': "const cls = 'underline'",
      'src/components/Button.spec.js': "const cls = 'uppercase'",
      'src/components/Button.test.ts': "const cls = 'lowercase'"
    })
    expect(css).toMatch(/\.grid\s*\{/)
    expect(css).toMatch(/\.flex\s*\{/)
    expect(css).toMatch(/\.italic\s*\{/)
    expect(css).not.toContain('\\!relative')
    expect(css).not.toMatch(/\.underline\s*\{/)
    expect(css).not.toMatch(/\.uppercase\s*\{/)
    expect(css).not.toMatch(/\.lowercase\s*\{/)
  })

  it('普通源码里出现的类即使测试文件也用到，仍然生成（不会误删）', async () => {
    const css = await buildUtilities({
      'src/App.vue': '<template><div class="relative"></div></template>',
      'src/components/__tests__/App.spec.js': "const cls = 'relative'"
    })
    expect(css).toMatch(/\.relative\s*\{/)
  })
})

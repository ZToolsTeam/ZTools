import { existsSync, rmSync, mkdirSync } from 'node:fs'
import { resolve, basename, join } from 'node:path'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import type { PluginConfig, TemplateType, CliOptions, GenerateResult } from './types.js'
import {
  colors,
  SUPPORTED_TEMPLATES,
  validatePluginId,
  getTemplatesDir,
  copyAndRenderTemplate
} from './utils.js'

export const CLI_VERSION = '1.0.0'

/**
 * 解析命令行参数
 */
export function parseArgs(rawArgs: string[]): { targetDir?: string; options: CliOptions } {
  const options: CliOptions = {}
  let targetDir: string | undefined

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]

    if (arg === '-h' || arg === '--help') {
      options.help = true
    } else if (arg === '-v' || arg === '--version') {
      options.version = true
    } else if (arg === '-y' || arg === '--yes') {
      options.yes = true
    } else if (arg === '--overwrite') {
      options.overwrite = true
    } else if (arg === '--id' && i + 1 < rawArgs.length) {
      options.id = rawArgs[++i]
    } else if (arg === '--name' && i + 1 < rawArgs.length) {
      options.name = rawArgs[++i]
    } else if (arg === '--author' && i + 1 < rawArgs.length) {
      options.author = rawArgs[++i]
    } else if (arg === '--description' && i + 1 < rawArgs.length) {
      options.description = rawArgs[++i]
    } else if ((arg === '-t' || arg === '--template') && i + 1 < rawArgs.length) {
      options.template = rawArgs[++i]
    } else if (!arg.startsWith('-') && !targetDir) {
      targetDir = arg
    }
  }

  return { targetDir, options }
}

/**
 * 打印帮助信息
 */
export function printHelp(): void {
  console.log(`
${colors.bold(colors.cyan('create-ztools-plugin'))} v${CLI_VERSION}
${colors.dim('官方 ZTools 插件脚手架工具')}

${colors.bold('用法:')}
  create-ztools-plugin [目标目录] [选项]

${colors.bold('选项:')}
  --id <id>                 插件唯一 ID (小写字母开头，只含小写字母、数字与连字符)
  --name <name>             插件显示名称
  --author <author>         插件作者
  --description <desc>      插件功能描述
  -t, --template <type>     模板类型 (${SUPPORTED_TEMPLATES.join(' | ')})
  -y, --yes                 使用默认值直接生成，不进行交互询问
  --overwrite               目标目录已存在时强制覆盖
  -v, --version             显示脚手架版本号
  -h, --help                显示帮助信息

${colors.bold('示例:')}
  npx create-ztools-plugin my-plugin
  npx create-ztools-plugin my-plugin --template vue-vite -y
  npx create-ztools-plugin my-tool --template preload-only --id my-tool --name "我的快速功能"
`)
}

/**
 * 核心创建插件函数 (支持编程调用与 CLI 调用)
 */
export async function createPlugin(
  customConfig: Partial<PluginConfig> & { overwrite?: boolean; silent?: boolean }
): Promise<GenerateResult> {
  const targetDir = resolve(process.cwd(), customConfig.targetDir || customConfig.id || 'my-ztools-plugin')
  const pluginId = customConfig.id || basename(targetDir).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'my-plugin'

  const idValidation = validatePluginId(pluginId)
  if (!idValidation.valid) {
    throw new Error(idValidation.message)
  }

  const template: TemplateType = customConfig.template || 'declarative'
  if (!SUPPORTED_TEMPLATES.includes(template)) {
    throw new Error(`不支持的模板类型: ${template}，可选值: ${SUPPORTED_TEMPLATES.join(', ')}`)
  }

  const config: PluginConfig = {
    id: pluginId,
    name: customConfig.name || pluginId,
    author: customConfig.author || 'ZTools Developer',
    description: customConfig.description || '基于 ZTools 官方脚手架创建的插件',
    template,
    targetDir
  }

  // 检查目标目录
  if (existsSync(targetDir)) {
    if (customConfig.overwrite) {
      rmSync(targetDir, { recursive: true, force: true })
    } else {
      throw new Error(`目标目录已存在: ${targetDir}。若要覆盖请使用 --overwrite 选项。`)
    }
  }

  mkdirSync(targetDir, { recursive: true })

  const templatesRoot = getTemplatesDir()
  const sourceTemplateDir = join(templatesRoot, template)

  if (!existsSync(sourceTemplateDir)) {
    throw new Error(`未找到模板源目录: ${sourceTemplateDir}`)
  }

  const generatedFiles = copyAndRenderTemplate(sourceTemplateDir, targetDir, config)

  if (!customConfig.silent) {
    console.log()
    console.log(colors.green(`✨ 插件工程创建成功！`))
    console.log(`📁 路径: ${colors.cyan(targetDir)}`)
    console.log(`🎨 模板: ${colors.yellow(template)}`)
    console.log(`🆔 插件 ID: ${colors.cyan(config.id)}`)
    console.log()
    console.log('下一步操作:')
    console.log(`  cd ${basename(targetDir)}`)
    console.log('  npm install')
    console.log('  npm run dev')
    console.log()
  }

  return {
    success: true,
    targetDir,
    config,
    files: generatedFiles
  }
}

/**
 * 命令行交互主流程
 */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { targetDir: inputTarget, options } = parseArgs(argv)

  if (options.help) {
    printHelp()
    return
  }

  if (options.version) {
    console.log(`create-ztools-plugin v${CLI_VERSION}`)
    return
  }

  console.log()
  console.log(colors.bold(colors.cyan('🚀 欢迎使用 ZTools 官方插件脚手架 create-ztools-plugin')))
  console.log()

  let finalTargetDir = inputTarget || options.id || ''
  let id = options.id || (inputTarget ? basename(inputTarget) : '')
  let name = options.name || ''
  let author = options.author || ''
  let description = options.description || ''
  let template = options.template as TemplateType | undefined
  let overwrite = options.overwrite || false

  if (options.yes) {
    // 快速非交互模式
    if (!id) id = 'my-ztools-plugin'
    if (!name) name = id
    if (!author) author = 'ZTools Developer'
    if (!description) description = '基于 ZTools 官方脚手架创建的插件'
    if (!template) template = 'declarative'
    if (!finalTargetDir) finalTargetDir = id
  } else {
    // 交互模式
    const rl = readline.createInterface({ input, output })

    try {
      // 1. 目标目录 / 插件 ID
      while (!id || !validatePluginId(id).valid) {
        const defaultId = finalTargetDir || 'my-ztools-plugin'
        const answer = await rl.question(
          `${colors.bold('?')} 插件 ID (${colors.dim('以小写字母开头，只含小写字母、数字和连字符')}) [${defaultId}]: `
        )
        id = answer.trim() || defaultId
        const validation = validatePluginId(id)
        if (!validation.valid) {
          console.log(colors.red(`  ✖ ${validation.message}`))
          id = ''
        }
      }

      if (!finalTargetDir) {
        finalTargetDir = id
      }

      // 2. 插件名称
      const defaultName = name || id
      const nameAnswer = await rl.question(
        `${colors.bold('?')} 插件名称 (${colors.dim('展示名称')}) [${defaultName}]: `
      )
      name = nameAnswer.trim() || defaultName

      // 3. 作者
      const defaultAuthor = author || 'ZTools Developer'
      const authorAnswer = await rl.question(
        `${colors.bold('?')} 作者 [${defaultAuthor}]: `
      )
      author = authorAnswer.trim() || defaultAuthor

      // 4. 描述
      const defaultDesc = description || '基于 ZTools 官方脚手架创建的插件'
      const descAnswer = await rl.question(
        `${colors.bold('?')} 插件描述 [${defaultDesc}]: `
      )
      description = descAnswer.trim() || defaultDesc

      // 5. 模板选择
      if (!template || !SUPPORTED_TEMPLATES.includes(template)) {
        console.log(`${colors.bold('?')} 选择插件模板:`)
        console.log(`  1) ${colors.green('declarative')}  ${colors.dim('(推荐: ZTools 声明式架构，零 CSS，纯 TypeScript)')}`)
        console.log(`  2) ${colors.cyan('vue-vite')}     ${colors.dim('(传统兼容: Vue 3 + Vite + TypeScript)')}`)
        console.log(`  3) ${colors.cyan('react-vite')}   ${colors.dim('(传统兼容: React 18 + Vite + TypeScript)')}`)
        console.log(`  4) ${colors.cyan('preload-only')} ${colors.dim('(纯无 UI 快速功能插件)')}`)

        const templateAnswer = await rl.question(`${colors.bold('?')} 请输入序号 (1-4) [1]: `)
        const choice = templateAnswer.trim()
        if (choice === '2' || choice === 'vue-vite') {
          template = 'vue-vite'
        } else if (choice === '3' || choice === 'react-vite') {
          template = 'react-vite'
        } else if (choice === '4' || choice === 'preload-only') {
          template = 'preload-only'
        } else {
          template = 'declarative'
        }
      }

      // 6. 检查目录是否已存在
      const resolvedTarget = resolve(process.cwd(), finalTargetDir)
      if (existsSync(resolvedTarget) && !overwrite) {
        const overwriteAnswer = await rl.question(
          `${colors.yellow('!')} 目标目录 ${colors.bold(finalTargetDir)} 已存在，是否覆盖？ (y/N) [n]: `
        )
        overwrite = overwriteAnswer.trim().toLowerCase() === 'y'
        if (!overwrite) {
          console.log(colors.yellow('操作已取消。'))
          return
        }
      }
    } finally {
      rl.close()
    }
  }

  await createPlugin({
    id,
    name,
    author,
    description,
    template,
    targetDir: finalTargetDir,
    overwrite
  })
}

// 自动识别是否为主入口运行
const isMain = process.argv[1] && (
  process.argv[1].endsWith('create-ztools-plugin') ||
  process.argv[1].endsWith('index.ts') ||
  process.argv[1].endsWith('index.js')
)

if (isMain) {
  runCli().catch((err) => {
    console.error(colors.red(`\n✖ 创建失败: ${err.message}\n`))
    process.exit(1)
  })
}

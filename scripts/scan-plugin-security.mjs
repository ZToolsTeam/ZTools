#!/usr/bin/env node

/**
 * scan-plugin-security.mjs
 * ZTools GitOps 插件安全 AST 扫描器与 Two-Man Rule 门禁
 *
 * 功能：
 * 1. 扫描插件源码抽象语法树 (AST)；
 * 2. 严禁动态 eval()、动态 new Function()、十六进制字符串混淆、未声明的 Node 原生模块；
 * 3. 对高危敏感权限（如 network、child_process）自动标记触发双人人工审查 (Two-Man Rule)；
 * 4. 具备 CLI 命令行独立运行与库模块调用能力。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  validatePluginManifest,
  HIGH_RISK_PERMISSIONS,
  PERMISSION_NODE_MODULE_MAP,
  NODE_BUILTIN_MODULES
} from '../packages/ztools-plugins-spec/src/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

// 动态解析 acorn 与 @babel/parser
let cachedAcorn = null
let cachedBabel = null

async function getAcorn() {
  if (cachedAcorn) return cachedAcorn
  const candidates = [
    'acorn',
    pathToFileURL(path.join(rootDir, 'frontend/node_modules/acorn/dist/acorn.mjs')).href,
    pathToFileURL(path.join(rootDir, 'plugins/create-plugin/node_modules/acorn/dist/acorn.mjs')).href,
    pathToFileURL(path.join(rootDir, 'node_modules/acorn/dist/acorn.mjs')).href
  ]
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate)
      cachedAcorn = mod.default || mod
      return cachedAcorn
    } catch {}
  }
  return null
}

async function getBabelParser() {
  if (cachedBabel) return cachedBabel
  const candidates = [
    '@babel/parser',
    pathToFileURL(path.join(rootDir, 'frontend/node_modules/@babel/parser/lib/index.js')).href,
    pathToFileURL(path.join(rootDir, 'node_modules/@babel/parser/lib/index.js')).href
  ]
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate)
      cachedBabel = mod.default || mod
      return cachedBabel
    } catch {}
  }
  return null
}

/**
 * 递归遍历目录获取需要扫描的脚本、页面及样式文件
 */
function collectPluginFiles(dir) {
  const scriptFiles = []
  const styleFiles = []

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', '.build-runs', '.test-runs', 'tests', '__tests__'].includes(entry.name)) {
          continue
        }
        walk(fullPath)
      } else if (entry.isFile()) {
        if (entry.name.includes('.test.') || entry.name.includes('.spec.')) {
          continue
        }
        const ext = path.extname(entry.name).toLowerCase()
        if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.htm'].includes(ext)) {
          scriptFiles.push(fullPath)
        } else if (['.css', '.less', '.scss', '.sass', '.styl'].includes(ext)) {
          styleFiles.push(fullPath)
        }
      }
    }
  }

  walk(dir)
  return { scriptFiles, styleFiles }
}

/**
 * 递归遍历目录获取需要扫描的脚本及页面文件 (向后兼容)
 */
function collectScannableFiles(dir, fileList = []) {
  const { scriptFiles } = collectPluginFiles(dir)
  return scriptFiles
}

/**
 * 从 HTML 文件中提取 <script> 标签中的 JS 内容
 */
function extractScriptsFromHtml(htmlContent) {
  const scripts = []
  const scriptRegex = /<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi
  let match
  while ((match = scriptRegex.exec(htmlContent)) !== null) {
    const content = match[1]
    if (content && content.trim().length > 0) {
      // 估算行号
      const prefix = htmlContent.substring(0, match.index)
      const lineOffset = prefix.split('\n').length
      scripts.push({
        code: content,
        lineOffset
      })
    }
  }
  return scripts
}

/**
 * 通用 AST 节点遍历器
 */
function traverse(node, visitor, parent = null) {
  if (!node || typeof node !== 'object') return
  visitor(node, parent)

  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'comments') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === 'object') {
          traverse(item, visitor, node)
        }
      }
    } else if (child && typeof child === 'object') {
      traverse(child, visitor, node)
    }
  }
}

/**
 * 扫描单个代码片段的 AST
 */
async function scanCodeAst({
  code,
  filePath,
  relPath,
  lineOffset = 0,
  declaredPermissions = new Set(),
  violations,
  twoManReviewReasons
}) {
  const acorn = await getAcorn()
  const babelParser = await getBabelParser()

  let ast = null
  let parseMethod = ''

  if (acorn) {
    try {
      ast = acorn.parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        locations: true
      })
      parseMethod = 'acorn-module'
    } catch {
      try {
        ast = acorn.parse(code, {
          ecmaVersion: 'latest',
          sourceType: 'script',
          locations: true
        })
        parseMethod = 'acorn-script'
      } catch {}
    }
  }

  if (!ast && babelParser) {
    try {
      ast = babelParser.parse(code, {
        sourceType: 'unambiguous',
        plugins: ['typescript', 'jsx']
      })
      parseMethod = 'babel'
    } catch (babelErr) {
      violations.push({
        rule: 'SYNTAX_PARSE_ERROR',
        severity: 'error',
        file: relPath,
        line: (babelErr.loc?.line || 1) + lineOffset,
        column: babelErr.loc?.column || 0,
        message: `语法解析失败: ${babelErr.message}`
      })
      return
    }
  }

  if (!ast) {
    violations.push({
      rule: 'NO_PARSER_AVAILABLE',
      severity: 'error',
      file: relPath,
      line: 1,
      column: 0,
      message: '无法初始化 JS AST 解析器 (acorn / @babel/parser)'
    })
    return
  }

  // 1. 扫描十六进制混淆字符串特征 (Hex string obfuscation detection)
  // 检查源码文本中密集出现的十六进制转义序列 \x.. 或混淆特征标识符 _0x....
  const hexEscapeRegex = /\\x[0-9a-fA-F]{2}/g
  const hexMatches = code.match(hexEscapeRegex) || []
  if (hexMatches.length >= 2) {
    // 检查是否存在典型的混淆十六进制字符串
    violations.push({
      rule: 'HEX_STRING_OBFUSCATION',
      severity: 'error',
      file: relPath,
      line: 1 + lineOffset,
      column: 0,
      message: `检测到十六进制转义混淆特征 (包含 ${hexMatches.length} 处 \\x.. 转义序列)，严禁在提交的插件中使用代码混淆`
    })
  }

  // 检查 obfuscator 特征变量标识符 (如 _0x1a2b, _0x5f9c 等)
  const obfuscatorVarRegex = /\b_0x[0-9a-fA-F]{4,8}\b/g
  const obfVarMatches = code.match(obfuscatorVarRegex) || []
  if (obfVarMatches.length >= 3) {
    violations.push({
      rule: 'OBFUSCATOR_VARIABLE_DETECTED',
      severity: 'error',
      file: relPath,
      line: 1 + lineOffset,
      column: 0,
      message: `检测到 javascript-obfuscator 特征变量命名 (${obfVarMatches.slice(0, 3).join(', ')}...)，严禁使用混淆打包工具`
    })
  }

  // 辅助函数：静态求值常量字符串表达式（如 "ev" + "al"）
  function evaluateStaticString(exprNode) {
    if (!exprNode) return null
    if (exprNode.type === 'Literal' && typeof exprNode.value === 'string') return exprNode.value
    if (exprNode.type === 'StringLiteral') return exprNode.value
    if (exprNode.type === 'BinaryExpression' && exprNode.operator === '+') {
      const left = evaluateStaticString(exprNode.left)
      const right = evaluateStaticString(exprNode.right)
      if (left !== null && right !== null) return left + right
    }
    return null
  }

  // 2. 遍历 AST 检查具体安全违规
  traverse(ast, (node, parent) => {
    const loc = node.loc ? {
      line: node.loc.start.line + lineOffset,
      column: node.loc.start.column
    } : { line: 1 + lineOffset, column: 0 }

    // --- A. 严禁动态 eval() 及其直接/间接引用 ---
    // 直接或间接引用标识符 eval（如 [eval][0]、const f = eval、foo(eval) 等）
    if (node.type === 'Identifier' && node.name === 'eval') {
      const isObjectKey = parent && parent.type === 'Property' && parent.key === node && !parent.computed
      const isStaticProp = parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed
      if (!isObjectKey && !isStaticProp) {
        violations.push({
          rule: 'BANNED_DYNAMIC_EVAL',
          severity: 'error',
          file: relPath,
          line: loc.line,
          column: loc.column,
          message: '严禁直接或间接引用动态 eval()'
        })
      }
    }

    // Member call: window.eval(...), globalThis.eval(...), window['ev'+'al'](...)
    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'MemberExpression'
    ) {
      const obj = node.callee.object
      const prop = node.callee.property
      const isWindowOrGlobal = obj && (
        (obj.type === 'Identifier' && ['window', 'globalThis', 'global', 'top', 'parent', 'self'].includes(obj.name)) ||
        obj.type === 'ThisExpression'
      )
      if (isWindowOrGlobal) {
        if (!node.callee.computed) {
          if (prop?.type === 'Identifier' && prop.name === 'eval') {
            violations.push({
              rule: 'BANNED_DYNAMIC_EVAL',
              severity: 'error',
              file: relPath,
              line: loc.line,
              column: loc.column,
              message: '严禁通过全局对象调用动态 eval()'
            })
          }
        } else {
          const staticVal = evaluateStaticString(prop)
          if (staticVal === 'eval') {
            violations.push({
              rule: 'BANNED_DYNAMIC_EVAL',
              severity: 'error',
              file: relPath,
              line: loc.line,
              column: loc.column,
              message: '严禁通过计算属性访问调用动态 eval()'
            })
          } else if (prop?.type === 'Identifier') {
            violations.push({
              rule: 'BANNED_DYNAMIC_EVAL',
              severity: 'error',
              file: relPath,
              line: loc.line,
              column: loc.column,
              message: `严禁通过全局对象的动态变量属性进行反射调用: window[${prop.name}]()`
            })
          }
        }
      }
    }

    // 数组间接包装调用: [eval][0](...)
    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'MemberExpression' &&
      node.callee.object?.type === 'ArrayExpression'
    ) {
      const hasEval = node.callee.object.elements.some(
        el => el && el.type === 'Identifier' && el.name === 'eval'
      )
      if (hasEval) {
        violations.push({
          rule: 'BANNED_DYNAMIC_EVAL',
          severity: 'error',
          file: relPath,
          line: loc.line,
          column: loc.column,
          message: '严禁通过数组包装间接调用 eval()'
        })
      }
    }

    // --- B. 严禁动态 new Function() / Function() 与原型链逃逸 ---
    if (
      (node.type === 'NewExpression' || node.type === 'CallExpression') &&
      node.callee
    ) {
      if (node.callee.type === 'Identifier' && node.callee.name === 'Function') {
        violations.push({
          rule: 'BANNED_DYNAMIC_FUNCTION',
          severity: 'error',
          file: relPath,
          line: loc.line,
          column: loc.column,
          message: '严禁使用 new Function() / Function() 动态编译构造代码'
        })
      }
      if (node.callee.type === 'MemberExpression') {
        const obj = node.callee.object
        const prop = node.callee.property
        const isWindowOrGlobal = obj && (
          (obj.type === 'Identifier' && ['window', 'globalThis', 'global'].includes(obj.name))
        )
        const staticProp = prop ? (prop.type === 'Identifier' ? prop.name : evaluateStaticString(prop)) : null
        if (isWindowOrGlobal && staticProp === 'Function') {
          violations.push({
            rule: 'BANNED_DYNAMIC_FUNCTION',
            severity: 'error',
            file: relPath,
            line: loc.line,
            column: loc.column,
            message: '严禁通过全局对象调用 Function() 动态编译构造代码'
          })
        }

        // 原型链逃逸: ({}).constructor.constructor(...)
        if (staticProp === 'constructor') {
          const innerObj = node.callee.object
          if (innerObj && innerObj.type === 'MemberExpression') {
            const innerProp = innerObj.property ? (innerObj.property.type === 'Identifier' ? innerObj.property.name : evaluateStaticString(innerObj.property)) : null
            if (innerProp === 'constructor') {
              violations.push({
                rule: 'BANNED_DYNAMIC_FUNCTION',
                severity: 'error',
                file: relPath,
                line: loc.line,
                column: loc.column,
                message: '严禁通过原型链 constructor.constructor 逃逸动态构造函数'
              })
            }
          }
        }
      }
    }

    // --- C. 严禁未声明的 Node 原生模块及动态计算 require ---
    let requiredModuleName = null

    // import ... from 'fs' / import 'node:fs'
    if (node.type === 'ImportDeclaration' && node.source) {
      requiredModuleName = node.source.value
    }
    // require(...)
    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      node.arguments
    ) {
      if (node.arguments.length > 0) {
        if (node.arguments[0].type === 'Literal' || node.arguments[0].type === 'StringLiteral') {
          requiredModuleName = node.arguments[0].value
        } else {
          // 动态计算 require(...) 例如 require(Buffer.from(...)) 或 require(variable)
          violations.push({
            rule: 'BANNED_DYNAMIC_REQUIRE',
            severity: 'error',
            file: relPath,
            line: loc.line,
            column: loc.column,
            message: '严禁使用动态计算或非常量参数调用 require()，所有模块依赖必须为静态字符串字面量'
          })
        }
      }
    }
    // dynamic import('fs')
    if (
      (node.type === 'ImportExpression' || (node.type === 'CallExpression' && node.callee?.type === 'Import')) &&
      node.source &&
      (node.source.type === 'Literal' || node.source.type === 'StringLiteral')
    ) {
      requiredModuleName = node.source.value
    }

    if (requiredModuleName && typeof requiredModuleName === 'string') {
      const cleanMod = requiredModuleName.replace(/^node:/, '')
      if (NODE_BUILTIN_MODULES.has(cleanMod)) {
        const neededPerm = PERMISSION_NODE_MODULE_MAP[cleanMod]
        if (neededPerm) {
          if (!declaredPermissions.has(neededPerm)) {
            violations.push({
              rule: 'UNAUTHORIZED_NODE_MODULE',
              severity: 'error',
              file: relPath,
              line: loc.line,
              column: loc.column,
              message: `使用了未在 plugin.json 声明的 Node 原生模块 "${requiredModuleName}"，缺少 "${neededPerm}" 权限授权`
            })
          } else {
            // 如果已声明敏感权限，记录双人复核原因
            if (HIGH_RISK_PERMISSIONS.has(neededPerm)) {
              twoManReviewReasons.add(`代码引入了敏感原生模块 "${requiredModuleName}"（已声明 "${neededPerm}" 权限）`)
            }
          }
        }
      }
    }

    // --- D. 高危敏感操作探测与 Two-Man Rule 标记 ---
    // 检查网络请求调用 (fetch, XMLHttpRequest, WebSocket)
    if (node.type === 'CallExpression' && node.callee) {
      let isNetworkCall = false
      if (node.callee.type === 'Identifier' && node.callee.name === 'fetch') {
        isNetworkCall = true
      }
      if (
        node.callee.type === 'MemberExpression' &&
        node.callee.object?.name === 'window' &&
        node.callee.property?.name === 'fetch'
      ) {
        isNetworkCall = true
      }
      if (isNetworkCall) {
        if (!declaredPermissions.has('network')) {
          violations.push({
            rule: 'UNAUTHORIZED_NETWORK_CALL',
            severity: 'error',
            file: relPath,
            line: loc.line,
            column: loc.column,
            message: '代码中调用了 fetch() 网络请求，但未在 plugin.json 中声明 "network" 权限'
          })
        } else {
          twoManReviewReasons.add('代码中使用了 fetch() 网络请求能力（已声明 "network" 权限）')
        }
      }
    }

    if (node.type === 'NewExpression' && node.callee && node.callee.type === 'Identifier') {
      if (['XMLHttpRequest', 'WebSocket', 'EventSource'].includes(node.callee.name)) {
        if (!declaredPermissions.has('network')) {
          violations.push({
            rule: 'UNAUTHORIZED_NETWORK_CALL',
            severity: 'error',
            file: relPath,
            line: loc.line,
            column: loc.column,
            message: `代码中实例化了 ${node.callee.name} 网络连接，但未在 plugin.json 中声明 "network" 权限`
          })
        } else {
          twoManReviewReasons.add(`代码中使用了 ${node.callee.name} 网络能力（已声明 "network" 权限）`)
        }
      }
    }

    // 检查 child_process 细粒度执行调用
    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'MemberExpression'
    ) {
      const propName = node.callee.property?.name
      if (['exec', 'execSync', 'spawn', 'spawnSync', 'fork', 'execFile', 'execFileSync'].includes(propName)) {
        if (declaredPermissions.has('child_process')) {
          twoManReviewReasons.add(`代码中调用了进程执行方法 child_process.${propName}()`)
        } else {
          violations.push({
            rule: 'UNAUTHORIZED_PROCESS_EXECUTION',
            severity: 'error',
            file: relPath,
            line: loc.line,
            column: loc.column,
            message: `代码中调用了未授权的进程执行方法: ${propName}()，未声明 "child_process" 权限`
          })
        }
      }
    }

    // --- F. 纯声明式架构安全门禁：封杀动态样式注入与 DOM 样式操纵 ---
    // 1. 禁止 document.createElement('style') 或 document.createElement('link')
    if (
      node.type === 'CallExpression' &&
      node.callee &&
      node.callee.type === 'MemberExpression'
    ) {
      const obj = node.callee.object
      const prop = node.callee.property
      const isDocument = obj && obj.type === 'Identifier' && obj.name === 'document'
      const isCreateElement = prop && (
        (!node.callee.computed && prop.type === 'Identifier' && prop.name === 'createElement') ||
        (node.callee.computed && evaluateStaticString(prop) === 'createElement')
      )
      if (isDocument && isCreateElement && node.arguments?.length > 0) {
        const tagName = evaluateStaticString(node.arguments[0])
        if (tagName && ['style', 'link'].includes(tagName.toLowerCase())) {
          violations.push({
            rule: 'DISALLOWED_DOM_STYLE_INJECTION',
            severity: 'error',
            file: relPath,
            line: loc.line,
            column: loc.column,
            message: `严禁通过 document.createElement('${tagName}') 动态注入样式或外部样式表。ZTools 架构全面转向纯声明式，严禁插件操作 DOM 样式`
          })
        }
      }
    }

    // 2. 禁止 element.style.xxx = ... 或 element.style = ...
    if (node.type === 'AssignmentExpression') {
      const left = node.left
      if (left && left.type === 'MemberExpression') {
        const propName = !left.computed && left.property?.type === 'Identifier' ? left.property.name : evaluateStaticString(left.property)
        const isStyleDirect = propName === 'style'
        const isStyleSub = left.object?.type === 'MemberExpression' && (
          (!left.object.computed && left.object.property?.type === 'Identifier' && left.object.property.name === 'style') ||
          (left.object.computed && evaluateStaticString(left.object.property) === 'style')
        )
        if (isStyleDirect || isStyleSub) {
          violations.push({
            rule: 'DISALLOWED_DOM_STYLE_INJECTION',
            severity: 'error',
            file: relPath,
            line: loc.line,
            column: loc.column,
            message: `严禁在代码中直接修改 DOM 元素的 style 样式属性。ZTools 纯声明式架构禁止插件操纵原生样式`
          })
        }

        // 3. 禁止 innerHTML / outerHTML 注入 <style>
        if (['innerHTML', 'outerHTML'].includes(propName)) {
          const strVal = evaluateStaticString(node.right)
          if (strVal && /<style\b/i.test(strVal)) {
            violations.push({
              rule: 'DISALLOWED_DOM_STYLE_INJECTION',
              severity: 'error',
              file: relPath,
              line: loc.line,
              column: loc.column,
              message: `严禁通过 ${propName} 动态注入 <style> 样式标签。ZTools 纯声明式架构禁止插件操纵原生样式`
            })
          }
        }
      }
    }
  })
}

/**
 * 直接对一段内存代码进行 AST 安全分析
 * @param {string} code - 源代码片段
 * @param {string[]} [declaredPermissions] - 已声明权限列表
 * @returns {Promise<{
 *   passed: boolean,
 *   requiresTwoManReview: boolean,
 *   twoManReviewReasons: string[],
 *   violations: Array<{ rule: string, severity: string, file: string, line: number, column: number, message: string }>
 * }>}
 */
export async function scanCodeSnippet(code, declaredPermissions = []) {
  const violations = []
  const twoManReviewReasons = new Set()
  await scanCodeAst({
    code,
    filePath: 'snippet.js',
    relPath: 'snippet.js',
    lineOffset: 0,
    declaredPermissions: new Set(declaredPermissions),
    violations,
    twoManReviewReasons
  })
  const errors = violations.filter(v => v.severity === 'error')
  return {
    passed: errors.length === 0,
    requiresTwoManReview: twoManReviewReasons.size > 0,
    twoManReviewReasons: Array.from(twoManReviewReasons),
    violations
  }
}

/**
 * 执行完整的插件安全扫描
 * @param {string} pluginDir - 插件根目录
 * @param {object} [options]
 * @returns {Promise<{
 *   pluginId: string,
 *   passed: boolean,
 *   requiresTwoManReview: boolean,
 *   twoManReviewReasons: string[],
 *   violations: Array<{ rule: string, severity: string, file: string, line: number, column: number, message: string }>,
 *   scannedFiles: string[]
 * }>}
 */
export async function scanPluginSecurity(pluginDir, options = {}) {
  const absPluginDir = path.resolve(pluginDir)
  const manifestPath = path.join(absPluginDir, 'plugin.json')

  const violations = []
  const twoManReviewReasons = new Set()
  const scannedFiles = []

  // 1. 读取并校验 plugin.json
  if (!fs.existsSync(manifestPath)) {
    return {
      pluginId: path.basename(absPluginDir),
      passed: false,
      requiresTwoManReview: false,
      twoManReviewReasons: [],
      violations: [{
        rule: 'MISSING_PLUGIN_MANIFEST',
        severity: 'error',
        file: 'plugin.json',
        line: 1,
        column: 0,
        message: '找不到插件清单文件 plugin.json'
      }],
      scannedFiles: []
    }
  }

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    return {
      pluginId: path.basename(absPluginDir),
      passed: false,
      requiresTwoManReview: false,
      twoManReviewReasons: [],
      violations: [{
        rule: 'INVALID_JSON_MANIFEST',
        severity: 'error',
        file: 'plugin.json',
        line: 1,
        column: 0,
        message: `plugin.json 不是合法的 JSON 文件: ${err.message}`
      }],
      scannedFiles: []
    }
  }

  const pluginId = manifest.id || path.basename(absPluginDir)

  // 2. 校验清单 Schema 规范
  const schemaResult = validatePluginManifest(manifest, { baseDir: absPluginDir })
  if (!schemaResult.valid) {
    for (const errorMsg of schemaResult.errors) {
      violations.push({
        rule: 'MANIFEST_SCHEMA_VIOLATION',
        severity: 'error',
        file: 'plugin.json',
        line: 1,
        column: 0,
        message: errorMsg
      })
    }
  }

  const declaredPermissions = new Set(Array.isArray(manifest.permissions) ? manifest.permissions : [])

  // 检查清单声明的高危权限
  for (const perm of declaredPermissions) {
    if (HIGH_RISK_PERMISSIONS.has(perm)) {
      twoManReviewReasons.add(`声明了高危敏感系统权限: "${perm}"`)
    }
  }

  // 3. 收集并扫描全部文件（包含样式文件检查与脚本文件）
  const { scriptFiles, styleFiles } = collectPluginFiles(absPluginDir)

  // 严禁包含任意 .css / .less / .scss / .sass / .styl 样式文件
  for (const styleFile of styleFiles) {
    const relPath = path.relative(absPluginDir, styleFile).replace(/\\/g, '/')
    violations.push({
      rule: 'DISALLOWED_STYLE_FILE',
      severity: 'error',
      file: relPath,
      line: 1,
      column: 0,
      message: `检测到禁止的样式文件 "${relPath}"。ZTools 纯声明式插件架构严格禁止在扩展内编写自定义 CSS/LESS/SCSS 样式代码，视图必须完全通过 @ztools/raycast-compat 语义化组件由宿主统一渲染`
    })
  }

  for (const file of scriptFiles) {
    const relPath = path.relative(absPluginDir, file).replace(/\\/g, '/')
    scannedFiles.push(relPath)
    const content = fs.readFileSync(file, 'utf8')
    const ext = path.extname(file).toLowerCase()

    if (['.html', '.htm'].includes(ext)) {
      // 检查 HTML 中内嵌的 <style> 标签
      const styleTagRegex = /<style(?:\s+[^>]*)?>([\s\S]*?)<\/style>/gi
      let styleMatch
      while ((styleMatch = styleTagRegex.exec(content)) !== null) {
        const prefix = content.substring(0, styleMatch.index)
        const line = prefix.split('\n').length
        violations.push({
          rule: 'DISALLOWED_INLINE_STYLE',
          severity: 'error',
          file: relPath,
          line,
          column: 0,
          message: `检测到禁止的 <style> 样式标签。ZTools 纯声明式插件架构严格禁止在页面中内嵌自定义 CSS，视图必须完全由宿主沉浸式统一渲染`
        })
      }

      // 检查 HTML 中内联的 style 属性
      const inlineStyleRegex = /\bstyle\s*=\s*(["'])(?:(?!\1)[\s\S])*\1/gi
      let inlineMatch
      while ((inlineMatch = inlineStyleRegex.exec(content)) !== null) {
        const prefix = content.substring(0, inlineMatch.index)
        const line = prefix.split('\n').length
        violations.push({
          rule: 'DISALLOWED_INLINE_STYLE',
          severity: 'error',
          file: relPath,
          line,
          column: 0,
          message: `检测到禁止的内联 style 属性。ZTools 纯声明式插件架构严格禁止内联样式，视图必须完全由宿主沉浸式统一渲染`
        })
      }

      const inlineScripts = extractScriptsFromHtml(content)
      for (const script of inlineScripts) {
        await scanCodeAst({
          code: script.code,
          filePath: file,
          relPath,
          lineOffset: script.lineOffset,
          declaredPermissions,
          violations,
          twoManReviewReasons
        })
      }
    } else {
      await scanCodeAst({
        code: content,
        filePath: file,
        relPath,
        lineOffset: 0,
        declaredPermissions,
        violations,
        twoManReviewReasons
      })
    }
  }

  const errors = violations.filter(v => v.severity === 'error')
  const passed = errors.length === 0
  const requiresTwoManReview = twoManReviewReasons.size > 0

  return {
    pluginId,
    passed,
    requiresTwoManReview,
    twoManReviewReasons: Array.from(twoManReviewReasons),
    violations,
    scannedFiles
  }
}

/**
 * CLI 入口函数
 */
async function runCli() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
用法:
  node scripts/scan-plugin-security.mjs [插件目录或包含插件的根目录] [选项]

选项:
  --json           以 JSON 格式输出扫描结果
  --two-man-rule   检查是否触发人工双人审查 (Two-Man Rule) 门禁
  --help, -h       显示此帮助信息

示例:
  node scripts/scan-plugin-security.mjs
  node scripts/scan-plugin-security.mjs plugins/timestamp
  node scripts/scan-plugin-security.mjs plugins/ --json
    `.trim())
    process.exit(0)
  }

  const isJson = args.includes('--json')
  const targetPath = args.find(arg => !arg.startsWith('--')) || 'plugins'

  const resolvedTarget = path.resolve(targetPath)
  if (!fs.existsSync(resolvedTarget)) {
    console.error(`❌ 指定的路径不存在: ${resolvedTarget}`)
    process.exit(1)
  }

  // 检查是单个插件目录还是多插件根目录
  const isSinglePlugin = fs.existsSync(path.join(resolvedTarget, 'plugin.json'))
  const pluginDirs = []

  if (isSinglePlugin) {
    pluginDirs.push(resolvedTarget)
  } else {
    // 递归寻找包含 plugin.json 的子目录
    function findPluginDirs(dir) {
      if (fs.existsSync(path.join(dir, 'plugin.json'))) {
        pluginDirs.push(dir)
        return
      }
      const subEntries = fs.readdirSync(dir, { withFileTypes: true })
      for (const sub of subEntries) {
        if (sub.isDirectory() && !['node_modules', '.git', 'dist', '.build-runs', '.test-runs', 'create-plugin'].includes(sub.name)) {
          findPluginDirs(path.join(dir, sub.name))
        }
      }
    }
    findPluginDirs(resolvedTarget)
  }

  if (pluginDirs.length === 0) {
    console.error(`❌ 在 "${resolvedTarget}" 下未发现任何包含 plugin.json 的插件！`)
    process.exit(1)
  }

  const results = []
  let overallPassed = true

  for (const dir of pluginDirs) {
    const result = await scanPluginSecurity(dir)
    results.push(result)
    if (!result.passed) {
      overallPassed = false
    }
  }

  if (isJson) {
    console.log(JSON.stringify(isSinglePlugin ? results[0] : results, null, 2))
    process.exit(overallPassed ? 0 : 1)
  }

  // 格式化输出终端报告
  console.log('\n🔍 ================== ZTools 插件安全 AST 扫描报告 ==================')
  for (const res of results) {
    console.log(`\n📦 插件 ID: ${res.pluginId}`)
    console.log(`📁 扫描文件数: ${res.scannedFiles.length} (${res.scannedFiles.join(', ') || '无脚本文件'})`)

    if (res.passed) {
      console.log('✅ AST 安全静态分析: 全部通过 (PASS)')
    } else {
      console.log(`❌ AST 安全静态分析: 未通过 (FAILED) - 发现 ${res.violations.length} 项违规:`)
      for (const v of res.violations) {
        console.log(`   - [${v.rule}] ${v.file}:${v.line}:${v.column} -> ${v.message}`)
      }
    }

    if (res.requiresTwoManReview) {
      console.log('⚠️ 【Two-Man Rule 门禁触发】: 该插件包含高危权限或敏感系统操作，需双人代码复核通过后方可合并/发布:')
      for (const reason of res.twoManReviewReasons) {
        console.log(`   - 审核原因: ${reason}`)
      }
    } else {
      console.log('🛡️  无需触发人工双人审查 (标准安全级别)')
    }
  }
  console.log('\n======================================================================')

  if (!overallPassed) {
    console.error('\n❌ 扫描未通过：存在严重安全隐患，流水线中止！\n')
    process.exit(1)
  } else {
    console.log('\n🎉 所有插件安全门禁验证通过！\n')
    process.exit(0)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runCli().catch(err => {
    console.error('扫描发生异常:', err)
    process.exit(1)
  })
}

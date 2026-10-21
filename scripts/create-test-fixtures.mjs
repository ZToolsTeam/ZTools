import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CROSS_PLATFORM_TARGETS = [
  { id: 'windows-electron-any', platform: 'windows', runtime: 'electron', arch: 'any' },
  { id: 'macos-electron-any', platform: 'macos', runtime: 'electron', arch: 'any' }
]

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

// 1x1 透明 PNG base64
const iconBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

const fixtures = [
  {
    dir: path.join(rootDir, 'tests/fixtures/plugins/malicious-eval'),
    manifest: {
      id: 'malicious-eval',
      name: '恶意 Eval 插件',
      version: '1.0.0',
      description: '测试包含 eval 动态代码执行的样本',
      author: 'attacker',
      entry: 'index.html',
      icon: 'icon.png',
      permissions: ['clipboard']
    },
    code: "const payload = 'alert(1)';\neval(payload);\n"
  },
  {
    dir: path.join(rootDir, 'tests/fixtures/plugins/malicious-new-function'),
    manifest: {
      id: 'malicious-new-function',
      name: '恶意 Function 插件',
      version: '1.0.0',
      description: '测试包含 new Function 构造的样本',
      author: 'attacker',
      entry: 'index.html',
      icon: 'icon.png',
      permissions: ['dialog']
    },
    code: "const dynamicFn = new Function('a', 'return a * 2');\nconsole.log(dynamicFn(21));\n"
  },
  {
    dir: path.join(rootDir, 'tests/fixtures/plugins/malicious-hex-obfuscated'),
    manifest: {
      id: 'malicious-hex-obfuscated',
      name: '恶意混淆插件',
      version: '1.0.0',
      description: '测试包含十六进制字符串混淆的样本',
      author: 'attacker',
      entry: 'index.html',
      icon: 'icon.png',
      permissions: ['dialog']
    },
    code: 'const _0x1a2b = ["\\x65\\x76\\x61\\x6c", "\\x66\\x73", "\\x73\\x79\\x73\\x74\\x65\\x6d"];\nconst _0x3b4c = _0x1a2b[0];\nconsole.log(_0x3b4c);\n'
  },
  {
    dir: path.join(rootDir, 'tests/fixtures/plugins/unauthorized-fs'),
    manifest: {
      id: 'unauthorized-fs',
      name: '未授权文件系统插件',
      version: '1.0.0',
      description: '测试代码调用未声明的 fs 模块',
      author: 'attacker',
      entry: 'index.html',
      icon: 'icon.png',
      permissions: ['clipboard']
    },
    code: "import fs from 'fs';\nconst data = fs.readFileSync('secret.txt', 'utf8');\nconsole.log(data);\n"
  },
  {
    dir: path.join(rootDir, 'tests/fixtures/plugins/sensitive-network'),
    manifest: {
      id: 'sensitive-network',
      name: '天气查询插件',
      version: '1.0.0',
      description: '合规声明 network 权限的天气查询插件',
      author: 'weather-dev',
      entry: 'index.html',
      icon: 'icon.png',
      permissions: ['network', 'dialog']
    },
    code: "async function getWeather() {\n  const res = await fetch('https://api.weather.example.com/today');\n  return res.json();\n}\ngetWeather();\n"
  },
  {
    dir: path.join(rootDir, 'tests/fixtures/plugins/compliant-plugin'),
    manifest: {
      id: 'text-counter',
      name: '字数统计工具',
      version: '1.2.0',
      description: '本地快速统计中文字数、词频与字符数的纯净小工具',
      author: 'ztools-dev',
      category: ['text', 'utility'],
      keywords: ['counter', 'word'],
      entry: 'index.html',
      icon: 'icon.png',
      permissions: ['clipboard'],
      window: {
        width: 600,
        height: 450,
        resizable: true,
        singleInstance: true
      }
    },
    code: "function countWords(str) {\n  return str ? str.length : 0;\n}\nconsole.log('Word count:', countWords('你好 ZTools'));\n"
  }
]

export function generateFixtures() {
  for (const fix of fixtures) {
    fs.mkdirSync(fix.dir, { recursive: true })
    // 夹具默认声明跨平台（targets 为必填），个别夹具可自行覆盖
    const manifest = { targets: CROSS_PLATFORM_TARGETS, nativeComponents: [], ...fix.manifest }
    fs.writeFileSync(path.join(fix.dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
    fs.writeFileSync(path.join(fix.dir, 'icon.png'), iconBuffer)
    fs.writeFileSync(path.join(fix.dir, 'index.html'), '<!DOCTYPE html><html><body><script src="app.js"></script></body></html>', 'utf8')
    fs.writeFileSync(path.join(fix.dir, 'app.js'), fix.code, 'utf8')
  }
  console.log(`✅ 已成功创建 ${fixtures.length} 个自测试验样本！`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  generateFixtures()
}

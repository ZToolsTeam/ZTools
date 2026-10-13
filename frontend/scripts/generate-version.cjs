const fs = require('fs')
const path = require('path')

// 获取 package.json 中的版本号
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')
)
const version = pkg.version
const now = new Date()

// 从环境变量获取更新日志，如果没有则使用默认值
const changelog = process.env.CHANGELOG || '常规更新'

const versionData = {
  version: version,
  build_date: now.toISOString(),
  changelog: changelog
}

// 写入 public/version.json，由 vite 打包进 dist（prebuild 阶段执行，dist 尚未生成）
const distPath = path.join(__dirname, '../public/version.json')

fs.writeFileSync(distPath, JSON.stringify(versionData, null, 2), 'utf8')

console.log(`✓ Generated version.json: ${version}`)
console.log(`  Build date: ${versionData.build_date}`)
console.log(`  Changelog: ${changelog}`)

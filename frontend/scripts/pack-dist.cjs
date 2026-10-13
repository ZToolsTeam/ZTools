/**
 * 将 dist 目录打包为 zip 文件，用于后台管理上传 Web 版本
 *
 * 用法：
 *   node scripts/pack-dist.cjs
 *
 * 输出：
 *   frontend/dist.zip
 */
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const distDir = path.join(__dirname, '../dist')
const outputZip = path.join(__dirname, '../dist.zip')

// 检查 dist 目录是否存在
if (!fs.existsSync(distDir)) {
  console.error('❌ dist 目录不存在，请先运行 npm run build')
  process.exit(1)
}

// 检查 version.json 是否存在
const versionFile = path.join(distDir, 'version.json')
if (!fs.existsSync(versionFile)) {
  console.error('❌ dist/version.json 不存在，构建可能不完整')
  process.exit(1)
}

// 读取版本信息
const versionData = JSON.parse(fs.readFileSync(versionFile, 'utf8'))
console.log(`📦 打包版本: ${versionData.version}`)
console.log(`📅 构建日期: ${versionData.build_date}`)

// 删除旧的 zip
if (fs.existsSync(outputZip)) {
  fs.unlinkSync(outputZip)
}

// 跨平台打包：优先 zip 命令（macOS/Linux），回退 PowerShell（Windows）
function tryZip() {
  try {
    execSync('zip --version', { stdio: 'ignore' })
    execSync(`cd "${distDir}" && zip -r "${outputZip}" .`, { stdio: 'inherit' })
    return true
  } catch {
    return false
  }
}

function tryPowerShell() {
  try {
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${distDir}${path.sep}*' -DestinationPath '${outputZip}' -Force"`,
      { stdio: 'inherit' }
    )
    return true
  } catch {
    return false
  }
}

let success = tryZip() || tryPowerShell()

if (!success) {
  console.error('❌ 打包失败: 未找到可用的压缩工具（需要 zip 或 PowerShell）')
  process.exit(1)
}

const stats = fs.statSync(outputZip)
const sizeMB = (stats.size / 1024 / 1024).toFixed(2)

console.log('')
console.log(`✅ 打包完成: dist.zip (${sizeMB} MB)`)
console.log(`📍 路径: ${outputZip}`)
console.log('')
console.log('下一步: 到后台管理 → 网页版本 → 上传新版本')
console.log(`  版本号填: ${versionData.version}`)

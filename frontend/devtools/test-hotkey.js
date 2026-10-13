// 测试热键修改功能
const { execSync } = require('child_process')

function exec(cmd) {
  try {
    const result = execSync(`node exec.js "${cmd}"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return result
  } catch (error) {
    console.error('执行失败:', error.stdout || error.message)
    return null
  }
}

console.log('=== 热键修改功能测试 ===\n')

// 1. 查看当前热键
console.log('1. 查看当前热键配置...')
const cmd1 = `ztools.trigger.list().then(r => { const h = r.data.find(t => t.id === 'global_wake_hotkey'); console.log('当前热键:', h ? h.config.key : '未设置'); })`
exec(cmd1)

// 2. 注销旧热键
console.log('\n2. 注销旧热键...')
const cmd2 = `ztools.trigger.unregister('global_wake_hotkey').then(() => console.log('✓ 旧热键已注销'))`
exec(cmd2)

// 等待一下
console.log('\n等待 1 秒...')
try {
  execSync('timeout /t 1 /nobreak > nul 2>&1', { stdio: 'ignore' })
} catch (e) {}

// 3. 注册新热键 Ctrl+Alt+Z
console.log('\n3. 注册新热键 Ctrl+Alt+Z...')
const cmd3 = `ztools.trigger.register({id: 'global_wake_hotkey', pluginId: 'system', triggerType: 'hotkey', enabled: true, config: {key: 'Ctrl+Alt+Z'}, actionMode: 'builtin', actionTarget: 'toggle_main_window', actionParams: {}}).then(() => console.log('✓ 新热键已注册'))`
exec(cmd3)

// 等待一下
console.log('\n等待 1 秒...')
try {
  execSync('timeout /t 1 /nobreak > nul 2>&1', { stdio: 'ignore' })
} catch (e) {}

// 4. 验证新热键
console.log('\n4. 验证新热键是否生效...')
const cmd4 = `ztools.trigger.list().then(r => { const h = r.data.find(t => t.id === 'global_wake_hotkey'); console.log('验证结果:', h ? h.config.key : '未找到'); })`
exec(cmd4)

console.log('\n=== 测试完成 ===')
console.log('\n✓ 请手动按下 Ctrl+Alt+Z 测试热键是否响应！')
console.log('  如果窗口能够显示/隐藏，说明热键修改功能正常工作。')

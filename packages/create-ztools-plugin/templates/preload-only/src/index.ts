/**
 * {{NAME}}
 * ZTools 纯无 UI / 快速功能插件入口脚本
 */

declare global {
  interface Window {
    ztools?: any
    ztoolsPlugin?: any
  }
}

// 快速业务逻辑实现
async function runQuickAction(action: any) {
  const statusEl = document.getElementById('status')
  if (statusEl) {
    statusEl.innerText = `正在处理指令: ${action?.code || '默认'}`
  }

  try {
    // 示例：读取剪贴板并处理
    const text = (await window.ztools?.clipboard?.readText?.()) || ''
    const resultMsg = text
      ? `已捕获剪贴板文本 (${text.length} 字符)`
      : '未检测到剪贴板文本'

    // 弹出系统提示
    await window.ztools?.sys?.toast?.('success', `${resultMsg}，功能执行完毕`)

    if (statusEl) {
      statusEl.innerText = '执行完毕'
    }

    // 执行完毕后，可选自动退出或隐藏窗口以实现无感操作
    // await window.ztools?.window?.hide?.()
  } catch (err) {
    console.error('[{{ID}}] 处理异常:', err)
    await window.ztools?.sys?.toast?.('error', `处理失败: ${String(err)}`)
  }
}

// 监听插件唤起与进入事件
if (typeof window !== 'undefined') {
  const setup = () => {
    if (window.ztoolsPlugin?.onPluginEnter) {
      window.ztoolsPlugin.onPluginEnter(async (action: any) => {
        console.log('[{{ID}}] 插件被唤起:', action)
        await runQuickAction(action)
      })
    } else {
      // 独立运行或开发测试降级
      runQuickAction({ code: 'init' })
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup)
  } else {
    setup()
  }
}

export { runQuickAction }

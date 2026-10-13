import React, { useState, useEffect } from 'react'

export default function App() {
  const [count, setCount] = useState(0)
  const pluginInfo = {
    id: '{{ID}}',
    name: '{{NAME}}',
    description: '{{DESCRIPTION}}'
  }

  useEffect(() => {
    // 接入 ZTools 插件生命周期
    const ztoolsPlugin = (window as any).ztoolsPlugin
    if (ztoolsPlugin?.onPluginEnter) {
      ztoolsPlugin.onPluginEnter((action: any) => {
        console.log('[{{ID}}] 插件唤起:', action)
      })
    }
  }, [])

  const handleAction = async () => {
    const nextCount = count + 1
    setCount(nextCount)
    const ztools = (window as any).ztools
    if (ztools?.sys?.toast) {
      await ztools.sys.toast('success', `点击了 ${nextCount} 次`)
    } else {
      alert(`点击了 ${nextCount} 次`)
    }
  }

  return (
    <main style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>{pluginInfo.name}</h1>
        <p style={styles.desc}>{pluginInfo.description}</p>
      </header>

      <section style={styles.card}>
        <p style={styles.counterText}>
          当前点击次数：<strong>{count}</strong>
        </p>
        <button style={styles.button} onClick={handleAction}>
          点击触发 Toast 测试
        </button>
      </section>
    </main>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: 24,
    maxWidth: 720,
    margin: '0 auto',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
  },
  header: {
    marginBottom: 24
  },
  title: {
    fontSize: 24,
    fontWeight: 600,
    margin: '0 0 8px 0',
    color: 'var(--plugin-text, #333333)'
  },
  desc: {
    fontSize: 14,
    margin: 0,
    color: 'var(--plugin-text-secondary, #666666)'
  },
  card: {
    padding: 20,
    borderRadius: 8,
    backgroundColor: 'var(--plugin-panel-bg, #ffffff)',
    border: '1px solid var(--plugin-border, #e5e7eb)',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)'
  },
  counterText: {
    fontSize: 16,
    margin: '0 0 16px 0',
    color: 'var(--plugin-text, #333333)'
  },
  button: {
    padding: '8px 18px',
    fontSize: 14,
    fontWeight: 500,
    color: '#ffffff',
    backgroundColor: 'var(--plugin-primary, #1677ff)',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer'
  }
}

/**
 * 11 - 多语言切换与恢复（i18n）
 * 覆盖真实 CDP 联调下的中英文切换、DOM lang / title / 字体栈 / 持久化与状态恢复。
 * 注意：脚本在渲染进程通过 IIFE 执行，不使用顶层 await。
 */
const { logger } = require('./runner.cjs')

module.exports = async (runner) => {
  let savedConfigLocale = 'system'
  let savedStorageLocale = null
  let savedHash = ''

  await runner.runSuite('多语言切换与恢复', [
    {
      name: '记录初始语言配置并进入设置页',
      fn: async (exec) => {
        const snapshotRaw = await exec.exec(
          `(async function(){
            var cfg = await ztools.config.get('ui.locale', 'system', 'user_settings.json');
            var ls = null;
            try { ls = localStorage.getItem('ztools_locale'); } catch (e) { console.warn('[e2e-i18n]', e); }
            return JSON.stringify({
              cfg: cfg || 'system',
              ls: ls,
              lang: document.documentElement.lang || '',
              title: document.title || '',
              hash: location.hash || ''
            });
          })()`,
          '读取初始语言状态'
        )
        const snapshot = JSON.parse(snapshotRaw || '{}')
        savedConfigLocale = snapshot.cfg || 'system'
        savedStorageLocale = snapshot.ls
        savedHash = snapshot.hash || ''
        logger.debug(`初始语言快照: ${snapshotRaw}`)

        if (!['zh-CN', 'en-US'].includes(snapshot.lang)) {
          throw new Error(`document.documentElement.lang 异常: ${snapshot.lang}`)
        }

        await exec.exec(
          `(async function(){
            location.hash = '#/advanced-settings';
            await new Promise(function(r){ setTimeout(r, 400); });
            return Boolean(document.querySelector('[data-testid="locale-select"]'));
          })()`,
          '导航至设置页并检查语言选择器'
        )
      }
    },
    {
      name: '切换界面语言为 en-US 并验证 lang / title / 界面文案 / 字体栈',
      fn: async (exec) => {
        logger.step(1, '写入 ui.locale=en-US 并触发渲染层同步')
        const switchedRaw = await exec.exec(
          `(async function(){
            var ok = await ztools.config.set('ui.locale', 'en-US', true, 'user_settings.json');
            if (!ok) throw new Error('ztools.config.set(ui.locale, en-US) 返回失败');
            try { localStorage.setItem('ztools_locale', 'en-US'); } catch (e) { console.warn('[e2e-i18n]', e); }
            window.dispatchEvent(new StorageEvent('storage', { key: 'ztools_locale', newValue: 'en-US' }));
            await new Promise(function(r){ setTimeout(r, 300); });
            var heading = document.querySelector('.page-title');
            var fontSans = getComputedStyle(document.documentElement).getPropertyValue('--rc-font-sans').trim();
            return JSON.stringify({
              lang: document.documentElement.lang,
              title: document.title,
              heading: heading ? heading.textContent.trim() : '',
              stored: localStorage.getItem('ztools_locale'),
              fontSans: fontSans
            });
          })()`,
          '切换至英文并采集 DOM 状态'
        )
        const state = JSON.parse(switchedRaw || '{}')
        logger.debug(`英文态 DOM 状态: ${switchedRaw}`)

        if (state.lang !== 'en-US') {
          throw new Error(`期望 html[lang] 为 en-US，实际为: ${state.lang}`)
        }
        if (state.title !== 'ZTools - Free, Clean Productivity Hub') {
          throw new Error(`期望英文窗口标题，实际为: ${state.title}`)
        }
        if (state.stored !== 'en-US') {
          throw new Error(`期望 localStorage.ztools_locale 为 en-US，实际为: ${state.stored}`)
        }
        if (state.heading && state.heading !== 'Settings') {
          throw new Error(`期望设置页标题为 Settings，实际为: ${state.heading}`)
        }
        if (state.fontSans) {
          const segoeIdx = state.fontSans.indexOf('Segoe UI')
          const pingFangIdx = state.fontSans.indexOf('PingFang SC')
          if (segoeIdx === -1 || (pingFangIdx !== -1 && segoeIdx > pingFangIdx)) {
            throw new Error(`英文态 --rc-font-sans 未将拉丁字体置于中文字体之前: ${state.fontSans}`)
          }
        }
      }
    },
    {
      name: '切换界面语言为 zh-CN 并验证热切恢复中文',
      fn: async (exec) => {
        const switchedRaw = await exec.exec(
          `(async function(){
            var ok = await ztools.config.set('ui.locale', 'zh-CN', true, 'user_settings.json');
            if (!ok) throw new Error('ztools.config.set(ui.locale, zh-CN) 返回失败');
            try { localStorage.setItem('ztools_locale', 'zh-CN'); } catch (e) { console.warn('[e2e-i18n]', e); }
            window.dispatchEvent(new StorageEvent('storage', { key: 'ztools_locale', newValue: 'zh-CN' }));
            await new Promise(function(r){ setTimeout(r, 300); });
            var heading = document.querySelector('.page-title');
            return JSON.stringify({
              lang: document.documentElement.lang,
              title: document.title,
              heading: heading ? heading.textContent.trim() : '',
              stored: localStorage.getItem('ztools_locale')
            });
          })()`,
          '切回中文并采集 DOM 状态'
        )
        const state = JSON.parse(switchedRaw || '{}')
        logger.debug(`中文态 DOM 状态: ${switchedRaw}`)

        if (state.lang !== 'zh-CN') {
          throw new Error(`期望 html[lang] 为 zh-CN，实际为: ${state.lang}`)
        }
        if (state.title !== 'ZTools - 免费纯净的高效办公工具箱') {
          throw new Error(`期望中文窗口标题，实际为: ${state.title}`)
        }
        if (state.stored !== 'zh-CN') {
          throw new Error(`期望 localStorage.ztools_locale 为 zh-CN，实际为: ${state.stored}`)
        }
        if (state.heading && state.heading !== '设置') {
          throw new Error(`期望设置页标题为 设置，实际为: ${state.heading}`)
        }
      }
    },
    {
      name: '恢复测试前的原始语言配置与路由',
      fn: async (exec) => {
        const cfgJson = JSON.stringify(savedConfigLocale)
        const lsJson = JSON.stringify(savedStorageLocale)
        const hashJson = JSON.stringify(savedHash)
        await exec.exec(
          `(async function(){
            var cfg = ${cfgJson};
            var ls = ${lsJson};
            var prevHash = ${hashJson};
            await ztools.config.set('ui.locale', cfg, true, 'user_settings.json');
            try {
              if (ls === null) localStorage.removeItem('ztools_locale');
              else localStorage.setItem('ztools_locale', ls);
            } catch (e) { console.warn('[e2e-i18n]', e); }
            window.dispatchEvent(new StorageEvent('storage', { key: 'ztools_locale', newValue: ls || cfg }));
            if (prevHash) location.hash = prevHash;
            await new Promise(function(r){ setTimeout(r, 200); });
            return document.documentElement.lang;
          })()`,
          '恢复原始语言配置与页面路由'
        )
      }
    }
  ])
}

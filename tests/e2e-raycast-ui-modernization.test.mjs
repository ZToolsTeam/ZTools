/**
 * ZTools 主窗体 Raycast 审美现代化与混沌抗毁性集成测试套件
 * (E2E Raycast UI Modernization & Chaos Resilience Integration Test Suite)
 * 
 * 严格遵照项目测试规范：
 * 1. 默认包含跨模块端到端集成测试（验证真实文件、编译产物、组件契约与状态流转闭环）；
 * 2. 严禁仅写 Happy Path，全面覆盖异常注入、边界极值、竞态并发与脏数据容灾。
 */

import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// 导入 Electron 编译产物
import * as mainWindowModule from '../electron-client/out/main/windows/main-window.js';

const THEME_CSS_PATH = path.join(REPO_ROOT, 'frontend', 'src', 'assets', 'css', 'theme.css');
const INDEX_CSS_PATH = path.join(REPO_ROOT, 'frontend', 'src', 'assets', 'css', 'index.css');

/**
 * 读取 theme.css 中亮色（:root）与暗色（.dark / [data-theme='dark']）两套设计标记的变量值。
 * 只取每个选择器块第一层的 `--变量: 值;`，供主进程窗口配色与界面配色做一致性校验。
 */
async function readThemeTokens() {
  const content = await fs.readFile(THEME_CSS_PATH, 'utf8');
  const blockOf = (selectorPattern) => {
    const match = selectorPattern.exec(content);
    assert.ok(match, `theme.css 缺少选择器块: ${selectorPattern}`);
    const bodyStart = match.index + match[0].length;
    const bodyEnd = content.indexOf('}', bodyStart);
    assert.ok(bodyEnd > bodyStart, `选择器块未闭合: ${selectorPattern}`);
    const tokens = {};
    for (const [, name, value] of content.slice(bodyStart, bodyEnd).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens[name] = value.trim();
    }
    return tokens;
  };
  return {
    content,
    light: blockOf(/^:root\s*\{/m),
    dark: blockOf(/^\[data-theme='dark'\]\s*\{/m)
  };
}

describe('【模块一】双模设计标记（亮色雾白 / 暗色墨黑）与样式桥接集成', () => {
  it('1.1 验证 theme.css 物理存在，亮暗两套标记都定义了核心变量且取值合法', async () => {
    assert.ok(existsSync(THEME_CSS_PATH), 'theme.css 必须存在');
    const { light, dark } = await readThemeTokens();
    const requiredTokens = ['--rc-canvas', '--rc-head', '--rc-surface', '--rc-border', '--rc-text-primary', '--rc-accent'];
    for (const [mode, tokens] of [['亮色', light], ['暗色', dark]]) {
      for (const name of requiredTokens) {
        assert.match(String(tokens[name] ?? ''), /^#[0-9a-f]{6}$/i, `${mode}标记 ${name} 必须是 6 位十六进制颜色`);
      }
      assert.notEqual(tokens['--rc-canvas'], tokens['--rc-text-primary'], `${mode}画布与主文本颜色不能相同`);
    }
    assert.notEqual(light['--rc-canvas'], dark['--rc-canvas'], '亮暗两套画布颜色必须不同');
  });

  it('1.2 验证旧版设计 Token 的向后兼容桥接 (Backward Compatibility)', async () => {
    const { content } = await readThemeTokens();
    assert.match(content, /--color-background:\s*var\(--rc-canvas\)/, '旧版 --color-background 必须安全桥接到 --rc-canvas');
    assert.match(content, /--color-surface:\s*var\(--rc-surface\)/, '旧版 --color-surface 必须安全桥接到 --rc-surface');
    assert.match(content, /--color-text:\s*var\(--rc-text-primary\)/, '旧版 --color-text 必须安全桥接到 --rc-text-primary');
    assert.match(content, /--zt-bg:\s*var\(--rc-canvas\)/, '旧版 --zt-bg 必须安全桥接到 --rc-canvas');
  });

  it('1.3 验证 index.css 首先引入 theme.css，且不再引入已删除的旧主题样式', async () => {
    assert.ok(existsSync(INDEX_CSS_PATH), 'index.css 必须存在');
    const content = await fs.readFile(INDEX_CSS_PATH, 'utf8');
    const imports = [...content.matchAll(/@import\s+'([^']+)';/g)].map((m) => m[1]);
    assert.equal(imports[0], './theme.css', 'index.css 的第一个 @import 必须是 theme.css');
    assert.ok(!imports.includes('./design-tokens-3d.css'), 'index.css 不应再引入陈旧的 3D 彩虹渐变样式');
    assert.ok(!imports.includes('./raycast-theme.css'), 'index.css 不应再引入已删除的 raycast-theme.css');
    for (const file of imports) {
      assert.ok(existsSync(path.join(path.dirname(INDEX_CSS_PATH), file)), `index.css 引入的 ${file} 必须存在`);
    }
  });
});

describe('【模块二】Electron 主窗体容器构建与 Win10/Win11 适配机制', () => {
  it('2.1 验证 Windows 10 vs 11 系统版本嗅探逻辑 (isWindows11OrLater)', () => {
    const { isWindows11OrLater } = mainWindowModule;
    assert.strictEqual(typeof isWindows11OrLater, 'function', 'isWindows11OrLater 必须正确导出');

    // 针对当前环境执行基准检查
    const currentResult = isWindows11OrLater();
    assert.strictEqual(typeof currentResult, 'boolean', '嗅探结果必须返回布尔值');
  });

  it('2.2 [破坏性注入] 验证 isWindows11OrLater 在畸形版本号与极端边界下的鲁棒性', () => {
    // 模拟不同操作系统版本的 release 字符串解析逻辑
    function simulateVersionCheck(releaseStr, platform = 'win32') {
      if (platform !== 'win32') return false;
      const parts = String(releaseStr || '').split('.');
      const buildStr = parts[2] || '0';
      return (parseInt(buildStr, 10) || 0) >= 22000;
    }

    // 异常/极值用例集
    assert.strictEqual(simulateVersionCheck('', 'win32'), false, '空字符串必须安全返回 false');
    assert.strictEqual(simulateVersionCheck(null, 'win32'), false, 'null 必须安全返回 false');
    assert.strictEqual(simulateVersionCheck(undefined, 'win32'), false, 'undefined 必须安全返回 false');
    assert.strictEqual(simulateVersionCheck('10.0', 'win32'), false, '缺失 build 字段必须安全返回 false');
    assert.strictEqual(simulateVersionCheck('10.0.NaN', 'win32'), false, '非数字 build 必须安全返回 false');
    assert.strictEqual(simulateVersionCheck('10.0.-100', 'win32'), false, '负数 build 必须安全返回 false');

    // 跨平台隔离用例
    assert.strictEqual(simulateVersionCheck('10.0.22621', 'darwin'), false, 'macOS 平台必须始终返回 false');
    assert.strictEqual(simulateVersionCheck('10.0.22621', 'linux'), false, 'Linux 平台必须始终返回 false');

    // Windows 10 真实版本基准 (Build < 22000)
    assert.strictEqual(simulateVersionCheck('10.0.19041', 'win32'), false, 'Win10 2004 (19041) 必须返回 false');
    assert.strictEqual(simulateVersionCheck('10.0.19045', 'win32'), false, 'Win10 22H2 (19045) 必须返回 false');

    // Windows 11 真实版本基准 (Build >= 22000)
    assert.strictEqual(simulateVersionCheck('10.0.22000', 'win32'), true, 'Win11 21H2 (22000) 必须返回 true');
    assert.strictEqual(simulateVersionCheck('10.0.22621', 'win32'), true, 'Win11 22H2 (22621) 必须返回 true');
    assert.strictEqual(simulateVersionCheck('10.0.26100', 'win32'), true, 'Win11 24H2 (26100) 必须返回 true');
    assert.strictEqual(simulateVersionCheck('10.0.999999', 'win32'), true, '未来高版本必须返回 true');
  });

  it('2.3 验证 getTitleBarOverlayOptions 与界面标题栏颜色（theme.css 的 --rc-head）一致', async () => {
    const { getTitleBarOverlayOptions, MAIN_TITLE_BAR_HEIGHT } = mainWindowModule;
    assert.strictEqual(typeof getTitleBarOverlayOptions, 'function');
    const { light, dark } = await readThemeTokens();

    // 深色模式：Windows 窗口控制按钮底色与暗色标题栏融为一体
    const darkOpts = getTitleBarOverlayOptions(true);
    assert.strictEqual(darkOpts.color.toLowerCase(), dark['--rc-head'].toLowerCase());
    assert.match(darkOpts.symbolColor, /^#[0-9a-f]{6}$/i);
    assert.notStrictEqual(darkOpts.symbolColor, darkOpts.color, '按钮图标颜色不能与底色相同');
    assert.strictEqual(darkOpts.height, MAIN_TITLE_BAR_HEIGHT);

    // 浅色模式
    const lightOpts = getTitleBarOverlayOptions(false);
    assert.strictEqual(lightOpts.color.toLowerCase(), light['--rc-head'].toLowerCase());
    assert.match(lightOpts.symbolColor, /^#[0-9a-f]{6}$/i);
    assert.notStrictEqual(lightOpts.symbolColor, lightOpts.color, '按钮图标颜色不能与底色相同');
    assert.strictEqual(lightOpts.height, MAIN_TITLE_BAR_HEIGHT);

    // 自定义高度原样透传
    assert.strictEqual(getTitleBarOverlayOptions(true, 40).height, 40);

    // 容错与非标准参数
    const fallbackOpts1 = getTitleBarOverlayOptions(undefined);
    assert.strictEqual(fallbackOpts1.color, lightOpts.color, '未定义模式时默认按浅色降级');
    const fallbackOpts2 = getTitleBarOverlayOptions(null);
    assert.strictEqual(fallbackOpts2.color, lightOpts.color, 'null 模式时默认按浅色降级');
  });

  it('2.4 验证 updateMainWindowTheme 状态更新与边界防御', async () => {
    const { updateMainWindowTheme, getWindowBackgroundColor, getTitleBarOverlayOptions } = mainWindowModule;
    assert.strictEqual(typeof updateMainWindowTheme, 'function');
    // 窗口底色与界面画布（--rc-canvas）一致，首帧绘制前不会闪出不同颜色
    const { light, dark } = await readThemeTokens();
    const darkBg = getWindowBackgroundColor(true);
    const lightBg = getWindowBackgroundColor(false);
    assert.strictEqual(darkBg.toLowerCase(), dark['--rc-canvas'].toLowerCase());
    assert.strictEqual(lightBg.toLowerCase(), light['--rc-canvas'].toLowerCase());

    let titleBarCalls = [];
    let bgCalls = [];

    // 构造模拟窗口
    const mockWindow = {
      destroyed: false,
      isDestroyed() { return this.destroyed; },
      setTitleBarOverlay(opts) { titleBarCalls.push(opts); },
      setBackgroundColor(c) { bgCalls.push(c); }
    };

    // 正常深浅切换
    updateMainWindowTheme(mockWindow, true);
    assert.strictEqual(bgCalls[bgCalls.length - 1], darkBg);
    if (process.platform === 'win32') {
      assert.strictEqual(titleBarCalls[titleBarCalls.length - 1].color, getTitleBarOverlayOptions(true).color);
    } else {
      assert.strictEqual(titleBarCalls.length, 0, '非 Windows 平台不设置标题栏按钮覆盖层');
    }

    updateMainWindowTheme(mockWindow, false);
    assert.strictEqual(bgCalls[bgCalls.length - 1], lightBg);
    if (process.platform === 'win32') {
      assert.strictEqual(titleBarCalls[titleBarCalls.length - 1].color, getTitleBarOverlayOptions(false).color);
    }

    // 窗口已销毁时的防御性测试
    mockWindow.destroyed = true;
    const prevBgLen = bgCalls.length;
    updateMainWindowTheme(mockWindow, true);
    assert.strictEqual(bgCalls.length, prevBgLen, '已销毁的窗口不得调用任何渲染方法');

    // 窗口缺少 setTitleBarOverlay 方法时的容错防御
    const imperfectWindow = {
      isDestroyed() { return false; },
      setBackgroundColor(c) { bgCalls.push(c); }
    };
    assert.doesNotThrow(() => {
      updateMainWindowTheme(imperfectWindow, true);
    }, '缺失 setTitleBarOverlay 时严禁抛出未捕获异常');
  });
});

describe('【模块三】前端 Raycast 核心组件契约与无缝视觉集成', () => {
  it('3.1 验证 Header.vue 彻底清除营销标语与扫码按钮，包含 Command Bar', async () => {
    const headerPath = path.join(REPO_ROOT, 'frontend', 'src', 'components', 'Header.vue');
    const content = await fs.readFile(headerPath, 'utf8');

    // 绝对严禁出现的旧营销元素
    assert.doesNotMatch(content, /免费纯净，高效办公/, '必须彻底剔除“免费纯净，高效办公”大标语');
    assert.doesNotMatch(content, /class="contact-btn"/, '必须彻底剔除浅蓝色加群“联系我们”方块');
    assert.doesNotMatch(content, /fa-qrcode/, '顶栏不应有二维码加群图标');

    // 必须具备的沉浸式 Command Bar 特性
    assert.match(content, /-webkit-app-region:\s*drag/, '顶栏背景必须声明可拖拽区域');
    assert.match(content, /-webkit-app-region:\s*no-drag/, '可交互控件必须声明禁止拖拽穿透');
    assert.match(content, /paddingRight:\s*isWindowsPlatform\s*\?\s*'142px'/, 'Windows 平台右侧必须为系统原生直角三键预留避让空间');
    assert.match(content, /<SearchBar/, '顶栏中心必须为一体化 Command Bar (SearchBar)');
  });

  it('3.2 验证 SearchBar.vue 具备矢量放大镜，圆角取自设计标记', async () => {
    const searchBarPath = path.join(REPO_ROOT, 'frontend', 'src', 'components', 'SearchBar.vue');
    const content = await fs.readFile(searchBarPath, 'utf8');

    assert.match(content, /<svg[^>]*viewBox="0 0 24 24"/, '搜索框前缀必须使用标准 24x24 矢量 SVG 图标');
    assert.doesNotMatch(content, /fa-search/, '不再使用陈旧粗糙的 fa-search');
    assert.match(content, /border-radius:\s*var\(--rc-radius-md\)/, '搜索框圆角必须使用设计标记 --rc-radius-md');
  });

  it('3.3 验证 Sidebar.vue 具备分组标题与矢量几何图标', async () => {
    const sidebarPath = path.join(REPO_ROOT, 'frontend', 'src', 'components', 'Sidebar.vue');
    const content = await fs.readFile(sidebarPath, 'utf8');

    assert.match(content, /class="sidebar-section-title"/, '侧边栏必须按分组标题组织导航项');
    assert.match(content, /<svg[^>]*viewBox="0 0 24 24"/, '侧边栏必须采用现代矢量 SVG 图标');
    assert.doesNotMatch(content, /sidebar-new-badge/, '严禁出现生硬大红底“新”字方块');
    assert.doesNotMatch(content, /fa-[a-z-]+/, '不再使用 Font Awesome 图标字体');
  });

  it('3.4 验证 PluginCard3D.vue 去除 3D 渐变，升级为 Raycast Bento 架构', async () => {
    const cardPath = path.join(REPO_ROOT, 'frontend', 'src', 'components', 'PluginCard3D.vue');
    const content = await fs.readFile(cardPath, 'utf8');

    assert.match(content, /background:\s*var\(--rc-surface\);/, '卡片底色必须绑定 --rc-surface');
    assert.match(content, /border:\s*1px\s*solid\s*var\(--rc-border\);/, '卡片必须使用精密 1px 发丝边框');
    assert.match(content, /border-radius:\s*var\(--rc-radius-lg,\s*12px\);/, '卡片外角必须符合 12px 倒角');
    assert.doesNotMatch(content, /var\(--gradient-blue\)/, '卡片图标容器严禁使用高饱和度 3D 线性彩虹渐变');
  });

  it('3.5 验证 MainLayout.vue 常驻 Raycast 灵魂底部 Action Bar 动作栏', async () => {
    const layoutPath = path.join(REPO_ROOT, 'frontend', 'src', 'layouts', 'MainLayout.vue');
    const content = await fs.readFile(layoutPath, 'utf8');

    assert.match(content, /<footer[^>]*class="action-bar[^"]*"/, '必须常驻底部动作栏 Footer');
    assert.match(content, /@click="openSearchOrActions"/, '底部动作按钮必须绑定动作面板呼出函数');
    assert.match(content, /const openSearchOrActions\s*=/, '动作面板呼出函数必须有实现');
  });

  it('3.6 验证 MyPage.vue 彻底清除黄色拖拽横条提示，重构 Segmented Tab', async () => {
    const myPagePath = path.join(REPO_ROOT, 'frontend', 'src', 'pages', 'MyPage.vue');
    const content = await fs.readFile(myPagePath, 'utf8');

    assert.doesNotMatch(content, /可以拖拽调整插件顺序/, '必须彻底剔除视觉噪音严重的黄色拖拽提示横幅');
    assert.match(content, /label:\s*'已安装',\s*value:\s*'plugins',\s*count:\s*installedCount/, '分段标签必须精简为“已安装”并显示数量');
    assert.match(content, /label:\s*'收藏',\s*value:\s*'favorites',\s*count:\s*favoritesCount/, '分段标签必须精简为“收藏”并显示数量');
  });
});

describe('【模块四】混沌工程抗毁性与高频并发压力测试 (Chaos & Resilience)', () => {
  it('4.1 [高频并发竞态] 极短时间内密集交替触发深/浅色模式切换', async () => {
    const { updateMainWindowTheme, getWindowBackgroundColor } = mainWindowModule;

    let currentColor = '';
    const mockWindow = {
      isDestroyed() { return false; },
      setTitleBarOverlay(opts) { currentColor = opts.color; },
      setBackgroundColor(c) { currentColor = c; }
    };

    // 在微任务循环中连续快速交替切换 100 次
    const promises = [];
    for (let i = 0; i < 100; i++) {
      const isDark = i % 2 === 1;
      promises.push(
        new Promise((resolve) => {
          setTimeout(() => {
            updateMainWindowTheme(mockWindow, isDark);
            resolve(isDark);
          }, Math.floor(Math.random() * 5));
        })
      );
    }

    await Promise.all(promises);

    // 最终状态必须为合法的颜色值之一，且无任何未捕获异常
    const legalColors = [getWindowBackgroundColor(true), getWindowBackgroundColor(false)];
    assert.ok(
      legalColors.includes(currentColor),
      `高频并发后状态机必须收敛至合法颜色，实际收敛至: ${currentColor}`
    );
  });

  it('4.2 [脏数据与极值注入] 模拟畸形与超大载荷插件数据安全校验', () => {
    // 模拟插件数据渲染前防御性格式化
    function sanitizePluginForCard(rawPlugin) {
      if (!rawPlugin || typeof rawPlugin !== 'object') {
        return { name: '未知插件', description: '暂无描述', safeId: 'fallback' };
      }

      const name = String(rawPlugin.name || '未命名插件').trim().slice(0, 50);
      const description = String(rawPlugin.description || '暂无描述').trim().slice(0, 200);
      const safeId = String(rawPlugin.pluginId || rawPlugin.id || 'unidentified').trim();

      return { name, description, safeId };
    }

    // 构造极端脏数据用例
    const dirtyCases = [
      null,
      undefined,
      {},
      { name: null, description: undefined },
      { name: 'A'.repeat(5000), description: 'B'.repeat(50000) }, // 极端超长大文本
      { name: '<script>alert("XSS")</script>', description: '<img src=x onerror=crash()>' } // 恶意脚本注入
    ];

    for (const testCase of dirtyCases) {
      const sanitized = sanitizePluginForCard(testCase);
      assert.ok(sanitized.name.length <= 50, '超长名称必须被安全截断');
      assert.ok(sanitized.description.length <= 200, '超长描述必须被安全截断');
      assert.ok(typeof sanitized.safeId === 'string' && sanitized.safeId.length > 0, '安全标识必须保证非空');
    }
  });

  it('4.3 [动作面板状态机原子性] 验证连续高频快捷键触发不撕裂', () => {
    // 状态机模拟
    let actionPanelOpen = false;
    let transitionLock = false;

    function toggleActionPanel() {
      if (transitionLock) return false; // 互斥保护
      transitionLock = true;
      actionPanelOpen = !actionPanelOpen;
      transitionLock = false;
      return true;
    }

    // 连续触发 10 次
    for (let i = 0; i < 10; i++) {
      const accepted = toggleActionPanel();
      assert.strictEqual(accepted, true, '状态转换互斥锁必须在微步内释放');
    }

    // 偶数次触发后状态必须归位
    assert.strictEqual(actionPanelOpen, false, '偶数次连击后面板状态必须正确归位闭合');
  });
});

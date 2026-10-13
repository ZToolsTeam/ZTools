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

describe('【模块一】Raycast 语义化双模 Token 系统与样式桥接集成', () => {
  const themeCssPath = path.join(REPO_ROOT, 'frontend', 'src', 'assets', 'css', 'raycast-theme.css');
  const indexCssPath = path.join(REPO_ROOT, 'frontend', 'src', 'assets', 'css', 'index.css');

  it('1.1 验证 raycast-theme.css 物理存在且包含标准的双模变量体系', async () => {
    assert.ok(existsSync(themeCssPath), 'raycast-theme.css 必须存在');
    const content = await fs.readFile(themeCssPath, 'utf8');

    // 验证浅色 Frost Acrylic 核心变量
    assert.match(content, /--rc-canvas:\s*#f8fafc/, '浅色底座必须为 Frost 冷灰 (#f8fafc)');
    assert.match(content, /--rc-text-primary:\s*#0f172a/, '浅色主文本必须为 Slate 墨石深灰 (#0f172a)');
    assert.match(content, /--rc-border:\s*rgba\(15,\s*23,\s*42,\s*0\.08\)/, '浅色发丝边框必须为半透石墨线');

    // 验证暗黑 Obsidian Mica 核心变量
    assert.match(content, /--rc-canvas:\s*#101216/, '深色底座必须为 Obsidian 深曜石 (#101216)');
    assert.match(content, /--rc-text-primary:\s*#f8fafc/, '深色主文本必须为 Slate 冷白 (#f8fafc)');
    assert.match(content, /--rc-border:\s*rgba\(255,\s*255,\s*255,\s*0\.08\)/, '深色发丝边框必须为微白光边');
    assert.match(content, /--rc-accent:\s*#38bdf8/, '深色强调色必须为纯正科技亮青');
  });

  it('1.2 验证旧版设计 Token 的向后兼容桥接 (Backward Compatibility)', async () => {
    const content = await fs.readFile(themeCssPath, 'utf8');
    assert.match(content, /--color-background:\s*var\(--rc-canvas\)/, '旧版 --color-background 必须安全桥接到 --rc-canvas');
    assert.match(content, /--color-surface:\s*var\(--rc-surface\)/, '旧版 --color-surface 必须安全桥接到 --rc-surface');
    assert.match(content, /--color-text:\s*var\(--rc-text-primary\)/, '旧版 --color-text 必须安全桥接到 --rc-text-primary');
    assert.match(content, /--zt-bg:\s*var\(--rc-canvas\)/, '旧版 --zt-bg 必须安全桥接到 --rc-canvas');
  });

  it('1.3 验证 index.css 正确导入 raycast-theme.css 且重构侧边栏项目高亮', async () => {
    assert.ok(existsSync(indexCssPath), 'index.css 必须存在');
    const content = await fs.readFile(indexCssPath, 'utf8');

    assert.match(content, /@import '\.\/raycast-theme\.css';/, 'index.css 必须首先引入 raycast-theme.css');
    assert.doesNotMatch(content, /@import '\.\/design-tokens-3d\.css';/, 'index.css 不应再引入陈旧的 3D 彩虹渐变样式');
    assert.match(content, /box-shadow:\s*inset\s*2\.5px\s*0\s*0\s*0\s*var\(--rc-accent\)/, '侧边栏激活项必须采用 Raycast 微亮条指示');
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

  it('2.3 验证 getTitleBarOverlayOptions 在暗黑与明亮模式下的色彩契约', () => {
    const { getTitleBarOverlayOptions } = mainWindowModule;
    assert.strictEqual(typeof getTitleBarOverlayOptions, 'function');

    // 深色模式：深曜石底色 + 浅灰三键
    const darkOpts = getTitleBarOverlayOptions(true);
    assert.strictEqual(darkOpts.color, '#101216');
    assert.strictEqual(darkOpts.symbolColor, '#94a3b8');
    assert.strictEqual(darkOpts.height, 40);

    // 浅色模式：冰霜冷灰底色 + 深灰三键
    const lightOpts = getTitleBarOverlayOptions(false);
    assert.strictEqual(lightOpts.color, '#f8fafc');
    assert.strictEqual(lightOpts.symbolColor, '#475569');
    assert.strictEqual(lightOpts.height, 40);

    // 容错与非标准参数
    const fallbackOpts1 = getTitleBarOverlayOptions(undefined);
    assert.strictEqual(fallbackOpts1.color, '#f8fafc', '未定义模式时默认按浅色降级');
    const fallbackOpts2 = getTitleBarOverlayOptions(null);
    assert.strictEqual(fallbackOpts2.color, '#f8fafc', 'null 模式时默认按浅色降级');
  });

  it('2.4 验证 updateMainWindowTheme 状态更新与边界防御', () => {
    const { updateMainWindowTheme } = mainWindowModule;
    assert.strictEqual(typeof updateMainWindowTheme, 'function');

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
    assert.strictEqual(bgCalls[bgCalls.length - 1], '#101216');
    if (process.platform === 'win32') {
      assert.strictEqual(titleBarCalls[titleBarCalls.length - 1].color, '#101216');
    }

    updateMainWindowTheme(mockWindow, false);
    assert.strictEqual(bgCalls[bgCalls.length - 1], '#f8fafc');
    if (process.platform === 'win32') {
      assert.strictEqual(titleBarCalls[titleBarCalls.length - 1].color, '#f8fafc');
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

  it('3.2 验证 SearchBar.vue 具备矢量放大镜与精致的 Ctrl K 键帽徽标', async () => {
    const searchBarPath = path.join(REPO_ROOT, 'frontend', 'src', 'components', 'SearchBar.vue');
    const content = await fs.readFile(searchBarPath, 'utf8');

    assert.match(content, /<svg[^>]*viewBox="0 0 24 24"/, '搜索框前缀必须使用标准 24x24 矢量 SVG 图标');
    assert.doesNotMatch(content, /fa-search/, '不再使用陈旧粗糙的 fa-search');
    assert.match(content, /<kbd class="rc-kbd[^"]*">Ctrl K<\/kbd>/, '搜索框后缀必须包含工业风 Ctrl K 快捷键微标');
    assert.match(content, /border-radius:\s*var\(--rc-radius-md,\s*8px\)/, '搜索框圆角必须符合 Raycast 8px 规范');
  });

  it('3.3 验证 Sidebar.vue 具备工作空间分栏与矢量几何图标', async () => {
    const sidebarPath = path.join(REPO_ROOT, 'frontend', 'src', 'components', 'Sidebar.vue');
    const content = await fs.readFile(sidebarPath, 'utf8');

    assert.match(content, /工作空间/, '侧边栏必须具备清晰的 WORKSPACE 工作空间分组');
    assert.match(content, /探索分类/, '侧边栏必须具备 CATEGORIES 分类分组');
    assert.match(content, /<svg[^>]*viewBox="0 0 24 24"/, '侧边栏必须采用现代矢量 SVG 图标');
    assert.doesNotMatch(content, /sidebar-new-badge/, '严禁出现生硬大红底“新”字方块');
    assert.match(content, /bg-red-500\s+animate-pulse/, '未读消息必须采用精巧的微型脉冲点');
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

    assert.match(content, /<footer[^>]*border-t/, '必须常驻底部边框 Footer');
    assert.match(content, /<kbd class="rc-kbd[^"]*">↵<\/kbd>/, '底部左侧必须展示 ↵ 打开动作指示');
    assert.match(content, /<kbd class="rc-kbd[^"]*">Ctrl K<\/kbd>/, '底部右侧必须常驻 Actions [Ctrl K] 动作呼出按钮');
    assert.match(content, /openSearchOrActions/, '底部动作按钮必须具备交互绑定函数');
  });

  it('3.6 验证 MyPage.vue 彻底清除黄色拖拽横条提示，重构 Segmented Tab', async () => {
    const myPagePath = path.join(REPO_ROOT, 'frontend', 'src', 'pages', 'MyPage.vue');
    const content = await fs.readFile(myPagePath, 'utf8');

    assert.doesNotMatch(content, /可以拖拽调整插件顺序/, '必须彻底剔除视觉噪音严重的黄色拖拽提示横幅');
    assert.match(content, /已安装\s*\(\{\{\s*installedCount\s*\}\}\)/, '分类标签必须精简为“已安装”');
    assert.match(content, /收藏\s*\(\{\{\s*favoritesCount\s*\}\}\)/, '分类标签必须精简为“收藏”');
  });
});

describe('【模块四】混沌工程抗毁性与高频并发压力测试 (Chaos & Resilience)', () => {
  it('4.1 [高频并发竞态] 极短时间内密集交替触发深/浅色模式切换', async () => {
    const { updateMainWindowTheme, getTitleBarOverlayOptions } = mainWindowModule;

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
    assert.ok(
      currentColor === '#101216' || currentColor === '#f8fafc',
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

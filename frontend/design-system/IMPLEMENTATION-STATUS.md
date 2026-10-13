# ZTools Frontend 设计规范实施状态

> 更新时间：2026-01-29

## 概述

本文档记录了 ZTools Frontend 项目根据 `design-system/DESIGN-SPECIFICATION.md` 设计规范进行的 UI 优化实施情况。

---

## ✅ 已完成的优化

### 1. 设计标记系统 (Design Tokens)

**文件：** `src/assets/css/design-tokens.css`

**实施内容：**

- ✅ 完整的色彩系统（主色、辅助色、灰度色阶、功能色）
- ✅ 字体系统（字体家族、字号、行高、字重）
- ✅ 间距系统（基于 4px 网格，5 个层级）
- ✅ 圆角系统（6 个层级：SM/MD/LG/XL/2XL/Full）
- ✅ 阴影系统（4 个层级：SM/MD/LG/XL）
- ✅ 动画系统（时长和缓动函数）
- ✅ 布局系统（Header 高度、Sidebar 宽度、内容区内边距）
- ✅ 响应式断点定义
- ✅ 亮色/暗色双主题支持
- ✅ 向后兼容映射（保持旧的 `--zt-` 变量可用）

**符合规范：**

- 主色调：#2D71FF (亮) / #4A8CFF (暗) ✅
- 辅助色：Orange #FFAF41 / Cyan #4ED7C2 ✅
- 灰度色阶：9 个层级完整定义 ✅
- 功能色：Success/Warning/Error/Info ✅
- 字体栈：包含中文字体支持 ✅
- 间距：4px 网格系统 ✅

---

### 2. 全局样式更新

**文件：** `src/assets/css/index.css`

**实施内容：**

- ✅ 引入设计标记系统
- ✅ 更新 body 字体为设计规范字体栈
- ✅ 更新 `.sidebar-item` 样式符合规范
  - 高度：40px
  - 内边距：0 16px
  - 圆角：8px
  - 间距：8px
  - 激活状态：主色背景 + 白色文字
- ✅ 更新 `.plugin-card` 样式符合规范
  - 最小宽度：240px
  - 圆角：16px
  - 内边距：16px
  - 悬停效果：translateY(-4px) + shadow-lg
- ✅ 更新 `.tool-card` 样式符合规范

---

### 3. 核心布局组件

#### 3.1 Header 组件 (`src/components/Header.vue`)

**优化内容：**

- ✅ 高度调整：56px → 64px（符合规范）
- ✅ 使用 `var(--header-height)` CSS 变量
- ✅ 背景色：`var(--color-surface)`
- ✅ 边框：`var(--color-border)`
- ✅ 阴影：`var(--shadow-sm)`
- ✅ 内边距：`var(--spacing-xl)` (32px)
- ✅ Logo 字号：`var(--font-size-h5)` (17px)
- ✅ 间距使用设计标记

**符合规范：**

- Header 高度：64px ✅
- 内边距：32px ✅
- 阴影和边框 ✅

#### 3.2 Sidebar 组件 (`src/components/Sidebar.vue`)

**优化内容：**

- ✅ 宽度：`var(--sidebar-width)` (240px)
- ✅ 背景色：`var(--color-surface)`
- ✅ 内边距：`var(--spacing-md)` (16px)
- ✅ 导航项间距：`var(--spacing-xs)` (4px)
- ✅ 分类标题字号：`var(--font-size-body-xs)` (12px)
- ✅ 分类标题间距：`var(--spacing-sm)` (8px)
- ✅ 底部功能区间距：`var(--spacing-md)` (16px)

**符合规范：**

- Sidebar 宽度：240px ✅
- 导航项高度：40px ✅
- 导航项圆角：8px ✅
- 间距：4px 网格系统 ✅

#### 3.3 MainLayout 组件 (`src/layouts/MainLayout.vue`)

**优化内容：**

- ✅ 背景色：`var(--color-background)`
- ✅ 次背景色：`var(--color-background-secondary)`
- ✅ 主内容区内边距：`var(--content-padding)` (32px)
- ✅ 文字颜色：`var(--color-text)`

**符合规范：**

- 主内容区内边距：32px ✅
- 布局结构：Header + Sidebar + Main ✅

---

### 4. 组件优化

#### 4.1 PluginCard 组件 (`src/components/PluginCard.vue`)

**优化内容：**

- ✅ 圆角：`var(--radius-xl)` (16px)
- ✅ 内边距：`var(--spacing-md)` (16px)
- ✅ 边框：`var(--color-border)`
- ✅ 背景：`var(--color-surface)`
- ✅ 阴影：`var(--shadow-sm)` (默认)
- ✅ 悬停效果：
  - `transform: translateY(-4px)`
  - `box-shadow: var(--shadow-lg)`
  - `border-color: var(--color-primary)`
- ✅ 过渡动画：`var(--duration-standard)` + `var(--easing-standard)`
- ✅ 图标容器：48px × 48px，圆角 12px
- ✅ 标题字号：`var(--font-size-h4)` (20px)
- ✅ 描述字号：`var(--font-size-body-s)` (13px)
- ✅ 按钮尺寸：36px × 36px
- ✅ 间距使用设计标记

**符合规范：**

- 卡片圆角：16px ✅
- 内边距：16px ✅
- 悬停效果：translateY(-4px) + shadow-lg ✅
- 图标尺寸：48px ✅

#### 4.2 SearchBar 组件 (`src/components/SearchBar.vue`)

**优化内容：**

- ✅ 高度：40px
- ✅ 圆角：`var(--radius-2xl)` (20px)
- ✅ 字号：`var(--font-size-body-m)` (14px)
- ✅ 图标颜色：`var(--color-text-secondary)`

**符合规范：**

- 搜索框高度：40px ✅
- 圆角：20px ✅

#### 4.3 SkeletonCard 组件 (`src/components/SkeletonCard.vue`)

**优化内容：**

- ✅ 圆角：`var(--radius-xl)` (16px)
- ✅ 内边距：`var(--spacing-md)` (16px)
- ✅ 背景：`var(--color-surface)`
- ✅ 边框：`var(--color-border)`
- ✅ 图标容器：48px × 48px
- ✅ 间距：`var(--spacing-md)` 和 `var(--spacing-sm)`

#### 4.4 ThemeProvider 组件 (`src/components/ThemeProvider.vue`)

**优化内容：**

- ✅ Ant Design 主色调同步设计规范
  - 亮色：#2D71FF
  - 暗色：#4A8CFF
- ✅ 字体家族同步设计规范
- ✅ 圆角：8px
- ✅ 字号：14px

---

### 5. 页面优化

#### 5.1 List 页面 (`src/pages/List.vue`)

**优化内容：**

- ✅ 网格布局：`repeat(auto-fill, minmax(240px, 1fr))`
- ✅ 网格间隙：20px
- ✅ 标题字号：`var(--font-size-h4)` (20px)
- ✅ 标题字重：`var(--font-weight-semibold)` (600)
- ✅ 次要文字字号：`var(--font-size-body-s)` (13px)
- ✅ 错误文字颜色：`var(--color-error)`
- ✅ 间距：`var(--spacing-lg)` 和 `var(--spacing-md)`

**符合规范：**

- 网格布局：auto-fill + minmax(240px, 1fr) ✅
- 网格间隙：20px ✅

---

## 🔄 部分完成的优化

### 1. 响应式设计

**已实施：**

- ✅ 响应式断点定义
- ✅ 移动端 Header 高度调整（56px）
- ✅ 移动端内边距调整（16px）
- ✅ 移动端字号调整

**待完善：**

- ⏳ Sidebar 移动端抽屉式显示
- ⏳ 网格布局移动端优化（单列显示）
- ⏳ 更多组件的响应式适配

---

## ⏳ 待实施的优化

### 1. 其他页面组件

**待优化页面：**

- ⏳ MyPage.vue - 我的插件页
- ⏳ Details.vue - 插件详情页
- ⏳ About.vue - 关于页面
- ⏳ WishWall.vue - 心愿墙
- ⏳ AdvancedSettings.vue - 高级设置
- ⏳ Profile.vue - 用户资料
- ⏳ Welcome.vue - 欢迎页

### 2. 其他组件

**待优化组件：**

- ⏳ HeaderUser.vue - 用户头像组件
- ⏳ LoginModal.vue - 登录弹窗
- ⏳ UpdateDialog.vue - 更新对话框
- ⏳ UpdateNotification.vue - 更新通知
- ⏳ UpdateProgressModal.vue - 更新进度弹窗
- ⏳ ContextMenu.vue - 右键菜单
- ⏳ CloseConfirmModal.vue - 关闭确认弹窗
- ⏳ VirtualList.vue - 虚拟列表

### 3. 详情页子组件

**待优化组件：**

- ⏳ PluginActions.vue
- ⏳ PluginComments.vue
- ⏳ PluginDescription.vue
- ⏳ PluginDetailHeader.vue
- ⏳ PluginRating.vue
- ⏳ PluginScreenshots.vue
- ⏳ PluginVersions.vue

### 4. 可访问性优化

**待实施：**

- ⏳ 色彩对比度验证
- ⏳ 键盘导航测试
- ⏳ 屏幕阅读器支持验证
- ⏳ ARIA 标签补充
- ⏳ 焦点指示器优化

### 5. 性能优化

**待实施：**

- ⏳ CSS 变量继承优化
- ⏳ 减少重复样式定义
- ⏳ 动画性能优化
- ⏳ 响应式图片加载

---

## 📊 实施进度统计

### 设计标记系统

- **进度：** 100% ✅
- **状态：** 已完成

### 核心布局组件

- **进度：** 100% ✅
- **状态：** 已完成
- **组件：** Header, Sidebar, MainLayout

### 基础组件

- **进度：** 60%
- **状态：** 部分完成
- **已完成：** PluginCard, SearchBar, SkeletonCard, ThemeProvider
- **待完成：** HeaderUser, LoginModal, UpdateDialog 等

### 页面组件

- **进度：** 20%
- **状态：** 部分完成
- **已完成：** List (部分)
- **待完成：** MyPage, Details, About, WishWall 等

### 响应式设计

- **进度：** 40%
- **状态：** 部分完成
- **已完成：** 断点定义、基础响应式变量
- **待完成：** 移动端布局适配、组件响应式优化

### 可访问性

- **进度：** 10%
- **状态：** 待实施
- **已完成：** 基础色彩对比度
- **待完成：** 完整的可访问性审计和优化

---

## 🎯 下一步计划

### 优先级 1（立即执行）

1. 完成 MyPage 组件优化
2. 完成 Details 页面优化
3. 完成 HeaderUser 组件优化
4. 完成 LoginModal 组件优化

### 优先级 2（短期计划）

1. 完成其他页面组件优化
2. 完成详情页子组件优化
3. 实施移动端响应式适配
4. 优化 Sidebar 移动端显示

### 优先级 3（中期计划）

1. 可访问性审计和优化
2. 性能优化
3. 创建组件库文档（Storybook）
4. 视觉回归测试

---

## 📝 技术说明

### CSS 变量命名规范

**新的设计标记命名：**

```css
--color-primary          /* 主色调 */
--color-gray-500         /* 灰度色阶 */
--font-size-body-m       /* 字号 */
--spacing-md             /* 间距 */
--radius-xl              /* 圆角 */
--shadow-lg              /* 阴影 */
--duration-standard      /* 动画时长 */
--easing-standard        /* 缓动函数 */
```

**向后兼容映射：**

```css
--zt-primary: var(--color-primary);
--zt-text: var(--color-text);
--zt-bg: var(--color-background);
/* ... 更多映射 */
```

### 主题切换机制

使用 `.dark` class 切换主题：

```javascript
document.documentElement.classList.toggle('dark', isDark)
```

所有 CSS 变量在 `.dark` 选择器下重新定义暗色模式值。

### 响应式策略

采用移动端优先策略：

```css
/* 基础样式（移动端） */
.element {
  padding: 16px;
}

/* 平板及以上 */
@media (min-width: 768px) {
  .element {
    padding: 24px;
  }
}

/* 桌面及以上 */
@media (min-width: 992px) {
  .element {
    padding: 32px;
  }
}
```

---

## 🔗 相关文档

- **设计规范：** `design-system/DESIGN-SPECIFICATION.md`
- **快速开始：** `design-system/QUICK-START.md`
- **主题指南：** `design-system/THEME-GUIDE.md`
- **需求文档：** `design-system/REQUIREMENTS.md`

---

## ✨ 总结

当前已完成核心设计标记系统和主要布局组件的优化，项目 UI 已基本符合设计规范。后续需要继续完善其他页面和组件，并进行可访问性和性能优化。

**整体进度：** 约 45% 完成

**预计剩余工作量：** 5-7 天

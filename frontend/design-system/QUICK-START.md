# ZTools 设计规范 - 快速开始指南

> 5 分钟快速了解和使用 ZTools 设计规范系统

## 🎯 核心概念

### 设计系统是什么？

ZTools 设计规范系统是一套完整的视觉和交互标准，包括：

- **设计标记**：色彩、字体、间距、圆角、阴影
- **组件库**：按钮、卡片、导航、输入框等 8 个核心组件
- **布局规范**：页面结构、网格系统
- **交互规范**：动画、悬停效果、加载状态
- **响应式设计**：6 个断点，适配所有设备

### 为什么使用设计系统？

✅ **一致性**：确保整个产品的视觉和交互体验统一  
✅ **效率**：减少重复设计和开发工作  
✅ **质量**：遵循最佳实践和可访问性标准  
✅ **可维护**：使用 CSS 变量，易于更新和扩展  
✅ **协作**：设计师和开发者使用相同的语言

## 🚀 5 分钟快速上手

### 第 1 步：了解色彩系统（1 分钟）

#### 亮色模式

```css
--color-primary: #2d71ff; /* 主色调 - 蓝色 */
--color-orange: #ffaf41; /* 辅助色 - 橙色 */
--color-cyan: #4ed7c2; /* 辅助色 - 青色 */
--color-background: #ffffff; /* 背景色 - 白色 */
--color-text: #2f2f46; /* 文字色 - 深灰 */
```

#### 暗色模式

```css
--color-primary: #4a8cff; /* 主色调 - 调亮的蓝色 */
--color-background: #0f0f0f; /* 背景色 - 深色 */
--color-text: #f0f2fa; /* 文字色 - 浅色 */
```

**记住**：所有颜色都有亮色和暗色两个版本！

### 第 2 步：掌握间距系统（1 分钟）

基于 **4px 网格系统**，所有间距都是 4 的倍数：

```css
--spacing-xs: 4px; /* 极小间距 */
--spacing-sm: 8px; /* 小间距 */
--spacing-md: 16px; /* 中等间距 ⭐ 最常用 */
--spacing-lg: 24px; /* 大间距 */
--spacing-xl: 32px; /* 超大间距 */
```

**使用场景**：

- 组件内边距：`var(--spacing-md)` (16px)
- 组件之间：`var(--spacing-lg)` (24px)
- 页面边距：`var(--spacing-xl)` (32px)

### 第 3 步：创建第一个按钮（1 分钟）

```html
<button class="btn-primary">主要按钮</button>
```

```css
.btn-primary {
  /* 尺寸 */
  height: 40px;
  padding: 0 var(--spacing-md);

  /* 样式 */
  background: var(--color-primary);
  color: #ffffff;
  border: none;
  border-radius: var(--radius-md);

  /* 字体 */
  font-size: var(--font-size-body-m);
  font-weight: var(--font-weight-semibold);

  /* 阴影和动画 */
  box-shadow: var(--shadow-sm);
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
  cursor: pointer;
}

.btn-primary:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.btn-primary:active {
  transform: translateY(0);
}
```

### 第 4 步：创建第一个卡片（1 分钟）

```html
<div class="card">
  <div class="card-icon">
    <!-- 图标 -->
  </div>
  <h3 class="card-title">卡片标题</h3>
  <p class="card-description">卡片描述文字</p>
  <button class="btn-primary">操作按钮</button>
</div>
```

```css
.card {
  /* 尺寸 */
  min-width: 240px;
  padding: var(--spacing-md);

  /* 样式 */
  background: var(--color-surface);
  border: 1px solid var(--color-gray-200);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-sm);

  /* 动画 */
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.card:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-lg);
  border-color: var(--color-primary);
}
```

### 第 5 步：实现主题切换（1 分钟）

```html
<!-- HTML -->
<button id="theme-toggle">切换主题</button>
```

```javascript
// JavaScript
function toggleTheme() {
  const html = document.documentElement
  const currentTheme = html.getAttribute('data-theme')
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark'

  html.setAttribute('data-theme', newTheme)
  localStorage.setItem('theme', newTheme)
}

// 初始化主题
function initTheme() {
  const savedTheme = localStorage.getItem('theme') || 'light'
  document.documentElement.setAttribute('data-theme', savedTheme)
}

initTheme()
```

```css
/* CSS */
:root {
  --color-primary: #2d71ff;
  --color-background: #ffffff;
}

[data-theme='dark'] {
  --color-primary: #4a8cff;
  --color-background: #0f0f0f;
}
```

## 📚 核心规范速查

### 色彩系统

| 用途     | 亮色模式  | 暗色模式  |
| -------- | --------- | --------- |
| 主色调   | `#2D71FF` | `#4A8CFF` |
| 背景色   | `#FFFFFF` | `#0F0F0F` |
| 卡片背景 | `#FFFFFF` | `#1F1F1F` |
| 主要文字 | `#212121` | `#E0E0E0` |
| 次要文字 | `#757575` | `#9E9E9E` |

### 字体系统

| 类型 | 字号 | 字重 | 行高 |
| ---- | ---- | ---- | ---- |
| H1   | 48px | 700  | 56px |
| H2   | 32px | 700  | 40px |
| H3   | 24px | 600  | 32px |
| H4   | 20px | 600  | 28px |
| 正文 | 14px | 400  | 22px |
| 小字 | 12px | 400  | 18px |

### 圆角系统

| 名称 | 值   | 用途         |
| ---- | ---- | ------------ |
| SM   | 4px  | 小元素       |
| MD   | 8px  | 按钮、输入框 |
| LG   | 12px | 导航项       |
| XL   | 16px | 卡片         |
| 2XL  | 20px | 搜索框       |
| Full | 50%  | 圆形头像     |

### 阴影系统

| 名称      | 用途         |
| --------- | ------------ |
| Shadow SM | 卡片默认状态 |
| Shadow MD | 卡片悬停状态 |
| Shadow LG | 下拉菜单     |
| Shadow XL | 模态对话框   |

### 组件尺寸

| 组件         | 尺寸    |
| ------------ | ------- |
| 按钮高度     | 40px    |
| 图标按钮     | 40x40px |
| 卡片最小宽度 | 240px   |
| Header 高度  | 64px    |
| Sidebar 宽度 | 240px   |
| 搜索框高度   | 40px    |
| 用户头像     | 40x40px |

## 💡 常用代码片段

### 1. 定义 CSS 变量

```css
:root {
  /* 色彩 */
  --color-primary: #2d71ff;
  --color-orange: #ffaf41;
  --color-cyan: #4ed7c2;
  --color-background: #ffffff;
  --color-surface: #ffffff;
  --color-gray-50: #fafafa;
  --color-gray-100: #f5f5f5;
  --color-gray-200: #eeeeee;
  --color-gray-700: #616161;
  --color-gray-900: #212121;

  /* 字体 */
  --font-family-base:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial,
    sans-serif;
  --font-size-h1: 48px;
  --font-size-h2: 32px;
  --font-size-h3: 24px;
  --font-size-h4: 20px;
  --font-size-body-m: 14px;
  --font-size-body-s: 13px;
  --font-size-body-xs: 12px;
  --font-weight-regular: 400;
  --font-weight-semibold: 600;
  --font-weight-bold: 700;

  /* 间距 */
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --spacing-xl: 32px;

  /* 圆角 */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-2xl: 20px;
  --radius-full: 50%;

  /* 阴影 */
  --shadow-sm: 0 1px 2px 0 rgba(47, 47, 70, 0.04);
  --shadow-md: 0 2px 4px 0 rgba(47, 47, 70, 0.08);
  --shadow-lg: 0 4px 8px 0 rgba(47, 47, 70, 0.12);
  --shadow-xl: 0 8px 16px 0 rgba(47, 47, 70, 0.16);

  /* 动画 */
  --duration-fast: 0.2s;
  --duration-standard: 0.3s;
  --easing-standard: cubic-bezier(0.34, 1.56, 0.64, 1);
}

[data-theme='dark'] {
  --color-primary: #4a8cff;
  --color-orange: #ffb84d;
  --color-cyan: #5de0ca;
  --color-background: #0f0f0f;
  --color-surface: #1f1f1f;
  --color-gray-50: #0a0a0a;
  --color-gray-100: #141414;
  --color-gray-200: #1f1f1f;
  --color-gray-700: #9e9e9e;
  --color-gray-900: #e0e0e0;

  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.2);
  --shadow-md: 0 2px 4px 0 rgba(0, 0, 0, 0.3);
  --shadow-lg: 0 4px 8px 0 rgba(0, 0, 0, 0.4);
  --shadow-xl: 0 8px 16px 0 rgba(0, 0, 0, 0.6);
}
```

### 2. 页面布局结构

```html
<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ZTools</title>
    <link rel="stylesheet" href="styles/main.css" />
  </head>
  <body>
    <!-- Header -->
    <header class="header">
      <div class="header-left">
        <h1 class="logo">ZTools</h1>
      </div>
      <div class="header-center">
        <input type="search" class="search-input" placeholder="搜索..." />
      </div>
      <div class="header-right">
        <button id="theme-toggle" class="btn-icon">🌙</button>
        <img src="avatar.jpg" alt="用户头像" class="avatar" />
      </div>
    </header>

    <!-- Main Container -->
    <div class="container">
      <!-- Sidebar -->
      <aside class="sidebar">
        <nav class="nav">
          <a href="#" class="nav-item active">首页</a>
          <a href="#" class="nav-item">我的工具</a>
          <a href="#" class="nav-item">设置</a>
        </nav>
      </aside>

      <!-- Main Content -->
      <main class="main-content">
        <div class="grid-container">
          <!-- 卡片内容 -->
        </div>
      </main>
    </div>

    <script src="scripts/app.js"></script>
  </body>
</html>
```

### 3. 响应式网格

```css
.grid-container {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 20px;
  padding: var(--spacing-xl);
}

/* 平板 */
@media (max-width: 992px) {
  .grid-container {
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 16px;
    padding: var(--spacing-lg);
  }
}

/* 手机 */
@media (max-width: 768px) {
  .grid-container {
    grid-template-columns: 1fr;
    gap: 12px;
    padding: var(--spacing-md);
  }
}
```

## ❓ 常见问题

### Q1: 如何选择合适的颜色？

**A**: 遵循以下原则：

- **主要操作**：使用 `--color-primary`（蓝色）
- **警告/收藏**：使用 `--color-orange`（橙色）
- **成功状态**：使用 `--color-cyan`（青色）
- **文字**：使用 `--color-gray-700` 或 `--color-gray-900`
- **背景**：使用 `--color-background` 或 `--color-surface`

### Q2: 如何选择合适的间距？

**A**: 根据元素关系选择：

- **紧密相关**（图标+文字）：`--spacing-xs` (4px)
- **相关元素**（按钮组）：`--spacing-sm` (8px)
- **组件内部**（卡片内边距）：`--spacing-md` (16px)
- **组件之间**（卡片间距）：`--spacing-lg` (24px)
- **页面边距**：`--spacing-xl` (32px)

### Q3: 按钮应该用多大的圆角？

**A**:

- **标准按钮**：`--radius-md` (8px)
- **大按钮/卡片**：`--radius-lg` (12px) 或 `--radius-xl` (16px)
- **搜索框**：`--radius-2xl` (20px)
- **圆形按钮/头像**：`--radius-full` (50%)

### Q4: 如何实现悬停效果？

**A**: 标准悬停效果包括：

```css
.element:hover {
  transform: translateY(-2px); /* 上移 2px */
  box-shadow: var(--shadow-md); /* 阴影加深 */
}
```

### Q5: 暗色模式如何适配？

**A**: 使用 CSS 变量，自动适配：

```css
.element {
  background: var(--color-background); /* 自动切换 */
  color: var(--color-text); /* 自动切换 */
}
```

### Q6: 如何确保可访问性？

**A**: 遵循以下原则：

- 文字与背景对比度 ≥ 4.5:1
- 所有交互元素可通过键盘访问
- 提供清晰的焦点指示器
- 为图标按钮添加 `aria-label`

### Q7: 响应式断点如何选择？

**A**: 使用标准断点：

- **手机**：< 768px
- **平板**：768px - 992px
- **桌面**：≥ 992px

### Q8: 如何自定义品牌颜色？

**A**: 修改 CSS 变量中的主色调：

```css
:root {
  --color-primary: #YOUR_COLOR; /* 替换为你的品牌色 */
}

[data-theme='dark'] {
  --color-primary: #YOUR_DARK_COLOR; /* 暗色模式的品牌色 */
}
```

## 📖 下一步学习

### 初学者

1. ✅ 完成本快速指南
2. 📖 阅读 `THEME-GUIDE.md` 了解主题系统
3. 🎨 实现 2-3 个基础组件
4. 🧪 测试响应式适配

### 进阶者

1. 📖 阅读完整的 `DESIGN-SPECIFICATION.md`
2. 🎨 实现所有 8 个核心组件
3. 🔄 实现主题切换功能
4. ♿ 验证可访问性

### 高级者

1. 📖 深入理解设计原则和最佳实践
2. 🎨 自定义和扩展设计系统
3. 📦 创建可复用的组件库
4. 👥 建立团队设计规范流程

## 🔗 相关文档

- **完整设计规范**：`DESIGN-SPECIFICATION.md`
- **需求文档**：`REQUIREMENTS.md`
- **实施任务**：`IMPLEMENTATION-TASKS.md`
- **主题指南**：`THEME-GUIDE.md`
- **使用指南**：`README.md`

## 💪 实战练习

### 练习 1：创建一个登录表单

使用设计系统创建包含以下元素的登录表单：

- 输入框（用户名、密码）
- 主要按钮（登录）
- 次要按钮（取消）
- 链接（忘记密码）

### 练习 2：创建一个工具卡片

创建一个包含以下元素的工具卡片：

- 图标容器
- 标题和描述
- 收藏按钮
- 启动按钮

### 练习 3：实现响应式导航

创建一个响应式导航栏：

- 桌面端：水平导航
- 移动端：汉堡菜单

---

**恭喜！** 你已经掌握了 ZTools 设计规范系统的核心概念。

**开始实践**：选择一个组件，参考 `DESIGN-SPECIFICATION.md` 开始实现吧！

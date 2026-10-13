# 设计文档 - ZTools 设计规范系统

## 概述

ZTools 设计规范系统是一个完整的、系统化的设计语言，为工具管理平台提供统一的视觉和交互标准。该系统支持亮色和暗色两种主题模式，确保在不同环境下都能提供优秀的用户体验。

### 设计理念

**简洁而强大**: 设计系统追求简洁明了的视觉语言，同时提供足够的灵活性来满足各种使用场景。

**一致性优先**: 通过标准化的设计标记（Design Tokens）和组件库，确保整个平台的视觉和交互体验保持一致。

**可访问性**: 所有设计决策都考虑可访问性，确保所有用户都能轻松使用平台。

**性能导向**: 优先使用系统原生字体和 CSS 变量，减少资源加载，提升性能。

### 核心特点

1. **双主题支持**: 完整的亮色和暗色模式，自动适配用户偏好
2. **模块化设计**: 基于原子设计理论，从基础标记到复杂组件层层构建
3. **响应式优先**: 移动端优先的设计策略，适配所有设备尺寸
4. **开发友好**: 使用 CSS 变量，易于维护和扩展

## 架构

### 设计标记层次结构

```
设计系统
├── 基础标记 (Foundation Tokens)
│   ├── 色彩 (Colors)
│   ├── 字体 (Typography)
│   ├── 间距 (Spacing)
│   ├── 圆角 (Border Radius)
│   └── 阴影 (Shadows)
├── 语义标记 (Semantic Tokens)
│   ├── 主题色 (Theme Colors)
│   ├── 功能色 (Functional Colors)
│   └── 组件标记 (Component Tokens)
└── 组件层 (Component Layer)
    ├── 基础组件 (Base Components)
    ├── 复合组件 (Composite Components)
    └── 布局组件 (Layout Components)
```

### 主题切换机制

系统使用 CSS 变量和 `data-theme` 属性实现主题切换：

```css
/* 根元素定义主题 */
:root[data-theme='light'] {
  --color-primary: #2d71ff;
  --color-background: #ffffff;
}

:root[data-theme='dark'] {
  --color-primary: #4a8cff;
  --color-background: #1a1a1a;
}
```

## 组件和接口

### 1. 色彩系统 (Color System)

#### 1.1 主色调 (Primary Colors)

| 模式 | 颜色名称 | HEX     | RGB               | CSS 变量        | 用途                 |
| ---- | -------- | ------- | ----------------- | --------------- | -------------------- |
| 亮色 | Primary  | #2D71FF | rgb(45, 113, 255) | --color-primary | 主要操作、链接、强调 |
| 暗色 | Primary  | #4A8CFF | rgb(74, 140, 255) | --color-primary | 主要操作、链接、强调 |

#### 1.2 辅助色 (Secondary Colors)

| 颜色名称 | 亮色模式 HEX | 亮色模式 RGB      | 暗色模式 HEX | 暗色模式 RGB      | CSS 变量       |
| -------- | ------------ | ----------------- | ------------ | ----------------- | -------------- |
| Orange   | #FFAF41      | rgb(255, 175, 65) | #FFB84D      | rgb(255, 184, 77) | --color-orange |
| Cyan     | #4ED7C2      | rgb(78, 215, 194) | #5DE0CA      | rgb(93, 224, 202) | --color-cyan   |

#### 1.3 灰度色阶 (Gray Scale)

| 层级     | 亮色模式 HEX | 暗色模式 HEX | CSS 变量         | 用途         |
| -------- | ------------ | ------------ | ---------------- | ------------ |
| Gray-50  | #FAFAFA      | #0A0A0A      | --color-gray-50  | 最浅背景     |
| Gray-100 | #F5F5F5      | #141414      | --color-gray-100 | 浅背景       |
| Gray-200 | #EEEEEE      | #1F1F1F      | --color-gray-200 | 边框、分割线 |
| Gray-300 | #E0E0E0      | #2A2A2A      | --color-gray-300 | 禁用状态     |
| Gray-400 | #BDBDBD      | #3F3F3F      | --color-gray-400 | 占位符       |
| Gray-500 | #9E9E9E      | #5C5C5C      | --color-gray-500 | 次要文本     |
| Gray-600 | #757575      | #7A7A7A      | --color-gray-600 | 辅助文本     |
| Gray-700 | #616161      | #9E9E9E      | --color-gray-700 | 正文文本     |
| Gray-800 | #424242      | #BDBDBD      | --color-gray-800 | 标题文本     |
| Gray-900 | #212121      | #E0E0E0      | --color-gray-900 | 主要文本     |

#### 1.4 功能色 (Functional Colors)

| 功能    | 亮色模式 HEX | 暗色模式 HEX | RGB (亮色)        | RGB (暗色)         | CSS 变量        |
| ------- | ------------ | ------------ | ----------------- | ------------------ | --------------- |
| Success | #10B981      | #34D399      | rgb(16, 185, 129) | rgb(52, 211, 153)  | --color-success |
| Warning | #F59E0B      | #FBBF24      | rgb(245, 158, 11) | rgb(251, 191, 36)  | --color-warning |
| Error   | #EF4444      | #F87171      | rgb(239, 68, 68)  | rgb(248, 113, 113) | --color-error   |
| Info    | #3B82F6      | #60A5FA      | rgb(59, 130, 246) | rgb(96, 165, 250)  | --color-info    |

#### 1.5 背景和表面色

| 用途     | 亮色模式 | 暗色模式 | CSS 变量                     |
| -------- | -------- | -------- | ---------------------------- |
| 主背景   | #FFFFFF  | #0F0F0F  | --color-background           |
| 次背景   | #FAFAFA  | #1A1A1A  | --color-background-secondary |
| 卡片背景 | #FFFFFF  | #1F1F1F  | --color-surface              |
| 悬停背景 | #F5F5F5  | #2A2A2A  | --color-hover                |

#### 1.6 色彩对比度指南

- 主要文本与背景对比度: ≥ 7:1 (AAA 级)
- 次要文本与背景对比度: ≥ 4.5:1 (AA 级)
- 大文本（18px+）与背景对比度: ≥ 3:1 (AA 级)
- 交互元素与背景对比度: ≥ 3:1

### 2. 字体系统 (Typography System)

#### 2.1 字体家族

```css
--font-family-base:
  -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
  'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial,
  sans-serif;
--font-family-mono:
  'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New',
  monospace;
```

#### 2.2 标题字号系统

| 层级 | 字号 | 行高         | 字重 | CSS 变量       | 使用场景   |
| ---- | ---- | ------------ | ---- | -------------- | ---------- |
| H1   | 48px | 56px (1.167) | 700  | --font-size-h1 | 页面主标题 |
| H2   | 32px | 40px (1.25)  | 700  | --font-size-h2 | 章节标题   |
| H3   | 24px | 32px (1.333) | 600  | --font-size-h3 | 子章节标题 |
| H4   | 20px | 28px (1.4)   | 600  | --font-size-h4 | 卡片标题   |
| H5   | 17px | 24px (1.412) | 600  | --font-size-h5 | 小标题     |

#### 2.3 正文字号系统

| 层级    | 字号 | 行高         | 字重 | CSS 变量            | 使用场景   |
| ------- | ---- | ------------ | ---- | ------------------- | ---------- |
| Body-L  | 16px | 24px (1.5)   | 400  | --font-size-body-l  | 主要正文   |
| Body-M  | 14px | 22px (1.571) | 400  | --font-size-body-m  | 次要正文   |
| Body-S  | 13px | 20px (1.538) | 400  | --font-size-body-s  | 辅助文本   |
| Body-XS | 12px | 18px (1.5)   | 400  | --font-size-body-xs | 标签、提示 |

#### 2.4 字重系统

```css
--font-weight-regular: 400;
--font-weight-semibold: 600;
--font-weight-bold: 700;
```

#### 2.5 字体使用指南

- **标题**: 使用 Semibold (600) 或 Bold (700)，确保层次清晰
- **正文**: 使用 Regular (400)，保持可读性
- **强调**: 使用 Semibold (600)，避免过度使用 Bold
- **行高**: 标题行高较紧凑（1.2-1.4），正文行高较宽松（1.5-1.6）

### 3. 间距系统 (Spacing System)

基于 4px 网格系统，确保视觉对齐和一致性。

| 层级 | 值   | CSS 变量     | 使用场景                 |
| ---- | ---- | ------------ | ------------------------ |
| XS   | 4px  | --spacing-xs | 紧密元素间距、图标边距   |
| SM   | 8px  | --spacing-sm | 小组件内边距、列表项间距 |
| MD   | 16px | --spacing-md | 标准组件内边距、卡片间距 |
| LG   | 24px | --spacing-lg | 章节间距、大组件内边距   |
| XL   | 32px | --spacing-xl | 页面边距、主要区块间距   |

#### 间距使用原则

1. **内边距 (Padding)**: 组件内部使用 MD (16px) 作为标准
2. **外边距 (Margin)**: 组件之间使用 MD (16px) 或 LG (24px)
3. **网格间隙 (Gap)**: 使用 SM (8px) 或 MD (16px)
4. **页面边距**: 使用 XL (32px)

### 4. 圆角系统 (Border Radius System)

| 层级 | 值   | CSS 变量      | 使用场景           |
| ---- | ---- | ------------- | ------------------ |
| SM   | 4px  | --radius-sm   | 小按钮、标签       |
| MD   | 8px  | --radius-md   | 标准按钮、输入框   |
| LG   | 12px | --radius-lg   | 卡片、对话框       |
| XL   | 16px | --radius-xl   | 大卡片、面板       |
| 2XL  | 20px | --radius-2xl  | 搜索框、特殊组件   |
| Full | 50%  | --radius-full | 圆形头像、圆形按钮 |

### 5. 阴影系统 (Shadow System)

#### 5.1 亮色模式阴影

```css
--shadow-sm: 0 1px 2px 0 rgba(47, 47, 70, 0.04);
--shadow-md: 0 2px 4px 0 rgba(47, 47, 70, 0.08);
--shadow-lg: 0 4px 8px 0 rgba(47, 47, 70, 0.12);
--shadow-xl: 0 8px 16px 0 rgba(47, 47, 70, 0.16);
```

#### 5.2 暗色模式阴影

```css
--shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.2);
--shadow-md: 0 2px 4px 0 rgba(0, 0, 0, 0.3);
--shadow-lg: 0 4px 8px 0 rgba(0, 0, 0, 0.4);
--shadow-xl: 0 8px 16px 0 rgba(0, 0, 0, 0.6);
```

#### 5.3 阴影使用指南

| 层级 | Z-index | 使用场景           |
| ---- | ------- | ------------------ |
| SM   | 1       | 卡片默认状态       |
| MD   | 2       | 卡片悬停状态、按钮 |
| LG   | 3       | 下拉菜单、弹出框   |
| XL   | 4       | 模态对话框、抽屉   |

## 数据模型

### 设计标记数据结构

```typescript
interface DesignToken {
  name: string // 标记名称，如 "color-primary"
  value: string // 标记值，如 "#2D71FF"
  cssVariable: string // CSS 变量名，如 "--color-primary"
  category: TokenCategory // 标记类别
  theme?: 'light' | 'dark' // 主题模式（可选）
}

type TokenCategory = 'color' | 'typography' | 'spacing' | 'radius' | 'shadow'

interface ColorToken extends DesignToken {
  category: 'color'
  hex: string // HEX 格式
  rgb: string // RGB 格式
  usage: string // 使用说明
  contrast?: number // 对比度（与背景）
}

interface TypographyToken extends DesignToken {
  category: 'typography'
  fontSize: string // 字号
  lineHeight: string // 行高
  fontWeight: number // 字重
  usage: string // 使用场景
}

interface ComponentSpec {
  name: string // 组件名称
  description: string // 组件描述
  variants: Variant[] // 变体列表
  states: State[] // 状态列表
  dimensions: Dimensions // 尺寸规范
  tokens: DesignToken[] // 使用的设计标记
}

interface Variant {
  name: string // 变体名称，如 "primary", "secondary"
  cssClass: string // CSS 类名
  tokens: DesignToken[] // 该变体使用的标记
}

interface State {
  name: 'default' | 'hover' | 'active' | 'disabled' | 'focus'
  cssClass: string // 状态类名
  styles: Record<string, string> // 样式属性
}

interface Dimensions {
  width?: string
  height?: string
  minWidth?: string
  minHeight?: string
  padding?: string
  margin?: string
}
```

### 组件规范示例

```typescript
const buttonSpec: ComponentSpec = {
  name: 'Button',
  description: '按钮组件，用于触发操作',
  variants: [
    {
      name: 'primary',
      cssClass: 'btn-primary',
      tokens: [
        { name: 'background', cssVariable: '--color-primary' },
        { name: 'text', cssVariable: '--color-white' }
      ]
    },
    {
      name: 'secondary',
      cssClass: 'btn-secondary',
      tokens: [
        { name: 'background', cssVariable: '--color-gray-100' },
        { name: 'text', cssVariable: '--color-gray-900' }
      ]
    }
  ],
  states: [
    {
      name: 'default',
      cssClass: '',
      styles: {}
    },
    {
      name: 'hover',
      cssClass: ':hover',
      styles: {
        transform: 'translateY(-2px)',
        boxShadow: 'var(--shadow-md)'
      }
    }
  ],
  dimensions: {
    height: '40px',
    padding: '0 var(--spacing-md)',
    minWidth: '80px'
  },
  tokens: []
}
```

## 组件规范详细说明

### 6. 按钮组件 (Button Component)

#### 6.1 按钮变体

**Primary Button (主要按钮)**

- 背景色: `var(--color-primary)`
- 文本色: `#FFFFFF`
- 高度: `40px`
- 内边距: `0 24px`
- 圆角: `var(--radius-md)` (8px)
- 字号: `var(--font-size-body-m)` (14px)
- 字重: `var(--font-weight-semibold)` (600)
- CSS 类名: `.btn-primary`

**Secondary Button (次要按钮)**

- 背景色: `var(--color-gray-100)` (亮色) / `var(--color-gray-800)` (暗色)
- 文本色: `var(--color-gray-900)`
- 高度: `40px`
- 内边距: `0 24px`
- 圆角: `var(--radius-md)` (8px)
- 字号: `var(--font-size-body-m)` (14px)
- 字重: `var(--font-weight-semibold)` (600)
- CSS 类名: `.btn-secondary`

**Icon Button (图标按钮)**

- 尺寸: `40px × 40px`
- 背景色: 透明
- 图标色: `var(--color-gray-700)`
- 圆角: `var(--radius-md)` (8px)
- CSS 类名: `.btn-icon`

**Favorite Button (收藏按钮)**

- 尺寸: `32px × 32px`
- 背景色: `rgba(255, 255, 255, 0.9)` (亮色) / `rgba(31, 31, 31, 0.9)` (暗色)
- 图标色: `var(--color-orange)`
- 圆角: `var(--radius-full)` (50%)
- CSS 类名: `.btn-favorite`

#### 6.2 按钮状态

**默认状态 (Default)**

```css
.btn-primary {
  background: var(--color-primary);
  color: #ffffff;
  box-shadow: var(--shadow-sm);
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}
```

**悬停状态 (Hover)**

```css
.btn-primary:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}
```

**激活状态 (Active)**

```css
.btn-primary:active {
  transform: translateY(0);
  box-shadow: var(--shadow-sm);
}
```

**禁用状态 (Disabled)**

```css
.btn-primary:disabled {
  background: var(--color-gray-300);
  color: var(--color-gray-500);
  cursor: not-allowed;
  box-shadow: none;
}
```

**聚焦状态 (Focus)**

```css
.btn-primary:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
```

### 7. 卡片组件 (Card Component)

#### 7.1 Plugin Card (插件卡片)

**尺寸规范**

- 最小宽度: `240px`
- 高度: 自适应内容
- 内边距: `var(--spacing-md)` (16px)
- 圆角: `var(--radius-xl)` (16px)
- 间距: `20px` (网格间隙)

**样式规范**

- 背景色: `var(--color-surface)`
- 边框: `1px solid var(--color-gray-200)`
- 阴影: `var(--shadow-sm)` (默认)
- 阴影 (悬停): `var(--shadow-lg)`

**内容结构**

```
Card
├── Icon (48px × 48px, 圆角 12px)
├── Title (H4, 20px, Semibold)
├── Description (Body-M, 14px, 2 行截断)
├── Tags (Body-XS, 12px, 圆角 4px)
└── Actions (Favorite Button)
```

**状态**

```css
.plugin-card {
  background: var(--color-surface);
  border: 1px solid var(--color-gray-200);
  border-radius: var(--radius-xl);
  padding: var(--spacing-md);
  box-shadow: var(--shadow-sm);
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.plugin-card:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-lg);
  border-color: var(--color-primary);
}
```

### 8. 导航组件 (Navigation Components)

#### 8.1 Header (顶部导航)

**尺寸规范**

- 高度: `64px` (固定)
- 位置: `fixed top`
- 宽度: `100%`
- 内边距: `0 var(--spacing-xl)` (0 32px)
- Z-index: `100`

**样式规范**

- 背景色: `var(--color-background)`
- 边框底部: `1px solid var(--color-gray-200)`
- 阴影: `var(--shadow-sm)`

**内容结构**

```
Header
├── Logo (左侧)
├── Search Bar (中间，最大宽度 600px)
└── User Actions (右侧)
    ├── Theme Toggle
    └── User Avatar
```

#### 8.2 Sidebar (侧边栏)

**尺寸规范**

- 宽度: `240px` (固定)
- 高度: `calc(100vh - 64px)`
- 位置: `fixed left`
- 顶部偏移: `64px`
- 内边距: `var(--spacing-md)` (16px)

**样式规范**

- 背景色: `var(--color-background-secondary)`
- 边框右侧: `1px solid var(--color-gray-200)`

**导航项规范**

- 高度: `40px`
- 内边距: `0 var(--spacing-md)`
- 圆角: `var(--radius-md)` (8px)
- 字号: `var(--font-size-body-m)` (14px)
- 图标尺寸: `20px × 20px`
- 图标与文本间距: `var(--spacing-sm)` (8px)

**导航项状态**

```css
.nav-item {
  display: flex;
  align-items: center;
  height: 40px;
  padding: 0 var(--spacing-md);
  border-radius: var(--radius-md);
  color: var(--color-gray-700);
  transition: all 0.2s ease;
}

.nav-item:hover {
  background: var(--color-hover);
  color: var(--color-gray-900);
}

.nav-item.active {
  background: var(--color-primary);
  color: #ffffff;
}
```

### 9. 输入组件 (Input Components)

#### 9.1 Search Input (搜索输入框)

**尺寸规范**

- 高度: `40px`
- 最大宽度: `600px`
- 内边距: `0 var(--spacing-md) 0 40px` (左侧留图标空间)
- 圆角: `var(--radius-2xl)` (20px)

**样式规范**

- 背景色: `var(--color-gray-100)` (亮色) / `var(--color-gray-800)` (暗色)
- 边框: `1px solid transparent`
- 字号: `var(--font-size-body-m)` (14px)
- 占位符颜色: `var(--color-gray-500)`

**图标规范**

- 位置: 绝对定位，左侧 12px
- 尺寸: `20px × 20px`
- 颜色: `var(--color-gray-600)`

**状态**

```css
.search-input {
  height: 40px;
  padding: 0 var(--spacing-md) 0 40px;
  background: var(--color-gray-100);
  border: 1px solid transparent;
  border-radius: var(--radius-2xl);
  font-size: var(--font-size-body-m);
  transition: all 0.2s ease;
}

.search-input:focus {
  background: var(--color-background);
  border-color: var(--color-primary);
  outline: none;
  box-shadow: 0 0 0 3px rgba(45, 113, 255, 0.1);
}

.search-input::placeholder {
  color: var(--color-gray-500);
}
```

### 10. 分页组件 (Pagination Component)

**按钮规范**

- 尺寸: `32px × 32px`
- 圆角: `var(--radius-md)` (8px)
- 字号: `var(--font-size-body-s)` (13px)
- 间距: `var(--spacing-xs)` (4px)

**样式规范**

```css
.pagination-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-gray-700);
  transition: all 0.2s ease;
}

.pagination-btn:hover {
  background: var(--color-hover);
}

.pagination-btn.active {
  background: var(--color-primary);
  color: #ffffff;
}
```

### 11. Toast 提示组件 (Toast Component)

**尺寸规范**

- 最小宽度: `300px`
- 最大宽度: `500px`
- 内边距: `var(--spacing-md)` (16px)
- 圆角: `var(--radius-lg)` (12px)

**位置**

- 固定定位: `fixed`
- 顶部: `80px` (Header 下方)
- 右侧: `var(--spacing-xl)` (32px)
- Z-index: `1000`

**变体**

```css
.toast {
  min-width: 300px;
  max-width: 500px;
  padding: var(--spacing-md);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xl);
  animation: slideIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.toast.success {
  background: var(--color-success);
  color: #ffffff;
}

.toast.error {
  background: var(--color-error);
  color: #ffffff;
}

.toast.info {
  background: var(--color-info);
  color: #ffffff;
}

@keyframes slideIn {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}
```

### 12. 进度条组件 (Progress Bar Component)

**尺寸规范**

- 高度: `4px`
- 宽度: `100%`
- 圆角: `var(--radius-full)` (50%)

**样式规范**

```css
.progress-bar {
  width: 100%;
  height: 4px;
  background: var(--color-gray-200);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  background: var(--color-primary);
  border-radius: var(--radius-full);
  transition: width 0.3s ease;
}
```

### 13. 用户头像组件 (Avatar Component)

**尺寸规范**

- 尺寸: `40px × 40px`
- 圆角: `var(--radius-full)` (50%)
- 边框: `2px solid var(--color-gray-200)`

**样式规范**

```css
.avatar {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-full);
  border: 2px solid var(--color-gray-200);
  object-fit: cover;
}

.avatar:hover {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px rgba(45, 113, 255, 0.1);
}
```

## 布局规范

### 页面结构

```
App Layout
├── Header (64px, fixed top)
├── Sidebar (240px, fixed left)
└── Main Content (flex: 1)
    ├── Content Padding (32px)
    └── Grid Container
        └── Grid Items (minmax(240px, 1fr))
```

### 网格系统

**主网格配置**

```css
.grid-container {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 20px;
  padding: var(--spacing-xl);
}
```

**响应式网格**

- XS/SM: 1 列
- MD: 2 列
- LG: 3 列
- XL: 4 列
- 2XL: 5+ 列

### 容器宽度

| 断点 | 容器最大宽度 |
| ---- | ------------ |
| SM   | 100%         |
| MD   | 720px        |
| LG   | 960px        |
| XL   | 1140px       |
| 2XL  | 1320px       |

### 主内容区域

```css
.main-content {
  margin-left: 240px; /* Sidebar 宽度 */
  margin-top: 64px; /* Header 高度 */
  padding: var(--spacing-xl);
  min-height: calc(100vh - 64px);
}
```

## 交互规范

### 动画时长

```css
--duration-fast: 0.2s; /* 快速交互 */
--duration-standard: 0.3s; /* 标准动画 */
--duration-slow: 0.5s; /* 慢速动画 */
```

### 缓动函数

```css
--easing-standard: cubic-bezier(0.34, 1.56, 0.64, 1); /* 弹性效果 */
--easing-ease: ease; /* 标准缓动 */
--easing-ease-in: ease-in; /* 加速 */
--easing-ease-out: ease-out; /* 减速 */
```

### 悬停效果

**卡片悬停**

```css
transform: translateY(-4px);
box-shadow: var(--shadow-lg);
transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
```

**按钮悬停**

```css
transform: translateY(-2px);
box-shadow: var(--shadow-md);
transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
```

**导航项悬停**

```css
background: var(--color-hover);
transition: all 0.2s ease;
```

### 点击效果

**按钮点击**

```css
transform: translateY(0);
box-shadow: var(--shadow-sm);
```

**卡片点击**

```css
transform: scale(0.98);
```

### 加载状态

**骨架屏动画**

```css
@keyframes skeleton-loading {
  0% {
    background-position: -200px 0;
  }
  100% {
    background-position: calc(200px + 100%) 0;
  }
}

.skeleton {
  background: linear-gradient(
    90deg,
    var(--color-gray-200) 0px,
    var(--color-gray-100) 40px,
    var(--color-gray-200) 80px
  );
  background-size: 200px 100%;
  animation: skeleton-loading 1.5s infinite;
}
```

**加载旋转器**

```css
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.spinner {
  width: 24px;
  height: 24px;
  border: 3px solid var(--color-gray-200);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
```

## 响应式设计

### 断点系统

```css
--breakpoint-xs: 480px;
--breakpoint-sm: 768px;
--breakpoint-md: 992px;
--breakpoint-lg: 1200px;
--breakpoint-xl: 1400px;
```

### 媒体查询

```css
/* Extra Small devices (< 480px) */
@media (max-width: 479px) {
  /* 移动端样式 */
}

/* Small devices (480px - 767px) */
@media (min-width: 480px) and (max-width: 767px) {
  /* 小屏幕样式 */
}

/* Medium devices (768px - 991px) */
@media (min-width: 768px) and (max-width: 991px) {
  /* 平板样式 */
}

/* Large devices (992px - 1199px) */
@media (min-width: 992px) and (max-width: 1199px) {
  /* 桌面样式 */
}

/* Extra Large devices (1200px - 1399px) */
@media (min-width: 1200px) and (max-width: 1399px) {
  /* 大桌面样式 */
}

/* 2X Large devices (≥ 1400px) */
@media (min-width: 1400px) {
  /* 超大桌面样式 */
}
```

### 响应式调整规则

#### 布局调整

**XS/SM (< 768px)**

- Sidebar 隐藏或转为抽屉式
- Header 高度保持 64px
- 主内容区域 margin-left: 0
- 网格变为单列
- 内边距减少至 16px

**MD (768px - 991px)**

- Sidebar 可选显示
- 网格 2 列
- 内边距 24px

**LG+ (≥ 992px)**

- 完整布局
- 网格 3-5 列
- 内边距 32px

#### 字体调整

**移动端 (< 768px)**

```css
--font-size-h1: 32px; /* 从 48px 缩小 */
--font-size-h2: 24px; /* 从 32px 缩小 */
--font-size-h3: 20px; /* 从 24px 缩小 */
```

#### 间距调整

**移动端 (< 768px)**

```css
--spacing-xl: 16px; /* 从 32px 缩小 */
--spacing-lg: 16px; /* 从 24px 缩小 */
```

### 移动端优先策略

1. **基础样式**: 先定义移动端样式
2. **渐进增强**: 使用 `min-width` 媒体查询逐步增强
3. **触摸优化**: 按钮最小尺寸 44px × 44px
4. **性能优先**: 减少动画和阴影效果

## 正确性属性 (Correctness Properties)

**关于正确性属性**: 属性是关于系统行为的特征或规则，应该在所有有效执行中保持为真。属性是人类可读规范和机器可验证正确性保证之间的桥梁。

### 属性反思

在分析所有验收标准后，我发现这个项目的所有需求都是关于**文档内容和格式**的要求，而不是关于可执行代码功能的要求。具体来说：

- 所有需求都是"设计系统应该定义/包含/提供某些内容"
- 这些是文档完整性和质量的要求
- 没有涉及运行时行为、数据处理或用户交互的代码逻辑

因此，这些需求不适合通过传统的属性测试（Property-Based Testing）来验证。相反，它们应该通过以下方式验证：

1. **人工审查**: 设计师和开发者审查文档是否包含所有必需的内容
2. **文档检查清单**: 使用清单确保所有章节和内容都已包含
3. **同行评审**: 团队成员验证文档的完整性和准确性

### 文档验证方法

虽然不能使用属性测试，但可以使用以下方法确保文档质量：

#### 1. 完整性检查清单

- [ ] 色彩系统包含主色、辅助色、灰度色阶、功能色
- [ ] 每个颜色都有 HEX 和 RGB 格式
- [ ] 每个颜色都有对应的 CSS 变量名
- [ ] 字体系统包含字体栈、标题字号、正文字号、字重
- [ ] 间距系统基于 4px 网格，包含 5 个层级
- [ ] 圆角系统包含 6 个层级
- [ ] 阴影系统包含 4 个层级，支持双主题
- [ ] 组件库包含 8 种核心组件的完整规范
- [ ] 每个组件包含尺寸、样式、状态规范
- [ ] 布局规范包含页面结构、网格系统、容器规范
- [ ] 交互规范包含动画时长、悬停效果、点击效果
- [ ] 响应式设计包含 6 个断点和调整规则
- [ ] 包含设计理念和核心原则
- [ ] 包含可访问性指南
- [ ] 所有内容使用中文编写

#### 2. 格式一致性检查

- [ ] 所有表格格式统一
- [ ] 所有代码块使用正确的语法高亮
- [ ] CSS 变量命名遵循统一规范
- [ ] 章节标题层级正确
- [ ] 示例代码完整可用

#### 3. 技术准确性验证

- [ ] 色彩对比度符合 WCAG 2.1 AA 标准
- [ ] CSS 变量名称符合命名规范
- [ ] 响应式断点值合理且不重叠
- [ ] 动画时长和缓动函数符合最佳实践
- [ ] 组件尺寸和间距符合 4px 网格系统

### 无可测试属性

基于预分析，本设计规范系统的所有需求都是文档性质的，不包含可通过自动化测试验证的代码行为属性。

**验收标准 1.1 - 11.5**: 所有验收标准都是关于文档应该包含的内容和格式，不是关于代码功能的可测试属性。

## 错误处理

由于本项目是设计规范文档，不涉及运行时错误处理。但在使用设计系统时，开发者应注意：

### CSS 变量回退值

```css
/* 提供回退值以防变量未定义 */
.element {
  color: var(--color-primary, #2d71ff);
  padding: var(--spacing-md, 16px);
}
```

### 主题切换错误处理

```javascript
// 确保主题值有效
function setTheme(theme) {
  const validThemes = ['light', 'dark']
  if (!validThemes.includes(theme)) {
    console.warn(`Invalid theme: ${theme}. Falling back to 'light'.`)
    theme = 'light'
  }
  document.documentElement.setAttribute('data-theme', theme)
}
```

### 响应式断点验证

```javascript
// 验证断点值
function validateBreakpoint(breakpoint) {
  const validBreakpoints = ['xs', 'sm', 'md', 'lg', 'xl', '2xl']
  if (!validBreakpoints.includes(breakpoint)) {
    throw new Error(`Invalid breakpoint: ${breakpoint}`)
  }
}
```

## 测试策略

### 文档测试方法

由于这是设计规范文档项目，测试策略侧重于文档质量而非代码测试：

#### 1. 人工审查

**审查清单**:

- 内容完整性审查
- 技术准确性审查
- 格式一致性审查
- 可读性审查
- 示例代码可用性审查

**审查流程**:

1. 设计师审查视觉规范的准确性
2. 开发者审查技术实现的可行性
3. 产品经理审查内容的完整性
4. 团队成员交叉审查

#### 2. 文档验证工具

虽然不能使用属性测试，但可以使用以下工具辅助验证：

**Markdown Linter**: 检查文档格式

```bash
# 使用 markdownlint 检查格式
markdownlint design.md
```

**链接检查**: 验证文档中的链接有效性

```bash
# 使用 markdown-link-check
markdown-link-check design.md
```

**拼写检查**: 确保文档无拼写错误

```bash
# 使用 cspell
cspell design.md
```

#### 3. 实际应用测试

**集成测试**: 在实际项目中应用设计系统，验证：

- CSS 变量是否正确定义
- 组件样式是否符合规范
- 响应式布局是否正常工作
- 主题切换是否正确

**视觉回归测试**: 使用工具如 Percy、Chromatic 进行视觉回归测试

```javascript
// 使用 Storybook + Chromatic 进行视觉测试
// 为每个组件创建 Story
export const PrimaryButton = () => (
  <button className="btn-primary">Primary Button</button>
)
```

**可访问性测试**: 使用工具验证可访问性

```bash
# 使用 axe-core 进行可访问性测试
npm run test:a11y
```

#### 4. 设计系统文档网站

创建交互式文档网站，展示所有组件和规范：

- 实时预览组件
- 代码示例可复制
- 主题切换演示
- 响应式预览

### 测试工具推荐

1. **Storybook**: 组件开发和文档
2. **Chromatic**: 视觉回归测试
3. **axe-core**: 可访问性测试
4. **markdownlint**: Markdown 格式检查
5. **cspell**: 拼写检查

## 设计原则和最佳实践

### 核心设计原则

#### 1. 一致性 (Consistency)

**视觉一致性**:

- 使用统一的色彩系统
- 保持间距和圆角的一致性
- 统一的字体和字号层级

**交互一致性**:

- 相同类型的元素使用相同的交互模式
- 统一的动画时长和缓动函数
- 一致的反馈机制

**代码一致性**:

- 使用 CSS 变量而非硬编码值
- 统一的命名规范
- 一致的代码结构

#### 2. 简洁性 (Simplicity)

**视觉简洁**:

- 避免过度装饰
- 使用留白创造呼吸感
- 清晰的视觉层次

**交互简洁**:

- 减少不必要的步骤
- 直观的操作流程
- 清晰的反馈

**代码简洁**:

- 避免冗余代码
- 使用语义化的类名
- 模块化的组件结构

#### 3. 可访问性 (Accessibility)

**色彩对比度**:

- 主要文本对比度 ≥ 7:1 (AAA)
- 次要文本对比度 ≥ 4.5:1 (AA)
- 大文本对比度 ≥ 3:1 (AA)

**键盘导航**:

- 所有交互元素可通过键盘访问
- 清晰的焦点指示器
- 合理的 Tab 顺序

**屏幕阅读器**:

- 使用语义化 HTML
- 提供 ARIA 标签
- 图片提供 alt 文本

#### 4. 性能 (Performance)

**优化策略**:

- 使用系统字体减少加载时间
- CSS 变量提升维护性和性能
- 避免过度使用阴影和动画
- 响应式图片和懒加载

#### 5. 可扩展性 (Scalability)

**模块化设计**:

- 基于原子设计理论
- 组件可组合和复用
- 易于添加新变体

**灵活性**:

- 支持自定义主题
- 可配置的设计标记
- 适应不同使用场景

### 最佳实践

#### 使用 CSS 变量

```css
/* ✅ 推荐：使用 CSS 变量 */
.button {
  background: var(--color-primary);
  padding: var(--spacing-md);
  border-radius: var(--radius-md);
}

/* ❌ 不推荐：硬编码值 */
.button {
  background: #2d71ff;
  padding: 16px;
  border-radius: 8px;
}
```

#### 遵循命名规范

```css
/* ✅ 推荐：语义化命名 */
.btn-primary {
}
.card-header {
}
.nav-item-active {
}

/* ❌ 不推荐：无意义命名 */
.blue-button {
}
.box1 {
}
.item-1 {
}
```

#### 移动端优先

```css
/* ✅ 推荐：移动端优先 */
.container {
  padding: 16px;
}

@media (min-width: 768px) {
  .container {
    padding: 32px;
  }
}

/* ❌ 不推荐：桌面端优先 */
.container {
  padding: 32px;
}

@media (max-width: 767px) {
  .container {
    padding: 16px;
  }
}
```

#### 使用语义化 HTML

```html
<!-- ✅ 推荐：语义化标签 -->
<header class="app-header">
  <nav class="main-nav">
    <ul>
      <li><a href="/">首页</a></li>
    </ul>
  </nav>
</header>

<!-- ❌ 不推荐：div 汤 -->
<div class="app-header">
  <div class="main-nav">
    <div>
      <div><a href="/">首页</a></div>
    </div>
  </div>
</div>
```

#### 提供焦点指示器

```css
/* ✅ 推荐：清晰的焦点指示器 */
.button:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

/* ❌ 不推荐：移除焦点指示器 */
.button:focus {
  outline: none;
}
```

### 可访问性指南

#### WCAG 2.1 AA 合规性

**色彩对比度**:

- 使用对比度检查工具验证所有文本
- 不仅依赖颜色传达信息
- 提供替代的视觉提示

**键盘可访问性**:

- 所有功能可通过键盘操作
- 提供跳过导航链接
- 合理的焦点管理

**屏幕阅读器支持**:

- 使用 ARIA 标签增强语义
- 提供替代文本
- 确保内容顺序合理

#### 实用技巧

**为图标添加标签**:

```html
<button aria-label="关闭对话框">
  <svg><!-- 关闭图标 --></svg>
</button>
```

**为表单提供标签**:

```html
<label for="search">搜索</label> <input id="search" type="text" />
```

**使用 ARIA 状态**:

```html
<button aria-pressed="true">已选中</button>
<div role="alert" aria-live="polite">操作成功</div>
```

## 实施指南

### 开始使用设计系统

#### 1. 引入 CSS 变量

在项目的主 CSS 文件中定义所有设计标记：

```css
:root[data-theme='light'] {
  /* 色彩 */
  --color-primary: #2d71ff;
  --color-background: #ffffff;
  /* ... 其他变量 */
}

:root[data-theme='dark'] {
  /* 色彩 */
  --color-primary: #4a8cff;
  --color-background: #0f0f0f;
  /* ... 其他变量 */
}
```

#### 2. 创建基础组件

基于设计规范创建可复用的组件：

```css
/* 按钮组件 */
.btn {
  height: 40px;
  padding: 0 var(--spacing-md);
  border-radius: var(--radius-md);
  font-size: var(--font-size-body-m);
  font-weight: var(--font-weight-semibold);
  transition: all 0.3s var(--easing-standard);
}

.btn-primary {
  background: var(--color-primary);
  color: #ffffff;
}
```

#### 3. 实现主题切换

```javascript
// 主题切换逻辑
function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme')
  const newTheme = currentTheme === 'light' ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', newTheme)
  localStorage.setItem('theme', newTheme)
}

// 初始化主题
function initTheme() {
  const savedTheme = localStorage.getItem('theme') || 'light'
  document.documentElement.setAttribute('data-theme', savedTheme)
}

initTheme()
```

#### 4. 应用响应式设计

```css
/* 移动端优先 */
.grid-container {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--spacing-md);
}

/* 平板 */
@media (min-width: 768px) {
  .grid-container {
    grid-template-columns: repeat(2, 1fr);
  }
}

/* 桌面 */
@media (min-width: 992px) {
  .grid-container {
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 20px;
  }
}
```

### 维护和更新

#### 版本控制

- 使用语义化版本号 (Semantic Versioning)
- 记录所有变更在 CHANGELOG
- 提供迁移指南

#### 文档更新

- 保持文档与实现同步
- 及时更新示例代码
- 收集和整合用户反馈

#### 团队协作

- 定期设计系统评审会议
- 建立贡献指南
- 鼓励团队成员参与改进

## 总结

ZTools 设计规范系统提供了一套完整、系统化的设计语言，涵盖了从基础设计标记到复杂组件的所有方面。通过遵循本规范，团队可以：

- 创建视觉一致的用户界面
- 提高开发效率和代码质量
- 确保可访问性和性能
- 轻松维护和扩展系统

设计系统是一个持续演进的过程，需要团队的共同努力和持续改进。

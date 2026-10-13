# ZTools 3D 插画风格设计指南

> 基于 APP 设计风格，打造轻松友好的 WEB 端体验

## 🎨 设计理念

ZTools 3D 插画风格设计系统采用明亮活泼的渐变色卡片和立体插画风格，营造轻松、友好、现代的用户体验。

### 核心特点

1. **3D 插画风格卡片**：使用渐变色背景，营造立体感
2. **更大的圆角**：20-28px 的圆角，更加圆润友好
3. **柔和的阴影**：轻微的投影效果，不过分强调
4. **明亮的配色**：蓝色、绿色、橙色、粉色、紫色、青色
5. **玻璃态效果**：半透明背景 + 模糊效果
6. **弹性动画**：使用 bounce 缓动函数，更有趣味性

---

## 🌈 渐变色系统

### 蓝色渐变 (Blue)

```css
background: linear-gradient(135deg, #5b9fff 0%, #4a8cff 100%);
box-shadow: 0 8px 24px 0 rgba(74, 140, 255, 0.2);
```

**用途：** 主要功能、系统工具、默认卡片

### 绿色渐变 (Green)

```css
background: linear-gradient(135deg, #5dd9b8 0%, #4ed7c2 100%);
box-shadow: 0 8px 24px 0 rgba(78, 215, 194, 0.2);
```

**用途：** 成功状态、办公效率、环保主题

### 橙色渐变 (Orange)

```css
background: linear-gradient(135deg, #ffb84d 0%, #ffaf41 100%);
box-shadow: 0 8px 24px 0 rgba(255, 175, 65, 0.2);
```

**用途：** 警告提示、热门推荐、限时活动

### 粉色渐变 (Pink)

```css
background: linear-gradient(135deg, #ff9ec8 0%, #ff8ab8 100%);
box-shadow: 0 8px 24px 0 rgba(255, 138, 184, 0.2);
```

**用途：** 创意工具、设计类、女性向

### 紫色渐变 (Purple)

```css
background: linear-gradient(135deg, #a78bfa 0%, #9575fa 100%);
box-shadow: 0 8px 24px 0 rgba(149, 117, 250, 0.2);
```

**用途：** 高级功能、VIP 特权、神秘感

### 青色渐变 (Cyan)

```css
background: linear-gradient(135deg, #67e8f9 0%, #22d3ee 100%);
box-shadow: 0 8px 24px 0 rgba(34, 211, 238, 0.2);
```

**用途：** 媒体处理、清新主题、科技感

---

## 📐 圆角系统

| 名称 | 值   | 用途               |
| ---- | ---- | ------------------ |
| SM   | 8px  | 小标签、徽章       |
| MD   | 12px | 按钮、输入框       |
| LG   | 16px | 导航项、小卡片     |
| XL   | 20px | 标准卡片           |
| 2XL  | 24px | 大卡片、主要内容区 |
| 3XL  | 28px | 特大卡片、封面     |
| Full | 50%  | 圆形头像、圆形按钮 |

**推荐：** 插件卡片使用 2XL (24px)，按钮使用 LG (16px)

---

## 🌟 阴影系统

### 柔和阴影

```css
--shadow-xs: 0 1px 2px 0 rgba(0, 0, 0, 0.03);
--shadow-sm: 0 2px 8px 0 rgba(0, 0, 0, 0.04);
--shadow-md: 0 4px 12px 0 rgba(0, 0, 0, 0.06);
--shadow-lg: 0 8px 24px 0 rgba(0, 0, 0, 0.08);
--shadow-xl: 0 12px 32px 0 rgba(0, 0, 0, 0.1);
--shadow-2xl: 0 16px 48px 0 rgba(0, 0, 0, 0.12);
```

### 彩色阴影

用于渐变卡片，增强立体感：

```css
--shadow-blue: 0 8px 24px 0 rgba(74, 140, 255, 0.2);
--shadow-green: 0 8px 24px 0 rgba(78, 215, 194, 0.2);
--shadow-orange: 0 8px 24px 0 rgba(255, 175, 65, 0.2);
```

---

## 🎭 玻璃态效果

### 半透明背景

```css
background: rgba(255, 255, 255, 0.2);
backdrop-filter: blur(10px);
```

**用途：**

- 卡片上的标签
- 悬浮按钮
- 图标容器
- 遮罩层

### 示例：标签样式

```css
.badge-3d {
  padding: 4px 10px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.25);
  backdrop-filter: blur(10px);
  color: white;
  font-size: 11px;
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}
```

---

## 🎬 动画系统

### 时长

```css
--duration-fast: 0.15s; /* 快速交互 */
--duration-standard: 0.25s; /* 标准动画 */
--duration-slow: 0.35s; /* 慢速动画 */
```

### 缓动函数

```css
--easing-bounce: cubic-bezier(0.68, -0.55, 0.265, 1.55); /* 弹性效果 */
--easing-smooth: cubic-bezier(0.4, 0, 0.2, 1); /* 平滑过渡 */
--easing-ease-out: cubic-bezier(0, 0, 0.2, 1); /* 减速 */
```

### 悬停效果

```css
.card:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-xl);
  transition: all var(--duration-standard) var(--easing-smooth);
}
```

### 点击效果

```css
.button:active {
  transform: scale(0.98);
  transition: all var(--duration-fast) var(--easing-smooth);
}
```

---

## 🎨 组件样式指南

### 1. 渐变卡片 (Gradient Card)

**基础结构：**

```html
<div class="card-gradient card-gradient-blue">
  <!-- 顶部标签 -->
  <div class="flex items-center justify-between mb-4">
    <span class="badge-3d">免费体验</span>
    <button class="icon-btn-3d">
      <i class="fa fa-star"></i>
    </button>
  </div>

  <!-- 3D 图标 -->
  <div class="icon-3d mb-4">
    <i class="fa fa-puzzle-piece"></i>
  </div>

  <!-- 内容 -->
  <h3 class="plugin-title">插件名称</h3>
  <p class="plugin-description">插件描述</p>

  <!-- 底部操作 -->
  <div class="flex items-center justify-between mt-4">
    <button class="action-btn-3d">更新</button>
    <button class="action-btn-3d primary">下载</button>
  </div>
</div>
```

**样式要点：**

- 圆角：24px
- 内边距：24px
- 文字颜色：白色
- 悬停：上移 4px + 阴影加深

### 2. 3D 图标容器

```css
.icon-3d {
  width: 64px;
  height: 64px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(10px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
}

.icon-3d:hover {
  transform: scale(1.05);
}
```

### 3. 玻璃态按钮

```css
.action-btn-3d {
  padding: 8px 16px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.2);
  backdrop-filter: blur(10px);
  color: white;
  font-size: 13px;
  font-weight: 600;
  border: none;
  cursor: pointer;
}

.action-btn-3d:hover {
  background: rgba(255, 255, 255, 0.3);
  transform: translateY(-2px);
}

.action-btn-3d.primary {
  background: rgba(255, 255, 255, 0.95);
  color: var(--color-primary);
}
```

### 4. 柔和白色卡片

用于不需要渐变的场景：

```css
.card-soft {
  background: var(--color-surface);
  border-radius: 24px;
  padding: 24px;
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--color-border);
}

.card-soft:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-lg);
  border-color: var(--color-primary);
}
```

---

## 🎯 使用场景

### 插件卡片

- **推荐：** 使用渐变卡片，按顺序循环使用 6 种渐变色
- **圆角：** 24px
- **阴影：** 对应的彩色阴影
- **标签：** "免费体验"、"限时免费"、"VIP 专享"

### 功能卡片

- **推荐：** 使用柔和白色卡片
- **圆角：** 20px
- **阴影：** shadow-sm
- **悬停：** 边框变为主色

### 导航项

- **默认：** 透明背景
- **悬停：** 浅色背景 + 右移 4px
- **激活：** 蓝色渐变背景 + 白色文字 + 彩色阴影

### 按钮

- **主要按钮：** 白色背景 + 主色文字
- **次要按钮：** 半透明背景 + 白色文字
- **图标按钮：** 圆形 + 半透明背景

---

## 📱 响应式适配

### 移动端 (< 768px)

- 卡片圆角：20px
- 内边距：16px
- 网格：单列
- 图标尺寸：48px

### 平板 (768px - 991px)

- 卡片圆角：22px
- 内边距：20px
- 网格：2-3 列
- 图标尺寸：56px

### 桌面 (≥ 992px)

- 卡片圆角：24px
- 内边距：24px
- 网格：auto-fill
- 图标尺寸：64px

---

## 🌓 暗色模式

### 调整原则

1. **渐变色稍微调亮**：提高可见度
2. **阴影加深**：增强层次感
3. **背景更深**：减少眼睛疲劳
4. **文字对比度保持**：确保可读性

### 暗色模式渐变

```css
.dark {
  --gradient-blue: linear-gradient(135deg, #6ba5ff 0%, #5b9fff 100%);
  --gradient-green: linear-gradient(135deg, #6de0c8 0%, #5dd9b8 100%);
  --gradient-orange: linear-gradient(135deg, #ffc05d 0%, #ffb84d 100%);
}
```

---

## ✨ 最佳实践

### DO ✅

- 使用渐变卡片展示插件
- 为不同类型的内容使用不同的渐变色
- 保持圆角一致性（20-24px）
- 使用玻璃态效果增强层次
- 添加柔和的悬停动画

### DON'T ❌

- 不要在同一屏幕使用过多渐变色
- 不要使用过于鲜艳的颜色
- 不要使用过重的阴影
- 不要忽略暗色模式适配
- 不要使用过快的动画

---

## 🎨 配色建议

### 渐变色分配策略

**按功能分类：**

- 系统工具 → 蓝色
- 办公效率 → 绿色
- 媒体处理 → 青色
- 安全工具 → 紫色
- 创意设计 → 粉色
- 热门推荐 → 橙色

**按顺序循环：**

```javascript
const gradients = ['blue', 'green', 'orange', 'pink', 'purple', 'cyan']
const getGradient = (index) => gradients[index % 6]
```

---

## 🔗 相关资源

- **设计标记文件：** `src/assets/css/design-tokens-3d.css`
- **3D 卡片组件：** `src/components/PluginCard3D.vue`
- **示例页面：** `src/pages/List.vue`

---

## 📝 更新日志

### v1.0.0 (2026-01-29)

- ✅ 创建 3D 插画风格设计系统
- ✅ 定义 6 种渐变色
- ✅ 实现玻璃态效果
- ✅ 创建 3D 风格组件
- ✅ 更新全局样式

---

**设计理念：** 让工具变得有趣，让效率变得轻松 🎨✨

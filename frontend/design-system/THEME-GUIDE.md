# ZTools 主题系统使用指南

## 🌓 主题切换功能

### 功能特性

1. **一键切换**
   - 点击右上角的太阳/月亮图标即可切换主题
   - 亮色模式：太阳图标 ☀️
   - 暗色模式：月亮图标 🌙

2. **自动保存**
   - 主题选择会自动保存到浏览器本地存储
   - 下次访问时自动应用上次选择的主题

3. **平滑过渡**
   - 所有颜色变化都有0.3s的过渡动画
   - 切换时显示Toast提示消息

## 🎨 主题配色方案

### 亮色模式（Light Mode）

**主色调**

- Primary: `#2D71FF` - 蓝色
- Primary Hover: `#1A5FE6`
- Primary Light: `#E8EFFF`

**背景色**

- 主背景: `#FFFFFF` 白色
- 次背景: `#F6F7FA` 浅灰
- 卡片背景: `#FFFFFF` 白色

**文字色**

- 主文字: `#2F2F46` 深灰
- 次文字: `#5D5F74` 中灰
- 辅助文字: `#8F91A1` 浅灰

**阴影**

- 轻微: `rgba(47, 47, 70, 0.04)`
- 中等: `rgba(47, 47, 70, 0.08)`
- 较深: `rgba(47, 47, 70, 0.12)`

---

### 暗色模式（Dark Mode）

**主色调**

- Primary: `#4A8CFF` - 调亮的蓝色
- Primary Hover: `#5B9AFF`
- Primary Light: `#1E3A5F` - 深蓝

**背景色**

- 主背景: `#1A1D2E` 深色
- 次背景: `#1E2130` 稍浅
- 卡片背景: `#252837` 中深色

**文字色**

- 主文字: `#F0F2FA` 浅色
- 次文字: `#C8CBDB` 中浅
- 辅助文字: `#A8ABBE` 中灰

**阴影**

- 轻微: `rgba(0, 0, 0, 0.2)`
- 中等: `rgba(0, 0, 0, 0.3)`
- 较深: `rgba(0, 0, 0, 0.4)`

## 🔧 技术实现

### CSS变量系统

所有颜色都使用CSS变量定义，通过`[data-theme="dark"]`选择器切换：

```css
:root {
  --primary-color: #2d71ff;
  --white: #ffffff;
  /* ... 更多变量 */
}

[data-theme='dark'] {
  --primary-color: #4a8cff;
  --white: #1a1d2e;
  /* ... 暗色变量 */
}
```

### JavaScript控制

```javascript
// 切换主题
function toggleTheme() {
  const htmlElement = document.documentElement
  const currentTheme = htmlElement.getAttribute('data-theme')
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark'

  htmlElement.setAttribute('data-theme', newTheme)
  localStorage.setItem('theme', newTheme)
}
```

### 本地存储

主题选择保存在`localStorage`中：

- Key: `theme`
- Value: `light` 或 `dark`

## 📱 适配的组件

### 已适配暗色模式的组件：

✅ **导航栏**

- 顶部导航栏
- 侧边栏
- 导航项

✅ **卡片**

- 插件卡片
- 图标背景
- 卡片阴影

✅ **按钮**

- 主要按钮
- 次要按钮
- 图标按钮
- 收藏按钮

✅ **表单**

- 搜索框
- 输入框

✅ **其他**

- Toast提示
- 下载进度条
- 用户头像
- 徽章标签

## 🎯 设计原则

### 暗色模式设计要点

1. **对比度**
   - 确保文字与背景有足够的对比度
   - WCAG AA标准：至少4.5:1

2. **颜色调整**
   - 主色调在暗色模式下稍微调亮
   - 避免使用纯黑色（#000000）
   - 使用深灰色（#1A1D2E）作为背景

3. **阴影处理**
   - 暗色模式使用更深的黑色阴影
   - 增加阴影的不透明度

4. **图标处理**
   - 图标颜色自动适配主题
   - 使用`fill: currentColor`或CSS变量

## 🚀 扩展指南

### 添加新组件的暗色模式

1. **使用CSS变量**

```css
.my-component {
  background: var(--white);
  color: var(--gray-700);
}
```

2. **添加暗色样式**

```css
[data-theme='dark'] .my-component {
  /* 暗色模式样式会自动应用 */
}
```

3. **特殊处理（如需要）**

```css
[data-theme='dark'] .my-component {
  background: var(--gray-100);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}
```

### 测试清单

- [ ] 所有文字清晰可读
- [ ] 按钮状态明显
- [ ] 阴影效果合适
- [ ] 图标颜色正确
- [ ] 过渡动画流畅
- [ ] 保存功能正常

## 💡 最佳实践

1. **始终使用CSS变量**
   - 不要硬编码颜色值
   - 使用语义化的变量名

2. **测试两种模式**
   - 开发时同时测试亮色和暗色模式
   - 确保两种模式下都有良好的视觉效果

3. **注意细节**
   - 边框颜色
   - 分隔线颜色
   - 悬停状态
   - 激活状态

4. **性能优化**
   - 使用CSS变量而不是JavaScript动态修改样式
   - 利用浏览器的硬件加速

## 📝 常见问题

**Q: 如何设置默认主题？**
A: 修改`initTheme()`函数中的默认值：

```javascript
const savedTheme = localStorage.getItem('theme') || 'dark' // 默认暗色
```

**Q: 如何禁用主题切换？**
A: 移除HTML中的主题切换按钮，或注释掉`initTheme()`调用。

**Q: 如何添加更多主题？**
A: 扩展CSS变量系统，添加新的`[data-theme="xxx"]`选择器。

---

**版本**: 2.1.0  
**更新日期**: 2024  
**特性**: 完整的明暗主题切换系统

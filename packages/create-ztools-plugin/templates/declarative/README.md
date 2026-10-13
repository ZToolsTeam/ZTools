# {{NAME}} ({{ID}})

{{DESCRIPTION}}

## 架构规范与开发指南

本项目基于 **ZTools 最新纯声明式 UI 架构** 与 **Raycast 兼容组件标准** 构建：

- **严禁编写任何 CSS/LESS/SCSS 样式**：扩展不允许直接编写任何自定义样式代码，界面呈现 100% 由宿主统一渲染，天然具备 Fluent / Mica 质感与深浅主题自适应；
- **严禁操作原生 HTML DOM**：扩展完全通过 `@ztools/raycast-compat` 导出的标准化语义组件（`<List>`, `<Detail>`, `<Form>`, `<ActionPanel>`, `<Action>` 等）输出结构化视图描述符（JSON View Descriptors）；
- **全键盘优先体验**：原生支持上下方向键滚屏对齐、`Enter` 激活首要动作、`Ctrl+K` 唤起操作抽屉、`Esc` 导航栈后退。

## 开发与构建

```bash
# 安装依赖
npm install

# 编译生成产物
npm run build

# 监听编译模式
npm run dev
```

# @ztools/declarative-ui

ZTools 原生纯声明式组件体系与运行时。

## 核心设计理念
1. **严格禁止插件写原生 CSS/DOM**：
   插件仅能通过声明式组件构建纯净的结构化虚拟视图树 (JSON View Descriptors)，由宿主统一安全渲染。
2. **纯键盘流与 Fluent / Mica 体验**：
   专为高效桌面快捷操作打造，原生支持 `Ctrl+K` 动作面板、上下键无缝导航、Enter 激活首要 Action、Esc 导航栈后退。
3. **轻量无外部依赖的微响应式运行时**：
   内置轻量 Hooks 协调器 (`useState`, `useEffect`, `useCallback`, `useMemo`, `useRef`, `useNavigation`)。

## 声明式组件体系
- **List**: `List`, `List.Item`, `List.Section`, `List.Dropdown`
- **Detail**: `Detail`, `Detail.Metadata`
- **Form**: `Form`, `Form.TextField`, `Form.TextArea`, `Form.Checkbox`, `Form.Dropdown`
- **ActionPanel**: `ActionPanel`, `ActionPanel.Section`
- **Action**: `Action`, `Action.CopyToClipboard`, `Action.OpenInBrowser`, `Action.Push`, `Action.SubmitForm`
- **Icon & Color**: 标准桌面 Fluent / 极客图标与语义色彩集合

## 核心系统 API
- `showToast(options | style, title, message)` / `Toast`
- `Clipboard.copy(text)` / `Clipboard.readText()`
- `LocalStorage.getItem(key)` / `LocalStorage.setItem(key, val)` / `LocalStorage.removeItem(key)` / `LocalStorage.clear()`
- `useNavigation()` -> `{ push, pop }`
- `open(url)`
- `showHUD(title)`
- `confirmAlert(options)`

## 内置移植验证应用
- `json-format`: JSON 校验、美化、压缩、自动转 TypeScript Interface
- `qr-code`: 纯 JS 二维码生成、不同纠错级别、SVG 矢量展示、剪贴板联动

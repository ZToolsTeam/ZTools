# @ztools/declarative-ui

Declarative plugin SDK for ZTools: UI components (`List`, `Detail`, `Form`, `ActionPanel`, `Action`, etc.), system APIs (`showToast`, `showHUD`, `Clipboard`, `LocalStorage`, etc.), i18n helpers (`useLocale`, `t`), and the Hooks runtime. Plugins declare UI structure only — the ZTools desktop client renders everything consistently without raw HTML or CSS.

ZTools 声明式插件 SDK：组件（`List`、`Detail`、`Form`、`ActionPanel`、`Action` 等）、系统 API（`showToast`、`showHUD`、`Clipboard`、`LocalStorage` 等）、多语言能力（`useLocale`、`t`）与 Hooks 运行时。插件只描述界面结构，由 ZTools 客户端统一渲染，不写 HTML 和 CSS。

## Usage / 引入方式

```ts
import React, { List, ActionPanel, Action } from "@ztools/declarative-ui";
```

## Documentation / 文档

- API, system capabilities & permissions / 组件、系统 API 与权限说明：[API Reference](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/docs/en/api.md) · [API 参考](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/docs/api.md)
- Layouts & keyboard conventions / 界面布局与交互规范：[UI Guidelines](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/docs/en/ui-guidelines.md) · [界面规范](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/docs/ui-guidelines.md)

Refer to generated `dist/*.d.ts` files for exact TypeScript signatures. / 准确的类型签名以编译产物 `dist/*.d.ts` 为准。

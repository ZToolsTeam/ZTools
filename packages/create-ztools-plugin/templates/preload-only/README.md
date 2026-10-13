# {{NAME}}

{{DESCRIPTION}}

基于 ZTools 官方脚手架 `create-ztools-plugin` 生成的纯无 UI 快速功能插件。

## 特点

- 极简结构，轻量快捷
- 适合配合关键字触发无界面快速操作（如剪贴板处理、快捷网络请求、系统级快速设置等）
- 标准接入 `window.ztoolsPlugin.onPluginEnter` 与 `window.ztools` API

## 开发调试

```bash
npm install
npm run dev
```

## 打包构建

```bash
npm run build
```

打包产物位于 `dist/` 目录。将产物与 `plugin.json`、`icon.svg` 部署至 ZTools 插件目录即可。

# 贡献指南

欢迎通过 Issue 和 Pull Request 改进插件与开发工具。创建插件、编译和单插件测试的命令见 [README](README.md#开发插件)。

## 插件要求

- 插件放在 `extensions/<plugin-id>/`，目录名与 `plugin.json` 的 `id` 一致，ID 不得重复。
- 提交 `src/`、清单、图标与测试。插件的 `dist/` 由构建生成，不提交编译产物。
- 界面使用 `@ztools/declarative-ui` 组件，不直接操作 HTML DOM 或注入自定义 CSS。
- 清单声明所用权限和 `targets`；只声明实际验证过的平台。跨平台插件应在 Windows 和 macOS 分别测试。
- 修改已有插件的非文档内容时提高 `version`。仅修改文档或仅标记下架的情况按检查脚本规则处理。
- 下架插件保留目录，在清单中填写 `revoked: true` 与 `revokedReason`。
- 存在 `extensions/shared/` 源文件副本时，保持副本一致。

清单字段与校验规则见 [`packages/ztools-plugins-spec/`](packages/ztools-plugins-spec/)。

## 本地检查与 CI

先按 README 对改动的插件进行构建、清单与安全扫描、自带测试，再在 ZTools 客户端验证正常和异常场景。

将改动提交到自己的分支后，在仓库根目录运行：

```bash
# 将本地 refs/remotes/upstream/main 更新为官方 main，Fork 仓库也可使用
# 如果已有名为 upstream 的远端，可改为 git fetch upstream main
git fetch https://github.com/ZToolsTeam/ZTools-extensions.git main:refs/remotes/upstream/main
node scripts/verify-changed-plugins.mjs --base refs/remotes/upstream/main
```

该脚本以基线与当前分支 **HEAD 的已提交差异**确定受影响插件，不以未提交改动计算检查范围；构建、扫描和测试读取当前工作区。请先提交改动并保持工作区干净，避免漏检或结果与提交不一致。它会检查插件 ID、版本、源码编译、清单、安全规则以及 `tests/*.test.mjs`；仅文档修改不触发插件检查。修改共享源码会扩大检查范围，修改构建脚本等基础设施会触发全部插件检查。

`npm test` 使用同一个脚本，但基线固定为 `origin/main`；仅在该引用对应官方主分支时使用。PR 的 CI 还会运行规范包测试：

```bash
node --test packages/ztools-plugins-spec/tests/*.test.mjs
```

## 提交 Pull Request

说明改动目的、涉及的插件、测试命令与结果，以及已经验证的系统和必要运行依赖。避免提交本机路径、凭据、日志中的个人信息或构建缓存。维护者审查合并后安排发布，PR 合并不等于客户端市场已经更新。

# 贡献指南

欢迎通过 Issue 和 Pull Request 改进 ZTools 客户端。插件相关的贡献请到 [ZTools Extensions](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/CONTRIBUTING.md)。

## 反馈问题

在 [Issues](https://github.com/ZToolsTeam/ZTools/issues) 新建，写清楚：

- 系统版本与架构（如 Windows 11 x64、macOS 15 Apple Silicon）；
- 客户端版本，从源码运行时附上提交号；
- 复现步骤、预期结果和实际结果；
- 相关日志或截图。提交前去掉用户名、路径、令牌等个人信息。

发现安全问题时，Issue 里只描述影响范围，不要公开利用方法，维护者会联系你确认细节。

## 提交 Pull Request

1. Fork 本仓库，从 `main` 新建分支。
2. 修改代码并补上测试，本地运行通过（见下文「提交前检查」）。
3. 向 `ZToolsTeam/ZTools` 的 `main` 分支发起 Pull Request。
4. 在 Pull Request 说明里勾选「贡献授权」一项（见下文「贡献授权」），没有勾选的不会被合并。
5. 维护者审查。需要修改时直接在原分支追加提交。
6. 审查通过后以 squash 方式合并。

Pull Request 说明里写：

- 改了什么、为什么改；较大的改动建议先开 Issue 讨论方案；
- 运行过的测试命令和结果；
- 手动验证过的系统（Windows / macOS）。

一个 Pull Request 只做一件事，不要夹带无关的格式化或重构。Issue 和 Pull Request 用中文或英文都可以。

## 代码要求

- 代码规范见 [代码规范](docs/coding-standards.md)：七项原则（完整、成对、互斥、状态机、边界、防御外部输入、测试覆盖）、各层规则、换行符与提交说明格式。
- 测试规范见 [测试](docs/testing.md)：默认写集成用例，覆盖崩溃、超时、并发、数据损坏等失败路径。
- 模块分工见 [架构概览](docs/architecture.md)。

## 提交前检查

```bash
npm run test:quick
```

再按改动范围运行对应模块的测试，命令见 [测试](docs/testing.md#按模块运行)。

## 贡献授权

发起 Pull Request 时，模板里有一项必须勾选：

```text
- [x] 我确认本次贡献是我本人的原创作品（或我有权提交），并同意以 GPL-3.0-only 和 MIT 双重许可提供 / I confirm this contribution is my own work (or I have the right to submit it) and I agree to license it under both GPL-3.0-only and MIT
```

把 `[ ]` 改成 `[x]` 即可，不要改动文字。没有勾选的 Pull Request 不会被合并。

为什么要双重许可：本仓库以 GPL-3.0-only 公开，任何人都能拿到源码。项目官方发布的安装包除了这些源码，还可能带有闭源组件（例如账号与在线服务）。GPL 要求和代码组合在一起发布的部分也要开源，MIT 没有这个要求，所以需要你同时以 MIT 授权，官方安装包才能包含你的贡献。公开仓库里的代码仍然按 GPL-3.0-only 发布，你也仍然保留自己贡献的著作权。

如果贡献里有别人写的代码，请确认你有权按上面的条款提交，并在说明里注明来源和原许可证。

## 许可

本仓库的代码以 [GNU GPL v3.0](LICENSE)（GPL-3.0-only）发布；外部贡献同时以 MIT 授权给项目，见上文「贡献授权」。

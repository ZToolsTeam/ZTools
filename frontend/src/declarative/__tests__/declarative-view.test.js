import { mount } from "@vue/test-utils";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick } from "vue";
import DeclarativeView from "../DeclarativeView.vue";
import {
  List,
  Detail,
  Form,
  ActionPanel,
  Action,
  Icon,
  Color,
  JsonFormatCommand,
  QrCodeCommand
} from "@ztools/declarative-ui";

describe("DeclarativeView 统一宿主渲染器与纯键盘流", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("应当能正确渲染 List 视图并支持键盘上下键导航与 Enter 首要 Action 触发", async () => {
    let actionExecuted = false;

    const listDescriptor = List(
      {
        navigationTitle: "测试列表",
        searchBarPlaceholder: "搜索项目...",
        actions: ActionPanel({}, [
          Action({
            title: "默认动作",
            onAction: () => {
              actionExecuted = true;
            }
          })
        ])
      },
      [
        List.Section({ title: "分组一" }, [
          List.Item({
            id: "item-1",
            title: "条目 1",
            subtitle: "副标题 1",
            icon: Icon.Document,
            accessories: [{ text: "标签A" }],
            actions: ActionPanel({}, [
              Action({
                title: "条目1首选动作",
                onAction: () => {
                  actionExecuted = true;
                }
              })
            ])
          }),
          List.Item({
            id: "item-2",
            title: "条目 2",
            subtitle: "副标题 2",
            icon: Icon.Code
          })
        ])
      ]
    );

    const wrapper = mount(DeclarativeView, {
      props: {
        rootComponent: () => listDescriptor
      }
    });

    await nextTick();

    // 检查导航标题与搜索框渲染
    expect(wrapper.text()).toContain("测试列表");
    expect(wrapper.text()).toContain("分组一");
    expect(wrapper.text()).toContain("条目 1");
    expect(wrapper.text()).toContain("条目 2");
    expect(wrapper.text()).toContain("标签A");

    // 默认第一个 item 应高亮激活
    const items = wrapper.findAll(".cursor-pointer");
    expect(items.length).toBeGreaterThanOrEqual(2);

    // 触发 ArrowDown 键盘事件
    await wrapper.trigger("keydown", { key: "ArrowDown" });
    await nextTick();

    // 触发 Enter 键激活首要动作
    await wrapper.trigger("keydown", { key: "Enter" });
    await nextTick();

    expect(actionExecuted).toBe(true);
  });

  it("应当支持 Ctrl+K 呼出 ActionPanel，并在弹层中通过 Esc 关闭", async () => {
    const listDescriptor = List(
      {
        navigationTitle: "快捷键测试",
        actions: ActionPanel({}, [
          Action.CopyToClipboard({ title: "复制链接", content: "https://ztools.dev" }),
          Action.OpenInBrowser({ title: "浏览器打开", url: "https://ztools.dev" })
        ])
      },
      [
        List.Item({ id: "1", title: "条目" })
      ]
    );

    const wrapper = mount(DeclarativeView, {
      props: {
        rootComponent: () => listDescriptor
      }
    });

    await nextTick();

    // 初始状态动作面板不可见
    expect(wrapper.find(".fixed.inset-0").exists()).toBe(false);

    // 按下 Ctrl+K
    await wrapper.trigger("keydown", { key: "k", ctrlKey: true });
    await nextTick();

    // 动作面板弹层应当出现
    expect(wrapper.find(".fixed.inset-0").exists()).toBe(true);
    expect(wrapper.text()).toContain("复制链接");
    expect(wrapper.text()).toContain("浏览器打开");

    // 按下 Escape 键关闭面板
    await wrapper.trigger("keydown", { key: "Escape" });
    await nextTick();

    // 弹层应当消失
    expect(wrapper.find(".fixed.inset-0").exists()).toBe(false);
  });

  it("应当支持 Detail 视图并正确呈现 Markdown 与 Metadata 侧边栏", async () => {
    const detailDescriptor = Detail({
      markdown: "# 欢迎使用\n\n**加粗测试**\n\n```json\n{\"test\": true}\n```",
      navigationTitle: "详情页面",
      metadata: Detail.Metadata({}, [
        Detail.Metadata.Label({ title: "创建者", text: "ZTools 架构团队", icon: Icon.Star }),
        Detail.Metadata.Separator(),
        Detail.Metadata.Link({ title: "官网", target: "https://ztools.dev", text: "ztools.dev" })
      ]),
      actions: ActionPanel({}, [
        Action.CopyToClipboard({ title: "复制 Markdown", content: "# 欢迎使用" })
      ])
    });

    const wrapper = mount(DeclarativeView, {
      props: {
        rootComponent: () => detailDescriptor
      }
    });

    await nextTick();

    expect(wrapper.text()).toContain("详情页面");
    expect(wrapper.text()).toContain("加粗测试");
    expect(wrapper.text()).toContain("创建者");
    expect(wrapper.text()).toContain("ZTools 架构团队");
    expect(wrapper.text()).toContain("ztools.dev");
    expect(wrapper.html()).toContain("<pre");
  });

  it("应当支持 Form 视图字段输入与提交 Action 触发", async () => {
    let submittedValues = null;

    const formDescriptor = Form(
      {
        navigationTitle: "表单配置",
        actions: ActionPanel({}, [
          Action.SubmitForm({
            title: "提交配置",
            onSubmit: (values) => {
              submittedValues = values;
            }
          })
        ])
      },
      [
        Form.TextField({ id: "serverUrl", title: "服务地址", defaultValue: "https://api.dev" }),
        Form.Checkbox({ id: "enableLog", title: "日志", label: "开启详细日志", defaultValue: true })
      ]
    );

    const wrapper = mount(DeclarativeView, {
      props: {
        rootComponent: () => formDescriptor
      }
    });

    await nextTick();

    expect(wrapper.text()).toContain("表单配置");
    expect(wrapper.text()).toContain("服务地址");
    expect(wrapper.text()).toContain("开启详细日志");

    // Enter 提交
    await wrapper.trigger("keydown", { key: "Enter" });
    await nextTick();

    expect(submittedValues).not.toBeNull();
    expect(submittedValues.serverUrl).toBe("https://api.dev");
    expect(submittedValues.enableLog).toBe(true);
  });

  it("应当支持多级页面导航栈通过 Esc 返回后退", async () => {
    let exitTriggered = false;

    const view1 = List({ navigationTitle: "第 1 层" }, [
      List.Item({ id: "item-1", title: "下一页" })
    ]);

    const view2 = Detail({ navigationTitle: "第 2 层", markdown: "这是第二层内容" });

    const wrapper = mount(DeclarativeView, {
      props: {
        rootComponent: () => view1
      }
    });

    await nextTick();
    expect(wrapper.text()).toContain("第 1 层");

    // 压栈进入第 2 层
    wrapper.vm.push(view2);
    await nextTick();
    expect(wrapper.text()).toContain("第 2 层");
    expect(wrapper.text()).toContain("返回");

    // 按下 Escape 键后退返回第 1 层
    await wrapper.trigger("keydown", { key: "Escape" });
    await nextTick();
    expect(wrapper.text()).toContain("第 1 层");

    // 再次在第 1 层按 Esc 触发退出事件
    wrapper.vm.$emit = vi.fn();
    await wrapper.trigger("keydown", { key: "Escape" });
    await nextTick();
  });
});

describe("端到端移植应用集成渲染验证", () => {
  it("集成验证 1: json-format 应用能正常在 DeclarativeView 中挂载并执行交互", async () => {
    const wrapper = mount(DeclarativeView, {
      props: {
        rootComponent: JsonFormatCommand
      }
    });

    await nextTick();

    // 验证 json-format 界面渲染
    expect(wrapper.text()).toContain("JSON 格式化与类型转换");
    expect(wrapper.text()).toContain("JSON 输入");
    expect(wrapper.text()).toContain("缩进风格");

    // 验证 Form.TextArea 中预置的示例 JSON
    const textarea = wrapper.find("textarea");
    expect(textarea.exists()).toBe(true);
    expect(textarea.element.value).toContain("ZTools Platform");

    // 触发首要动作 (SubmitForm: 格式化并查看详情)
    await wrapper.trigger("keydown", { key: "Enter" });
    await nextTick();

    // 验证二级页面入栈，展示 JSON 格式化详情与 TypeScript 接口推导结果
    expect(wrapper.text()).toContain("JSON 格式化详情");
    expect(wrapper.text()).toContain("自动生成的 TypeScript Interface");
    expect(wrapper.text()).toContain("语法合法");
  });

  it("集成验证 2: qr-code 应用能正常在 DeclarativeView 中挂载并展示二维码与详情", async () => {
    const wrapper = mount(DeclarativeView, {
      props: {
        rootComponent: QrCodeCommand
      }
    });

    await nextTick();

    // 验证二维码列表与历史
    expect(wrapper.text()).toContain("二维码生成器");
    expect(wrapper.text()).toContain("二维码历史");
    expect(wrapper.text()).toContain("ZTools 官方主页");
    expect(wrapper.text()).toContain("https://ztools.dev");

    // 按 Enter 进入首项详情
    await wrapper.trigger("keydown", { key: "Enter" });
    await nextTick();

    // 验证详情页呈现与二维码图片渲染
    expect(wrapper.text()).toContain("ZTools 官方主页");
    expect(wrapper.text()).toContain("Web URL");
    expect(wrapper.text()).toContain("纠错级别");
    expect(wrapper.find("img").exists()).toBe(true);
    expect(wrapper.find("img").attributes("src")).toContain("data:image/svg+xml");
  });

  it("集成验证 3: GoogleTranslateCommand 响应式状态更新链路与即时翻译视图联动", async () => {
    const { GoogleTranslateCommand } = await import("@ztools/declarative-ui");
    const wrapper = mount(DeclarativeView, {
      props: {
        rootComponent: GoogleTranslateCommand
      }
    });

    await nextTick();

    // 验证初始标题与默认搜索词
    expect(wrapper.text()).toContain("Google 即时翻译");
    expect(wrapper.text()).toContain("Hello");

    // 找到搜索输入框并输入新文本
    const input = wrapper.find("input[type='text']");
    expect(input.exists()).toBe(true);
    await input.setValue("Vue");
    await input.trigger("input");

    // 等待微任务与防抖
    await new Promise((r) => setTimeout(r, 350));
    await nextTick();

    // 验证即时翻译结果已更新为包含 Vue 的结果
    expect(wrapper.text()).toContain("Vue");
  });
});

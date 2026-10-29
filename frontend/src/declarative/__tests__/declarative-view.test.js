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
  Icon
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
    expect(wrapper.find(".action-panel-scrim").exists()).toBe(false);

    // 按下 Ctrl+K
    await wrapper.trigger("keydown", { key: "k", ctrlKey: true });
    await nextTick();

    // 动作面板弹层应当出现
    expect(wrapper.find(".action-panel-scrim").exists()).toBe(true);
    expect(wrapper.text()).toContain("复制链接");
    expect(wrapper.text()).toContain("浏览器打开");

    // 按下 Escape 键关闭面板
    await wrapper.trigger("keydown", { key: "Escape" });
    await nextTick();

    // 弹层应当消失
    expect(wrapper.find(".action-panel-scrim").exists()).toBe(false);
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

  it("集成验证 3: GoogleTranslateCommand 首屏为空，输入后显示联网译文；断网时如实报错", async () => {
    const { GoogleTranslateCommand } = await import("@ztools/declarative-ui");
    const { configureTranslationService } = await import("@ztools/declarative-ui/host");
    // 测试用的翻译服务地址（不是任何真实服务）；正式构建的地址在构建时注入
    configureTranslationService({ endpoint: "https://translate.example.test/api/translation" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, data: { from: "en", trans_result: [{ dst: "苹果派很好吃" }] } })
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const wrapper = mount(DeclarativeView, { props: { rootComponent: GoogleTranslateCommand } });
      await nextTick();
      // 不再预填「Hello」和示例历史
      expect(wrapper.text()).not.toContain("Hello");
      expect(wrapper.text()).toContain("翻译历史 (0)");

      const input = wrapper.find("input[type='text']");
      await input.setValue("apple pie is delicious");
      await input.trigger("input");
      await new Promise((r) => setTimeout(r, 350));
      await nextTick();
      expect(fetchMock).toHaveBeenCalled();
      expect(wrapper.text()).toContain("苹果派很好吃");

      // 断网：不出现伪造的「[译] 原文」，而是提示服务不可用
      fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
      await input.setValue("Good morning developers");
      await input.trigger("input");
      await new Promise((r) => setTimeout(r, 350));
      await nextTick();
      expect(wrapper.text()).toContain("翻译服务暂时不可用");
      expect(wrapper.text()).not.toContain("[译]");
      wrapper.unmount();
    } finally {
      configureTranslationService({ endpoint: "" });
      vi.unstubAllGlobals();
    }
  });

  it("集成验证 3b: 未配置翻译服务时 GoogleTranslateCommand 提示「未配置翻译服务」，不发请求也不崩溃", async () => {
    const { GoogleTranslateCommand } = await import("@ztools/declarative-ui");
    const { configureTranslationService } = await import("@ztools/declarative-ui/host");
    configureTranslationService({ endpoint: "" });
    const fetchMock = vi.fn().mockRejectedValue(new Error("不应发请求"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const wrapper = mount(DeclarativeView, { props: { rootComponent: GoogleTranslateCommand } });
      await nextTick();
      const input = wrapper.find("input[type='text']");
      await input.setValue("Good morning developers");
      await input.trigger("input");
      await new Promise((r) => setTimeout(r, 350));
      await nextTick();
      expect(wrapper.text()).toContain("未配置翻译服务");
      expect(fetchMock).not.toHaveBeenCalled();

      // 词典收录的词照常离线翻译
      await input.setValue("Hello");
      await input.trigger("input");
      await new Promise((r) => setTimeout(r, 350));
      await nextTick();
      expect(wrapper.text()).toContain("你好");
      wrapper.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("集成验证 4: 支持次要动作 (Ctrl+Enter)、自定义 Action 快捷键免开菜单直达、右侧详情快捷按钮栏与 PasswordField 切换", async () => {
    const executedLog = [];

    const listDescriptor = List(
      {
        navigationTitle: "交互增强测试",
        isShowingDetail: true
      },
      [
        List.Item({
          id: "item-a",
          title: "测试进程 A",
          detail: List.Item.Detail({
            markdown: "# 进程详情\n占用内存 512MB"
          }),
          actions: ActionPanel({}, [
            Action({
              title: "温和结束进程",
              onAction: () => executedLog.push("primary")
            }),
            Action({
              title: "强制杀死进程 (-9)",
              style: "destructive",
              onAction: () => executedLog.push("secondary")
            }),
            Action({
              title: "新建监控规则",
              shortcut: { modifiers: ["cmd"], key: "n" },
              onAction: () => executedLog.push("ctrl+n")
            })
          ])
        })
      ]
    );

    const wrapper = mount(DeclarativeView, {
      props: {
        rootComponent: () => listDescriptor
      }
    });
    await nextTick();

    // 1. 验证底部黄金三键按钮栏渲染出主动作、次动作与动作面板 (3)，低频第3动作收纳于面板内
    expect(wrapper.text()).toContain("温和结束进程");
    expect(wrapper.text()).toContain("强制杀死进程 (-9)");
    // 面板按钮只计收起的动作（主 / 次动作已在底栏），危险的次动作不用强调色主按钮样式
    expect(wrapper.text()).toContain("动作面板 (1)");
    expect(wrapper.find("[data-decl-secondary]").classes()).toContain("is-destructive");
    expect(wrapper.find("[data-decl-primary]").classes()).toContain("is-primary");

    // 2. 触发 Ctrl+Enter 执行次动作
    await wrapper.trigger("keydown", { key: "Enter", ctrlKey: true });
    await nextTick();
    expect(executedLog).toContain("secondary");

    // 3. 免开菜单直接触发 Ctrl+N 自定义快捷键
    await wrapper.trigger("keydown", { key: "n", ctrlKey: true });
    await nextTick();
    expect(executedLog).toContain("ctrl+n");

    // 4. Beyond Happy Path: 当用户在搜索输入框内输入了文字并按下 Ctrl+A / Ctrl+V 时，不应误触自定义动作
    let ctrlATriggered = false;
    const listWithCtrlA = List({}, [
      List.Item({
        id: "item-b",
        title: "条目 B",
        actions: ActionPanel({}, [
          Action({
            title: "全选动作",
            shortcut: { modifiers: ["ctrl"], key: "a" },
            onAction: () => {
              ctrlATriggered = true;
            }
          })
        ])
      })
    ]);
    const wrapper2 = mount(DeclarativeView, {
      props: { rootComponent: () => listWithCtrlA }
    });
    await nextTick();
    const searchInput = wrapper2.find("input[type='text']");
    await searchInput.setValue("hello");
    await searchInput.trigger("keydown", { key: "a", ctrlKey: true });
    expect(ctrlATriggered).toBe(false);

    // 5. 验证 Form.PasswordField 掩码与明文切换及表单内嵌提交按钮
    let formSubmitted = null;
    const passwordForm = Form(
      {
        navigationTitle: "解锁密码库",
        actions: ActionPanel({}, [
          Action.SubmitForm({
            title: "立即解锁",
            onSubmit: (vals) => {
              formSubmitted = vals;
            }
          })
        ])
      },
      [
        Form.Description({ text: "请输入 AES-256-GCM 主密码" }),
        Form.PasswordField({ id: "masterPwd", title: "主密码", defaultValue: "Secret#2026" })
      ]
    );
    const wrapper3 = mount(DeclarativeView, {
      props: { rootComponent: () => passwordForm }
    });
    await nextTick();
    expect(wrapper3.text()).toContain("请输入 AES-256-GCM 主密码");
    const pwdInput = wrapper3.find("input#masterPwd");
    expect(pwdInput.exists()).toBe(true);
    expect(pwdInput.attributes("type")).toBe("password");

    // 点击“显示”切换为 text
    const toggleBtn = wrapper3.findAll("button").find((b) => b.text() === "显示");
    expect(toggleBtn).toBeDefined();
    await toggleBtn.trigger("click");
    expect(pwdInput.attributes("type")).toBe("text");

    // 点击表单内嵌提交按钮
    const submitBtn = wrapper3.findAll("button").find((b) => b.text().includes("立即解锁"));
    expect(submitBtn).toBeDefined();
    await submitBtn.trigger("click");
    expect(formSubmitted).toEqual({ masterPwd: "Secret#2026" });
  });
});

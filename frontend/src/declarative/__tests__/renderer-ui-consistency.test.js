/**
 * 声明式渲染器界面一致性回归：
 * 共用复选框 / 输入框 / 附件 / 空状态 / 元数据组件、列表选中与悬停区分（键盘导航时不显示悬停）、
 * 底栏动作（危险样式、收起数量、详情切换按真实快捷键）、子页面标题交给宿主标题栏、Toast 位置与播报、表单无障碍属性。
 */
import { mount } from "@vue/test-utils";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import DeclarativeView from "../DeclarativeView.vue";
import DeclCheckbox from "../components/DeclCheckbox.vue";
import DetailMetadata from "../components/DetailMetadata.vue";
import ListAccessory from "../components/ListAccessory.vue";
import ToastOverlay from "../components/ToastOverlay.vue";
import { cleanUiText, displayText, formatActionShortcut, actionKeyHint, isDestructiveAction } from "../uiText.js";
import { List, Detail, Form, ActionPanel, Action } from "@ztools/declarative-ui";

const mounted = [];

function mountView(rootComponent, props = {}) {
  const wrapper = mount(DeclarativeView, { props: { rootComponent, ...props }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

async function flush(times = 3) {
  for (let i = 0; i < times; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

function press(target, key, init = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = "darwin";
});

afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__;
  document.body.innerHTML = "";
});

describe("uiText 共用工具", () => {
  it("cleanUiText 去掉彩色 Emoji 并压缩空白，displayText 原样保留并把换行显示为 ⏎", () => {
    expect(cleanUiText("  清理 🚀  缓存 ")).toBe("清理 缓存");
    expect(cleanUiText(null)).toBe("");
    expect(displayText("a\nb\tc 🚀")).toBe("a⏎b c 🚀");
    expect(displayText(undefined)).toBe("");
  });

  it("[边界] formatActionShortcut 忽略缺 key、未知或重复修饰键、非数组修饰键", () => {
    expect(formatActionShortcut({ props: { shortcut: { modifiers: ["cmd", "meta", "shift"], key: "c" } } })).toBe("Ctrl+Shift+c");
    expect(formatActionShortcut({ props: { shortcut: { modifiers: ["hyper"], key: "k" } } })).toBe("k");
    expect(formatActionShortcut({ props: { shortcut: { modifiers: "cmd", key: "x" } } })).toBe("x");
    expect(formatActionShortcut({ props: { shortcut: { modifiers: ["cmd"] } } })).toBe("");
    expect(formatActionShortcut({ props: { shortcut: "space" } })).toBe("");
    expect(formatActionShortcut(null)).toBe("");
  });

  it("actionKeyHint：声明的快捷键优先；列表第 1/2 个为 Enter / ⌘Enter；表单只有第 1 个；子菜单与非法下标无提示", () => {
    const a = { props: { title: "a" } };
    expect(actionKeyHint(a, 0, "List")).toBe("Enter");
    expect(actionKeyHint(a, 1, "Detail")).toBe("Ctrl+Enter");
    expect(actionKeyHint(a, 2, "List")).toBe("");
    expect(actionKeyHint(a, 0, "Form")).toBe("Ctrl+Enter");
    expect(actionKeyHint(a, 1, "Form")).toBe("");
    expect(actionKeyHint({ ...a, _fromSubmenu: true }, 0, "List")).toBe("");
    expect(actionKeyHint(a, -1, "List")).toBe("");
    expect(actionKeyHint({ props: { shortcut: { modifiers: ["cmd"], key: "o" } } }, 5, "List")).toBe("Ctrl+o");
    expect(isDestructiveAction({ props: { style: "Destructive" } })).toBe(true);
    expect(isDestructiveAction({ props: {} })).toBe(false);
  });
});

describe("DeclCheckbox 统一复选框", () => {
  it("三种状态的 aria-checked 与样式类；点击发出取反值且不冒泡到所在行", async () => {
    let rowClicks = 0;
    const host = document.createElement("div");
    host.addEventListener("click", () => rowClicks++);
    document.body.appendChild(host);
    const wrapper = mount(DeclCheckbox, { props: { checked: false }, attachTo: host });
    mounted.push(wrapper);
    expect(wrapper.attributes("role")).toBe("checkbox");
    expect(wrapper.attributes("aria-checked")).toBe("false");
    await wrapper.trigger("click");
    expect(wrapper.emitted("change")[0]).toEqual([true]);
    expect(rowClicks).toBe(0);

    await wrapper.setProps({ checked: "indeterminate" });
    expect(wrapper.attributes("aria-checked")).toBe("mixed");
    expect(wrapper.classes()).toContain("is-mixed");
    // 部分选中时点击变为全选
    await wrapper.trigger("click");
    expect(wrapper.emitted("change")[1]).toEqual([true]);

    await wrapper.setProps({ checked: true });
    expect(wrapper.attributes("aria-checked")).toBe("true");
    await wrapper.trigger("click");
    expect(wrapper.emitted("change")[2]).toEqual([false]);
  });

  it("[边界] 禁用时点击不发出 change", async () => {
    const wrapper = mount(DeclCheckbox, { props: { checked: false, disabled: true } });
    mounted.push(wrapper);
    await wrapper.trigger("click");
    expect(wrapper.emitted("change")).toBeUndefined();
  });

  it("列表、分组、右栏全选与表单都使用同一主题复选框，不再写死 zinc 色或原生系统复选框", async () => {
    const wrapper = mountView(() =>
      List(
        {
          subList: {
            title: "文件",
            checkable: true,
            checked: "indeterminate",
            items: [List.Item({ id: "f1", title: "a.log", checkable: true, checked: true })]
          }
        },
        [List.Section({ title: "分组", checkable: true, checked: false }, [List.Item({ id: "n1", title: "导航", checkable: true })])]
      )
    );
    await flush();
    expect(wrapper.findAll(".decl-checkbox").length).toBe(4);
    expect(wrapper.html()).not.toContain("zinc");

    const form = mountView(() => Form({}, [Form.Checkbox({ id: "c", label: "记住我", defaultValue: false })]));
    await flush();
    expect(form.find("input[type='checkbox']").exists()).toBe(false);
    const box = form.find(".decl-checkbox");
    await box.trigger("click");
    await flush();
    expect(box.attributes("aria-checked")).toBe("true");
  });

  it("勾选列表行的复选框只改勾选状态，不改变选中行", async () => {
    const log = [];
    const wrapper = mountView(() =>
      List({}, [
        List.Item({ id: "a", title: "A" }),
        List.Item({ id: "b", title: "B", checkable: true, onCheckChange: (v) => log.push(v) })
      ])
    );
    await flush();
    const rows = wrapper.findAll(".decl-row");
    expect(rows[0].classes()).toContain("is-selected");
    await rows[1].find(".decl-checkbox").trigger("click");
    await flush();
    expect(log).toEqual([true]);
    expect(wrapper.findAll(".decl-row")[0].classes()).toContain("is-selected");
  });
});

describe("列表选中、悬停与无障碍", () => {
  const twoItems = () => List({}, [List.Item({ id: "a", title: "A" }), List.Item({ id: "b", title: "B" })]);

  it("列表是 listbox，行是 option 且 aria-selected 跟随选中项", async () => {
    const wrapper = mountView(twoItems);
    await flush();
    expect(wrapper.find("[data-decl-listbox]").attributes("role")).toBe("listbox");
    const rows = wrapper.findAll("[role='option']");
    expect(rows.map((r) => r.attributes("aria-selected"))).toEqual(["true", "false"]);
    press(wrapper.find("input[type='text']").element, "ArrowDown");
    await flush();
    expect(wrapper.findAll("[role='option']").map((r) => r.attributes("aria-selected"))).toEqual(["false", "true"]);
  });

  it("键盘移动后进入键盘模式（不显示悬停高亮），鼠标真正移动后恢复；同位置的补发事件不算", async () => {
    const wrapper = mountView(twoItems);
    await flush();
    const body = () => wrapper.find(".flex-1.flex.overflow-hidden.min-h-0");
    expect(body().classes()).not.toContain("is-keyboard-nav");
    press(wrapper.find("input[type='text']").element, "ArrowDown");
    await flush();
    expect(body().classes()).toContain("is-keyboard-nav");

    await body().trigger("mousemove", { screenX: 10, screenY: 10 });
    expect(body().classes()).not.toContain("is-keyboard-nav");

    press(wrapper.find("input[type='text']").element, "ArrowUp");
    await flush();
    expect(body().classes()).toContain("is-keyboard-nav");
    // 同一位置的 mousemove（例如滚动后浏览器补发）不退出键盘模式
    await body().trigger("mousemove", { screenX: 10, screenY: 10 });
    expect(body().classes()).toContain("is-keyboard-nav");
  });

  it("分组标题是纯文字，不带背景与边框；附件标签用正文字体", async () => {
    const wrapper = mountView(() =>
      List({}, [List.Section({ title: "最近使用", subtitle: "3" }, [List.Item({ id: "a", title: "A", accessories: [{ text: "1.2 GB" }] })])])
    );
    await flush();
    const title = wrapper.find(".decl-section-title");
    expect(title.text()).toContain("最近使用");
    expect(title.classes().some((c) => c.startsWith("border") || c.startsWith("bg-") || c.startsWith("rounded"))).toBe(false);
    const acc = wrapper.find(".decl-acc-text");
    expect(acc.text()).toBe("1.2 GB");
    expect(acc.classes()).not.toContain("font-mono");
  });

  it("[边界] 右栏没写标题时不显示写死的业务标题；空右栏用中性文案", async () => {
    const wrapper = mountView(() => List({ subList: { items: [] } }, [List.Item({ id: "n", title: "导航" })]));
    await flush();
    expect(wrapper.text()).not.toContain("大文件明细列表");
    expect(wrapper.text()).not.toContain("可清理的大文件");
    expect(wrapper.find(".decl-sublist-head").exists()).toBe(false);
    expect(wrapper.find(".decl-sublist-empty").text()).toBe("暂无内容");
  });

  it("[边界] 工作台面板没写标题时不显示写死的标题", async () => {
    const wrapper = mountView(() =>
      List({ workbenchPanel: { fields: [{ id: "x", label: "格式", value: "H.264" }] }, subList: { items: [] } }, [])
    );
    await flush();
    expect(wrapper.text()).not.toContain("加工参数配置面板");
    expect(wrapper.find(".decl-workbench-head").exists()).toBe(false);
  });

  it("工作台布尔参数用主题复选框，点击回调取反值", async () => {
    const log = [];
    const wrapper = mountView(() =>
      List(
        { workbenchPanel: { title: "参数", fields: [{ id: "hw", label: "硬件加速", type: "toggle", value: false, onChange: (v) => log.push(v) }] }, subList: { items: [] } },
        []
      )
    );
    await flush();
    await wrapper.find(".decl-field-toggle .decl-checkbox").trigger("click");
    expect(log).toEqual([true]);
  });
});

describe("ListAccessory", () => {
  it("[边界] 进度值越界或非数字时夹到 0~100，标签按风险色 / 灰阶显示", () => {
    const over = mount(ListAccessory, { props: { accessory: { progress: 250 } } });
    expect(over.attributes("aria-valuenow")).toBe("100");
    const nan = mount(ListAccessory, { props: { accessory: { progress: { value: "abc" } } } });
    expect(nan.attributes("aria-valuenow")).toBe("0");
    const danger = mount(ListAccessory, { props: { accessory: { tag: { value: "危险", color: "red" } } } });
    expect(danger.attributes("style")).toContain("var(--rc-error)");
    const empty = mount(ListAccessory, { props: { accessory: {} } });
    expect(empty.text()).toBe("");
  });
});

describe("底栏动作", () => {
  it("危险主动作用错误色样式，不是余烬橙主按钮", async () => {
    const wrapper = mountView(() =>
      List({}, [List.Item({ id: "a", title: "A", actions: ActionPanel({}, [Action({ title: "删除", style: "destructive", onAction: () => {} })]) })])
    );
    await flush();
    const primary = wrapper.find("[data-decl-primary]");
    expect(primary.classes()).toContain("is-destructive");
    expect(primary.classes()).not.toContain("is-primary");
  });

  it("只有主 / 次动作时不显示动作面板按钮，但 ⌘K 仍能打开面板", async () => {
    const wrapper = mountView(() =>
      List({}, [
        List.Item({
          id: "a",
          title: "A",
          actions: ActionPanel({}, [Action({ title: "打开", onAction: () => {} }), Action({ title: "复制", onAction: () => {} })])
        })
      ])
    );
    await flush();
    expect(wrapper.find("[data-decl-action-panel]").exists()).toBe(false);
    press(wrapper.find("input[type='text']").element, "k", { metaKey: true });
    await flush();
    expect(wrapper.find(".action-panel").exists()).toBe(true);
  });

  it("没有任何动作时底栏只剩返回入口", async () => {
    const wrapper = mountView(() => List({}, [List.Item({ id: "a", title: "A" })]));
    await flush();
    expect(wrapper.find("[data-decl-primary]").exists()).toBe(false);
    expect(wrapper.find("[data-decl-action-panel]").exists()).toBe(false);
    expect(wrapper.find("[data-decl-exit]").element.tagName).toBe("BUTTON");
  });

  it("详情切换按插件声明的快捷键显示与触发；写死的 ⌘D 不再触发它", async () => {
    const log = [];
    const wrapper = mountView(() =>
      List({ isShowingDetail: true }, [
        List.Item({
          id: "a",
          title: "A",
          detail: List.Item.Detail({ markdown: "正文" }),
          actions: ActionPanel({}, [
            Action({ title: "打开", onAction: () => log.push("open") }),
            Action({ title: "复制", onAction: () => log.push("copy") }),
            Action({ title: "切换详情预览分栏", shortcut: { modifiers: ["cmd", "shift"], key: "p" }, onAction: () => log.push("toggle") })
          ])
        })
      ])
    );
    await flush();
    const toggle = wrapper.find("[data-decl-toggle-detail]");
    expect(toggle.exists()).toBe(true);
    // ⌘ ⇧ P 三枚键帽，而不是写死的 ⌘ D
    expect(toggle.findAll("kbd").map((k) => k.text())).toEqual(["⌘", "⇧", "P"]);
    // 已在底栏露出，不计入面板按钮
    expect(wrapper.find("[data-decl-action-panel]").exists()).toBe(false);

    const input = wrapper.find("input[type='text']").element;
    press(input, "d", { metaKey: true });
    await flush();
    expect(log).toEqual([]);
    press(input, "p", { metaKey: true, shiftKey: true });
    await flush();
    expect(log).toEqual(["toggle"]);
  });

  it("[边界] 详情切换动作没声明快捷键时不放到底栏左侧，只在动作面板里", async () => {
    const wrapper = mountView(() =>
      List({}, [
        List.Item({
          id: "a",
          title: "A",
          actions: ActionPanel({}, [
            Action({ title: "打开", onAction: () => {} }),
            Action({ title: "复制", onAction: () => {} }),
            Action({ title: "Toggle Details", onAction: () => {} })
          ])
        })
      ])
    );
    await flush();
    expect(wrapper.find("[data-decl-toggle-detail]").exists()).toBe(false);
    expect(wrapper.find("[data-decl-action-panel]").text()).toContain("(1)");
  });

  it("独立窗口根页面：底栏只显示一处灰阶 Esc 提示，没有返回工作台", async () => {
    const wrapper = mountView(() => List({}, [List.Item({ id: "a", title: "A" })]), { isPopout: true });
    await flush();
    expect(wrapper.findAll("[data-decl-popout-hint]")).toHaveLength(1);
    expect(wrapper.find("[data-decl-exit]").exists()).toBe(false);
    expect(wrapper.html()).not.toContain("rc-success");
  });
});

describe("子页面标题交给宿主标题栏", () => {
  it("hostTitleBar 时视图内不显示第二条标题栏，push / pop 时上报当前标题", async () => {
    const wrapper = mountView(() => List({ navigationTitle: "根" }, [List.Item({ id: "a", title: "A" })]), {
      hostTitleBar: true,
      hideRootTitle: true
    });
    await flush();
    expect(wrapper.emitted("title-change")?.at(-1)).toEqual([""]);
    wrapper.vm.push(() => Form({ navigationTitle: "编辑规则" }, []));
    await flush();
    expect(wrapper.emitted("title-change").at(-1)).toEqual(["编辑规则"]);
    expect(wrapper.find(".px-4.py-2\\.5.border-b").exists()).toBe(false);
    // 返回入口仍只在底栏
    await wrapper.find("[data-decl-back]").trigger("click");
    await flush();
    expect(wrapper.emitted("title-change").at(-1)).toEqual([""]);
  });

  it("没有宿主标题栏时保持原样：子页面显示自己的标题栏，不上报", async () => {
    const wrapper = mountView(() => List({}, [List.Item({ id: "a", title: "A" })]));
    await flush();
    wrapper.vm.push(() => Form({ navigationTitle: "编辑规则" }, []));
    await flush();
    expect(wrapper.find(".px-4.py-2\\.5.border-b").text()).toContain("编辑规则");
    expect(wrapper.emitted("title-change")).toBeUndefined();
  });
});

describe("独立详情页与元数据", () => {
  it("独立 Detail 页不再在顶部重复一排动作按钮，动作只在底栏", async () => {
    const wrapper = mountView(() =>
      Detail({
        markdown: "# 标题\n\n正文",
        actions: ActionPanel({}, [Action({ title: "复制内容", onAction: () => {} }), Action({ title: "打开链接", onAction: () => {} })])
      })
    );
    await flush();
    expect(wrapper.findAll("button").filter((b) => b.text().includes("复制内容"))).toHaveLength(1);
    expect(wrapper.text()).not.toContain("更多动作");
    const md = wrapper.find(".declarative-markdown");
    expect(md.classes()).not.toContain("prose");
    expect(md.classes()).not.toContain("space-y-4");
  });

  it("[边界] Label 长值单行截断并可悬停看全文；不安全链接不生成地址；分隔线与标签列表都渲染", () => {
    const longText = "x".repeat(300);
    const wrapper = mount(DetailMetadata, {
      props: {
        variant: "sidebar",
        items: [
          { type: "Detail.Metadata.Label", props: { title: "路径", text: longText } },
          { type: "Detail.Metadata.Separator", props: {} },
          { type: "Detail.Metadata.Link", props: { title: "危险", text: "点我", target: "javascript:alert(1)" } },
          { type: "Detail.Metadata.Link", props: { title: "官网", text: "ztools.cn", target: "https://ztools.cn" } },
          { type: "Detail.Metadata.TagList", props: { title: "标签" }, children: [{ props: { text: "A" } }, { props: { text: "B" } }] }
        ]
      }
    });
    const value = wrapper.find(".decl-meta-value");
    expect(value.attributes("title")).toBe(longText);
    expect(value.find(".decl-meta-text").exists()).toBe(true);
    expect(wrapper.find("hr").exists()).toBe(true);
    const links = wrapper.findAll("a");
    expect(links[0].attributes("href")).toBeUndefined();
    expect(links[1].attributes("href")).toBe("https://ztools.cn");
    expect(links[1].attributes("rel")).toContain("noopener");
    expect(wrapper.findAll(".decl-meta-tag").map((t) => t.text())).toEqual(["A", "B"]);
  });

  it("加载提示用灰阶，不用强调色", async () => {
    const wrapper = mountView(() => Detail({ markdown: "", isLoading: true }));
    await flush();
    const loading = wrapper.find(".decl-detail-loading");
    expect(loading.exists()).toBe(true);
    expect(loading.classes().join(" ")).not.toContain("accent");
  });
});

describe("表单无障碍与输入框", () => {
  it("有错误时输入框 aria-invalid 并通过 aria-describedby 关联错误文字；info 显示在输入框下方", async () => {
    const wrapper = mountView(() =>
      Form({}, [
        Form.TextField({ id: "name", title: "名称", error: "名称不能为空", info: "最多 20 字" }),
        Form.TextArea({ id: "desc", title: "说明", info: "支持换行" })
      ])
    );
    await flush();
    const name = wrapper.find("#name");
    expect(name.attributes("aria-invalid")).toBe("true");
    expect(name.attributes("aria-describedby")).toBe("name-error");
    expect(wrapper.find("#name-error").text()).toContain("名称不能为空");
    // 有错误时 info 让位
    expect(wrapper.find("#name-info").exists()).toBe(false);

    const desc = wrapper.find("#desc");
    expect(desc.element.tagName).toBe("TEXTAREA");
    expect(desc.attributes("aria-invalid")).toBeUndefined();
    expect(desc.attributes("aria-describedby")).toBe("desc-info");
    const info = wrapper.find("#desc-info");
    expect(info.text()).toBe("支持换行");
    // info 在输入框之后（下方），不再与标签同行右对齐
    expect(desc.element.compareDocumentPosition(info.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 文本域默认用正文字体
    expect(desc.classes()).not.toContain("is-mono");
  });

  it("单行 / 密码 / 多行输入共用同一外观；密码可切换显示，输入回调插件", async () => {
    const log = [];
    const wrapper = mountView(() =>
      Form({}, [
        Form.TextField({ id: "a", title: "A" }),
        Form.PasswordField({ id: "p", title: "密码", onChange: (v) => log.push(v) }),
        Form.TextArea({ id: "t", title: "T" })
      ])
    );
    await flush();
    expect(wrapper.findAll(".decl-input")).toHaveLength(3);
    const pwd = wrapper.find("#p");
    expect(pwd.attributes("type")).toBe("password");
    await wrapper.find(".decl-reveal-btn").trigger("click");
    expect(wrapper.find("#p").attributes("type")).toBe("text");
    await wrapper.find("#p").setValue("secret");
    expect(log).toEqual(["secret"]);
  });
});

describe("Toast", () => {
  it("浮在底栏上方，带 role=status 与礼貌播报", () => {
    const wrapper = mount(ToastOverlay, { props: { toasts: [{ id: 1, title: "已复制", style: "SUCCESS" }] } });
    const host = wrapper.find(".decl-toast-host");
    expect(host.attributes("role")).toBe("status");
    expect(host.attributes("aria-live")).toBe("polite");
    expect(host.classes()).not.toContain("fixed");
    expect(wrapper.text()).toContain("已复制");
  });
});

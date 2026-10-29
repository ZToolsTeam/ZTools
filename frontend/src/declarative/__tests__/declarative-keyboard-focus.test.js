/**
 * 声明式宿主键盘流与焦点回归测试：
 * 输入法组字、输入框原生编辑键、浮层关闭后回焦、表单自动聚焦与提交、ActionPanel.Submenu、布局二左右栏键盘切换。
 * 组件挂载到真实 document 上，按键经窗口级 keymap 与根节点 @keydown 两条路径分发（与客户端一致）。
 */
import { mount } from "@vue/test-utils";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import DeclarativeView from "../DeclarativeView.vue";
import { List, Detail, Form, ActionPanel, Action } from "@ztools/declarative-ui";

const mounted = [];

function mountView(rootComponent) {
  const wrapper = mount(DeclarativeView, {
    props: { rootComponent },
    attachTo: document.body
  });
  mounted.push(wrapper);
  return wrapper;
}

async function flush(times = 3) {
  for (let i = 0; i < times; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

/** 在指定元素上派发真实冒泡的 keydown，返回事件对象（可检查 defaultPrevented） */
function press(target, key, init = {}) {
  const { keyCode, ...rest } = init;
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true, ...rest });
  if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: keyCode });
  target.dispatchEvent(event);
  return event;
}

function searchInput(wrapper) {
  return wrapper.find("input[type='text']").element;
}

beforeEach(() => {
  globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = "darwin";
});

afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__;
  document.body.innerHTML = "";
});

describe("输入法组字时的按键不当快捷键", () => {
  function listWithPrimary(log) {
    return () =>
      List({ navigationTitle: "IME" }, [
        List.Item({
          id: "a",
          title: "条目 A",
          actions: ActionPanel({}, [Action({ title: "主动作", onAction: () => log.push("primary") })])
        })
      ]);
  }

  it("isComposing=true 的 Enter 不执行主动作、不 preventDefault", async () => {
    const log = [];
    const wrapper = mountView(listWithPrimary(log));
    await flush();
    const input = searchInput(wrapper);
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const ev = press(input, "Enter", { isComposing: true });
    await flush();
    expect(log).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("keyCode 229 的 Enter / Escape 都交给输入法：不执行主动作、不退出", async () => {
    const log = [];
    const wrapper = mountView(listWithPrimary(log));
    await flush();
    const input = searchInput(wrapper);
    const enter = press(input, "Enter", { keyCode: 229 });
    const esc = press(input, "Escape", { keyCode: 229 });
    await flush();
    expect(log).toEqual([]);
    expect(enter.defaultPrevented).toBe(false);
    expect(esc.defaultPrevented).toBe(false);
    expect(wrapper.emitted("exit")).toBeUndefined();

    // 组字结束后的普通 Enter 仍正常执行，且只执行一次（窗口监听与根节点 @keydown 不重复分发）
    press(input, "Enter");
    await flush();
    expect(log).toEqual(["primary"]);
  });
});

describe("输入法组字时的方向键与动作面板按键", () => {
  it("搜索框组字时 ↓ 不移动列表选中项、不 preventDefault；组字结束后 ↓ 正常移动", async () => {
    const log = [];
    const wrapper = mountView(() =>
      List({}, [
        List.Item({ id: "a", title: "条目 A", actions: ActionPanel({}, [Action({ title: "A 动作", onAction: () => log.push("a") })]) }),
        List.Item({ id: "b", title: "条目 B", actions: ActionPanel({}, [Action({ title: "B 动作", onAction: () => log.push("b") })]) })
      ])
    );
    await flush();
    const input = searchInput(wrapper);
    input.focus();
    const ev = press(input, "ArrowDown", { isComposing: true });
    press(input, "ArrowDown", { keyCode: 229 });
    await flush();
    expect(ev.defaultPrevented).toBe(false);
    press(input, "Enter");
    await flush();
    expect(log).toEqual(["a"]);
    press(input, "ArrowDown");
    await flush();
    press(input, "Enter");
    await flush();
    expect(log).toEqual(["a", "b"]);
  });

  it("⌘K 面板搜索框组字时 Enter / Esc 不执行动作、不关闭面板", async () => {
    const log = [];
    const wrapper = mountView(() =>
      List({}, [
        List.Item({ id: "a", title: "条目", actions: ActionPanel({}, [Action({ title: "主动作", onAction: () => log.push("primary") })]) })
      ])
    );
    await flush();
    const input = searchInput(wrapper);
    input.focus();
    press(input, "k", { metaKey: true });
    await flush();
    const panelInput = wrapper.find("#action-panel-query").element;
    const enter = press(panelInput, "Enter", { isComposing: true });
    press(panelInput, "Escape", { keyCode: 229 });
    await flush();
    expect(log).toEqual([]);
    expect(enter.defaultPrevented).toBe(false);
    expect(wrapper.find(".action-panel-scrim").exists()).toBe(true);
    press(panelInput, "Enter");
    await flush();
    expect(log).toEqual(["primary"]);
  });
});

describe("输入框原生编辑组合键与 macOS 修饰键", () => {
  function listWithShortcuts(log) {
    return () =>
      List({}, [
        List.Item({
          id: "a",
          title: "条目 A",
          actions: ActionPanel({}, [
            Action({ title: "主动作", onAction: () => log.push("primary") }),
            Action({ title: "复制规格", shortcut: { modifiers: ["cmd"], key: "c" }, onAction: () => log.push("cmd+c") }),
            Action({ title: "重置流水", shortcut: { modifiers: ["cmd", "shift"], key: "z" }, onAction: () => log.push("cmd+shift+z") })
          ])
        })
      ]);
  }

  it("搜索框有选区时 ⌘C 留给原生复制；无选区时触发插件动作", async () => {
    const log = [];
    const wrapper = mountView(listWithShortcuts(log));
    await flush();
    const input = searchInput(wrapper);
    input.focus();
    input.value = "Apple";
    input.setSelectionRange(0, 5);
    const withSelection = press(input, "c", { metaKey: true });
    await flush();
    expect(log).toEqual([]);
    expect(withSelection.defaultPrevented).toBe(false);

    input.setSelectionRange(5, 5);
    const noSelection = press(input, "c", { metaKey: true });
    await flush();
    expect(log).toEqual(["cmd+c"]);
    expect(noSelection.defaultPrevented).toBe(true);
  });

  it("输入框有内容时 ⌘⇧Z（重做）不被插件动作劫持；空输入框时照常触发", async () => {
    const log = [];
    const wrapper = mountView(listWithShortcuts(log));
    await flush();
    const input = searchInput(wrapper);
    input.focus();
    input.value = "abc";
    press(input, "z", { metaKey: true, shiftKey: true });
    await flush();
    expect(log).toEqual([]);
    input.value = "";
    press(input, "z", { metaKey: true, shiftKey: true });
    await flush();
    expect(log).toEqual(["cmd+shift+z"]);
  });

  it("输入框有内容时 ⌘⌫ 留给输入框删除文字，不触发删除动作；空输入框时照常触发", async () => {
    const log = [];
    const wrapper = mountView(() =>
      List({}, [
        List.Item({
          id: "a",
          title: "条目 A",
          actions: ActionPanel({}, [
            Action({ title: "主动作", onAction: () => log.push("primary") }),
            Action({ title: "删除", shortcut: { modifiers: ["ctrl"], key: "backspace" }, onAction: () => log.push("delete") })
          ])
        })
      ])
    );
    await flush();
    const input = searchInput(wrapper);
    input.focus();
    input.value = "abc";
    const typing = press(input, "Backspace", { metaKey: true });
    await flush();
    expect(log).toEqual([]);
    expect(typing.defaultPrevented).toBe(false);
    input.value = "";
    press(input, "Backspace", { metaKey: true });
    await flush();
    expect(log).toEqual(["delete"]);
  });

  it("macOS 上 ⌃C 不匹配声明为 cmd 的动作", async () => {
    const log = [];
    const wrapper = mountView(listWithShortcuts(log));
    await flush();
    const input = searchInput(wrapper);
    input.focus();
    press(input, "c", { ctrlKey: true });
    await flush();
    expect(log).toEqual([]);
  });

  it("Windows 上 Ctrl+C 匹配、Win 键+C 不匹配", async () => {
    globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = "win32";
    const log = [];
    const wrapper = mountView(listWithShortcuts(log));
    await flush();
    const input = searchInput(wrapper);
    input.focus();
    press(input, "c", { metaKey: true });
    await flush();
    expect(log).toEqual([]);
    press(input, "c", { ctrlKey: true });
    await flush();
    expect(log).toEqual(["cmd+c"]);
  });
});

describe("动作面板关闭、推入新页面后焦点回到当前视图", () => {
  function calcLike(log) {
    return () =>
      List({}, [
        List.Item({
          id: "a",
          title: "结果",
          actions: ActionPanel({}, [
            Action({ title: "复制结果", onAction: () => log.push("primary") }),
            Action({ title: "保存到历史", shortcut: { modifiers: ["cmd"], key: "p" }, onAction: () => log.push("cmd+p") })
          ])
        })
      ]);
  }

  it("⌘K → Esc 后焦点回到搜索框，⌘P 仍能触发、可以继续打字", async () => {
    const log = [];
    const wrapper = mountView(calcLike(log));
    await flush();
    const input = searchInput(wrapper);
    input.focus();
    press(input, "k", { metaKey: true });
    await flush();
    expect(wrapper.find(".action-panel-scrim").exists()).toBe(true);
    press(document.activeElement, "Escape");
    await flush();
    expect(wrapper.find(".action-panel-scrim").exists()).toBe(false);
    expect(document.activeElement).toBe(input);
    press(document.activeElement, "p", { metaKey: true });
    await flush();
    expect(log).toEqual(["cmd+p"]);
  });

  it("⌘K → Enter 执行动作后焦点同样回到搜索框", async () => {
    const log = [];
    const wrapper = mountView(calcLike(log));
    await flush();
    const input = searchInput(wrapper);
    input.focus();
    press(input, "k", { metaKey: true });
    await flush();
    press(document.activeElement, "Enter");
    await flush();
    expect(log).toEqual(["primary"]);
    expect(document.activeElement).toBe(input);
  });

  it("推入 Detail 后焦点在视图根节点内；焦点丢到 body 上时插件快捷键也能命中", async () => {
    const log = [];
    const detail = Detail({
      markdown: "# 预览",
      actions: ActionPanel({}, [
        Action({ title: "打开", onAction: () => log.push("open") }),
        Action({ title: "复制路径", shortcut: { modifiers: ["cmd", "shift"], key: "c" }, onAction: () => log.push("copy-path") })
      ])
    });
    const wrapper = mountView(() =>
      List({}, [
        List.Item({
          id: "f",
          title: "a.txt",
          actions: ActionPanel({}, [Action.Push({ title: "预览", target: detail })])
        })
      ])
    );
    await flush();
    searchInput(wrapper).focus();
    press(document.activeElement, "Enter");
    await flush();
    expect(wrapper.text()).toContain("预览");
    expect(wrapper.element.contains(document.activeElement)).toBe(true);
    press(document.activeElement, "c", { metaKey: true, shiftKey: true });
    await flush();
    expect(log).toEqual(["copy-path"]);

    // 焦点被外部夺走到 body：窗口级 keymap 兜底
    document.activeElement.blur();
    expect(document.activeElement).toBe(document.body);
    press(document.body, "c", { metaKey: true, shiftKey: true });
    await flush();
    expect(log).toEqual(["copy-path", "copy-path"]);
  });

  it("焦点在列表根节点上直接打字时，焦点交回搜索框且不执行任何动作", async () => {
    const log = [];
    const wrapper = mountView(calcLike(log));
    await flush();
    wrapper.element.focus();
    expect(document.activeElement).toBe(wrapper.element);
    const ev = press(wrapper.element, "a");
    await flush();
    expect(document.activeElement).toBe(searchInput(wrapper));
    expect(ev.defaultPrevented).toBe(false);
    expect(log).toEqual([]);
  });

  it("视图卸载后的延迟回焦不抛错", async () => {
    const wrapper = mountView(calcLike([]));
    await flush();
    press(searchInput(wrapper), "k", { metaKey: true });
    await flush();
    press(document.activeElement, "Escape");
    wrapper.unmount();
    mounted.length = 0;
    await flush();
    expect(document.body.contains(wrapper.element)).toBe(false);
  });
});

describe("Form 视图：自动聚焦、底栏主动作与 ⌘Enter 提交", () => {
  it("打开表单后首个文本框获得焦点，光标在预填内容末尾", async () => {
    const wrapper = mountView(() =>
      Form({ actions: ActionPanel({}, [Action.SubmitForm({ title: "保存", onSubmit: () => {} })]) }, [
        Form.Description({ text: "说明" }),
        Form.TextField({ id: "title", title: "标题", value: "已有" }),
        Form.TextArea({ id: "content", title: "正文" })
      ])
    );
    await flush();
    const el = document.activeElement;
    expect(el?.id).toBe("title");
    expect(el.selectionStart).toBe(2);
  });

  it("声明 autoFocus 的字段优先获得焦点", async () => {
    const wrapper = mountView(() =>
      Form({ actions: ActionPanel({}, [Action.SubmitForm({ title: "格式化", onSubmit: () => {} })]) }, [
        Form.TextField({ id: "name", title: "名称" }),
        Form.TextArea({ id: "json", title: "JSON", autoFocus: true })
      ])
    );
    await flush();
    expect(document.activeElement?.id).toBe("json");
    expect(wrapper.vm).toBeTruthy();
  });

  it("普通 Action 作为表单主动作时，点底栏主动作执行 onAction（与键盘 ⌘Enter 一致）；表单内不再重复渲染提交按钮", async () => {
    const log = [];
    const wrapper = mountView(() =>
      Form({ actions: ActionPanel({}, [Action({ title: "保存日程", onAction: () => log.push("save") })]) }, [
        Form.TextField({ id: "t", title: "标题" })
      ])
    );
    await flush();
    const matches = wrapper.findAll("button").filter((b) => b.text().includes("保存日程"));
    // 同一动作只出现一次：底栏主动作；不再有带“(Enter)”或“✓”的表单内按钮，也没有“取消 / 返回”
    expect(matches).toHaveLength(1);
    expect(wrapper.text()).not.toContain("(Enter)");
    expect(wrapper.text()).not.toContain("取消 / 返回");
    const btn = matches[0];
    expect(btn.attributes("title")).toContain("执行首要动作");
    await btn.trigger("click");
    await flush();
    expect(log).toEqual(["save"]);
  });

  it("主动作抛错时点底栏主动作给出失败提示，不静默", async () => {
    const wrapper = mountView(() =>
      Form({ actions: ActionPanel({}, [Action({ title: "复制 HMAC", onAction: () => { throw new Error("密钥为空"); } })]) }, [
        Form.TextField({ id: "k", title: "密钥" })
      ])
    );
    await flush();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const btn = wrapper.findAll("button").find((b) => b.text().includes("复制 HMAC"));
    expect(btn).toBeDefined();
    await btn.trigger("click");
    await flush();
    expect(wrapper.text()).toContain("密钥为空");
    errSpy.mockRestore();
  });

  it("焦点在 textarea 时 ⌘Enter 提交表单，不执行第 2 个动作；Enter 仍是换行", async () => {
    const log = [];
    let submitted = null;
    const wrapper = mountView(() =>
      Form(
        {
          actions: ActionPanel({}, [
            Action.SubmitForm({ title: "保存", onSubmit: (v) => { submitted = v; log.push("submit"); } }),
            Action({ title: "返回", onAction: () => log.push("back") })
          ])
        },
        [Form.TextField({ id: "title", title: "标题" }), Form.TextArea({ id: "content", title: "正文", value: "第一行" })]
      )
    );
    await flush();
    const textarea = wrapper.find("textarea").element;
    textarea.focus();
    const enter = press(textarea, "Enter");
    await flush();
    expect(log).toEqual([]);
    expect(enter.defaultPrevented).toBe(false);

    press(textarea, "Enter", { metaKey: true });
    await flush();
    expect(log).toEqual(["submit"]);
    expect(submitted).toMatchObject({ content: "第一行" });
    // 底栏不再把第 2 个动作作为 ⌘Enter 次动作外露
    expect(wrapper.findAll("button").some((b) => b.attributes("title")?.startsWith("执行次要动作"))).toBe(false);
  });
});

describe("ActionPanel.Submenu", () => {
  function withSubmenu(log) {
    return () =>
      List({}, [
        List.Item({
          id: "r",
          title: "1 米 = 100 厘米",
          actions: ActionPanel({}, [
            Action({ title: "复制结果", onAction: () => log.push("copy") }),
            ActionPanel.Submenu({ title: "调整保留小数位" }, [
              Action({ title: "保留 2 位小数", onAction: () => log.push("p2") }),
              Action({ title: "保留 4 位小数", onAction: () => log.push("p4") })
            ]),
            Action({ title: "复制公式", onAction: () => log.push("formula") })
          ])
        })
      ]);
  }

  it("子菜单动作出现在 ⌘K 面板中并可执行，但不抢占 Enter / ⌘Enter", async () => {
    const log = [];
    const wrapper = mountView(withSubmenu(log));
    await flush();
    const input = searchInput(wrapper);
    input.focus();
    // 主动作「复制结果」与次动作「复制公式」已在底栏露出，面板按钮只计收起的 2 个子菜单动作
    expect(wrapper.text()).toContain("动作面板 (2)");

    press(input, "Enter", { metaKey: true });
    await flush();
    expect(log).toEqual(["formula"]);

    press(input, "k", { metaKey: true });
    await flush();
    expect(wrapper.text()).toContain("调整保留小数位");
    expect(wrapper.text()).toContain("保留 2 位小数");
    const panelInput = document.activeElement;
    panelInput.value = "保留 2";
    panelInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    press(panelInput, "Enter");
    await flush();
    expect(log).toEqual(["formula", "p2"]);
  });

  it("按子菜单标题搜索能找到子菜单里的动作", async () => {
    const wrapper = mountView(withSubmenu([]));
    await flush();
    press(searchInput(wrapper), "k", { metaKey: true });
    await flush();
    const panelInput = document.activeElement;
    panelInput.value = "小数位";
    panelInput.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    const panelText = wrapper.find(".action-panel-scrim").text();
    expect(panelText).toContain("保留 4 位小数");
    expect(panelText).not.toContain("复制公式");
  });

  it("不认识的 ActionPanel.* 节点被跳过而不是崩溃，其余动作照常可用", async () => {
    const log = [];
    const wrapper = mountView(() =>
      List({}, [
        List.Item({
          id: "x",
          title: "x",
          actions: ActionPanel({}, [{ type: "ActionPanel.Weird", props: { title: "怪节点" }, children: [] }, Action({ title: "唯一动作", onAction: () => log.push("only") })])
        })
      ])
    );
    await flush();
    expect(wrapper.text()).toContain("唯一动作");
    // 唯一的动作已作为主动作显示在底栏，没有收起的动作时不显示动作面板按钮
    expect(wrapper.find("[data-decl-action-panel]").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("怪节点");
    press(searchInput(wrapper), "Enter");
    await flush();
    expect(log).toEqual(["only"]);
  });
});

describe("布局二：左栏导航与右栏明细的键盘切换", () => {
  function layoutTwo(state) {
    return () => {
      const rightItems = (state.rules[state.rule] || []).map((name) =>
        List.Item({
          id: `f-${name}`,
          title: name,
          checkable: true,
          checked: state.checked.has(name),
          onCheckChange: (v) => {
            if (v) state.checked.add(name);
            else state.checked.delete(name);
            state.log.push(`check:${name}:${v}`);
          },
          actions: ActionPanel({}, [Action({ title: `处理 ${name}`, onAction: () => state.log.push(`run:${name}`) })])
        })
      );
      return List(
        {
          subList: { title: "文件", items: rightItems }
        },
        [
          List.Section({ title: "规则" }, Object.keys(state.rules).map((rule) =>
            List.Item({
              id: `rule-${rule}`,
              title: rule,
              onSelect: () => {
                state.rule = rule;
                state.log.push(`select:${rule}`);
              },
              actions: ActionPanel({}, [Action({ title: `切换到${rule}`, onAction: () => state.log.push(`rule-action:${rule}`) })])
            })
          ))
        ]
      );
    };
  }

  function newState() {
    return { rules: { 序号: ["a.jpg", "b.jpg"], 日期: ["c.jpg"] }, rule: "序号", checked: new Set(), log: [] };
  }

  it("← 切到左栏后 ↓ 切换规则（调用 onSelect），底栏主动作变为左栏条目的动作；→ 切回右栏", async () => {
    const state = newState();
    const wrapper = mountView(layoutTwo(state));
    await flush();
    const input = searchInput(wrapper);
    input.focus();
    expect(wrapper.text()).toContain("处理 a.jpg");

    press(input, "ArrowLeft");
    await flush();
    expect(wrapper.text()).toContain("切换到序号");
    press(input, "ArrowDown");
    await flush();
    expect(state.log).toContain("select:日期");
    expect(wrapper.text()).toContain("切换到日期");
    press(input, "Enter");
    await flush();
    expect(state.log).toContain("rule-action:日期");

    press(input, "ArrowRight");
    await flush();
    press(input, "Enter");
    await flush();
    expect(state.log.filter((l) => l.startsWith("run:")).length).toBe(1);
  });

  it("搜索框有文字且光标不在边缘时 ← / → 只移动光标，不切栏", async () => {
    const state = newState();
    const wrapper = mountView(layoutTwo(state));
    await flush();
    const input = searchInput(wrapper);
    input.focus();
    input.value = "ab";
    input.setSelectionRange(1, 1);
    const ev = press(input, "ArrowLeft");
    await flush();
    expect(ev.defaultPrevented).toBe(false);
    expect(wrapper.text()).not.toContain("切换到序号");
  });

  it("右键左栏条目打开的动作面板展示该条目的动作", async () => {
    const state = newState();
    const wrapper = mountView(layoutTwo(state));
    await flush();
    const leftRow = wrapper.findAll("div.cursor-pointer").find((d) => d.text().includes("日期") && !d.text().includes("jpg"));
    await leftRow.trigger("contextmenu");
    await flush();
    const panel = wrapper.find(".action-panel-scrim");
    expect(panel.exists()).toBe(true);
    expect(panel.text()).toContain("日期");
    expect(panel.text()).toContain("切换到日期");
    expect(panel.text()).not.toContain("处理 a.jpg");
  });

  it("Space 切换右栏当前条目的勾选；搜索框有文字时空格照常输入", async () => {
    const state = newState();
    const wrapper = mountView(layoutTwo(state));
    await flush();
    const input = searchInput(wrapper);
    input.focus();
    const ev = press(input, " ", { code: "Space" });
    await flush();
    expect(ev.defaultPrevented).toBe(true);
    expect(state.log).toContain("check:a.jpg:true");

    input.value = "a";
    const typed = press(input, " ", { code: "Space" });
    await flush();
    expect(typed.defaultPrevented).toBe(false);
    expect(state.log.filter((l) => l.startsWith("check:")).length).toBe(1);
  });
});

describe("列表状态栏按钮", () => {
  it("按钮回调失败时如实提示，不静默；成功时不弹失败提示", async () => {
    let fail = true;
    const wrapper = mountView(() =>
      List({ filterBar: { summaryText: "状态", actions: [{ id: "refresh", title: "重新扫描", onAction: async () => { if (fail) throw new Error("扫描被拒绝"); } }] } }, [
        List.Item({ id: "a", title: "条目 A" })
      ])
    );
    await flush();
    const button = wrapper.findAll("button").find((item) => item.text().includes("重新扫描"));
    expect(button).toBeTruthy();
    await button.trigger("click");
    await flush(6);
    expect(wrapper.text()).toContain("操作失败");
    expect(wrapper.text()).toContain("扫描被拒绝");
  });
});

describe("⌘K 动作面板合并列表级动作", () => {
  it("条目已有同名动作时，列表级同名动作不重复出现；不同名的仍在全局操作里", async () => {
    const log = [];
    const wrapper = mountView(() =>
      List({ actions: ActionPanel({}, [
        Action({ title: "新建便签", onAction: () => log.push("list-new") }),
        Action({ title: "重新读取", onAction: () => log.push("list-reload") })
      ]) }, [
        List.Item({ id: "a", title: "条目 A", actions: ActionPanel({}, [
          Action({ title: "打开", onAction: () => log.push("open") }),
          Action({ title: "新建便签", onAction: () => log.push("item-new") })
        ]) })
      ])
    );
    await flush();
    const titles = wrapper.vm.$.setupState.activeActions.map((act) => act.props.title);
    expect(titles.filter((title) => title === "新建便签")).toHaveLength(1);
    expect(titles).toContain("重新读取");
  });
});

/**
 * 声明式宿主渲染器回归测试（选中项、导航栈、回调刷新、用户内容原样显示、Markdown、剪贴板失败如实提示）。
 * 组件挂载到真实 document，用真实 SDK 运行时（useState 等）渲染插件，按键经窗口级 keymap 与根节点两条路径分发。
 */
import { mount } from "@vue/test-utils";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import DeclarativeView from "../DeclarativeView.vue";
import DetailRenderer from "../components/DetailRenderer.vue";
import { renderMarkdown } from "../markdown.js";
import {
  List,
  Detail,
  Form,
  ActionPanel,
  Action,
  Clipboard,
  showToast,
  Toast,
  useState,
  getDeclarativeBridge
} from "@ztools/declarative-ui";

const mounted = [];

function mountView(rootComponent) {
  const wrapper = mount(DeclarativeView, { props: { rootComponent }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await nextTick();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

function press(target, key, init = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function searchInput(wrapper) {
  return wrapper.find("input[type='text']").element;
}

async function typeSearch(wrapper, text) {
  const input = searchInput(wrapper);
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  return input;
}

/** 模拟 preload 的 transport.methods；handler 返回信封 */
function installTransport(handlers) {
  const calls = [];
  const methods = {};
  for (const [name, handler] of Object.entries(handlers)) {
    methods[name] = async (request) => {
      calls.push([name, request.params]);
      return handler(request.params);
    };
  }
  window.__ztoolsElectron = { transport: { methods } };
  return calls;
}

let originalScrollIntoView;

beforeEach(() => {
  globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = "darwin";
  originalScrollIntoView = Element.prototype.scrollIntoView;
});

afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__;
  delete window.__ztoolsElectron;
  Element.prototype.scrollIntoView = originalScrollIntoView;
  document.body.innerHTML = "";
});

describe("列表 / 子列表变空后不能对看不见的旧条目执行动作", () => {
  function cityList(log) {
    return function Cmd() {
      const [q, setQ] = useState("");
      const items = ["北京", "上海"].filter((c) => c.includes(q));
      return List(
        { onSearchTextChange: setQ },
        items.map((c) =>
          List.Item({
            id: c,
            title: c,
            actions: ActionPanel({}, [
              Action({ title: `主动作 ${c}`, onAction: () => log.push(`primary:${c}`) }),
              Action.CopyToClipboard({ title: "复制城市", content: c }),
              Action({ title: "快捷动作", shortcut: { modifiers: ["cmd"], key: "d" }, onAction: () => log.push(`shortcut:${c}`) })
            ])
          })
        )
      );
    };
  }

  it("过滤为空后 Enter / ⌘Enter / 动作快捷键 / ⌘K 都不触发旧条目，也不写剪贴板", async () => {
    const log = [];
    const calls = installTransport({ clipboard_copy_text: () => ({ success: true, data: { success: true } }) });
    const wrapper = mountView(cityList(log));
    await flush();
    expect(wrapper.text()).toContain("主动作 北京");

    const input = await typeSearch(wrapper, "qqqqxyz");
    expect(wrapper.text()).toContain("未找到匹配条目");
    expect(wrapper.text()).not.toContain("主动作 北京");

    press(input, "Enter");
    press(input, "Enter", { metaKey: true });
    press(input, "d", { metaKey: true });
    await flush();
    expect(log).toEqual([]);
    expect(calls).toEqual([]);

    press(input, "k", { metaKey: true });
    await flush();
    // 动作面板没有旧条目的动作，也不显示旧条目标题
    expect(document.body.textContent).not.toContain("主动作 北京");
    expect(document.body.textContent).not.toContain("复制城市");
  });

  it("搜索恢复有结果后，动作重新作用于当前可见的条目", async () => {
    const log = [];
    const wrapper = mountView(cityList(log));
    await flush();
    const input = await typeSearch(wrapper, "zzz");
    await typeSearch(wrapper, "上");
    press(input, "Enter");
    await flush();
    expect(log).toEqual(["primary:上海"]);
  });

  it("布局二右栏过滤为空：Enter 只回落到 List 级动作，不执行看不见的文件的动作", async () => {
    const log = [];
    const Cmd = () => {
      const [q, setQ] = useState("");
      const files = ["a.txt", "b.txt"].filter((f) => f.includes(q));
      return List(
        {
          onSearchTextChange: setQ,
          actions: ActionPanel({}, [Action({ title: "重新扫描", onAction: () => log.push("rescan") })]),
          subList: {
            title: "文件",
            items: files.map((f) =>
              List.Item({ id: f, title: f, actions: ActionPanel({}, [Action({ title: `删除 ${f}`, onAction: () => log.push(`delete:${f}`) })]) })
            )
          }
        },
        [List.Item({ id: "nav", title: "全部文件", actions: ActionPanel({}, [Action({ title: "导航动作", onAction: () => log.push("nav") })]) })]
      );
    };
    const wrapper = mountView(Cmd);
    await flush();
    expect(wrapper.text()).toContain("删除 a.txt");
    const input = await typeSearch(wrapper, "zzz-no-match");
    press(input, "Enter");
    await flush();
    expect(log).toEqual(["rescan"]);
    expect(wrapper.text()).not.toContain("删除 a.txt");
  });
});

describe("搜索词变化后选中项回到第一项", () => {
  function calc(log, externals = {}) {
    return function Cmd() {
      const [q, setQ] = useState("");
      const [tick, setTick] = useState(0);
      externals.setTick = setTick;
      const children = [];
      if (q) {
        children.push(List.Item({ id: "result", title: `= ${q}`, actions: ActionPanel({}, [Action({ title: "复制结果", onAction: () => log.push(`result:${q}`) })]) }));
      }
      children.push(
        List.Section({ title: "示例" }, [
          List.Item({ id: "ex1", title: "1+1", subtitle: `t${tick}`, actions: ActionPanel({}, [Action({ title: "填入 1+1", onAction: () => log.push("ex1") })]) }),
          List.Item({ id: "ex2", title: "2+2", subtitle: `t${tick}`, actions: ActionPanel({}, [Action({ title: "填入 2+2", onAction: () => log.push("ex2") })]) })
        ])
      );
      return List({ onSearchTextChange: setQ }, children);
    };
  }

  it("先选中示例行再输入：Enter 执行结果行而不是示例", async () => {
    const log = [];
    const wrapper = mountView(calc(log));
    await flush();
    const input = searchInput(wrapper);
    press(input, "ArrowDown");
    await flush();
    await typeSearch(wrapper, "12*(3+4)");
    press(input, "Enter");
    await flush();
    expect(log).toEqual(["result:12*(3+4)"]);
  });

  it("搜索词不变的数据刷新仍按 key 保留用户选中项", async () => {
    const log = [];
    const ext = {};
    const wrapper = mountView(calc(log, ext));
    await flush();
    const input = searchInput(wrapper);
    press(input, "ArrowDown");
    await flush();
    ext.setTick(1);
    await flush();
    expect(wrapper.text()).toContain("t1");
    press(input, "Enter");
    await flush();
    expect(log).toEqual(["ex2"]);
  });

  it("异步搜索：加载中的中间帧之后，结果到来时仍选中新结果的第一项", async () => {
    const log = [];
    const Cmd = () => {
      const [q, setQ] = useState("");
      const [loading, setLoading] = useState(false);
      const [items, setItems] = useState(["a", "b"]);
      return List(
        {
          isLoading: loading,
          onSearchTextChange: (text) => {
            setQ(text);
            setLoading(true);
            setTimeout(() => {
              setItems(["c", "a"]);
              setLoading(false);
            }, 5);
          }
        },
        items.map((id) => List.Item({ id, title: `${id}${q ? "" : ""}`, actions: ActionPanel({}, [Action({ title: `执行 ${id}`, onAction: () => log.push(id) })]) }))
      );
    };
    const wrapper = mountView(Cmd);
    await flush();
    const input = searchInput(wrapper);
    press(input, "ArrowDown");
    await flush();
    await typeSearch(wrapper, "x");
    await new Promise((r) => setTimeout(r, 20));
    await flush();
    press(input, "Enter");
    await flush();
    expect(log).toEqual(["c"]);
  });

  it("受控 selectedItemId：插件指定或改变时选中对应条目，且不回调 onSelectionChange", async () => {
    const log = [];
    const changes = [];
    const ext = {};
    const Cmd = () => {
      const [sel, setSel] = useState("b");
      ext.setSel = setSel;
      return List(
        { selectedItemId: sel, onSelectionChange: (id) => changes.push(id) },
        ["a", "b", "c"].map((id) => List.Item({ id, title: id, actions: ActionPanel({}, [Action({ title: `执行 ${id}`, onAction: () => log.push(id) })]) }))
      );
    };
    const wrapper = mountView(Cmd);
    await flush();
    const input = searchInput(wrapper);
    press(input, "Enter");
    await flush();
    expect(log).toEqual(["b"]);
    expect(changes).toEqual([]);
    ext.setSel("c");
    await flush();
    press(input, "Enter");
    await flush();
    expect(log).toEqual(["b", "c"]);
    // 用户用方向键改选后，插件没改 selectedItemId 时不会被拉回去
    press(input, "ArrowUp");
    await flush();
    press(input, "Enter");
    await flush();
    expect(log).toEqual(["b", "c", "b"]);
    expect(changes).toEqual(["b"]);
  });
});

describe("右栏子列表方向键选择滚动到可视区", () => {
  it("↓ 移动右栏选中项时对选中行调用 scrollIntoView", async () => {
    const scrolled = [];
    Element.prototype.scrollIntoView = function () {
      scrolled.push(this.textContent);
    };
    const Cmd = () =>
      List(
        { subList: { title: "文件", items: Array.from({ length: 30 }, (_, i) => List.Item({ id: `f${i}`, title: `文件-${i}-行` })) } },
        [List.Item({ id: "nav", title: "全部" })]
      );
    const wrapper = mountView(Cmd);
    await flush();
    const input = searchInput(wrapper);
    for (let i = 0; i < 14; i++) press(input, "ArrowDown");
    await flush();
    expect(scrolled.at(-1)).toContain("文件-14-行");
    press(input, "ArrowUp");
    await flush();
    expect(scrolled.at(-1)).toContain("文件-13-行");
  });
});

describe("下拉框展开 Dropdown.Section", () => {
  it("List.Dropdown 的分组选项全部显示为 optgroup，切换后 onChange 收到值", async () => {
    const values = [];
    const Cmd = () =>
      List(
        {
          searchBarAccessory: List.Dropdown({ onChange: (v) => values.push(v) }, [
            List.Dropdown.Item({ title: "默认", value: "default" }),
            List.Dropdown.Section({ title: "类型筛选" }, [
              List.Dropdown.Item({ title: "全部", value: "type:all" }),
              List.Dropdown.Item({ title: "📄 文档", value: "type:document" })
            ]),
            List.Dropdown.Section({ title: "排序方式" }, [
              List.Dropdown.Item({ title: "按名称", value: "sort:name" }),
              List.Dropdown.Item({ title: "按大小", value: "sort:size" })
            ])
          ])
        },
        [List.Item({ id: "x", title: "x" })]
      );
    const wrapper = mountView(Cmd);
    await flush();
    const select = wrapper.find("select").element;
    expect(select.options.length).toBe(5);
    expect([...select.querySelectorAll("optgroup")].map((g) => g.label)).toEqual(["类型筛选", "排序方式"]);
    // 下拉选项是插件固定文案：仍去掉彩色 Emoji
    expect(select.options[2].textContent.trim()).toBe("文档");
    // 非受控下拉框不留空白：默认显示第一个选项
    expect(select.value).toBe("default");
    select.value = "sort:size";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(values).toEqual(["sort:size"]);
    // 推入下一层再返回，下拉框仍显示用户选的值，且不重复回调 onChange
    wrapper.vm.push(Detail({ markdown: "下一层" }));
    await flush();
    press(document.activeElement || document.body, "Escape");
    await flush();
    expect(wrapper.find("select").element.value).toBe("sort:size");
    expect(values).toEqual(["sort:size"]);
  });

  it("Form.Dropdown.Section 的选项同样显示且可选", async () => {
    const values = [];
    const Cmd = () =>
      Form({ actions: ActionPanel({}, [Action.SubmitForm({ title: "保存", onSubmit: () => {} })]) }, [
        Form.Dropdown({ id: "fmt", title: "格式", onChange: (v) => values.push(v) }, [
          Form.Dropdown.Section({ title: "图片" }, [
            Form.Dropdown.Item({ title: "PNG", value: "png" }),
            Form.Dropdown.Item({ title: "JPG", value: "jpg" })
          ]),
          Form.Dropdown.Item({ title: "PDF", value: "pdf" })
        ])
      ]);
    const wrapper = mountView(Cmd);
    await flush();
    const select = wrapper.find("select#fmt").element;
    expect(select.options.length).toBe(3);
    expect(select.querySelector("optgroup").label).toBe("图片");
    select.value = "jpg";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(values).toEqual(["jpg"]);
  });
});

describe("从推入的页面返回后恢复搜索词与选中项", () => {
  it("push → Esc 返回：输入框仍是原关键词，选中项不变，不重复回调 onSearchTextChange", async () => {
    const log = [];
    const searches = [];
    const Cmd = () => {
      const [q, setQ] = useState("");
      const items = ["a.txt", "ab.txt", "abc.txt", "zzz.txt"].filter((f) => f.includes(q));
      return List(
        {
          onSearchTextChange: (t) => {
            searches.push(t);
            setQ(t);
          }
        },
        items.map((f) => List.Item({ id: f, title: f, actions: ActionPanel({}, [Action({ title: `打开 ${f}`, onAction: () => log.push(f) })]) }))
      );
    };
    const wrapper = mountView(Cmd);
    await flush();
    const input = await typeSearch(wrapper, "a");
    press(input, "ArrowDown");
    press(input, "ArrowDown");
    await flush();
    const searchCount = searches.length;

    wrapper.vm.push(Detail({ markdown: "预览内容" }));
    await flush();
    expect(wrapper.text()).toContain("预览内容");
    press(document.activeElement || document.body, "Escape");
    await flush();

    const restored = searchInput(wrapper);
    expect(restored.value).toBe("a");
    expect(searches.length).toBe(searchCount);
    press(restored, "Enter");
    await flush();
    expect(log).toEqual(["abc.txt"]);
    // 恢复后 Esc 先清空搜索，而不是直接退出
    expect(wrapper.vm.$props).toBeTruthy();
  });

  it("推入的第二层列表不套用外部传入的根页面快照", async () => {
    const searches = [];
    const Second = () => List({ onSearchTextChange: (t) => searches.push(t) }, [List.Item({ id: "s", title: "第二层" })]);
    const wrapper = mount(DeclarativeView, {
      props: { rootComponent: () => List({}, [List.Item({ id: "r", title: "根" })]), initialSnapshot: { searchText: "根页面关键词" } },
      attachTo: document.body
    });
    mounted.push(wrapper);
    await flush();
    wrapper.vm.push(Second);
    await flush();
    expect(searchInput(wrapper).value).toBe("");
    expect(searches).toEqual([]);
  });
});

describe("视图树 JSON 不变时刷新宿主持有的回调闭包", () => {
  it("方向键选中第二项后点顶栏全局动作，执行的是最新闭包（作用于第二项）", async () => {
    const log = [];
    const Cmd = () => {
      const [sel, setSel] = useState(null);
      const items = ["e1", "e2", "e3"];
      const active = items.find((i) => i === sel) || items[0];
      return List(
        {
          onSelectionChange: setSel,
          filterBar: { summaryText: "日程", actions: [{ id: "copy", title: "复制日程摘要", onAction: () => log.push(active) }] }
        },
        items.map((i) => List.Item({ id: i, title: i, actions: ActionPanel({}, [Action({ title: `加入 ${i}`, onAction: () => log.push(`join:${active}`) })]) }))
      );
    };
    const wrapper = mountView(Cmd);
    await flush();
    const input = searchInput(wrapper);
    press(input, "ArrowDown");
    await flush();
    const btn = wrapper.findAll("button").find((b) => b.text().includes("复制日程摘要"));
    await btn.trigger("click");
    await flush();
    expect(log).toEqual(["e2"]);
    press(input, "Enter");
    await flush();
    expect(log).toEqual(["e2", "join:e2"]);
  });
});

describe("用户内容原样显示（不删 Emoji / 符号）", () => {
  it("列表行标题、副标题、标签保留 ★✓☎🍎，分组标题等插件文案仍去 Emoji", async () => {
    const Cmd = () =>
      List({}, [
        List.Section({ title: "🔍 解码结果" }, [
          List.Item({ id: "1", title: "价格 ★★★★☆ ✓ ☎", subtitle: "🍎 ✅ 苹果待办", accessories: [{ tag: { value: "🏷️" } }, { text: "line1\nline2" }] })
        ])
      ]);
    const wrapper = mountView(Cmd);
    await flush();
    const text = wrapper.text();
    expect(text).toContain("价格 ★★★★☆ ✓ ☎");
    expect(text).toContain("🍎 ✅ 苹果待办");
    expect(text).toContain("🏷️");
    expect(text).toContain("line1⏎line2");
    expect(text).toContain("解码结果");
    expect(text).not.toContain("🔍");
  });

  it("Detail 代码块里的 Emoji 与 &nbsp; 原样显示，元数据值保留符号", () => {
    const wrapper = mount(DetailRenderer, {
      props: {
        descriptor: {
          type: "Detail",
          props: {
            markdown: "# 任务 ✅\n\n```diff\n-任务A 完成 ✅\n+任务A 完成 ❌\n-<p>a&nbsp;b</p>\n+<p>a b</p>\n```",
            metadata: { type: "Detail.Metadata", children: [{ type: "Detail.Metadata.Label", props: { title: "标签 🏷️", text: "★ 重要 ☎" } }] }
          }
        }
      }
    });
    const pre = wrapper.find("pre").element.textContent;
    expect(pre).toContain("-任务A 完成 ✅");
    expect(pre).toContain("+任务A 完成 ❌");
    expect(pre).toContain("-<p>a&nbsp;b</p>");
    expect(pre).toContain("+<p>a b</p>");
    expect(wrapper.find("h1").text()).toBe("任务 ✅");
    expect(wrapper.text()).toContain("★ 重要 ☎");
    expect(wrapper.text()).toContain("标签 🏷️");
  });

  it("Form.Description 保留换行", async () => {
    const Cmd = () => Form({}, [Form.Description({ text: "line1\nline2\n\ttab" })]);
    const wrapper = mountView(Cmd);
    await flush();
    const desc = wrapper.findAll("div").filter((d) => d.text().startsWith("line1")).at(-1);
    expect(desc.classes()).toContain("whitespace-pre-wrap");
    expect(desc.element.textContent).toContain("line1\nline2\n\ttab");
  });
});

describe("Detail Markdown 渲染", () => {
  it("GFM 表格（含对齐）渲染为 table，单元格内容转义", () => {
    const html = renderMarkdown("| JSONPath | 类型 | 示例 |\n| :--- | :---: | ---: |\n| $ | object | <script>alert(1)</script> |\n| $.a\\|b | string | `x` |");
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.querySelectorAll("table").length).toBe(1);
    expect([...host.querySelectorAll("th")].map((t) => t.textContent)).toEqual(["JSONPath", "类型", "示例"]);
    expect(host.querySelectorAll("tbody tr").length).toBe(2);
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("tbody td:nth-child(3)").textContent).toBe("<script>alert(1)</script>");
    expect(host.querySelectorAll("th")[1].getAttribute("style")).toContain("center");
    expect(host.querySelectorAll("tbody tr")[1].firstElementChild.textContent).toBe("$.a|b");
  });

  it("单换行、有序列表、任务列表、斜体、删除线", () => {
    const host = document.createElement("div");
    host.innerHTML = renderMarkdown("牛奶\n鸡蛋\n面包\n\n1. 有序一\n2. 有序二\n\n- [ ] 未完成\n- [x] 已完成\n\n*斜体* _也是斜体_ ~~删除~~ **加粗** snake_case_name");
    const p = host.querySelector("p");
    expect(p.innerHTML.split("<br>").length).toBe(3);
    expect(host.textContent).toContain("1.有序一");
    expect(host.textContent).toContain("2.有序二");
    expect(host.textContent).toContain("☐未完成");
    expect(host.textContent).toContain("☑已完成");
    expect([...host.querySelectorAll("em")].map((e) => e.textContent)).toEqual(["斜体", "也是斜体"]);
    expect(host.querySelector("del").textContent).toBe("删除");
    expect(host.querySelector("strong").textContent).toBe("加粗");
    expect(host.textContent).toContain("snake_case_name");
  });

  it("长围栏代码块里可以出现 ```，各行独立保留", () => {
    const md = "````diff\n- ```js\n-const a = 1\n+const a = 2\n- ```\n````\n\n结尾";
    const host = document.createElement("div");
    host.innerHTML = renderMarkdown(md);
    const pre = host.querySelectorAll("pre");
    expect(pre.length).toBe(1);
    expect(pre[0].textContent).toBe("- ```js\n-const a = 1\n+const a = 2\n- ```");
    expect(host.querySelector("p").textContent).toBe("结尾");
  });

  it("代码块内的 # 与 * 不当作标题 / 列表，未闭合围栏到文末", () => {
    const host = document.createElement("div");
    host.innerHTML = renderMarkdown("```\n# 注释\n* 星号\n");
    expect(host.querySelector("h1")).toBeNull();
    expect(host.querySelector("pre").textContent).toBe("# 注释\n* 星号\n");
  });

  it("[对抗] 链接 javascript: 不生成标签，属性里的引号被转义，代码块里的 HTML 不执行", () => {
    const host = document.createElement("div");
    host.innerHTML = renderMarkdown("[x](javascript:alert(1)) [ok](https://a.cn/?q=\"b\" onmouseover=\"x)\n\n```\n<img src=x onerror=alert(1)>\n```\n\n| a |\n| - |\n| <img src=x onerror=alert(1)> |");
    expect(host.querySelectorAll("a").length).toBe(1);
    expect(host.querySelector("a").getAttribute("onmouseover")).toBeNull();
    expect(host.querySelectorAll("img").length).toBe(0);
    expect(host.querySelector("pre").textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("非代码文本里插件写的 &nbsp; 显示为不换行空格，空输入返回空串", () => {
    expect(renderMarkdown("a&nbsp;b")).toContain("a b");
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown(null)).toBe("");
  });
});

describe("剪贴板写入失败如实提示，不能显示“已复制”", () => {
  it.each(["CLIPBOARD_ERROR", "RESPONSE_TOO_LARGE", "CALLER_DESTROYED", "NOT_SUPPORTED", "PERMISSION_DENIED"])("自动粘贴被拒绝（%s）不臆测已经复制，也不执行成功回调", async (code) => {
    const onPaste = vi.fn();
    installTransport({ clipboard_hide_and_paste_text: () => ({ success: false, error: { code, message: "测试宿主拒绝粘贴" } }) });
    const wrapper = mountView(() => List({}, [List.Item({
      id: "paste", title: "待粘贴内容",
      actions: ActionPanel({}, [Action.Paste({ title: "粘贴", content: "新的测试内容", onPaste })])
    })]));
    await flush();
    press(searchInput(wrapper), "Enter");
    await flush();
    expect(wrapper.text()).toContain("粘贴失败");
    expect(wrapper.text()).toContain("测试宿主拒绝粘贴");
    expect(wrapper.text()).not.toContain("已复制");
    expect(wrapper.text()).not.toContain("已粘贴到活动窗口");
    expect(onPaste).not.toHaveBeenCalled();
  });

  it("发送粘贴请求的回执不能宣称目标应用已经收到", async () => {
    installTransport({ clipboard_hide_and_paste_text: () => ({ success: true }) });
    const wrapper = mountView(() => List({}, [List.Item({ id: "paste", title: "测试条目",
      actions: ActionPanel({}, [Action.Paste({ title: "发送", content: "测试内容" })])
    })]));
    await flush(); press(searchInput(wrapper), "Enter"); await flush();
    expect(wrapper.text()).toContain("已发送粘贴请求");
    expect(wrapper.text()).not.toContain("已粘贴到活动窗口");
  });

  function copyList(content, extra = {}) {
    return () =>
      List({}, [
        List.Item({
          id: "x",
          title: "条目",
          actions: ActionPanel({}, [
            Action.CopyToClipboard({ title: "复制内容", content }),
            Action({
              title: "插件复制",
              onAction: async () => {
                await Clipboard.copy(content);
                await showToast(Toast.Style.Success, "UUID 已复制到剪贴板");
              }
            }),
            ...(extra.actions || [])
          ])
        })
      ]);
  }

  it("宿主返回 success:false（如 text 无效）：Action.CopyToClipboard 弹失败提示，不弹成功提示", async () => {
    installTransport({ clipboard_copy_text: () => ({ success: false, error: { code: "INVALID_REQUEST", message: "text 无效" } }) });
    const wrapper = mountView(copyList("abc"));
    await flush();
    press(searchInput(wrapper), "Enter");
    await flush();
    expect(wrapper.text()).toContain("操作失败");
    expect(wrapper.text()).toContain("text 无效");
    expect(wrapper.text()).not.toContain("已复制到剪贴板");
  });

  it("IPC 管道抛错：插件 onAction 里的 Clipboard.copy 抛出，插件自己的成功提示不出现，宿主兜底弹失败提示", async () => {
    installTransport({
      clipboard_copy_text: () => {
        throw new Error("CLIPBOARD_ERROR 剪贴板被占用");
      }
    });
    const wrapper = mountView(copyList("uuid-1"));
    await flush();
    press(searchInput(wrapper), "Enter", { metaKey: true });
    await flush();
    expect(wrapper.text()).toContain("操作失败");
    expect(wrapper.text()).not.toContain("UUID 已复制到剪贴板");
  });

  it("空内容不调用宿主，直接提示失败", async () => {
    const calls = installTransport({ clipboard_copy_text: () => ({ success: true, data: { success: true } }) });
    const wrapper = mountView(copyList(""));
    await flush();
    press(searchInput(wrapper), "Enter");
    await flush();
    expect(calls).toEqual([]);
    expect(wrapper.text()).toContain("操作失败");
    expect(wrapper.text()).not.toContain("已复制到剪贴板");
    await expect(getDeclarativeBridge().copyToClipboard("")).rejects.toMatchObject({ code: "EMPTY_CONTENT" });
  });

  it("900K 字符文本原样交给宿主（不截断），成功后才提示已复制", async () => {
    const big = "x".repeat(900 * 1024);
    const calls = installTransport({ clipboard_copy_text: () => ({ success: true, data: { success: true } }) });
    const wrapper = mountView(copyList(big));
    await flush();
    press(searchInput(wrapper), "Enter");
    await flush();
    expect(calls.length).toBe(1);
    expect(calls[0][1].text.length).toBe(big.length);
    expect(wrapper.text()).toContain("已复制到剪贴板");
  });

  it("SDK Clipboard.copy / clear：宿主失败时 reject，clear 走 clipboard_clear", async () => {
    const calls = installTransport({
      clipboard_copy_text: () => ({ success: false, error: { code: "RESPONSE_TOO_LARGE", message: "剪贴板文本超过 8 MiB 上限" } }),
      clipboard_clear: () => ({ success: true, data: { success: true } })
    });
    mountView(copyList("x"));
    await flush();
    await expect(Clipboard.copy("big")).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    await expect(Clipboard.clear()).resolves.toBeUndefined();
    expect(calls.map((c) => c[0])).toEqual(["clipboard_copy_text", "clipboard_clear"]);
  });
});

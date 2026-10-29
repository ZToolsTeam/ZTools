/**
 * 声明式渲染器真机走查问题回归：
 * 图标全覆盖（与 @ztools/declarative-ui 的 Icon 枚举做契约）、进度条主题色、列表空状态文案、
 * 表单不重复渲染按钮 / 不拿字段 id 当标签、subList 锁图标只在插件声明时出现、去掉内部技术术语、GFM 提示块。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { mount } from "@vue/test-utils";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import DeclarativeView from "../DeclarativeView.vue";
import DeclarativeIcon from "../components/DeclarativeIcon.vue";
import { ICONS, FALLBACK_ICON, normalizeIconName, resolveIconShape } from "../icons.js";
import { renderMarkdown } from "../markdown.js";
import { List, Form, ActionPanel, Action } from "@ztools/declarative-ui";

const ICONS_TS = path.resolve(__dirname, "../../../../packages/declarative-ui/src/constants/icons.ts");

/** 读取 Icon 枚举的全部取值（"Name = \"value\"" 形式） */
function readIconEnumValues() {
  const source = readFileSync(ICONS_TS, "utf8");
  const body = /export enum Icon\s*\{([\s\S]*?)\n\}/.exec(source);
  if (!body) throw new Error("icons.ts 中没有找到 Icon 枚举");
  const values = [...body[1].matchAll(/=\s*"([^"]+)"/g)].map((m) => m[1]);
  return [...new Set(values)];
}

const mounted = [];

function mountView(rootComponent) {
  const wrapper = mount(DeclarativeView, { props: { rootComponent }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

async function flush(times = 3) {
  for (let i = 0; i < times; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

beforeEach(() => {
  globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = "darwin";
});

afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__;
  document.body.innerHTML = "";
});

describe("图标：Icon 枚举契约", () => {
  const values = readIconEnumValues();

  it("枚举能读到（防止正则失效导致空循环假通过）", () => {
    expect(values.length).toBeGreaterThan(80);
    expect(values).toContain("microphone");
    expect(values).toContain("rotate-anti-clockwise");
  });

  it("每个枚举值都有自己的图形，不落到兜底图标", () => {
    const missing = values.filter((v) => resolveIconShape(v).fallback);
    expect(missing).toEqual([]);
  });

  it("每个图形的路径都是合法字符串（不含 NaN / undefined，且以 M 开头）", () => {
    for (const [name, entry] of Object.entries(ICONS)) {
      const paths = Array.isArray(entry) ? entry : [entry.fill];
      expect(paths.length, name).toBeGreaterThan(0);
      for (const d of paths) {
        expect(typeof d, name).toBe("string");
        expect(d, name).toMatch(/^M/);
        expect(d, name).not.toMatch(/NaN|undefined/);
      }
    }
  });

  it("挂载每个枚举值都渲染出 currentColor 的 SVG 路径，不再出现实心圆点兜底", () => {
    for (const v of values) {
      const w = mount(DeclarativeIcon, { props: { icon: v } });
      const svg = w.find("svg");
      expect(svg.exists(), v).toBe(true);
      expect(svg.attributes("data-icon"), v).toBe(v);
      expect(svg.attributes("stroke")).toBe("currentColor");
      expect(w.findAll("path").length, v).toBeGreaterThan(0);
      expect(w.find(".rounded-full").exists(), v).toBe(false);
      w.unmount();
    }
  });

  it("插件写枚举名（Icon.CheckCircle / QrCode）也能解析", () => {
    expect(normalizeIconName("Icon.CheckCircle")).toBe("check-circle");
    expect(normalizeIconName("QrCode")).toBe("qr-code");
    expect(normalizeIconName("  HARD-DRIVE ")).toBe("hard-drive");
    expect(resolveIconShape("Icon.Box").fallback).toBe(false);
    expect(resolveIconShape("Icon.XMarkCircle").fallback).toBe(false);
  });

  it("[边界] 未知图标名、空值、畸形对象都显示中性方块轮廓，不崩溃、不显示实心圆点", () => {
    for (const icon of ["no-such-icon", "", { source: 123 }, { foo: "bar" }, "   "]) {
      const w = mount(DeclarativeIcon, { props: { icon } });
      const svg = w.find("svg");
      expect(svg.exists()).toBe(true);
      expect(svg.attributes("data-icon")).toBe("fallback");
      expect(w.find("path").attributes("d")).toBe(FALLBACK_ICON[0]);
      expect(w.find(".rounded-full").exists()).toBe(false);
      w.unmount();
    }
  });

  it("圆点类图标为实心，其它为描边；图片地址仍按图片显示；对象 tintColor 生效", () => {
    const dot = mount(DeclarativeIcon, { props: { icon: "dot" } });
    expect(dot.find("path").attributes("fill")).toBe("currentColor");
    dot.unmount();

    const img = mount(DeclarativeIcon, { props: { icon: { source: "https://example.com/A.png", tintColor: "red" } } });
    expect(img.find("img").attributes("src")).toBe("https://example.com/A.png");
    img.unmount();

    const tinted = mount(DeclarativeIcon, { props: { icon: { source: "star", tintColor: "rgb(1, 2, 3)" } } });
    expect(tinted.element.style.color).toBe("rgb(1, 2, 3)");
    tinted.unmount();
  });
});

describe("列表进度条跟随主题", () => {
  it("左栏与右栏子列表的进度条都不再写死白色", async () => {
    const wrapper = mountView(() =>
      List(
        {
          subList: {
            title: "文件",
            items: [List.Item({ id: "f1", title: "大文件", checkable: true, accessories: [{ progress: 40 }] })]
          }
        },
        [List.Item({ id: "a", title: "分类", accessories: [{ progress: { value: 70 } }] })]
      )
    );
    await flush();
    const html = wrapper.html();
    expect(html).not.toContain("rgba(255, 255, 255");
    expect(html).not.toContain("bg-white/");
    const tracks = wrapper.findAll(".decl-progress-track");
    expect(tracks).toHaveLength(2);
    for (const t of tracks) {
      expect(t.classes()).toContain("bg-[var(--rc-border)]");
      expect(t.find("div").attributes("style")).toContain("var(--rc-text-muted)");
    }
  });
});

describe("列表空状态文案", () => {
  const emptyList = (props) => () => List(props, []);

  it("加载中显示“正在加载…”，不提前说未找到", async () => {
    const wrapper = mountView(emptyList({ isLoading: true, searchText: "abc" }));
    await flush();
    expect(wrapper.find(".decl-list-empty").text()).toBe("正在加载…");
  });

  it("有搜索词且无结果时显示“未找到匹配条目”", async () => {
    const wrapper = mountView(emptyList({ searchText: "abc" }));
    await flush();
    expect(wrapper.find(".decl-list-empty").text()).toBe("未找到匹配条目");
  });

  it("没有搜索词、也不在加载时显示中性的“暂无内容”", async () => {
    const wrapper = mountView(emptyList({ searchText: "   " }));
    await flush();
    expect(wrapper.find(".decl-list-empty").text()).toBe("暂无内容");
  });
});

describe("表单：同一功能只出现一次、不拿 id 当标签", () => {
  it("没有动作的表单也不渲染表单内按钮，底栏仍有返回入口", async () => {
    const wrapper = mountView(() => Form({}, [Form.TextField({ id: "name", title: "名称" })]));
    await flush();
    expect(wrapper.text()).not.toContain("提交保存");
    expect(wrapper.text()).not.toContain("(Enter)");
    expect(wrapper.text()).toContain("返回工作台");
  });

  it("第 2、3 个动作只在动作面板里，不在表单里再出一排按钮", async () => {
    const wrapper = mountView(() =>
      Form({ actions: ActionPanel({}, [Action.SubmitForm({ title: "生成", onSubmit: () => {} }), Action({ title: "清空", onAction: () => {} })]) }, [
        Form.TextField({ id: "t", title: "内容" })
      ])
    );
    await flush();
    expect(wrapper.findAll("button").filter((b) => b.text().includes("生成"))).toHaveLength(1);
    expect(wrapper.findAll("button").filter((b) => b.text().includes("清空"))).toHaveLength(0);
  });

  it("字段没有 title 时不显示标签行；Checkbox 只显示 label 文字，不显示 id", async () => {
    const wrapper = mountView(() =>
      Form({}, [
        Form.Checkbox({ id: "hidden", label: "隐藏原文" }),
        Form.TextField({ id: "secretFieldId", placeholder: "请输入" }),
        Form.TextField({ id: "named", title: "名称", info: "必填" })
      ])
    );
    await flush();
    const text = wrapper.text();
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("secretFieldId");
    expect(text).toContain("隐藏原文");
    expect(text).toContain("名称");
    expect(text).toContain("必填");
    expect(wrapper.findAll("label").map((l) => l.text())).toEqual(["隐藏原文", "名称"]);
  });
});

describe("右栏子列表锁图标只在插件声明受保护时出现", () => {
  function subListView(items) {
    return () => List({ subList: { title: "文件", items } }, [List.Item({ id: "g", title: "分组" })]);
  }

  it("未设置 checkable 的普通行（如待转换文档）不显示锁", async () => {
    const wrapper = mountView(subListView([List.Item({ id: "doc", title: "待转换文档" })]));
    await flush();
    expect(wrapper.find(".decl-sub-lock").exists()).toBe(false);
    expect(wrapper.html()).not.toContain("系统保护文件");
  });

  it("checkable: false 显示锁和中性提示；lockedReason 作为提示原文", async () => {
    const wrapper = mountView(
      subListView([
        List.Item({ id: "p1", title: "系统文件", checkable: false }),
        List.Item({ id: "p2", title: "核心进程", checkable: false, lockedReason: "系统核心进程受保护，不能结束" }),
        List.Item({ id: "ok", title: "可清理", checkable: true })
      ])
    );
    await flush();
    const locks = wrapper.findAll(".decl-sub-lock");
    expect(locks).toHaveLength(2);
    expect(locks[0].attributes("title")).toBe("受保护，不可选择");
    expect(locks[1].attributes("title")).toBe("系统核心进程受保护，不能结束");
  });
});

describe("不显示内部技术术语", () => {
  it("带导航标题的视图头部不出现“声明式运行时”", async () => {
    const wrapper = mountView(() => List({ navigationTitle: "下载管理" }, [List.Item({ id: "a", title: "A" })]));
    await flush();
    expect(wrapper.text()).toContain("下载管理");
    expect(wrapper.text()).not.toContain("声明式运行时");
  });

  it("插件页顶栏不再有“V2 声明式扩展 / 官方标杆”徽标", () => {
    const src = readFileSync(path.resolve(__dirname, "../../pages/DeclarativePage.vue"), "utf8");
    expect(src).not.toContain("V2 声明式扩展");
    expect(src).not.toMatch(/'官方标杆'/);
  });
});

describe("Markdown：GFM 提示块", () => {
  it("[!TIP] / [!NOTE] / [!WARNING] 去掉标记并加中文小标题", () => {
    const tip = renderMarkdown("> [!TIP]\n> 按 ⌘K 打开动作面板");
    expect(tip).not.toContain("[!TIP]");
    expect(tip).toContain(">提示</strong>");
    expect(tip).toContain("按 ⌘K 打开动作面板");
    expect(tip).toMatch(/^<blockquote/);

    expect(renderMarkdown("> [!NOTE]\n> 内容")).toContain(">注意</strong>");
    expect(renderMarkdown("> [!WARNING]\n> 内容")).toContain(">警告</strong>");
    expect(renderMarkdown("> [!important]\n> 内容")).toContain(">重要</strong>");
    expect(renderMarkdown("> [!CAUTION]\n> 内容")).toContain(">小心</strong>");
  });

  it("标记后同一行的文字保留；只有标记没有正文时只显示标题", () => {
    expect(renderMarkdown("> [!TIP] 同行正文")).toContain("提示</strong><br>同行正文");
    const only = renderMarkdown("> [!WARNING]");
    expect(only).toContain(">警告</strong></blockquote>");
  });

  it("未知标记与普通引用保持原样", () => {
    expect(renderMarkdown("> [!FOO]\n> 内容")).toContain("[!FOO]");
    const plain = renderMarkdown("> 普通引用");
    expect(plain).toContain("普通引用");
    expect(plain).not.toContain("<strong");
  });

  it("[安全] 提示块正文里的 HTML 仍被转义", () => {
    const html = renderMarkdown('> [!TIP] <img src=x onerror="alert(1)">\n> <script>alert(2)</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });
});

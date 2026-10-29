/**
 * macOS 真机截图复核问题回归：
 * 1. Color.* 语义色按深色主题写死，必须映射到跟随主题的变量（图标 tintColor、标签 color 共用同一映射）；
 * 2. 状态栏摘要 / 内联指标不用等宽字体；
 * 3. 工作台左栏说明性字段值换行显示、卡片标题不被副标题挤掉；
 * 4. 子页面返回入口只有底栏一个，统一叫“返回”；
 * 5. List.Item.Detail 正文与 Metadata 在同一滚动容器里，Metadata 不再固定占底部挡住正文。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { mount } from "@vue/test-utils";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import DeclarativeView from "../DeclarativeView.vue";
import DeclarativeIcon from "../components/DeclarativeIcon.vue";
import { resolveThemeColor, semanticColorName } from "../colors.js";
import { List, Detail, Form, ActionPanel, Action, Icon } from "@ztools/declarative-ui";

const COLORS_TS = path.resolve(__dirname, "../../../../packages/declarative-ui/src/constants/colors.ts");
const THEME_CSS = path.resolve(__dirname, "../../assets/css/theme.css");

/** 读取 Color 枚举：{ 键名: 取值 } */
function readColorEnum() {
  const source = readFileSync(COLORS_TS, "utf8");
  const body = /export enum Color\s*\{([\s\S]*?)\n\}/.exec(source);
  if (!body) throw new Error("colors.ts 中没有找到 Color 枚举");
  return Object.fromEntries([...body[1].matchAll(/(\w+)\s*=\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
}

/** 读取 theme.css 中浅色（:root 第一段）与深色作用域里的变量值 */
function readThemeVars() {
  const css = readFileSync(THEME_CSS, "utf8");
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
  const parse = (body) => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const light = blocks.find((b) => /(^|\s|\/)\s*:root\s*$/.test(b.selector) || b.selector.endsWith(":root"));
  const dark = blocks.find((b) => /dark/.test(b.selector) && /--rc-text-primary/.test(b.body));
  if (!light || !dark) throw new Error("theme.css 中没有找到浅色 / 深色变量块");
  return { light: parse(light.body), dark: parse(dark.body) };
}

/** #rrggbb 的相对亮度（0 黑 ~ 1 白） */
function luminance(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`不是 #rrggbb：${hex}`);
  const [r, g, b] = m.slice(1).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
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

describe("语义色映射：Color 枚举契约", () => {
  const colors = readColorEnum();
  const theme = readThemeVars();

  it("枚举能读到（防止正则失效导致空循环假通过）", () => {
    expect(Object.keys(colors).length).toBeGreaterThanOrEqual(9);
    expect(colors.SecondaryText).toMatch(/255,\s*255,\s*255/);
  });

  it("按深色主题写死的白色文字色一律换成主题变量，不再原样输出白色", () => {
    expect(resolveThemeColor(colors.PrimaryText)).toBe("var(--rc-text-primary)");
    expect(resolveThemeColor(colors.SecondaryText)).toBe("var(--rc-text-muted)");
    // 枚举里所有白色系取值都必须被映射（以后新增同类值时这里会失败）
    for (const [key, value] of Object.entries(colors)) {
      if (/255,\s*255,\s*255/.test(value)) {
        expect(resolveThemeColor(value), key).toMatch(/^var\(--rc-/);
      }
    }
  });

  it("状态色映射到主题状态变量；Purple / Magenta 两种主题都可读，保持原值", () => {
    expect(resolveThemeColor(colors.Red)).toBe("var(--rc-error)");
    expect(resolveThemeColor(colors.Green)).toBe("var(--rc-success)");
    expect(resolveThemeColor(colors.Yellow)).toBe("var(--rc-warning)");
    expect(resolveThemeColor(colors.Orange)).toMatch(/^var\(--rc-/);
    expect(resolveThemeColor(colors.Blue)).toMatch(/^var\(--rc-/);
    expect(resolveThemeColor(colors.Purple)).toBe(colors.Purple);
    expect(resolveThemeColor(colors.Magenta)).toBe(colors.Magenta);
  });

  it("映射到的变量在浅色和深色主题都有定义，且浅色主题下文字色与背景对比足够", () => {
    for (const value of Object.values(colors)) {
      const resolved = resolveThemeColor(value);
      const name = /^var\((--[\w-]+)\)$/.exec(resolved)?.[1];
      if (!name) continue;
      expect(theme.light[name], `浅色缺少 ${name}`).toBeTruthy();
      expect(theme.dark[name], `深色缺少 ${name}`).toBeTruthy();
      expect(theme.light[name]).not.toBe(theme.dark[name]);
    }
    // 回归点：SecondaryText 原来在浅色背景上是 60% 白，几乎看不见
    const lightBg = theme.light["--rc-surface"];
    const darkBg = theme.dark["--rc-canvas"];
    expect(contrast(theme.light["--rc-text-muted"], lightBg)).toBeGreaterThan(4.5);
    expect(contrast(theme.light["--rc-text-primary"], lightBg)).toBeGreaterThan(7);
    expect(contrast(theme.dark["--rc-text-muted"], darkBg)).toBeGreaterThan(4.5);
    expect(contrast(theme.dark["--rc-text-primary"], darkBg)).toBeGreaterThan(7);
  });

  it("识别空白 / 大小写不同的写法、枚举键名与 raycast- 前缀名", () => {
    expect(resolveThemeColor("rgba(255,255,255,0.6)")).toBe("var(--rc-text-muted)");
    expect(resolveThemeColor("  RGBA(255, 255, 255, 0.60) ")).toBe("var(--rc-text-muted)");
    expect(resolveThemeColor("SecondaryText")).toBe("var(--rc-text-muted)");
    expect(resolveThemeColor("raycast-primary-text")).toBe("var(--rc-text-primary)");
    expect(resolveThemeColor("red")).toBe("var(--rc-error)");
    expect(semanticColorName("raycast-red")).toBe("red");
  });

  it("普通颜色原样返回；空值、非字符串、对象返回空串（由调用方回退为继承色）", () => {
    expect(resolveThemeColor("#ff6b3d")).toBe("#ff6b3d");
    expect(resolveThemeColor("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
    expect(resolveThemeColor("rgba(255, 255, 255, 0.5)")).toBe("rgba(255, 255, 255, 0.5)");
    expect(resolveThemeColor("")).toBe("");
    expect(resolveThemeColor("   ")).toBe("");
    expect(resolveThemeColor(undefined)).toBe("");
    expect(resolveThemeColor(null)).toBe("");
    expect(resolveThemeColor(123)).toBe("");
    expect(resolveThemeColor({ light: "#000", dark: "#fff" })).toBe("");
    expect(semanticColorName("toString")).toBe("");
    expect(semanticColorName("constructor")).toBe("");
  });
});

describe("语义色映射：图标与标签共用同一映射", () => {
  const colors = readColorEnum();

  it("DeclarativeIcon 的 tintColor 属性与 icon 对象里的 tintColor 都走映射", () => {
    const viaProp = mount(DeclarativeIcon, { props: { icon: "terminal", tintColor: colors.SecondaryText } });
    expect(viaProp.attributes("style")).toContain("var(--rc-text-muted)");
    expect(viaProp.attributes("style")).not.toContain("255, 255, 255");

    const viaObject = mount(DeclarativeIcon, { props: { icon: { source: "terminal", tintColor: colors.PrimaryText } } });
    expect(viaObject.attributes("style")).toContain("var(--rc-text-primary)");

    const plain = mount(DeclarativeIcon, { props: { icon: "terminal", tintColor: "#123456" } });
    expect(plain.attributes("style")).toMatch(/#123456|rgb\(18, 52, 86\)/);

    const none = mount(DeclarativeIcon, { props: { icon: { source: "terminal", tintColor: 42 } } });
    expect(none.attributes("style")).toContain("inherit");
  });

  it("列表行图标的 Color.SecondaryText 渲染为主题变量；Color.Red 标签按风险色显示，其他颜色标签保持灰阶", async () => {
    const wrapper = mountView(() =>
      List({}, [
        List.Item({
          id: "a",
          title: "下载",
          icon: { source: Icon.Download, tintColor: colors.SecondaryText },
          accessories: [{ tag: { value: "磁盘将满", color: colors.Red } }, { tag: { value: "镜像", color: colors.Blue } }]
        })
      ])
    );
    await flush();
    const html = wrapper.html();
    expect(html).not.toContain("255, 255, 255, 0.6");
    expect(html).toContain("var(--rc-text-muted)");
    const tags = wrapper.findAll(".decl-acc-tag").filter((s) => ["磁盘将满", "镜像"].includes(s.text()));
    const danger = tags.find((t) => t.text() === "磁盘将满");
    const neutral = tags.find((t) => t.text() === "镜像");
    expect(danger.attributes("style")).toContain("var(--rc-error)");
    expect(neutral.attributes("style")).toContain("var(--rc-text-secondary)");
    expect(neutral.attributes("style")).not.toContain("--rc-h-slate-fg");
  });
});

describe("状态栏摘要与内联指标不用等宽字体", () => {
  it("summaryText 用正文字体并保持数字等宽对齐", async () => {
    const wrapper = mountView(() => List({ filterBar: { summaryText: "共 120 个进程，占用 3.0 GB" } }, [List.Item({ id: "a", title: "x" })]));
    await flush();
    const summary = wrapper.find(".decl-summary-text");
    expect(summary.exists()).toBe(true);
    expect(summary.classes()).not.toContain("font-mono");
    expect(summary.classes()).toContain("tabular-nums");
  });

  it("没有 summaryText 时内联指标同样不用等宽字体", async () => {
    const wrapper = mountView(() =>
      List({ metricGrid: { items: [{ id: "n", label: "进程", value: "120" }] } }, [List.Item({ id: "a", title: "x" })])
    );
    await flush();
    const metrics = wrapper.find(".decl-summary-metrics");
    expect(metrics.exists()).toBe(true);
    expect(metrics.classes()).not.toContain("font-mono");
    expect(metrics.classes()).toContain("tabular-nums");
  });
});

describe("工作台左栏：说明性值换行、标题不被截断", () => {
  const panel = {
    title: "未选择任何视频文件",
    subtitle: "支持 MP4 / MOV / MKV，单次最多 200 个文件",
    fields: [
      { id: "fmt", label: "格式", value: "JPEG / PNG / HEIC 可清除位置信息" },
      { id: "privacy", label: "说明", value: "不处理正文中的个人信息和修订记录" },
      { id: "res", label: "分辨率", value: "1920x1080" },
      { id: "long", label: "路径", value: "/Users/someone/Movies/very-long-folder-name/output" },
      { id: "multi", label: "备注", value: "a\nb" },
      { id: "empty", label: "空值", value: undefined }
    ]
  };

  async function mountPanel() {
    const wrapper = mountView(() => List({ workbenchPanel: panel }, [List.Item({ id: "a", title: "x" })]));
    await flush();
    return wrapper;
  }

  function fieldSpan(wrapper, text) {
    return wrapper.findAll(".decl-field-text, .decl-field-code").find((s) => s.text() === text);
  }

  it("含中文的说明性值用正文字体、允许换行，不截断", async () => {
    const wrapper = await mountPanel();
    for (const text of ["JPEG / PNG / HEIC 可清除位置信息", "不处理正文中的个人信息和修订记录"]) {
      const span = fieldSpan(wrapper, text);
      expect(span, text).toBeTruthy();
      expect(span.classes()).toContain("decl-field-text");
      expect(span.classes()).not.toContain("font-mono");
      expect(span.classes()).not.toContain("truncate");
      expect(span.classes()).toContain("break-words");
    }
  });

  it("短的代码型值保留等宽单行并带完整值提示；超长或多行的值按说明文字处理", async () => {
    const wrapper = await mountPanel();
    const res = fieldSpan(wrapper, "1920x1080");
    expect(res.classes()).toContain("font-mono");
    expect(res.attributes("title")).toBe("1920x1080");

    const longPath = fieldSpan(wrapper, "/Users/someone/Movies/very-long-folder-name/output");
    expect(longPath.classes()).toContain("decl-field-text");

    const multi = fieldSpan(wrapper, "a⏎b");
    expect(multi.classes()).toContain("decl-field-text");

    // 空值不报错，按代码型空串显示
    expect(wrapper.findAll(".decl-field-code").some((s) => s.text() === "")).toBe(true);
  });

  it("卡片标题与副标题分行，标题不加 truncate", async () => {
    const wrapper = await mountPanel();
    const title = wrapper.find(".decl-workbench-title");
    expect(title.text()).toBe("未选择任何视频文件");
    expect(title.classes()).not.toContain("truncate");
    expect(wrapper.find(".decl-workbench-head").classes()).toContain("flex-col");
    expect(wrapper.find(".decl-workbench-subtitle").classes()).not.toContain("font-mono");
  });
});

describe("子页面返回入口只出现一次", () => {
  function Child() {
    return Form({ navigationTitle: "编辑规则" }, []);
  }

  it("push 子页面后：顶部只显示标题，没有返回按钮；底栏有一个“返回 Esc”，点击可返回", async () => {
    let push;
    const wrapper = mountView(() =>
      List({ navigationTitle: "规则列表" }, [
        List.Item({
          id: "a",
          title: "规则 A",
          actions: ActionPanel({}, [Action({ title: "编辑", onAction: () => push(Child) })])
        })
      ])
    );
    push = (c) => wrapper.vm.push(c);
    await flush();
    wrapper.vm.push(Child);
    await flush();

    expect(wrapper.text()).toContain("编辑规则");
    expect(wrapper.text()).not.toContain("后退");
    const backs = wrapper.findAll("[data-decl-back]");
    expect(backs).toHaveLength(1);
    expect(backs[0].text()).toContain("返回");
    // 顶部导航头里没有任何按钮
    const header = wrapper.find(".border-b.bg-\\[var\\(--rc-surface-subtle\\)\\]");
    expect(header.exists()).toBe(true);
    expect(header.findAll("button")).toHaveLength(0);

    await backs[0].trigger("click");
    await flush();
    expect(wrapper.text()).toContain("规则 A");
    expect(wrapper.findAll("[data-decl-back]")).toHaveLength(0);
  });

  it("子页面没有标题时不显示空的导航头，仍可从底栏返回", async () => {
    const wrapper = mountView(() => List({}, [List.Item({ id: "a", title: "根" })]));
    await flush();
    wrapper.vm.push(() => Detail({ markdown: "子页面正文" }));
    await flush();
    expect(wrapper.text()).toContain("子页面正文");
    expect(wrapper.findAll("[data-decl-back]")).toHaveLength(1);
    expect(wrapper.find(".px-4.py-2\\.5.border-b").exists()).toBe(false);
  });
});

describe("List.Item.Detail：正文不被 Metadata 挡住", () => {
  it("正文与 Metadata 位于同一滚动容器，Metadata 不再固定占用底部高度", async () => {
    const md = ["#### 示例", "```bash", "ls -la", "```", "```bash", "du -sh *", "```", "```bash", "find . -name '*.log'", "```"].join("\n");
    const wrapper = mountView(() =>
      List({ isShowingDetail: true }, [
        List.Item({
          id: "ls",
          title: "ls",
          detail: List.Item.Detail({
            markdown: md,
            metadata: List.Item.Detail.Metadata({}, [List.Item.Detail.Metadata.Label({ title: "软件包名", text: "coreutils" })])
          })
        })
      ])
    );
    await flush();
    const scroll = wrapper.find("[data-decl-detail-scroll]");
    expect(scroll.exists()).toBe(true);
    expect(scroll.classes()).toContain("overflow-y-auto");
    expect(scroll.classes()).toContain("min-h-0");

    const body = scroll.find("[data-decl-detail-body]");
    const meta = scroll.find("[data-decl-detail-metadata]");
    expect(body.text()).toContain("find . -name '*.log'");
    expect(meta.text()).toContain("coreutils");
    // 正文在前、Metadata 在后，两者都不再各自滚动或限高
    const children = [...scroll.element.children];
    expect(children.indexOf(body.element)).toBeLessThan(children.indexOf(meta.element));
    for (const el of [body, meta]) {
      expect(el.classes()).not.toContain("overflow-y-auto");
      expect(el.classes().some((c) => c.startsWith("max-h-"))).toBe(false);
    }
  });

  it("没有 Metadata 时只渲染正文", async () => {
    const wrapper = mountView(() =>
      List({ isShowingDetail: true }, [List.Item({ id: "a", title: "a", detail: List.Item.Detail({ markdown: "只有正文" }) })])
    );
    await flush();
    expect(wrapper.find("[data-decl-detail-body]").text()).toContain("只有正文");
    expect(wrapper.find("[data-decl-detail-metadata]").exists()).toBe(false);
  });
});

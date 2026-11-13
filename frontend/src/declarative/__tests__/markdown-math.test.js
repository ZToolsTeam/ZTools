// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { renderMarkdown } from "../markdown.js";
import { typesetMath } from "../math.js";
import DetailRenderer from "../components/DetailRenderer.vue";
import FormRenderer from "../components/FormRenderer.vue";

const until = async (check) => {
  for (let i = 0; i < 50 && !check(); i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("Detail 公式块", () => {
  it("math 围栏输出待排版的源码块，源码先转义；其它语言仍是代码块，空 math 块按代码块显示", () => {
    const html = renderMarkdown("```math\n\\frac{a}{b} <script>\n```\n\n```latex\nx^2\n```\n\n```math\n\n```");
    const host = document.createElement("div");
    host.innerHTML = html;
    const math = host.querySelectorAll("[data-ztools-math]");
    expect(math).toHaveLength(1);
    expect(math[0].textContent).toBe("\\frac{a}{b} <script>");
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelectorAll("pre")).toHaveLength(2);
  });

  it("KaTeX 排版公式；不能排版的 LaTeX 保留源码并标记；不重复排版；已移出页面的块跳过", async () => {
    const detached = document.createElement("div");
    detached.innerHTML = renderMarkdown("```math\nE=mc^{2}\n```");
    expect(await typesetMath(detached)).toBe(0);
    const host = document.body.appendChild(document.createElement("div"));
    host.innerHTML = renderMarkdown("```math\nx=\\frac{-b\\pm\\sqrt{b^{2}-4ac}}{2a}\n```\n\n```math\n\\frac{1}{\n```");
    expect(await typesetMath(host)).toBe(1);
    const [good, bad] = host.querySelectorAll("[data-ztools-math]");
    expect(good.querySelector(".katex-display")).not.toBeNull();
    expect(good.querySelector("math")).not.toBeNull();
    expect(bad.hasAttribute("data-ztools-math-error")).toBe(true);
    expect(bad.textContent).toBe("\\frac{1}{");
    expect(await typesetMath(host)).toBe(0);
    expect(await typesetMath(null)).toBe(0);
    host.remove();
  });

  it("不信任公式里的链接与外部资源命令", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    host.innerHTML = renderMarkdown("```math\n\\href{javascript:alert(1)}{x}+\\includegraphics{https://example.com/a.png}\n```");
    await typesetMath(host);
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    host.remove();
  });

  it("Detail 写入页面后自动排版，内容变化后重新排版", async () => {
    const wrapper = mount(DetailRenderer, {
      attachTo: document.body,
      props: { isListDetail: true, descriptor: { type: "Detail", props: { markdown: "```math\nE=mc^{2}\n```" } } }
    });
    await until(() => wrapper.find(".katex").exists());
    expect(wrapper.find(".katex").exists()).toBe(true);
    await wrapper.setProps({ descriptor: { type: "Detail", props: { markdown: "```math\na^{2}+b^{2}=c^{2}\n```" } } });
    await until(() => wrapper.find("[data-ztools-math-done]").exists());
    expect(wrapper.find("[data-ztools-math]").attributes("data-ztools-math-done")).toBe("");
    expect(wrapper.find(".katex-mathml").text()).toContain("a");
    wrapper.unmount();
  });

  it("表单编辑经真实输入回调更新公式预览，保留焦点；源码与图片地址经过安全渲染", async () => {
    let wrapper;
    const description = (latex) => ({ type: "Form.Description", props: { markdown: `![原图](data:image/png;base64,aGVsbG8=)\n\n\`\`\`math\n${latex}\n\`\`\`` } });
    const descriptor = (latex) => ({ type: "Form", props: {}, children: [
      { type: "Form.TextArea", props: { id: "latex", value: latex, autoFocus: true, onChange: (value) => wrapper.setProps({ descriptor: descriptor(value) }) } },
      description(latex),
      { type: "Form.Description", props: { text: "<script>plain text</script>\n保留换行" } }
    ] });
    wrapper = mount(FormRenderer, { attachTo: document.body, props: { descriptor: descriptor("x^{2}") } });
    try {
      await until(() => wrapper.find(".katex").exists());
      expect(wrapper.find(".katex").exists()).toBe(true);
      expect(wrapper.find("img").attributes("src")).toBe("data:image/png;base64,aGVsbG8=");
      const input = wrapper.find("textarea");
      input.element.focus();
      await input.setValue("\\boldsymbol{y}+\\text{if x > 0}");
      await until(() => wrapper.find(".katex-mathml").text().includes("if x > 0"));
      expect(wrapper.find(".katex-mathml").text()).toContain("if x > 0");
      expect(document.activeElement).toBe(input.element);
      expect(wrapper.find("script").exists()).toBe(false);
      expect(wrapper.text()).toContain("<script>plain text</script>\n保留换行");
      await input.setValue("\\frac{1}{");
      await until(() => wrapper.find("[data-ztools-math-error]").exists());
      expect(wrapper.find("[data-ztools-math-error]").text()).toBe("\\frac{1}{");
      await input.setValue("\\href{javascript:alert(1)}{x}+\\includegraphics{https://example.com/a.png}");
      await until(() => wrapper.find("[data-ztools-math-done]").exists());
      expect(wrapper.findAll("a")).toHaveLength(0);
      expect(wrapper.findAll("img")).toHaveLength(1);
    } finally {
      wrapper.unmount();
    }
  });
});

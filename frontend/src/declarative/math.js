/**
 * Detail 里 ```math 公式块的排版：markdown.js 先输出带 data-ztools-math 的源码块，这里按需加载 KaTeX 排版。
 * KaTeX 只在页面里真的有公式时才加载（不进主包）。安全：trust 关闭（不允许 \href、\url、\includegraphics 等），
 * 限制宏展开与尺寸；排版失败时保留源码原样显示，不报错。
 */

let katexPromise;

function loadKatex() {
  katexPromise ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")])
    .then(([module]) => module.default ?? module)
    .catch((error) => {
      katexPromise = undefined;
      throw error;
    });
  return katexPromise;
}

const OPTIONS = Object.freeze({
  displayMode: true,
  throwOnError: true,
  trust: false,
  strict: "ignore",
  maxExpand: 500,
  maxSize: 20,
  output: "htmlAndMathml"
});

/** 排版 root 里所有未处理的公式块；返回成功排版的块数 */
export async function typesetMath(root) {
  const blocks = root ? [...root.querySelectorAll("[data-ztools-math]:not([data-ztools-math-done])")] : [];
  if (blocks.length === 0) return 0;
  let katex;
  try {
    katex = await loadKatex();
  } catch (error) {
    console.warn("[declarative] 公式排版组件加载失败，显示源码:", error);
    return 0;
  }
  let rendered = 0;
  for (const block of blocks) {
    if (!block.isConnected || block.hasAttribute("data-ztools-math-done")) continue;
    block.setAttribute("data-ztools-math-done", "");
    const source = block.textContent ?? "";
    try {
      const html = katex.renderToString(source, OPTIONS);
      block.innerHTML = html;
      rendered++;
    } catch {
      // 识别出的 LaTeX 不能排版时保留源码，并标记方便样式区分
      block.setAttribute("data-ztools-math-error", "");
    }
  }
  return rendered;
}

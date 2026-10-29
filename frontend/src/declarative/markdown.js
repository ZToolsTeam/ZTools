/**
 * 声明式 Detail 的 Markdown 渲染器（无外部依赖）。
 *
 * 安全模型：每一行先整体做 HTML 转义，之后只生成白名单标签；图片与链接地址只允许白名单协议，
 * 属性值再转义引号。插件与用户的原文一律原样显示（不删 Emoji、不改空白），代码块内容不做任何处理。
 *
 * 支持：围栏代码块（``` 或 ~~~，长度 ≥ 3，结束围栏同字符且不短于开头）、GFM 表格、# 标题、
 * 无序 / 有序 / 任务列表、> 引用（含 GFM 提示块 > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]）、分割线、段落内单换行、行内代码、图片、链接、加粗、斜体、删除线。
 */

// 块级元素的上下间距统一由 declarative-fluent.css 的 .declarative-markdown 规则控制（标题上大下小），这里只写外观
const CLS = {
  pre: "bg-[var(--rc-surface-subtle)] border border-[var(--rc-border)] rounded-lg p-3 font-mono text-xs overflow-x-auto text-[var(--rc-text-primary)] leading-relaxed whitespace-pre-wrap break-words",
  inlineCode: "bg-[var(--rc-surface-active)] px-1.5 py-0.5 rounded text-[var(--rc-text-secondary)] border border-[var(--rc-border)] text-xs font-mono",
  h1: "text-lg font-semibold text-[var(--rc-text-primary)]",
  h2: "text-base font-semibold text-[var(--rc-text-primary)] border-b border-[var(--rc-border)] pb-1.5",
  h3: "text-sm font-semibold text-[var(--rc-text-primary)]",
  hr: "border-t border-[var(--rc-border)]",
  quote: "pl-3 border-l-2 border-[var(--rc-border-highlight)] text-[var(--rc-text-secondary)] italic",
  alert: "pl-3 border-l-2 border-[var(--rc-border-highlight)] text-[var(--rc-text-secondary)]",
  alertTitle: "font-semibold text-[var(--rc-text-primary)] not-italic",
  p: "break-words",
  list: "space-y-1",
  li: "flex items-start gap-2",
  bullet: "text-[var(--rc-text-muted)] select-none flex-shrink-0",
  tableWrap: "overflow-x-auto",
  table: "w-full border-collapse text-xs",
  th: "border border-[var(--rc-border)] bg-[var(--rc-surface-hover)] px-2.5 py-1.5 font-semibold text-[var(--rc-text-primary)]",
  td: "border border-[var(--rc-border)] px-2.5 py-1.5 text-[var(--rc-text-secondary)] align-top",
  strong: "font-semibold text-[var(--rc-text-primary)]",
  link: "text-[var(--rc-text-primary)] underline underline-offset-2",
  imgWrap: "my-2 flex items-center justify-center p-4 bg-[var(--rc-surface-hover)] rounded-xl border border-[var(--rc-border)]",
  img: "max-h-72 object-contain rounded-lg"
};

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return value.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 行内格式；输入为原始文本（未转义） */
function renderInline(raw) {
  const tokens = [];
  const hold = (html) => {
    tokens.push(html);
    return `\u0000${tokens.length - 1}\u0000`;
  };
  let text = escapeHtml(raw);

  // 行内代码先占位：内容原样显示，不参与后续格式化
  text = text.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code class="${CLS.inlineCode}">${code}</code>`));

  // 图片 ![alt](src)：只允许 data:image / https / ztools 协议
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
    const cleanSrc = src.trim();
    if (!/^(data:image\/|https:\/\/|ztools:\/\/)/i.test(cleanSrc.replace(/&amp;/g, "&"))) return match;
    return hold(`<span class="${CLS.imgWrap}"><img src="${escapeAttr(cleanSrc)}" alt="${escapeAttr(alt)}" class="${CLS.img}" /></span>`);
  });

  // 链接 [text](url)：只允许 http(s) / mailto
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => {
    const cleanHref = href.trim();
    if (!/^(https?:\/\/|mailto:)/i.test(cleanHref)) return match;
    return hold(`<a href="${escapeAttr(cleanHref)}" target="_blank" rel="noopener noreferrer" class="${CLS.link}">${label}</a>`);
  });

  // 插件写的 &nbsp; 显示为不换行空格（代码已占位，不受影响）
  text = text.replace(/&amp;nbsp;/g, " ");

  // 加粗、删除线、斜体
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, `<strong class="${CLS.strong}">$1</strong>`);
  text = text.replace(/(^|[^\w])__([^_\n]+?)__(?![\w])/g, `$1<strong class="${CLS.strong}">$2</strong>`);
  text = text.replace(/~~(?!\s)([^~\n]+?)~~/g, "<del>$1</del>");
  text = text.replace(/(^|[^\w*])\*(?![\s*])([^*\n]+?)\*(?![\w*])/g, "$1<em>$2</em>");
  text = text.replace(/(^|[^\w_])_(?![\s_])([^_\n]+?)_(?![\w_])/g, "$1<em>$2</em>");

  return text.replace(/\u0000(\d+)\u0000/g, (_, idx) => tokens[Number(idx)] ?? "");
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const ALERT = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i;
const ALERT_TITLES = { NOTE: "注意", TIP: "提示", IMPORTANT: "重要", WARNING: "警告", CAUTION: "小心" };
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += s[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines, i) {
  const head = lines[i];
  const sep = lines[i + 1];
  if (sep === undefined || !head.includes("|") || !TABLE_SEP.test(sep) || !sep.includes("-")) return false;
  if (!sep.includes("|") && !head.trim().startsWith("|")) return false;
  return splitRow(head).length === splitRow(sep).length;
}

function renderTable(lines, start) {
  const header = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : "";
  });
  const style = (idx) => (aligns[idx] ? ` style="text-align:${aligns[idx]}"` : "");
  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  const th = header.map((c, idx) => `<th class="${CLS.th}"${style(idx)}>${renderInline(c)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${header.map((_, idx) => `<td class="${CLS.td}"${style(idx)}>${renderInline(row[idx] ?? "")}</td>`).join("")}</tr>`)
    .join("");
  return { html: `<div class="${CLS.tableWrap}"><table class="${CLS.table}"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`, next: i };
}

function renderListItem(content, ordered, number) {
  const task = /^\[( |x|X)\]\s+(.*)$/.exec(content);
  if (task && !ordered) {
    const done = task[1] !== " ";
    // 任务框用带边框的方块表示，不用 ☑ / ☐ 字符（会被当成彩色符号渲染）
    const box = `<span class="inline-block w-3 h-3 mt-1 rounded-sm border border-[var(--rc-text-muted)]${done ? " bg-[var(--rc-text-muted)]" : ""}" data-task="${done ? "done" : "todo"}" aria-label="${done ? "已完成" : "未完成"}"></span>`;
    return `<div class="${CLS.li}"><span class="${CLS.bullet}">${box}</span><span class="${done ? "line-through opacity-70" : ""}">${renderInline(task[2])}</span></div>`;
  }
  const marker = ordered ? `${number}.` : "•";
  return `<div class="${CLS.li}"><span class="${CLS.bullet}">${marker}</span><span>${renderInline(content)}</span></div>`;
}

/**
 * 把 Markdown 渲染为安全 HTML 字符串。
 * @param {unknown} markdown
 * @returns {string}
 */
export function renderMarkdown(markdown) {
  if (markdown === undefined || markdown === null || markdown === "") return "";
  // 占位符使用 \u0000，原文里的 \u0000 先替换掉
  const lines = String(markdown).replace(/\u0000/g, "\uFFFD").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p class="${CLS.p}">${paragraph.map(renderInline).join("<br>")}</p>`);
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE_OPEN.exec(line);
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      flushParagraph();
      const marker = fence[1];
      const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // 跳过结束围栏（未闭合时到文末）
      blocks.push(`<pre class="${CLS.pre}"><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      i++;
      continue;
    }

    if (isTableStart(lines, i)) {
      flushParagraph();
      const table = renderTable(lines, i);
      blocks.push(table.html);
      i = table.next;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      const level = Math.min(heading[1].length, 3);
      blocks.push(`<h${level} class="${CLS[`h${level}`]}">${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (HR.test(line)) {
      flushParagraph();
      blocks.push(`<hr class="${CLS.hr}" />`);
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      flushParagraph();
      const raw = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        raw.push(QUOTE.exec(lines[i])[1]);
        i++;
      }
      // GFM 提示块：首行是 [!TIP] 等标记时去掉标记，换成固定的中文小标题（标题是常量，不含插件原文）
      const alert = ALERT.exec(raw[0]);
      const title = alert ? ALERT_TITLES[alert[1].toUpperCase()] : "";
      if (alert) {
        raw[0] = alert[2];
        if (raw[0].trim() === "") raw.shift();
      }
      const quoted = raw.map(renderInline);
      const head = title ? `<strong class="${CLS.alertTitle}">${title}</strong>` : "";
      const sep = head && quoted.length > 0 ? "<br>" : "";
      blocks.push(`<blockquote class="${title ? CLS.alert : CLS.quote}">${head}${sep}${quoted.join("<br>")}</blockquote>`);
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      flushParagraph();
      const items = [];
      while (i < lines.length) {
        const b = BULLET.exec(lines[i]);
        const o = b ? null : ORDERED.exec(lines[i]);
        if (!b && !o) break;
        items.push(b ? renderListItem(b[2], false) : renderListItem(o[3], true, o[2]));
        i++;
      }
      blocks.push(`<div class="${CLS.list}">${items.join("")}</div>`);
      continue;
    }

    paragraph.push(line);
    i++;
  }
  flushParagraph();
  return blocks.join("");
}

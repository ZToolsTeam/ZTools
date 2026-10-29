import { List, ActionPanel, Action, Icon, showToast, Toast, Clipboard, useState, useEffect, confirmAlert } from "@ztools/declarative-ui";
import { parseColor, rgbToOklch, generateColorSwatchSvg, getSavedPalette, saveColorToPalette, clearPalette, removeFromPalette, calculateContrast, evaluateRating, splitColorInputs, generateContrastPreviewSvg } from "./converter.js";
export * from "./converter.js";
/**
 * 颜色详情面板：真实色块 + 无障碍对比度 + 配色方案
 */
function colorDetailMarkdown(color) {
    const h = color.harmonies;
    return [
        `![${displayHex(color)}](${generateColorSwatchSvg(color.hex8)})`,
        "",
        ...(color.hasAlpha ? [`**透明度** ${Math.round(color.alpha * 100)}%（下列对比度按不透明颜色计算）`, ""] : []),
        `**白字对比度** ${color.wcag.contrastOnWhite}:1（${color.wcag.whiteRating}）`,
        "",
        `**黑字对比度** ${color.wcag.contrastOnBlack}:1（${color.wcag.blackRating}）`,
        "",
        `**推荐文字颜色** ${color.wcag.recommendedText === "white" ? "白色" : "黑色"}`,
        "",
        "---",
        "",
        `- 互补色 \`${h.complementary}\``,
        `- 类似色 \`${h.analogous.join("`、`")}\``,
        `- 三色配色 \`${h.triadic.join("`、`")}\``,
        `- 单色渐变 \`${h.monochromatic.join("` → `")}\``
    ].join("\n");
}
const USAGE_MARKDOWN = [
    "**支持的写法**",
    "",
    "- `#0A84FF`、`#0A84FF80`、`#abc`",
    "- `rgb(10, 132, 255)`、`hsl(210, 100%, 52%)`、`hsv(...)`",
    "- `oklch(62.8% 0.2577 29.23)`、`cmyk(96%, 48%, 0%, 0%)`",
    "- 颜色英文名，例如 `orange`"
].join("\n");
const PALETTE_EMPTY_MARKDOWN = "在任一写法上打开动作面板，选「收藏到调色板」即可保存常用颜色。";
function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}
/** macOS 只写 ⌘，Windows 写 Ctrl */
function modKey() {
    const nav = globalThis.navigator;
    return /Mac/i.test(String(nav?.platform || nav?.userAgent || "")) ? "⌘" : "Ctrl";
}
/** 半透明颜色以 8 位 HEX 作为代表写法，否则用 6 位 */
function displayHex(color) {
    return color.hasAlpha ? color.hex8 : color.hex;
}
export function ColorPickerCommand() {
    const [input, setInput] = useState("");
    const [palette, setPalette] = useState([]);
    const [loaded, setLoaded] = useState(false);
    useEffect(() => {
        let cancelled = false;
        getSavedPalette()
            .then((items) => { if (!cancelled)
            setPalette(items); })
            .catch((err) => showToast(Toast.Style.Failure, "读取调色板失败", errorText(err)))
            .finally(() => { if (!cancelled)
            setLoaded(true); });
        return () => { cancelled = true; };
    }, []);
    const trimmed = input.trim();
    const color = trimmed ? parseColor(trimmed) : null;
    const valid = Boolean(color && color.isValid);
    const copy = async (value) => {
        await Clipboard.copy(value);
        await showToast(Toast.Style.Success, `已复制 ${value}`);
    };
    const save = async (c) => {
        try {
            const hex = displayHex(c);
            setPalette(await saveColorToPalette(hex, hex));
            await showToast(Toast.Style.Success, `已收藏 ${hex}`);
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "收藏失败", errorText(err));
        }
    };
    const remove = async (item) => {
        const ok = await confirmAlert({
            title: `从调色板移除 ${item.hex}？`,
            message: "移除后无法恢复。",
            primaryAction: { title: "移除", style: "destructive" },
            dismissAction: { title: "取消" }
        });
        if (!ok)
            return;
        try {
            setPalette(await removeFromPalette(item.id));
            await showToast(Toast.Style.Success, `已移除 ${item.hex}`);
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "移除失败", errorText(err));
        }
    };
    const clearAll = async () => {
        if (palette.length === 0)
            return;
        const ok = await confirmAlert({
            title: `清空调色板中的 ${palette.length} 个颜色？`,
            message: "清空后无法恢复。",
            primaryAction: { title: "清空", style: "destructive" },
            dismissAction: { title: "取消" }
        });
        if (!ok)
            return;
        try {
            await clearPalette();
            setPalette([]);
            await showToast(Toast.Style.Success, "已清空调色板");
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "清空失败", errorText(err));
        }
    };
    const sections = [];
    if (color && valid) {
        const oklch = rgbToOklch(color.rgb);
        const detail = List.Item.Detail({ markdown: colorDetailMarkdown(color) });
        const formats = [
            ["hex", "HEX", color.hex],
            ["rgb", "RGB", color.hasAlpha ? color.cssRgba : color.cssRgb],
            ["hsl", "HSL", color.hasAlpha ? color.cssHsla : color.cssHsl],
            ["oklch", "OKLCH", oklch.css],
            ["hsv", "HSV", color.cssHsv],
            ["cmyk", "CMYK", color.cssCmyk],
            ["hex8", "HEX（含透明度）", color.hex8],
            ["tailwind", "Tailwind 任意值", `bg-[${displayHex(color)}]`],
            ["css-var", "CSS 变量", color.cssVar]
        ];
        sections.push(List.Section({
            title: color.outOfGamut
                ? `${displayHex(color)} 的各种写法（超出 sRGB 色域，已按最接近的颜色换算）`
                : `${displayHex(color)} 的各种写法（按回车复制）`
        }, formats.map(([id, label, value]) => List.Item({
            id: `fmt-${id}`,
            title: value,
            subtitle: label,
            icon: Icon.Brush,
            detail,
            actions: ActionPanel({ title: label }, [
                Action({ title: "复制", icon: Icon.CopyClipboard, onAction: () => copy(value) }),
                Action({ title: "收藏到调色板", icon: Icon.Star, onAction: () => save(color) }),
                Action({ title: "粘贴到当前应用", icon: Icon.Pencil, onAction: async () => { await Clipboard.paste(value); } })
            ])
        }))));
    }
    else if (trimmed) {
        sections.push(List.Section({ title: "无法识别" }, [
            List.Item({
                id: "invalid",
                title: `无法识别「${trimmed}」`,
                subtitle: "支持 #RGB、#RRGGBB、#RRGGBBAA、rgb()、hsl()、hsv()、oklch()、cmyk()、颜色英文名",
                icon: Icon.ExclamationMark,
                detail: List.Item.Detail({ markdown: USAGE_MARKDOWN })
            })
        ]));
    }
    else {
        sections.push(List.Section({ title: "开始" }, [
            List.Item({
                id: "hint",
                title: "在上方输入颜色",
                subtitle: "例如 #0A84FF、rgb(10, 132, 255)、hsl(210, 100%, 52%)、orange",
                icon: Icon.Brush,
                detail: List.Item.Detail({ markdown: USAGE_MARKDOWN })
            })
        ]));
    }
    const q = trimmed.toLowerCase();
    const paletteMatches = palette.filter((p) => !q || valid || p.hex.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
    if (paletteMatches.length > 0) {
        sections.push(List.Section({ title: `调色板（${palette.length}）` }, paletteMatches.map((item) => {
            const c = parseColor(item.hex);
            return List.Item({
                id: item.id,
                title: item.hex,
                subtitle: item.name !== item.hex ? item.name : (c.hasAlpha ? c.cssRgba : c.cssRgb),
                icon: Icon.Star,
                accessories: [{ text: item.savedAt }],
                detail: List.Item.Detail({ markdown: colorDetailMarkdown(c) }),
                actions: ActionPanel({ title: item.hex }, [
                    Action({ title: "复制 HEX", icon: Icon.CopyClipboard, onAction: () => copy(item.hex) }),
                    Action({ title: "查看各种写法", icon: Icon.Eye, onAction: () => setInput(item.hex) }),
                    Action({ title: "从调色板移除", icon: Icon.Trash, onAction: () => remove(item) }),
                    Action({ title: "清空调色板", icon: Icon.Trash, onAction: clearAll })
                ])
            });
        })));
    }
    else if (loaded && palette.length === 0 && valid) {
        sections.push(List.Section({ title: "调色板" }, [
            List.Item({
                id: "palette-empty",
                title: "调色板还是空的",
                subtitle: `在上面任一写法上按 ${modKey()}+Enter 收藏到调色板`,
                icon: Icon.Star,
                detail: List.Item.Detail({ markdown: PALETTE_EMPTY_MARKDOWN })
            })
        ]));
    }
    return List({
        navigationTitle: "调色板与色彩转换",
        // 没有可展示的颜色时不开右侧详情栏，避免整块空白
        isShowingDetail: valid || paletteMatches.length > 0,
        searchBarPlaceholder: "输入颜色：#0A84FF、rgb(10, 132, 255)、hsl(210, 100%, 52%)…",
        searchText: input,
        onSearchTextChange: (val) => setInput(val)
    }, sections);
}
const RATING_TEXT = {
    AAA: "AAA 通过",
    AA: "AA 通过",
    "AA Large": "仅大字 AA 通过",
    Fail: "不通过"
};
function contrastMarkdown(fg, bg, ratio) {
    const pass = (ok) => (ok ? "通过" : "不通过");
    return [
        `![${displayHex(fg)} / ${displayHex(bg)}](${generateContrastPreviewSvg(fg.hex, bg.hex)})`,
        "",
        `**对比度** ${ratio}:1`,
        "",
        `- 正文 AA（≥ 4.5:1）：${pass(ratio >= 4.5)}`,
        `- 正文 AAA（≥ 7:1）：${pass(ratio >= 7)}`,
        `- 大字 AA（≥ 3:1，18pt 或 14pt 粗体以上）：${pass(ratio >= 3)}`,
        `- 大字 AAA（≥ 4.5:1）：${pass(ratio >= 4.5)}`,
        "",
        ...(fg.hasAlpha || bg.hasAlpha ? ["> 含透明度的颜色按不透明颜色计算。", ""] : []),
        `前景色 \`${displayHex(fg)}\`，背景色 \`${displayHex(bg)}\``
    ].join("\n");
}
const CONTRAST_USAGE_MARKDOWN = [
    "**输入两种颜色**：前景色（文字）在前，背景色在后，用空格分隔。",
    "",
    "- `#333333 #FFFFFF`",
    "- `rgb(10, 132, 255) on white`",
    "",
    "只输入一种颜色时，分别计算它在白色与黑色背景上的对比度。"
].join("\n");
/** WCAG 对比度检测：前景色与背景色两种颜色之间的对比度 */
export function ContrastCheckCommand() {
    const [input, setInput] = useState("");
    const parts = splitColorInputs(input.trim());
    const colors = parts.slice(0, 2).map((part) => parseColor(part));
    const invalidPart = parts.find((part, index) => index < 2 && !colors[index].isValid);
    const copy = async (value) => {
        await Clipboard.copy(value);
        await showToast(Toast.Style.Success, `已复制 ${value}`);
    };
    const pairItem = (id, fg, bg, title) => {
        const ratio = calculateContrast(fg.rgb, bg.rgb);
        const ratioText = `${ratio}:1`;
        return List.Item({
            id,
            title,
            subtitle: `对比度 ${ratioText}`,
            icon: Icon.Eye,
            accessories: [{ text: RATING_TEXT[evaluateRating(ratio)] }],
            detail: List.Item.Detail({ markdown: contrastMarkdown(fg, bg, ratio) }),
            actions: ActionPanel({ title }, [
                Action({ title: "复制对比度", icon: Icon.CopyClipboard, onAction: () => copy(ratioText) }),
                Action({
                    title: "交换前景色与背景色",
                    icon: Icon.ArrowClockwise,
                    onAction: () => setInput(`${displayHex(bg)} ${displayHex(fg)}`)
                })
            ])
        });
    };
    let sections;
    let showDetail = true;
    if (parts.length > 2) {
        showDetail = false;
        sections = [List.Section({ title: "无法计算" }, [List.Item({
                    id: "too-many",
                    title: "只能比较两种颜色",
                    subtitle: `已输入 ${parts.length} 段，请保留前景色和背景色两种`,
                    icon: Icon.ExclamationMark
                })])];
    }
    else if (invalidPart) {
        showDetail = false;
        sections = [List.Section({ title: "无法识别" }, [List.Item({
                    id: "invalid",
                    title: `无法识别「${invalidPart}」`,
                    subtitle: "支持 #RGB、#RRGGBB、rgb()、hsl()、hsv()、oklch()、cmyk()、颜色英文名",
                    icon: Icon.ExclamationMark
                })])];
    }
    else if (colors.length === 2) {
        sections = [List.Section({ title: "前景色与背景色" }, [
                pairItem("pair", colors[0], colors[1], `${displayHex(colors[0])} 在 ${displayHex(colors[1])} 上`)
            ])];
    }
    else if (colors.length === 1) {
        const white = parseColor("#FFFFFF");
        const black = parseColor("#000000");
        const fg = colors[0];
        sections = [List.Section({ title: `${displayHex(fg)} 作为文字颜色（再输入一种颜色可指定背景）` }, [
                pairItem("on-white", fg, white, "在白色背景上"),
                pairItem("on-black", fg, black, "在黑色背景上")
            ])];
    }
    else {
        sections = [List.Section({ title: "开始" }, [List.Item({
                    id: "hint",
                    title: "输入前景色和背景色",
                    subtitle: "例如 #333333 #FFFFFF",
                    icon: Icon.Eye,
                    detail: List.Item.Detail({ markdown: CONTRAST_USAGE_MARKDOWN })
                })])];
    }
    return List({
        navigationTitle: "对比度检测",
        isShowingDetail: showDetail,
        searchBarPlaceholder: "前景色 背景色，例如 #333333 #FFFFFF",
        searchText: input,
        onSearchTextChange: (val) => setInput(val)
    }, sections);
}
export const commands = {
    "convert-color": ColorPickerCommand,
    "contrast-check": ContrastCheckCommand
};
export default ColorPickerCommand;

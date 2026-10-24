import { List, ActionPanel, Action, Icon, showToast, Toast, Clipboard, useState, useEffect, confirmAlert } from "@ztools/declarative-ui";
import { parseColor, rgbToOklch, generateColorSwatchSvg, getSavedPalette, saveColorToPalette, clearPalette, removeFromPalette } from "./converter.js";
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
            .catch((err) => showToast(Toast.Style.Failure, "读取调色板失败", err?.message || String(err)))
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
            await showToast(Toast.Style.Failure, "收藏失败", err?.message || String(err));
        }
    };
    const remove = async (item) => {
        try {
            setPalette(await removeFromPalette(item.id));
            await showToast(Toast.Style.Success, `已移除 ${item.hex}`);
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "移除失败", err?.message || String(err));
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
            await showToast(Toast.Style.Failure, "清空失败", err?.message || String(err));
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
                detail: List.Item.Detail({ markdown: "" })
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
                detail: List.Item.Detail({ markdown: "" })
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
                subtitle: "在上面任一写法上按 Ctrl+K，选「收藏到调色板」",
                icon: Icon.Star,
                detail: List.Item.Detail({ markdown: "" })
            })
        ]));
    }
    return List({
        navigationTitle: "调色板与色彩转换",
        isShowingDetail: true,
        searchBarPlaceholder: "输入颜色：#0A84FF、rgb(10, 132, 255)、hsl(210, 100%, 52%)…",
        searchText: input,
        onSearchTextChange: (val) => setInput(val)
    }, sections);
}
export default ColorPickerCommand;

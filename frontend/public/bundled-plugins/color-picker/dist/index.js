import { List, ActionPanel, Action, Icon, showToast, Toast, Clipboard, useState, useEffect, useLocale, confirmAlert } from "@ztools/declarative-ui";
import { t } from "./i18n.js";
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
        ...(color.hasAlpha ? [t("detailAlpha", { alpha: Math.round(color.alpha * 100) }), ""] : []),
        t("detailWhiteContrast", { ratio: color.wcag.contrastOnWhite, rating: color.wcag.whiteRating }),
        "",
        t("detailBlackContrast", { ratio: color.wcag.contrastOnBlack, rating: color.wcag.blackRating }),
        "",
        t("detailRecommendedText", { color: color.wcag.recommendedText === "white" ? t("colorWhite") : t("colorBlack") }),
        "",
        "---",
        "",
        t("harmonyComplementary", { val: h.complementary }),
        t("harmonyAnalogous", { val: h.analogous.join("`, `") }),
        t("harmonyTriadic", { val: h.triadic.join("`, `") }),
        t("harmonyMonochromatic", { val: h.monochromatic.join("` → `") })
    ].join("\n");
}
function usageMarkdown() {
    return [
        t("usageTitle"),
        "",
        "- `#0A84FF`, `#0A84FF80`, `#abc`",
        "- `rgb(10, 132, 255)`, `hsl(210, 100%, 52%)`, `hsv(...)`",
        "- `oklch(62.8% 0.2577 29.23)`, `cmyk(96%, 48%, 0%, 0%)`",
        t("usageNamed")
    ].join("\n");
}
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
    useLocale();
    const [input, setInput] = useState("");
    const [palette, setPalette] = useState([]);
    const [loaded, setLoaded] = useState(false);
    useEffect(() => {
        let cancelled = false;
        getSavedPalette()
            .then((items) => { if (!cancelled)
            setPalette(items); })
            .catch((err) => showToast(Toast.Style.Failure, t("readPaletteFailed"), errorText(err)))
            .finally(() => { if (!cancelled)
            setLoaded(true); });
        return () => { cancelled = true; };
    }, []);
    const trimmed = input.trim();
    const color = trimmed ? parseColor(trimmed) : null;
    const valid = Boolean(color && color.isValid);
    const copy = async (value) => {
        await Clipboard.copy(value);
        await showToast(Toast.Style.Success, t("copiedToast", { val: value }));
    };
    const save = async (c) => {
        try {
            const hex = displayHex(c);
            setPalette(await saveColorToPalette(hex, hex));
            await showToast(Toast.Style.Success, t("savedToast", { hex }));
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t("saveFailed"), errorText(err));
        }
    };
    const remove = async (item) => {
        const ok = await confirmAlert({
            title: t("removeConfirmTitle", { hex: item.hex }),
            message: t("removeConfirmMsg"),
            primaryAction: { title: t("removeConfirmBtn"), style: "destructive" },
            dismissAction: { title: t("cancel") }
        });
        if (!ok)
            return;
        try {
            setPalette(await removeFromPalette(item.id));
            await showToast(Toast.Style.Success, t("removedToast", { hex: item.hex }));
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t("removeFailed"), errorText(err));
        }
    };
    const clearAll = async () => {
        if (palette.length === 0)
            return;
        const ok = await confirmAlert({
            title: t("clearConfirmTitle", { count: palette.length }),
            message: t("clearConfirmMsg"),
            primaryAction: { title: t("clearConfirmBtn"), style: "destructive" },
            dismissAction: { title: t("cancel") }
        });
        if (!ok)
            return;
        try {
            await clearPalette();
            setPalette([]);
            await showToast(Toast.Style.Success, t("clearedToast"));
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t("clearFailed"), errorText(err));
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
            ["hex8", t("fmtHex8"), color.hex8],
            ["tailwind", t("fmtTailwind"), `bg-[${displayHex(color)}]`],
            ["css-var", t("fmtCssVar"), color.cssVar]
        ];
        sections.push(List.Section({
            title: color.outOfGamut
                ? t("sectionFormatsOutOfGamut", { hex: displayHex(color) })
                : t("sectionFormats", { hex: displayHex(color) })
        }, formats.map(([id, label, value]) => List.Item({
            id: `fmt-${id}`,
            title: value,
            subtitle: label,
            icon: Icon.Brush,
            detail,
            actions: ActionPanel({ title: label }, [
                Action({ title: t("copyAction"), icon: Icon.CopyClipboard, onAction: () => copy(value) }),
                Action({ title: t("saveToPaletteAction"), icon: Icon.Star, onAction: () => save(color) }),
                Action({ title: t("pasteToActiveAction"), icon: Icon.Pencil, onAction: async () => { await Clipboard.paste(value); } })
            ])
        }))));
    }
    else if (trimmed) {
        sections.push(List.Section({ title: t("sectionInvalid") }, [
            List.Item({
                id: "invalid",
                title: t("invalidTitle", { input: trimmed }),
                subtitle: t("invalidSub"),
                icon: Icon.ExclamationMark,
                detail: List.Item.Detail({ markdown: usageMarkdown() })
            })
        ]));
    }
    else {
        sections.push(List.Section({ title: t("sectionStart") }, [
            List.Item({
                id: "hint",
                title: t("hintTitle"),
                subtitle: t("hintSub"),
                icon: Icon.Brush,
                detail: List.Item.Detail({ markdown: usageMarkdown() })
            })
        ]));
    }
    const q = trimmed.toLowerCase();
    const paletteMatches = palette.filter((p) => !q || valid || p.hex.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
    if (paletteMatches.length > 0) {
        sections.push(List.Section({ title: t("sectionPaletteCount", { count: palette.length }) }, paletteMatches.map((item) => {
            const c = parseColor(item.hex);
            return List.Item({
                id: item.id,
                title: item.hex,
                subtitle: item.name !== item.hex ? item.name : (c.hasAlpha ? c.cssRgba : c.cssRgb),
                icon: Icon.Star,
                accessories: [{ text: item.savedAt }],
                detail: List.Item.Detail({ markdown: colorDetailMarkdown(c) }),
                actions: ActionPanel({ title: item.hex }, [
                    Action({ title: t("copyHexAction"), icon: Icon.CopyClipboard, onAction: () => copy(item.hex) }),
                    Action({ title: t("viewFormatsAction"), icon: Icon.Eye, onAction: () => setInput(item.hex) }),
                    Action({ title: t("removeFromPaletteAction"), icon: Icon.Trash, onAction: () => remove(item) }),
                    Action({ title: t("clearPaletteAction"), icon: Icon.Trash, onAction: clearAll })
                ])
            });
        })));
    }
    else if (loaded && palette.length === 0 && valid) {
        sections.push(List.Section({ title: t("sectionPalette") }, [
            List.Item({
                id: "palette-empty",
                title: t("paletteEmptyTitle"),
                subtitle: t("paletteEmptySub", { mod: modKey() }),
                icon: Icon.Star,
                detail: List.Item.Detail({ markdown: t("paletteEmptyMd") })
            })
        ]));
    }
    return List({
        navigationTitle: t("navTitle"),
        // 没有可展示的颜色时不开右侧详情栏，避免整块空白
        isShowingDetail: valid || paletteMatches.length > 0,
        searchBarPlaceholder: t("searchPlaceholder"),
        searchText: input,
        onSearchTextChange: (val) => setInput(val)
    }, sections);
}
function ratingLabel(rating) {
    switch (rating) {
        case "AAA": return t("ratingAAA");
        case "AA": return t("ratingAA");
        case "AA Large": return t("ratingAALarge");
        default: return t("ratingFail");
    }
}
function contrastMarkdown(fg, bg, ratio) {
    const pass = (ok) => (ok ? t("pass") : t("fail"));
    return [
        `![${displayHex(fg)} / ${displayHex(bg)}](${generateContrastPreviewSvg(fg.hex, bg.hex)})`,
        "",
        t("contrastRatioMd", { ratio }),
        "",
        t("contrastBodyAA", { status: pass(ratio >= 4.5) }),
        t("contrastBodyAAA", { status: pass(ratio >= 7) }),
        t("contrastLargeAA", { status: pass(ratio >= 3) }),
        t("contrastLargeAAA", { status: pass(ratio >= 4.5) }),
        "",
        ...(fg.hasAlpha || bg.hasAlpha ? [t("contrastAlphaNote"), ""] : []),
        t("contrastColorsNote", { fg: displayHex(fg), bg: displayHex(bg) })
    ].join("\n");
}
function contrastUsageMarkdown() {
    return [
        t("contrastUsageLine1"),
        "",
        "- `#333333 #FFFFFF`",
        "- `rgb(10, 132, 255) on white`",
        "",
        t("contrastUsageLine2")
    ].join("\n");
}
/** WCAG 对比度检测：前景色与背景色两种颜色之间的对比度 */
export function ContrastCheckCommand() {
    useLocale();
    const [input, setInput] = useState("");
    const parts = splitColorInputs(input.trim());
    const colors = parts.slice(0, 2).map((part) => parseColor(part));
    const invalidPart = parts.find((part, index) => index < 2 && !colors[index].isValid);
    const copy = async (value) => {
        await Clipboard.copy(value);
        await showToast(Toast.Style.Success, t("copiedToast", { val: value }));
    };
    const pairItem = (id, fg, bg, title) => {
        const ratio = calculateContrast(fg.rgb, bg.rgb);
        const ratioText = `${ratio}:1`;
        return List.Item({
            id,
            title,
            subtitle: t("contrastSub", { ratio: ratioText }),
            icon: Icon.Eye,
            accessories: [{ text: ratingLabel(evaluateRating(ratio)) }],
            detail: List.Item.Detail({ markdown: contrastMarkdown(fg, bg, ratio) }),
            actions: ActionPanel({ title }, [
                Action({ title: t("copyContrastAction"), icon: Icon.CopyClipboard, onAction: () => copy(ratioText) }),
                Action({
                    title: t("swapColorsAction"),
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
        sections = [List.Section({ title: t("sectionTooMany") }, [List.Item({
                    id: "too-many",
                    title: t("tooManyTitle"),
                    subtitle: t("tooManySub", { count: parts.length }),
                    icon: Icon.ExclamationMark
                })])];
    }
    else if (invalidPart) {
        showDetail = false;
        sections = [List.Section({ title: t("sectionInvalid") }, [List.Item({
                    id: "invalid",
                    title: t("invalidTitle", { input: invalidPart }),
                    subtitle: t("contrastInvalidSub"),
                    icon: Icon.ExclamationMark
                })])];
    }
    else if (colors.length === 2) {
        sections = [List.Section({ title: t("sectionPair") }, [
                pairItem("pair", colors[0], colors[1], t("pairTitle", { fg: displayHex(colors[0]), bg: displayHex(colors[1]) }))
            ])];
    }
    else if (colors.length === 1) {
        const white = parseColor("#FFFFFF");
        const black = parseColor("#000000");
        const fg = colors[0];
        sections = [List.Section({ title: t("sectionSingle", { fg: displayHex(fg) }) }, [
                pairItem("on-white", fg, white, t("onWhiteTitle")),
                pairItem("on-black", fg, black, t("onBlackTitle"))
            ])];
    }
    else {
        sections = [List.Section({ title: t("sectionStart") }, [List.Item({
                    id: "hint",
                    title: t("contrastHintTitle"),
                    subtitle: t("contrastHintSub"),
                    icon: Icon.Eye,
                    detail: List.Item.Detail({ markdown: contrastUsageMarkdown() })
                })])];
    }
    return List({
        navigationTitle: t("contrastNavTitle"),
        isShowingDetail: showDetail,
        searchBarPlaceholder: t("contrastSearchPlaceholder"),
        searchText: input,
        onSearchTextChange: (val) => setInput(val)
    }, sections);
}
export const commands = {
    "convert-color": ColorPickerCommand,
    "contrast-check": ContrastCheckCommand
};
export default ColorPickerCommand;

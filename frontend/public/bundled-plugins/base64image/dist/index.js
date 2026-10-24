import { List, ActionPanel, Action, Icon, showToast, Toast, Clipboard, useState, useRef } from "@ztools/declarative-ui";
import { parseBase64Image, encodeSvgOrTextToBase64, isSvgSource, SAMPLE_PNG_DATA_URI } from "./logic.js";
import { pickImageFile, readClipboardImage, readClipboardImageFile } from "./host.js";
export default function Base64ImageCommand() {
    const [inputText, setInputText] = useState("");
    const [loaded, setLoaded] = useState(null);
    const [busy, setBusy] = useState(false);
    // 渲染闭包里的 busy 可能是旧值，用 ref 做真正的互斥
    const busyRef = useRef(false);
    const source = loaded ? loaded.dataUri : inputText.trim();
    let parsed = { valid: false };
    if (source) {
        parsed = isSvgSource(source) || /^<\?xml/i.test(source)
            ? encodeSvgOrTextToBase64(source)
            : parseBase64Image(source);
    }
    const handleCopy = async (content, label) => {
        await Clipboard.copy(content);
        await showToast(Toast.Style.Success, `已复制 ${label}`);
    };
    // 校验图片格式后展示
    const showImage = async (image) => {
        const check = parseBase64Image(image.base64);
        if (!check.valid || !check.dataUri) {
            await showToast(Toast.Style.Failure, "不是支持的图片", check.error);
            return;
        }
        setLoaded({ name: image.name, dataUri: check.dataUri });
        setInputText("");
        await showToast(Toast.Style.Success, `已转换 ${image.name}`, check.formattedSize);
    };
    // 读取期间加锁，避免连按触发并发读取
    const runExclusive = async (task) => {
        if (busyRef.current)
            return;
        busyRef.current = true;
        setBusy(true);
        try {
            await task();
        }
        finally {
            busyRef.current = false;
            setBusy(false);
        }
    };
    const handlePickFile = () => runExclusive(async () => {
        try {
            const image = await pickImageFile();
            if (image)
                await showImage(image);
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "读取图片失败", err?.message || String(err));
        }
    });
    // 剪贴板读取顺序：复制的图片文件（保留原文件字节）→ 图片（截图）→ 文字（Base64 / Data URL / SVG 源码）。
    // 读文件或图片出错时直接提示真实原因，不再落到“没有图片或文字”。
    const handlePaste = () => runExclusive(async () => {
        let image;
        try {
            image = await readClipboardImageFile();
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "读取复制的图片文件失败", err?.message || String(err));
            return;
        }
        if (!image) {
            try {
                image = await readClipboardImage();
            }
            catch (err) {
                // 截图 / 复制的图片会被系统重新编码成 PNG，体积可能远大于原文件，原文件可改用选择文件
                const detail = err?.message || String(err);
                await showToast(Toast.Style.Failure, "读取剪贴板图片失败", err?.code === "FILE_TOO_LARGE" ? `${detail}；原图文件可改用「选择图片文件」` : detail);
                return;
            }
        }
        if (image) {
            await showImage(image);
            return;
        }
        try {
            const text = await Clipboard.readText();
            if (text && text.trim()) {
                setLoaded(null);
                setInputText(text.trim());
                return;
            }
            await showToast(Toast.Style.Failure, "剪贴板里没有图片或文字");
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "读取剪贴板失败", err?.message || String(err));
        }
    });
    const clearAll = () => {
        setLoaded(null);
        setInputText("");
    };
    const sourceActions = [
        Action({ title: "选择图片文件…", icon: Icon.Image, onAction: handlePickFile }),
        Action({ title: "粘贴剪贴板图片或文字", icon: Icon.CopyClipboard, onAction: handlePaste }),
        Action({ title: "清空", icon: Icon.Trash, onAction: clearAll })
    ];
    const previewDetail = parsed.valid && parsed.dataUri && parsed.format
        ? List.Item.Detail({
            markdown: `![preview](${parsed.dataUri})\n\n**${loaded ? loaded.name : "输入内容"}**\n\n- 格式：${parsed.format.toUpperCase()}（${parsed.mimeType}）\n- 原始大小：${parsed.formattedSize}\n- Base64 长度：${parsed.base64Length} 字符`
        })
        : undefined;
    const exportItem = (id, title, value, label, icon) => value
        ? List.Item({
            id,
            title,
            subtitle: value.length > 60 ? value.slice(0, 60) + "…" : value,
            icon,
            detail: previewDetail,
            actions: ActionPanel({ title: label }, [
                Action({ title: `复制${label}`, icon: Icon.CopyClipboard, onAction: () => handleCopy(value, label) }),
                ...sourceActions
            ])
        })
        : null;
    let sections;
    if (parsed.valid) {
        sections = [
            List.Section({ title: loaded ? `已载入 ${loaded.name}` : "转换结果（按回车复制）" }, [
                exportItem("export-datauri", "Data URL", parsed.dataUri, " Data URL", Icon.Globe),
                exportItem("export-raw-base64", "纯 Base64", parsed.encoded, "纯 Base64", Icon.Terminal),
                exportItem("export-markdown", "Markdown", parsed.markdown, " Markdown", Icon.Document),
                exportItem("export-html", "HTML <img>", parsed.html, " HTML", Icon.Code),
                exportItem("export-css", "CSS 背景图", parsed.cssBackground, " CSS", Icon.Brush)
            ].filter(Boolean))
        ];
    }
    else if (source) {
        sections = [
            List.Section({ title: "无法识别" }, [
                List.Item({
                    id: "item-error",
                    title: parsed.error || "无法识别的内容",
                    subtitle: "支持：图片文件、截图、Base64 字符串、data:image/... 链接、SVG 源码",
                    icon: Icon.ExclamationMark,
                    actions: ActionPanel({ title: "操作" }, sourceActions)
                })
            ])
        ];
    }
    else {
        sections = [
            List.Section({ title: "开始" }, [
                List.Item({
                    id: "start-pick",
                    title: busy ? "正在读取…" : "选择图片文件，转成 Base64",
                    subtitle: "PNG、JPG、GIF、WebP、SVG，单张不超过 10 MB",
                    icon: Icon.Image,
                    actions: ActionPanel({ title: "开始" }, sourceActions)
                }),
                List.Item({
                    id: "start-paste",
                    title: "粘贴截图或复制的图片",
                    subtitle: "也可以粘贴 Base64 字符串，还原成图片",
                    icon: Icon.CopyClipboard,
                    actions: ActionPanel({ title: "开始" }, [sourceActions[1], sourceActions[0]])
                }),
                List.Item({
                    id: "start-sample",
                    title: "看一个示例",
                    subtitle: "载入一张 1×1 的示例 PNG",
                    icon: Icon.Eye,
                    actions: ActionPanel({ title: "示例" }, [
                        Action({ title: "载入示例", icon: Icon.Eye, onAction: () => { setLoaded({ name: "示例 PNG", dataUri: SAMPLE_PNG_DATA_URI }); setInputText(""); } })
                    ])
                })
            ])
        ];
    }
    return List({
        navigationTitle: "Base64 图片编解码",
        isLoading: busy,
        isShowingDetail: Boolean(previewDetail),
        searchBarPlaceholder: "粘贴 Base64 / Data URL / SVG 源码，或按回车选择图片文件…",
        searchText: inputText,
        onSearchTextChange: (text) => {
            setInputText(text);
            if (text)
                setLoaded(null);
        },
        actions: ActionPanel({ title: "全局操作" }, sourceActions)
    }, sections);
}

import { List, Form, ActionPanel, Action, Icon, Clipboard, showToast, Toast, useState, useEffect, useNavigation, confirmAlert } from "@ztools/declarative-ui";
import { generateQrSvg, generateQrPngBase64, detectQrContentType, buildWifiPayload, getQrHistory, saveQrItem, toggleFavoriteQrItem, deleteQrItem, clearQrHistory } from "./qr-generator.js";
import { copyPngToClipboard, savePngFile } from "./host.js";
export * from "./qr-generator.js";
const LEVEL_LABEL = { L: "低（7%）", M: "中（15%）", Q: "较高（25%）", H: "高（30%）" };
/**
 * 预览缓存（LRU）：key = 纠错等级 + 内容。每次渲染都会为所有匹配的历史项生成预览，
 * 历史最多 100 条，不缓存时每次按键都要把它们全部重新编码。
 * 条数上限覆盖满额历史 + 最近输入；字符预算防止大量第 40 版大码占满内存。
 */
const PREVIEW_CACHE_MAX_ENTRIES = 160;
const PREVIEW_CACHE_MAX_CHARS = 16 * 1024 * 1024;
const previewCache = new Map();
let previewCacheChars = 0;
const previewSize = (p) => (p.ok ? p.markdown.length : p.error.length);
export function previewMarkdown(content, lv) {
    const key = `${lv}\u0000${content}`;
    const hit = previewCache.get(key);
    if (hit) {
        // 命中后移到队尾，保持最近使用顺序
        previewCache.delete(key);
        previewCache.set(key, hit);
        return hit;
    }
    let result;
    try {
        const { dataUrl, qr } = generateQrSvg(content, lv);
        result = {
            ok: true,
            markdown: `![二维码](${dataUrl})\n\n${detectQrContentType(content).label} · ${new TextEncoder().encode(content).length} 字节 · 版本 ${qr.version}（${qr.size}×${qr.size}）· 纠错 ${LEVEL_LABEL[lv]}`
        };
    }
    catch (err) {
        result = { ok: false, error: err?.message || String(err) };
    }
    previewCache.set(key, result);
    previewCacheChars += previewSize(result);
    // 至少保留刚放入的这一条
    while (previewCache.size > 1 && (previewCache.size > PREVIEW_CACHE_MAX_ENTRIES || previewCacheChars > PREVIEW_CACHE_MAX_CHARS)) {
        const [oldestKey, oldest] = previewCache.entries().next().value;
        previewCache.delete(oldestKey);
        previewCacheChars -= previewSize(oldest);
    }
    return result;
}
/** 仅供测试：查看与清空预览缓存 */
export function getPreviewCacheStats() {
    return { entries: previewCache.size, chars: previewCacheChars };
}
export function resetPreviewCache() {
    previewCache.clear();
    previewCacheChars = 0;
}
function newItem(content, level, title) {
    return {
        id: `qr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        title: title || content.slice(0, 40),
        content,
        level,
        createdAt: new Date().toLocaleString()
    };
}
/**
 * Wi-Fi 二维码表单：手机扫码即可连接
 */
export function WifiQrForm({ onCreated }) {
    const { pop } = useNavigation();
    const [ssid, setSsid] = useState("");
    const [password, setPassword] = useState("");
    const [security, setSecurity] = useState("WPA");
    const [hidden, setHidden] = useState(false);
    const [error, setError] = useState(undefined);
    const submit = async () => {
        let payload;
        try {
            payload = buildWifiPayload(ssid.trim(), password, security, hidden);
        }
        catch (err) {
            setError(err?.message);
            return;
        }
        if (await onCreated(newItem(payload, "M", `Wi-Fi：${ssid.trim()}`)))
            pop();
    };
    return Form({
        navigationTitle: "Wi-Fi 二维码",
        actions: ActionPanel({ title: "Wi-Fi" }, [
            Action.SubmitForm({ title: "生成并保存", icon: Icon.Check, onSubmit: submit }),
            Action({ title: "返回", icon: Icon.ArrowLeft, onAction: () => pop() })
        ])
    }, [
        Form.TextField({ id: "ssid", title: "Wi-Fi 名称", placeholder: "区分大小写", value: ssid, error, onChange: (v) => { setSsid(v); setError(undefined); } }),
        Form.PasswordField({ id: "password", title: "密码", placeholder: "无密码网络可留空", value: password, onChange: (v) => { setPassword(v); setError(undefined); } }),
        Form.Dropdown({ id: "security", title: "加密方式", value: security, onChange: (v) => setSecurity(v) }, [
            Form.Dropdown.Item({ title: "WPA / WPA2 / WPA3", value: "WPA" }),
            Form.Dropdown.Item({ title: "WEP", value: "WEP" }),
            Form.Dropdown.Item({ title: "无密码", value: "nopass" })
        ]),
        Form.Checkbox({ id: "hidden", label: "隐藏网络（不广播名称）", value: hidden, onChange: (v) => setHidden(v) })
    ]);
}
export default function QrCodeCommand() {
    const [searchText, setSearchText] = useState("");
    const [level, setLevel] = useState("M");
    const [history, setHistory] = useState([]);
    const [loaded, setLoaded] = useState(false);
    const { push } = useNavigation();
    useEffect(() => {
        let cancelled = false;
        getQrHistory()
            .then((items) => { if (!cancelled)
            setHistory(items); })
            .catch((err) => showToast(Toast.Style.Failure, "读取历史失败", err?.message || String(err)))
            .finally(() => { if (!cancelled)
            setLoaded(true); });
        return () => { cancelled = true; };
    }, []);
    const run = async (fn, success) => {
        try {
            setHistory(await fn());
            if (success)
                await showToast(Toast.Style.Success, success);
            return true;
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "保存失败", err?.message || String(err));
            return false;
        }
    };
    const copyImage = async (content, lv, remember) => {
        try {
            await copyPngToClipboard(generateQrPngBase64(content, lv));
            await showToast(Toast.Style.Success, "已复制二维码图片", "可以直接粘贴到聊天或文档里");
            if (remember)
                await run(() => saveQrItem(newItem(content, lv)), "");
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "复制图片失败", err?.message || String(err));
        }
    };
    const saveFile = async (content, lv) => {
        try {
            const path = await savePngFile(generateQrPngBase64(content, lv), "qrcode.png");
            if (path)
                await showToast(Toast.Style.Success, "已保存", path);
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "保存图片失败", err?.message || String(err));
        }
    };
    const fromClipboard = async () => {
        const text = (await Clipboard.readText()).trim();
        if (!text) {
            await showToast(Toast.Style.Failure, "剪贴板里没有文字");
            return;
        }
        setSearchText(text);
    };
    const openWifiForm = () => push(() => WifiQrForm({ onCreated: (item) => run(() => saveQrItem(item), "已生成 Wi-Fi 二维码") }));
    const clearAll = async () => {
        const ok = await confirmAlert({
            title: `清空 ${history.length} 条二维码历史？`,
            message: "收藏的也会一起清空，无法恢复。",
            primaryAction: { title: "清空", style: "destructive" },
            dismissAction: { title: "取消" }
        });
        if (!ok)
            return;
        try {
            await clearQrHistory();
            setHistory([]);
            await showToast(Toast.Style.Success, "已清空历史");
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "清空失败", err?.message || String(err));
        }
    };
    // 生成预览；内容超出二维码容量时给出明确提示。编码结果走模块级缓存，避免每次按键为全部历史重新编码
    const preview = (content, lv) => {
        const p = previewMarkdown(content, lv);
        return p.ok
            ? { ok: true, detail: List.Item.Detail({ markdown: p.markdown }) }
            : { ok: false, error: p.error, detail: List.Item.Detail({ markdown: "" }) };
    };
    const globalActions = [
        Action({ title: "用剪贴板内容生成", icon: Icon.Clipboard, onAction: fromClipboard }),
        Action({ title: "生成 Wi-Fi 二维码…", icon: Icon.Shield, onAction: openWifiForm })
    ];
    const sections = [];
    const text = searchText.trim();
    if (text) {
        const p = preview(text, level);
        sections.push(List.Section({ title: "当前输入" }, [
            p.ok
                ? List.Item({
                    id: "live",
                    title: text.length > 60 ? text.slice(0, 60) + "…" : text,
                    subtitle: "按回车复制二维码图片",
                    icon: detectQrContentType(text).icon,
                    detail: p.detail,
                    actions: ActionPanel({ title: "二维码" }, [
                        Action({ title: "复制二维码图片", icon: Icon.CopyClipboard, onAction: () => copyImage(text, level, true) }),
                        Action({ title: "保存到历史", icon: Icon.Star, onAction: async () => { await run(() => saveQrItem(newItem(text, level)), "已保存到历史"); } }),
                        Action({ title: "另存为 PNG…", icon: Icon.Download, onAction: () => saveFile(text, level) }),
                        ...globalActions
                    ])
                })
                : List.Item({ id: "live-error", title: p.error, subtitle: "请缩短内容，或把纠错等级调低", icon: Icon.ExclamationMark, detail: p.detail })
        ]));
    }
    else {
        sections.push(List.Section({ title: "开始" }, [
            List.Item({ id: "hint", title: "在上方输入网址或文字，实时生成二维码", subtitle: "回车复制图片，可直接粘贴到微信、文档", icon: Icon.QrCode, detail: List.Item.Detail({ markdown: "" }), actions: ActionPanel({ title: "开始" }, globalActions) }),
            List.Item({ id: "wifi", title: "生成 Wi-Fi 二维码", subtitle: "手机扫码直接连网", icon: Icon.Shield, detail: List.Item.Detail({ markdown: "" }), actions: ActionPanel({ title: "开始" }, [globalActions[1], globalActions[0]]) })
        ]));
    }
    const q = text.toLowerCase();
    const matches = history
        .filter((it) => !q || it.content.toLowerCase().includes(q) || it.title.toLowerCase().includes(q))
        .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)));
    if (matches.length > 0) {
        sections.push(List.Section({ title: `历史（${history.length}）` }, matches.map((it) => List.Item({
            id: it.id,
            title: it.title,
            subtitle: it.title !== it.content ? it.content : undefined,
            icon: it.favorite ? Icon.Star : detectQrContentType(it.content).icon,
            accessories: [{ text: it.createdAt }],
            detail: preview(it.content, it.level).detail,
            actions: ActionPanel({ title: it.title }, [
                Action({ title: "复制二维码图片", icon: Icon.CopyClipboard, onAction: () => copyImage(it.content, it.level, false) }),
                Action({ title: "复制内容文字", icon: Icon.Clipboard, onAction: async () => { await Clipboard.copy(it.content); await showToast(Toast.Style.Success, "已复制内容"); } }),
                Action({ title: "另存为 PNG…", icon: Icon.Download, onAction: () => saveFile(it.content, it.level) }),
                Action({ title: it.favorite ? "取消收藏" : "收藏", icon: Icon.Star, onAction: async () => { await run(() => toggleFavoriteQrItem(it.id), ""); } }),
                Action({ title: "删除", icon: Icon.Trash, onAction: async () => { await run(() => deleteQrItem(it.id), "已删除"); } }),
                Action({ title: "清空历史", icon: Icon.Trash, onAction: clearAll })
            ])
        }))));
    }
    return List({
        navigationTitle: "二维码生成",
        isShowingDetail: true,
        searchBarPlaceholder: "输入网址或文字，实时生成二维码…",
        searchText,
        onSearchTextChange: (v) => setSearchText(v),
        searchBarAccessory: List.Dropdown({ tooltip: "纠错等级", value: level, onChange: (v) => setLevel(v) }, ["L", "M", "Q", "H"].map((l) => List.Dropdown.Item({ title: `纠错 ${LEVEL_LABEL[l]}`, value: l }))),
        actions: ActionPanel({ title: "二维码" }, globalActions)
    }, sections);
}

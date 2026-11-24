import { List, Form, ActionPanel, Action, Icon, Clipboard, showToast, Toast, useState, useEffect, useNavigation, useLocale, getLocale, confirmAlert } from "@ztools/declarative-ui";
import { t } from "./i18n.js";
import { generateQrSvg, generateQrPngBase64, detectQrContentType, buildWifiPayload, getQrHistory, saveQrItem, toggleFavoriteQrItem, deleteQrItem, clearQrHistory } from "./qr-generator.js";
import { copyPngToClipboard, savePngFile, decodeQrImageFile } from "./host.js";
import { createCompatFileInputProps } from "./host-compat.js";
export * from "./qr-generator.js";
function levelLabel(lv) {
    switch (lv) {
        case "L": return t("levelL");
        case "M": return t("levelM");
        case "Q": return t("levelQ");
        case "H": return t("levelH");
    }
}
/**
 * 预览缓存（LRU）：key = locale + 纠错等级 + 内容。每次渲染都会为所有匹配的历史项生成预览，
 * 历史最多 100 条，不缓存时每次按键都要把它们全部重新编码。
 * 条数上限覆盖满额历史 + 最近输入；字符预算防止大量第 40 版大码占满内存。
 */
const PREVIEW_CACHE_MAX_ENTRIES = 160;
const PREVIEW_CACHE_MAX_CHARS = 16 * 1024 * 1024;
const previewCache = new Map();
let previewCacheChars = 0;
const previewSize = (p) => (p.ok ? p.markdown.length : p.error.length);
export function previewMarkdown(content, lv) {
    const key = `${getLocale()}\u0000${lv}\u0000${content}`;
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
            markdown: `![${t("qrAlt")}](${dataUrl})\n\n${t("previewMeta", {
                type: detectQrContentType(content).label,
                bytes: new TextEncoder().encode(content).length,
                version: qr.version,
                size: qr.size,
                level: levelLabel(lv)
            })}`
        };
    }
    catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
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
        id: `qr_${globalThis.crypto.randomUUID()}`,
        title: title || content.slice(0, 40),
        content,
        level,
        createdAt: new Date().toLocaleString(getLocale())
    };
}
/**
 * Wi-Fi 二维码表单：手机扫码即可连接
 */
export function WifiQrForm({ onCreated }) {
    useLocale();
    const { pop } = useNavigation();
    const [ssid, setSsid] = useState("");
    const [password, setPassword] = useState("");
    const [security, setSecurity] = useState("WPA");
    const [hidden, setHidden] = useState(false);
    const [error, setError] = useState(undefined);
    const [passwordError, setPasswordError] = useState(undefined);
    const submit = async () => {
        let payload;
        try {
            payload = buildWifiPayload(ssid, password, security, hidden);
        }
        catch (err) {
            const code = err && typeof err === "object" && "code" in err ? String(err.code || "") : "";
            const message = err instanceof Error ? err.message : String(err);
            // 密码相关的错误显示在密码框下，名称相关的显示在名称框下
            if (code === "WIFI_PASSWORD_INVALID")
                setPasswordError(message);
            else
                setError(message);
            return;
        }
        if (await onCreated(newItem(payload, "M", `Wi-Fi：${ssid}`)))
            pop();
    };
    return Form({
        navigationTitle: t("wifiFormTitle"),
        actions: ActionPanel({ title: "Wi-Fi" }, [
            Action.SubmitForm({ title: t("wifiSubmit"), icon: Icon.Check, onSubmit: submit })
        ])
    }, [
        Form.TextField({ id: "ssid", title: t("wifiSsidTitle"), placeholder: t("wifiSsidPlaceholder"), value: ssid, error, onChange: (v) => { setSsid(v); setError(undefined); } }),
        Form.PasswordField({ id: "password", title: t("wifiPassTitle"), placeholder: t("wifiPassPlaceholder"), value: password, error: passwordError, onChange: (v) => { setPassword(v); setPasswordError(undefined); } }),
        Form.Dropdown({ id: "security", title: t("wifiSecTitle"), value: security, onChange: (v) => { setSecurity(v === "WEP" || v === "nopass" ? v : "WPA"); setPasswordError(undefined); } }, [
            Form.Dropdown.Item({ title: "WPA / WPA2 / WPA3", value: "WPA" }),
            Form.Dropdown.Item({ title: "WEP", value: "WEP" }),
            Form.Dropdown.Item({ title: t("wifiSecNoPass"), value: "nopass" })
        ]),
        Form.Checkbox({ id: "hidden", title: t("wifiHiddenTitle"), label: t("wifiHiddenLabel"), value: hidden, onChange: (v) => setHidden(v) })
    ]);
}
export default function QrCodeCommand({ initialWifi = false } = {}) {
    useLocale();
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
            .catch((err) => showToast(Toast.Style.Failure, t("readHistoryFailed"), err instanceof Error ? err.message : String(err)))
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
            await showToast(Toast.Style.Failure, t("saveFailed"), err instanceof Error ? err.message : String(err));
            return false;
        }
    };
    const copyImage = async (content, lv, remember) => {
        try {
            await copyPngToClipboard(generateQrPngBase64(content, lv));
            await showToast(Toast.Style.Success, t("copiedImgTitle"), t("copiedImgDesc"));
            if (remember)
                await run(() => saveQrItem(newItem(content, lv)), "");
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t("copyImgFailed"), err instanceof Error ? err.message : String(err));
        }
    };
    const saveFile = async (content, lv) => {
        try {
            const path = await savePngFile(generateQrPngBase64(content, lv), "qrcode.png");
            if (path)
                await showToast(Toast.Style.Success, t("savedToast"), path);
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t("saveImgFailed"), err instanceof Error ? err.message : String(err));
        }
    };
    const fromClipboard = async () => {
        const text = (await Clipboard.readText()).trim();
        if (!text) {
            await showToast(Toast.Style.Failure, t("clipboardEmpty"));
            return;
        }
        setSearchText(text);
    };
    const openWifiForm = () => push(() => WifiQrForm({ onCreated: async (item) => {
            const saved = await run(() => saveQrItem(item), t("wifiCreatedToast"));
            if (saved) {
                setSearchText(item.content);
                setLevel(item.level);
            }
            return saved;
        } }));
    useEffect(() => {
        if (initialWifi)
            openWifiForm();
    }, [initialWifi]);
    const clearAll = async () => {
        const ok = await confirmAlert({
            title: t("clearConfirmTitle", { count: history.length }),
            message: t("clearConfirmMsg"),
            primaryAction: { title: t("clearConfirmBtn"), style: "destructive" },
            dismissAction: { title: t("cancel") }
        });
        if (!ok)
            return;
        try {
            await clearQrHistory();
            setHistory([]);
            await showToast(Toast.Style.Success, t("clearedToast"));
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t("clearFailed"), err instanceof Error ? err.message : String(err));
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
        Action({ title: t("fromClipboard"), icon: Icon.Clipboard, onAction: fromClipboard }),
        Action({ title: t("openWifiForm"), icon: Icon.Shield, onAction: openWifiForm })
    ];
    const sections = [];
    const text = searchText.trim();
    if (text) {
        const p = preview(text, level);
        sections.push(List.Section({ title: t("sectionCurrent") }, [
            p.ok
                ? List.Item({
                    id: "live",
                    title: text.length > 60 ? text.slice(0, 60) + "…" : text,
                    subtitle: t("liveSubtitle"),
                    icon: detectQrContentType(text).icon,
                    detail: p.detail,
                    actions: ActionPanel({ title: t("qrPanelTitle") }, [
                        Action({ title: t("copyQrImg"), icon: Icon.CopyClipboard, onAction: () => copyImage(text, level, true) }),
                        Action({ title: t("saveToHistory"), icon: Icon.Star, onAction: async () => { await run(() => saveQrItem(newItem(text, level)), t("savedToHistoryToast")); } }),
                        Action({ title: t("saveAsPng"), icon: Icon.Download, onAction: () => saveFile(text, level) }),
                        ...globalActions
                    ])
                })
                : List.Item({ id: "live-error", title: p.error, subtitle: t("liveErrorSub"), icon: Icon.ExclamationMark, detail: p.detail })
        ]));
    }
    else {
        sections.push(List.Section({ title: t("sectionStart") }, [
            // 引导条目不带详情：首屏没有可预览的二维码，避免右侧留出半屏空白
            List.Item({ id: "hint", title: t("hintTitle"), subtitle: t("hintSub"), icon: Icon.QrCode, actions: ActionPanel({ title: t("sectionStart") }, globalActions) }),
            List.Item({ id: "wifi", title: t("wifiItemTitle"), subtitle: t("wifiItemSub"), icon: Icon.Shield, actions: ActionPanel({ title: t("sectionStart") }, [globalActions[1], globalActions[0]]) })
        ]));
    }
    const q = text.toLowerCase();
    const matches = history
        .filter((it) => !q || it.content.toLowerCase().includes(q) || it.title.toLowerCase().includes(q))
        .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)));
    if (matches.length > 0) {
        sections.push(List.Section({ title: t("sectionHistory", { count: history.length }) }, matches.map((it) => List.Item({
            id: it.id,
            title: it.title,
            subtitle: it.title !== it.content ? it.content : undefined,
            icon: it.favorite ? Icon.Star : detectQrContentType(it.content).icon,
            accessories: [{ text: it.createdAt }],
            detail: preview(it.content, it.level).detail,
            actions: ActionPanel({ title: it.title }, [
                Action({ title: t("copyQrImg"), icon: Icon.CopyClipboard, onAction: () => copyImage(it.content, it.level, false) }),
                Action({ title: t("copyTextAction"), icon: Icon.Clipboard, onAction: async () => { await Clipboard.copy(it.content); await showToast(Toast.Style.Success, t("copiedTextToast")); } }),
                Action({ title: t("saveAsPng"), icon: Icon.Download, onAction: () => saveFile(it.content, it.level) }),
                Action({ title: it.favorite ? t("unfavorite") : t("favorite"), icon: Icon.Star, onAction: async () => { await run(() => toggleFavoriteQrItem(it.id), ""); } }),
                Action({ title: t("deleteAction"), icon: Icon.Trash, onAction: async () => { await run(() => deleteQrItem(it.id), t("deletedToast")); } }),
                Action({ title: t("clearHistoryAction"), icon: Icon.Trash, onAction: clearAll })
            ])
        }))));
    }
    const fileInputProps = createCompatFileInputProps(async (files) => {
        const targetPath = files[0]?.trim();
        if (!targetPath)
            return;
        try {
            const decoded = (await decodeQrImageFile(targetPath)).trim();
            setSearchText(decoded);
            await showToast(Toast.Style.Success, t("decodedToast"), decoded.slice(0, 60));
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t("decodeFailedToast"), err instanceof Error ? err.message : String(err));
        }
    }, {
        extensions: [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"],
        allowClipboardImage: true,
        onTextPaste: (pasted) => {
            const trimmed = pasted.trim();
            if (trimmed)
                setSearchText(trimmed);
        }
    });
    return List({
        ...fileInputProps,
        navigationTitle: t("navTitle"),
        // 只有在有二维码可预览（当前输入或历史）时才显示右侧详情栏
        isShowingDetail: Boolean(text) || matches.length > 0,
        searchBarPlaceholder: t("searchPlaceholder"),
        searchText,
        onSearchTextChange: (v) => setSearchText(v),
        searchBarAccessory: List.Dropdown({ tooltip: t("ecTooltip"), value: level, onChange: (v) => setLevel(v) }, ["L", "M", "Q", "H"].map((l) => List.Dropdown.Item({ title: t("ecOption", { level: levelLabel(l) }), value: l }))),
        actions: ActionPanel({ title: t("qrPanelTitle") }, globalActions)
    }, sections);
}
export const commands = {
    "qr-text": () => QrCodeCommand(),
    "qr-wifi": () => QrCodeCommand({ initialWifi: true })
};

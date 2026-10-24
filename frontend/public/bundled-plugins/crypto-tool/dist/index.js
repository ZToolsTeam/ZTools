import { List, Form, ActionPanel, Action, Icon, showToast, Toast, useState, useRef, useEffect, useNavigation } from "@ztools/declarative-ui";
import { calculateMultiHash, decodeBase64, aesEncrypt, aesDecrypt, calculateHmac, valueMarkdown } from "./logic.js";
import { usePopoutValue } from "./popout-state.js";
import { encodeText, decodeText } from "./codecs.js";
import GenUuidCommand from "./uuid.js";
export { default as genUuid } from "./uuid.js";
const HMAC_ALGORITHMS = ["sha256", "sha512", "sha1", "md5"];
const DEFAULT_AES_DRAFT = { direction: "encrypt", text: "", iv: "" };
const DEFAULT_HMAC_DRAFT = { algorithm: "sha256", text: "" };
const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v) => typeof v === "string";
const isMode = (v) => v === "hash" || v === "base64-decode" || v === "url" || v === "unicode" || v === "hex";
const isAesDraft = (v) => isPlainObject(v) && (v.direction === "encrypt" || v.direction === "decrypt") && isText(v.text) && isText(v.iv);
const isHmacDraft = (v) => isPlainObject(v) && HMAC_ALGORITHMS.includes(v.algorithm) && isText(v.text);
/**
 * AES-256-CBC 加解密表单：结果直接显示在表单底部，可复制。
 * 返回由宿主的 Esc / 头部返回按钮负责，表单里不再放「返回」动作（否则会占用 ⌘↵ 次动作位、与宿主入口重复）。
 * 结果只对应生成它的那组输入：明文、口令、IV、方向任一改变都清空结果，「复制结果」随之消失，避免复制到旧密文。
 */
export function AesForm({ draft = DEFAULT_AES_DRAFT, onDraftChange } = {}) {
    const [direction, setDirectionState] = useState(draft.direction);
    const [text, setTextState] = useState(draft.text);
    const [key, setKey] = useState("");
    const [iv, setIvState] = useState(draft.iv);
    const [result, setResult] = useState("");
    const [error, setError] = useState(undefined);
    const requestVersion = useRef(0);
    useEffect(() => () => { requestVersion.current++; }, []);
    // 草稿回写根页面：独立窗口弹出时由根页面带走
    const saveDraft = (patch) => onDraftChange?.({ direction, text, iv, ...patch });
    const setDirection = (v) => { setDirectionState(v); saveDraft({ direction: v }); };
    const setText = (v) => { setTextState(v); saveDraft({ text: v }); };
    const setIv = (v) => { setIvState(v); saveDraft({ iv: v }); };
    // 输入一变，旧结果就不再对应当前输入，必须清空
    const resetResult = () => {
        requestVersion.current++;
        setResult("");
        setError(undefined);
    };
    const run = async () => {
        const version = ++requestVersion.current;
        setError(undefined);
        const res = direction === "encrypt"
            ? await aesEncrypt(text, key, { iv: iv || undefined })
            : await aesDecrypt(text, key, { iv: iv || undefined });
        if (version !== requestVersion.current)
            return;
        if (!res.success) {
            setResult("");
            setError(res.error);
            await showToast(Toast.Style.Failure, direction === "encrypt" ? "加密失败" : "解密失败", res.error);
            return;
        }
        setResult(res.result || "");
        await showToast(Toast.Style.Success, direction === "encrypt" ? "加密完成" : "解密完成");
    };
    return Form({
        navigationTitle: "AES-256-CBC 加解密",
        actions: ActionPanel({ title: "AES" }, [
            Action.SubmitForm({ title: direction === "encrypt" ? "加密" : "解密", icon: Icon.Lock, onSubmit: run }),
            ...(result
                ? [Action.CopyToClipboard({ title: "复制结果", content: result, icon: Icon.CopyClipboard })]
                : [])
        ])
    }, [
        Form.Dropdown({ id: "direction", title: "操作", value: direction, onChange: (v) => { setDirection(v === "decrypt" ? "decrypt" : "encrypt"); resetResult(); } }, [
            Form.Dropdown.Item({ title: "加密：明文 → Base64 密文", value: "encrypt" }),
            Form.Dropdown.Item({ title: "解密：Base64 密文 → 明文", value: "decrypt" })
        ]),
        Form.TextArea({
            id: "text",
            title: direction === "encrypt" ? "明文" : "密文",
            placeholder: direction === "encrypt" ? "要加密的文字" : "粘贴 Base64 密文",
            value: text,
            error,
            onChange: (v) => { setText(v); resetResult(); }
        }),
        Form.PasswordField({ id: "key", title: "口令", placeholder: "加密和解密必须使用同一个口令", value: key, onChange: (v) => { setKey(v); resetResult(); } }),
        Form.TextField({ id: "iv", title: "IV（可选）", placeholder: "留空则由口令派生", value: iv, onChange: (v) => { setIv(v); resetResult(); } }),
        Form.Description({ title: "结果", text: result || `填写后执行「${direction === "encrypt" ? "加密" : "解密"}」，结果显示在这里` })
    ]);
}
/**
 * HMAC 计算表单：输入或口令变化时实时计算；返回交给宿主 Esc / 头部返回按钮
 */
export function HmacForm({ draft = DEFAULT_HMAC_DRAFT, onDraftChange } = {}) {
    const [algorithm, setAlgorithmState] = useState(draft.algorithm);
    const [text, setTextState] = useState(draft.text);
    const [key, setKey] = useState("");
    const setAlgorithm = (v) => { setAlgorithmState(v); onDraftChange?.({ algorithm: v, text }); };
    const setText = (v) => { setTextState(v); onDraftChange?.({ algorithm, text: v }); };
    const value = calculateHmac(algorithm, text, key);
    return Form({
        navigationTitle: "HMAC 计算",
        actions: ActionPanel({ title: "HMAC" }, [
            Action.CopyToClipboard({ title: "复制 HMAC", content: value, icon: Icon.CopyClipboard })
        ])
    }, [
        Form.Dropdown({ id: "algorithm", title: "算法", value: algorithm, onChange: (v) => setAlgorithm(HMAC_ALGORITHMS.includes(v) ? v : "sha256") }, [
            Form.Dropdown.Item({ title: "HMAC-SHA256", value: "sha256" }),
            Form.Dropdown.Item({ title: "HMAC-SHA512", value: "sha512" }),
            Form.Dropdown.Item({ title: "HMAC-SHA1", value: "sha1" }),
            Form.Dropdown.Item({ title: "HMAC-MD5", value: "md5" })
        ]),
        Form.TextArea({ id: "text", title: "消息", placeholder: "要签名的文字", value: text, onChange: (v) => setText(v) }),
        Form.PasswordField({ id: "key", title: "密钥", placeholder: "HMAC 密钥", value: key, onChange: (v) => setKey(v) }),
        Form.Description({ title: "结果（十六进制）", text: value })
    ]);
}
export default function CryptoToolCommand() {
    const winRecord = typeof window !== "undefined" ? window : {};
    const launchCtx = isPlainObject(winRecord.__ztoolsLaunchContext)
        ? winRecord.__ztoolsLaunchContext
        : {};
    const initialFeature = typeof launchCtx.featureCode === "string" ? launchCtx.featureCode.trim() : "";
    const featureMode = { "codec-base64": "base64-decode", "codec-url": "url", "codec-unicode": "unicode", "codec-hex": "hex" };
    const defaultMode = Object.prototype.hasOwnProperty.call(featureMode, initialFeature) ? featureMode[initialFeature] : "hash";
    // 根页面持有全部可带走的状态：散列页输入与模式，以及两个二级表单的草稿
    const [inputText, setInputText] = usePopoutValue("inputText", () => "", isText);
    const [mode, setMode] = usePopoutValue("mode", () => defaultMode, isMode);
    const [aesDraft, setAesDraft] = usePopoutValue("aesDraft", () => DEFAULT_AES_DRAFT, isAesDraft);
    const [hmacDraft, setHmacDraft] = usePopoutValue("hmacDraft", () => DEFAULT_HMAC_DRAFT, isHmacDraft);
    const { push } = useNavigation();
    const globalActions = [
        Action({ title: "AES 加解密…", icon: Icon.Lock, onAction: () => push(() => AesForm({ draft: aesDraft, onDraftChange: setAesDraft })) }),
        Action({ title: "HMAC 计算…", icon: Icon.Key, onAction: () => push(() => HmacForm({ draft: hmacDraft, onDraftChange: setHmacDraft })) }),
        Action({ title: "UUID 批量生成…", icon: Icon.Key, onAction: () => push(GenUuidCommand) })
    ];
    const commonItemActions = (value, label) => ActionPanel({ title: label }, [
        Action.CopyToClipboard({ title: "复制", content: value, icon: Icon.CopyClipboard }),
        ...globalActions,
        Action({ title: "清空输入", icon: Icon.Trash, onAction: () => setInputText("") })
    ]);
    let items;
    if (mode === "url" || mode === "unicode" || mode === "hex") {
        items = !inputText ? [List.Item({ id: "empty", title: "输入文字或编码内容", subtitle: "编码与解码结果分别显示", icon: Icon.Text })] : ["encode", "decode"].map(direction => {
            try {
                const value = direction === "encode" ? encodeText(inputText, mode) : decodeText(inputText, mode);
                return List.Item({ id: direction, title: value || "（空文本）", subtitle: `${mode.toUpperCase()} ${direction === "encode" ? "编码" : "解码"}`, icon: Icon.Text, detail: List.Item.Detail({ markdown: valueMarkdown(value) }), actions: commonItemActions(value, direction === "encode" ? "编码结果" : "解码结果") });
            }
            catch (err) {
                return List.Item({ id: `${direction}-error`, title: direction === "encode" ? "无法编码" : "无法解码", subtitle: err instanceof Error ? err.message : String(err), icon: Icon.ExclamationMark });
            }
        });
    }
    else if (mode === "base64-decode") {
        const decoded = decodeBase64(inputText);
        items = !inputText.trim()
            ? [List.Item({ id: "empty", title: "在上方粘贴 Base64 字符串", subtitle: "支持标准与 URL-safe 两种写法", icon: Icon.Text, actions: ActionPanel({ title: "操作" }, globalActions) })]
            : decoded.success
                ? [List.Item({
                        id: "decoded",
                        title: decoded.result || "（空文本）",
                        subtitle: "Base64 解码结果（UTF-8）",
                        icon: Icon.Text,
                        accessories: [{ text: `${(decoded.result || "").length} 字符` }],
                        // 解码结果往往是多行或很长的文本，列表行只能显示一行，右侧原样显示完整内容
                        detail: decoded.result ? List.Item.Detail({ markdown: valueMarkdown(decoded.result) }) : undefined,
                        actions: commonItemActions(decoded.result || "", "解码结果")
                    })]
                : [List.Item({ id: "decode-error", title: "无法解码", subtitle: decoded.error, icon: Icon.ExclamationMark, actions: ActionPanel({ title: "操作" }, globalActions) })];
    }
    else if (!inputText) {
        items = [
            List.Item({
                id: "empty",
                title: "在上方输入文字，实时计算 MD5 / SHA / Base64",
                subtitle: "AES 加解密和 HMAC 请按 Ctrl+K 打开动作面板",
                icon: Icon.Key,
                actions: ActionPanel({ title: "操作" }, globalActions)
            })
        ];
    }
    else {
        const multiHash = calculateMultiHash(inputText);
        const hashItems = [
            { id: "md5-lower", title: multiHash.md5, subtitle: "MD5（32 位小写）", value: multiHash.md5, icon: Icon.Key },
            { id: "md5-upper", title: multiHash.md5Upper, subtitle: "MD5（32 位大写）", value: multiHash.md5Upper, icon: Icon.Key },
            { id: "md5-16", title: multiHash.md5_16, subtitle: "MD5（16 位）", value: multiHash.md5_16, icon: Icon.Key },
            { id: "sha1", title: multiHash.sha1, subtitle: "SHA-1", value: multiHash.sha1, icon: Icon.Lock },
            { id: "sha256", title: multiHash.sha256, subtitle: "SHA-256", value: multiHash.sha256, icon: Icon.Lock },
            { id: "sha512", title: multiHash.sha512, subtitle: "SHA-512", value: multiHash.sha512, icon: Icon.Lock },
            { id: "base64", title: multiHash.base64, subtitle: "Base64 编码", value: multiHash.base64, icon: Icon.Text },
            { id: "url-encoded", title: multiHash.urlEncoded, subtitle: "URL 编码", value: multiHash.urlEncoded, icon: Icon.Globe }
        ];
        items = hashItems.map((item) => List.Item({
            id: item.id,
            title: item.title,
            subtitle: item.subtitle,
            icon: item.icon,
            accessories: [{ text: `${item.value.length} 字符` }],
            // SHA-512、长 Base64 / URL 编码在列表行里会被截断，右侧折行显示选中项的完整值
            detail: List.Item.Detail({ markdown: valueMarkdown(item.value) }),
            actions: commonItemActions(item.value, item.subtitle)
        }));
    }
    return List({
        navigationTitle: "加解密与散列助手",
        // 只有存在结果时才开右侧预览；空状态、解码失败等提示行没有 detail，自动保持全宽
        isShowingDetail: Boolean(inputText),
        searchBarPlaceholder: mode === "hash" ? "输入要计算散列或编码的文字..." : mode === "base64-decode" ? "粘贴要解码的 Base64..." : "输入文字或编码内容…",
        searchText: inputText,
        onSearchTextChange: (text) => setInputText(text),
        searchBarAccessory: List.Dropdown({ tooltip: "模式", value: mode, onChange: (v) => setMode(isMode(v) ? v : "hash") }, [
            List.Dropdown.Item({ title: "散列与编码", value: "hash" }),
            List.Dropdown.Item({ title: "Base64 解码", value: "base64-decode" }),
            List.Dropdown.Item({ title: "URL 编解码", value: "url" }),
            List.Dropdown.Item({ title: "Unicode 编解码", value: "unicode" }),
            List.Dropdown.Item({ title: "Hex 编解码（UTF-8）", value: "hex" })
        ]),
        actions: ActionPanel({ title: "全局操作" }, globalActions)
    }, [List.Section({ title: mode === "hash" ? `散列与编码（输入 ${inputText.length} 字符）` : mode === "base64-decode" ? "Base64 解码" : `${mode.toUpperCase()} 编解码` }, items)]);
}
export { AesForm as cipherAes };

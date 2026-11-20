import { List, Form, ActionPanel, Action, Icon, showToast, Toast, useState, useRef, useEffect, useNavigation, useLocale, Clipboard } from "@ztools/declarative-ui";
import { t } from "./i18n.js";
import { calculateMultiHash, calculateFileHash, decodeBase64, encodeBase64, aesEncrypt, aesDecrypt, calculateHmac, valueMarkdown } from "./logic.js";
import { createCompatFileInputProps } from "./host-compat.js";
import { usePopoutValue } from "./popout-state.js";
import { encodeText, decodeText, hasLoneSurrogate } from "./codecs.js";
import GenUuidCommand from "./uuid.js";
export { default as genUuid } from "./uuid.js";
const CODEC_LABEL = { url: "URL", unicode: "Unicode", hex: "Hex" };
/** macOS 只写 ⌘，Windows 写 Ctrl */
function modKey() {
    const nav = globalThis.navigator;
    return /Mac/i.test(String(nav?.platform || nav?.userAgent || "")) ? "⌘" : "Ctrl";
}
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
    useLocale();
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
            await showToast(Toast.Style.Failure, direction === "encrypt" ? t("encryptFailed") : t("decryptFailed"), res.error);
            return;
        }
        setResult(res.result || "");
        await showToast(Toast.Style.Success, direction === "encrypt" ? t("encryptDone") : t("decryptDone"));
    };
    const actionLabel = direction === "encrypt" ? t("encrypt") : t("decrypt");
    return Form({
        navigationTitle: t("aesNavTitle"),
        actions: ActionPanel({ title: "AES" }, [
            Action.SubmitForm({ title: actionLabel, icon: Icon.Lock, onSubmit: run }),
            ...(result
                ? [Action.CopyToClipboard({ title: t("copyResult"), content: result, icon: Icon.CopyClipboard })]
                : [])
        ])
    }, [
        Form.Dropdown({ id: "direction", title: t("operationField"), value: direction, onChange: (v) => { setDirection(v === "decrypt" ? "decrypt" : "encrypt"); resetResult(); } }, [
            Form.Dropdown.Item({ title: t("encryptOpt"), value: "encrypt" }),
            Form.Dropdown.Item({ title: t("decryptOpt"), value: "decrypt" })
        ]),
        Form.TextArea({
            id: "text",
            title: direction === "encrypt" ? t("plaintextTitle") : t("ciphertextTitle"),
            placeholder: direction === "encrypt" ? t("plaintextPlaceholder") : t("ciphertextPlaceholder"),
            value: text,
            error,
            onChange: (v) => { setText(v); resetResult(); }
        }),
        Form.PasswordField({ id: "key", title: t("passphraseTitle"), placeholder: t("passphrasePlaceholder"), value: key, onChange: (v) => { setKey(v); resetResult(); } }),
        Form.TextField({ id: "iv", title: t("ivTitle"), placeholder: t("ivPlaceholder"), value: iv, onChange: (v) => { setIv(v); resetResult(); } }),
        Form.Description({ title: t("resultTitle"), text: result || t("aesResultHint", { action: actionLabel }) })
    ]);
}
/**
 * HMAC 计算表单：输入或口令变化时实时计算；返回交给宿主 Esc / 头部返回按钮
 */
export function HmacForm({ draft = DEFAULT_HMAC_DRAFT, onDraftChange } = {}) {
    useLocale();
    const [algorithm, setAlgorithmState] = useState(draft.algorithm);
    const [text, setTextState] = useState(draft.text);
    const [key, setKey] = useState("");
    const setAlgorithm = (v) => { setAlgorithmState(v); onDraftChange?.({ algorithm: v, text }); };
    const setText = (v) => { setTextState(v); onDraftChange?.({ algorithm, text: v }); };
    // 消息和密钥都没填时不展示空串的 HMAC，也不提供复制，避免把无意义的值当结果用
    const hasInput = Boolean(text || key);
    const value = hasInput ? calculateHmac(algorithm, text, key) : "";
    return Form({
        navigationTitle: t("hmacNavTitle"),
        actions: ActionPanel({ title: "HMAC" }, hasInput
            ? [Action.CopyToClipboard({ title: t("copyHmac"), content: value, icon: Icon.CopyClipboard })]
            : [])
    }, [
        Form.Dropdown({ id: "algorithm", title: t("algorithmField"), value: algorithm, onChange: (v) => setAlgorithm(HMAC_ALGORITHMS.includes(v) ? v : "sha256") }, [
            Form.Dropdown.Item({ title: "HMAC-SHA256", value: "sha256" }),
            Form.Dropdown.Item({ title: "HMAC-SHA512", value: "sha512" }),
            Form.Dropdown.Item({ title: "HMAC-SHA1", value: "sha1" }),
            Form.Dropdown.Item({ title: "HMAC-MD5", value: "md5" })
        ]),
        Form.TextArea({ id: "text", title: t("messageField"), placeholder: t("messagePlaceholder"), value: text, onChange: (v) => setText(v) }),
        Form.PasswordField({ id: "key", title: t("secretField"), placeholder: t("secretPlaceholder"), value: key, onChange: (v) => setKey(v) }),
        Form.Description({ title: t("hmacResultTitle"), text: hasInput ? value : t("hmacResultHint") })
    ]);
}
export default function CryptoToolCommand() {
    useLocale();
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
    const [fileHash, setFileHash] = useState(null);
    const { push } = useNavigation();
    const clearAllInput = () => {
        setFileHash(null);
        setInputText("");
    };
    const fileInputProps = createCompatFileInputProps(async (files) => {
        const targetPath = files[0]?.trim();
        if (!targetPath)
            return;
        try {
            const res = await calculateFileHash(targetPath);
            setFileHash(res);
            setMode("hash");
            await showToast(Toast.Style.Success, t("fileHashSuccess"), res.fileName);
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t("fileHashFailed"), err instanceof Error ? err.message : String(err));
        }
    }, {
        onTextPaste: (text) => {
            if (text) {
                setFileHash(null);
                setInputText(text);
            }
        }
    });
    const globalActions = [
        Action({ title: t("aesAction"), icon: Icon.Lock, onAction: () => push(() => AesForm({ draft: aesDraft, onDraftChange: setAesDraft })) }),
        Action({ title: t("hmacAction"), icon: Icon.Key, onAction: () => push(() => HmacForm({ draft: hmacDraft, onDraftChange: setHmacDraft })) }),
        Action({ title: t("uuidAction"), icon: Icon.Key, onAction: () => push(GenUuidCommand) })
    ];
    // 空状态提示行的主动作：把剪贴板内容填进搜索框；AES / HMAC / UUID 只在动作面板（列表级动作）里
    const pasteFromClipboard = async () => {
        try {
            const text = await Clipboard.readText();
            if (!text) {
                await showToast(Toast.Style.Failure, t("clipboardEmpty"));
                return;
            }
            setFileHash(null);
            setInputText(text);
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t("readClipboardFailed"), err instanceof Error ? err.message : String(err));
        }
    };
    const emptyActions = ActionPanel({ title: t("actionsTitle") }, [
        Action({ title: t("pasteFromClipboard"), icon: Icon.Clipboard, onAction: pasteFromClipboard })
    ]);
    // 错误行：主动作清空输入，次动作从剪贴板重新粘贴，都与当前任务相关
    const errorActions = ActionPanel({ title: t("actionsTitle") }, [
        Action({ title: t("clearInput"), icon: Icon.Trash, onAction: clearAllInput }),
        Action({ title: t("pasteFromClipboard"), icon: Icon.Clipboard, onAction: pasteFromClipboard })
    ]);
    const commonItemActions = (value, label) => ActionPanel({ title: label }, [
        Action.CopyToClipboard({ title: t("copy"), content: value, icon: Icon.CopyClipboard }),
        Action({ title: t("clearInput"), icon: Icon.Trash, onAction: clearAllInput }),
        // AES / HMAC / UUID 是另开表单的全局工具，排在后面收进动作面板，不占回车与次动作位
        ...globalActions
    ]);
    let items;
    if (mode === "url" || mode === "unicode" || mode === "hex") {
        items = !inputText ? [List.Item({ id: "empty", title: t("codecEmptyTitle"), subtitle: t("codecEmptySub"), icon: Icon.Text, actions: emptyActions })] : ["encode", "decode"].map(direction => {
            try {
                const value = direction === "encode" ? encodeText(inputText, mode) : decodeText(inputText, mode);
                return List.Item({ id: direction, title: value || t("emptyTextLabel"), subtitle: `${CODEC_LABEL[mode]} ${direction === "encode" ? t("encodeWord") : t("decodeWord")}`, icon: Icon.Text, detail: List.Item.Detail({ markdown: valueMarkdown(value) }), actions: commonItemActions(value, direction === "encode" ? t("encodeResult") : t("decodeResult")) });
            }
            catch (err) {
                return List.Item({ id: `${direction}-error`, title: direction === "encode" ? t("cannotEncode") : t("cannotDecode"), subtitle: err instanceof Error ? err.message : String(err), icon: Icon.ExclamationMark, actions: errorActions });
            }
        });
    }
    else if (mode === "base64-decode") {
        const decoded = decodeBase64(inputText);
        const encoded = inputText.trim()
            ? (() => {
                const value = encodeBase64(inputText);
                return List.Item({
                    id: "encoded",
                    title: value,
                    subtitle: t("base64EncodedSub"),
                    icon: Icon.Text,
                    accessories: [{ text: t("charCount", { count: value.length }) }],
                    detail: List.Item.Detail({ markdown: valueMarkdown(value) }),
                    actions: commonItemActions(value, t("encodeResult"))
                });
            })()
            : null;
        // 编码与解码都给：能解码的输入把解码结果放前面，否则编码结果放前面
        items = !inputText.trim()
            ? [List.Item({ id: "empty", title: t("base64EmptyTitle"), subtitle: t("base64EmptySub"), icon: Icon.Text, actions: emptyActions })]
            : decoded.success
                ? [List.Item({
                        id: "decoded",
                        title: decoded.result || t("emptyTextLabel"),
                        subtitle: t("base64DecodedSub"),
                        icon: Icon.Text,
                        accessories: [{ text: t("charCount", { count: (decoded.result || "").length }) }],
                        // 解码结果往往是多行或很长的文本，列表行只能显示一行，右侧原样显示完整内容
                        detail: decoded.result ? List.Item.Detail({ markdown: valueMarkdown(decoded.result) }) : undefined,
                        actions: commonItemActions(decoded.result || "", t("decodeResult"))
                    }), encoded]
                : [encoded, List.Item({ id: "decode-error", title: t("base64InvalidTitle"), subtitle: decoded.error, icon: Icon.ExclamationMark, actions: errorActions })];
    }
    else if (fileHash && !inputText) {
        const fileItems = [
            { id: "file-sha256", title: fileHash.sha256, subtitle: t("fileSha256Sub", { name: fileHash.fileName }), value: fileHash.sha256, icon: Icon.Lock },
            ...(fileHash.md5 ? [{ id: "file-md5-lower", title: fileHash.md5, subtitle: t("fileMd5LowerSub", { name: fileHash.fileName }), value: fileHash.md5, icon: Icon.Key }] : []),
            ...(fileHash.md5Upper ? [{ id: "file-md5-upper", title: fileHash.md5Upper, subtitle: t("fileMd5UpperSub", { name: fileHash.fileName }), value: fileHash.md5Upper, icon: Icon.Key }] : []),
            ...(fileHash.sha1 ? [{ id: "file-sha1", title: fileHash.sha1, subtitle: t("fileSha1Sub", { name: fileHash.fileName }), value: fileHash.sha1, icon: Icon.Lock }] : []),
            ...(fileHash.sha512 ? [{ id: "file-sha512", title: fileHash.sha512, subtitle: t("fileSha512Sub", { name: fileHash.fileName }), value: fileHash.sha512, icon: Icon.Lock }] : [])
        ];
        const fileDetailHeader = [
            t("fileNameMd", { name: fileHash.fileName }),
            t("filePathMd", { path: fileHash.filePath }),
            ...(typeof fileHash.byteLength === "number" ? [t("fileSizeMd", { bytes: fileHash.byteLength })] : [])
        ].join("\n\n");
        items = fileItems.map((item) => List.Item({
            id: item.id,
            title: item.title,
            subtitle: item.subtitle,
            icon: item.icon,
            accessories: [{ text: fileHash.filePath }],
            detail: List.Item.Detail({ markdown: `${fileDetailHeader}\n\n${valueMarkdown(item.value)}` }),
            actions: commonItemActions(item.value, item.subtitle)
        }));
    }
    else if (!inputText) {
        items = [
            List.Item({
                id: "empty",
                title: t("hashEmptyTitle"),
                subtitle: t("hashEmptySub", { mod: modKey() }),
                icon: Icon.Key,
                actions: emptyActions
            })
        ];
    }
    else if (hasLoneSurrogate(inputText)) {
        // TextEncoder 会把不成对的代理项替换成 U+FFFD 再算散列，encodeURIComponent 会直接抛错；如实提示而不是给出别的文字的散列
        items = [
            List.Item({
                id: "invalid-text",
                title: t("loneSurrogateTitle"),
                subtitle: t("loneSurrogateSub"),
                icon: Icon.ExclamationMark,
                actions: ActionPanel({ title: t("actionsTitle") }, [Action({ title: t("clearInput"), icon: Icon.Trash, onAction: () => setInputText("") })])
            })
        ];
    }
    else {
        const multiHash = calculateMultiHash(inputText);
        const hashItems = [
            { id: "md5-lower", title: multiHash.md5, subtitle: t("md5LowerSub"), value: multiHash.md5, icon: Icon.Key },
            { id: "md5-upper", title: multiHash.md5Upper, subtitle: t("md5UpperSub"), value: multiHash.md5Upper, icon: Icon.Key },
            { id: "md5-16", title: multiHash.md5_16, subtitle: t("md5ShortSub"), value: multiHash.md5_16, icon: Icon.Key },
            { id: "sha1", title: multiHash.sha1, subtitle: "SHA-1", value: multiHash.sha1, icon: Icon.Lock },
            { id: "sha256", title: multiHash.sha256, subtitle: "SHA-256", value: multiHash.sha256, icon: Icon.Lock },
            { id: "sha512", title: multiHash.sha512, subtitle: "SHA-512", value: multiHash.sha512, icon: Icon.Lock },
            { id: "base64", title: multiHash.base64, subtitle: t("base64EncodeSub"), value: multiHash.base64, icon: Icon.Text },
            { id: "url-encoded", title: multiHash.urlEncoded, subtitle: t("urlEncodeSub"), value: multiHash.urlEncoded, icon: Icon.Globe }
        ];
        items = hashItems.map((item) => List.Item({
            id: item.id,
            title: item.title,
            subtitle: item.subtitle,
            icon: item.icon,
            accessories: [{ text: t("charCount", { count: item.value.length }) }],
            // SHA-512、长 Base64 / URL 编码在列表行里会被截断，右侧折行显示选中项的完整值
            detail: List.Item.Detail({ markdown: valueMarkdown(item.value) }),
            actions: commonItemActions(item.value, item.subtitle)
        }));
    }
    return List({
        ...fileInputProps,
        navigationTitle: t("navTitle"),
        // 只有存在结果时才开右侧预览；空状态、解码失败等提示行没有 detail，自动保持全宽
        isShowingDetail: Boolean(inputText || fileHash),
        searchBarPlaceholder: mode === "hash" ? t("placeholderHash") : mode === "base64-decode" ? t("placeholderBase64") : t("placeholderCodec"),
        searchText: inputText,
        onSearchTextChange: (text) => { setFileHash(null); setInputText(text); },
        searchBarAccessory: List.Dropdown({ tooltip: t("modeTooltip"), value: mode, onChange: (v) => setMode(isMode(v) ? v : "hash") }, [
            List.Dropdown.Item({ title: t("modeHash"), value: "hash" }),
            List.Dropdown.Item({ title: t("modeBase64"), value: "base64-decode" }),
            List.Dropdown.Item({ title: t("modeUrl"), value: "url" }),
            List.Dropdown.Item({ title: t("modeUnicode"), value: "unicode" }),
            List.Dropdown.Item({ title: t("modeHex"), value: "hex" })
        ]),
        // AES / HMAC / UUID 是另开表单的工具，与当前页任务无关：放进子菜单，只在动作面板里出现，
        // 不会因为空状态或错误行没有第 2 个动作而被顶到 ⌘↵ 次动作位
        actions: ActionPanel({ title: t("globalActionsTitle") }, [ActionPanel.Submenu({ title: t("otherToolsSubmenu"), icon: Icon.Lock }, globalActions)])
    }, 
    // 模式名已在下拉框里，分组标题只说明内容，不重复“Base64 编解码”
    [List.Section({ title: fileHash && !inputText ? t("sectionFileHash", { name: fileHash.fileName, path: fileHash.filePath }) : inputText ? t("sectionResultsCount", { count: inputText.length }) : t("sectionResults") }, items)]);
}
export { AesForm as cipherAes, HmacForm as cipherHmac };

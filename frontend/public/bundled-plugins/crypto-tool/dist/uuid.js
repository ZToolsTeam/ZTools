import { List, ActionPanel, Action, Icon, Clipboard, useState, useLocale, showToast, Toast } from "@ztools/declarative-ui";
import { t } from "./i18n.js";
import { UUID_VERSIONS, UUID_FORMATS, MAX_UUID_BATCH_COUNT, formatUuid, generateUuidBatch, isUuidVersion } from "./uuid-logic.js";
export { generateUuidV1, generateUuidV4, generateUuidV7, formatUuid, generateUuidBatch } from "./uuid-logic.js";
const DEFAULT_BATCH_COUNT = 5;
const QUICK_COUNTS = [1, 5, 10, 20, 50, 100];
const NUMERIC_INPUT_RE = /^[+-]?\d+(?:\.\d+)?$/;
const FORMAT_EXAMPLES = {
    standard: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    uppercase: "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX",
    "no-dash": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "no-dash-upper": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
};
function versionLabel(version) {
    if (version === "v7")
        return t("uuidVersionV7");
    if (version === "v1")
        return t("uuidVersionV1");
    return t("uuidVersionV4");
}
function formatLabel(format) {
    switch (format) {
        case "uppercase":
            return t("uuidFormatUpper");
        case "no-dash":
            return t("uuidFormatNoDash");
        case "no-dash-upper":
            return t("uuidFormatNoDashUpper");
        default:
            return t("uuidFormatStandard");
    }
}
function createInitialBatch() {
    try {
        return {
            uuids: generateUuidBatch({ version: "v4", format: "standard", count: DEFAULT_BATCH_COUNT }),
            error: ""
        };
    }
    catch (err) {
        return {
            uuids: [],
            error: err instanceof Error ? err.message : String(err)
        };
    }
}
function buildResultItems(params) {
    const { error, displayUuids, version, format, count, currentFormatLabel, isNumericInput, trimmed, onCopySingle, onCopyAll, onRegenerate, onFormatChange, onClearSearch } = params;
    if (error) {
        return [
            List.Item({
                id: "uuid-error",
                title: error,
                subtitle: t("uuidSubtitle"),
                icon: Icon.ExclamationMark,
                actions: ActionPanel({ title: t("actionsTitle") }, [
                    Action({
                        title: t("uuidGenAction"),
                        icon: Icon.Repeat,
                        onAction: () => onRegenerate(isNumericInput ? trimmed : count, version, false)
                    }),
                    Action({
                        title: t("uuidClearFilter"),
                        icon: Icon.Trash,
                        onAction: () => onClearSearch(true)
                    })
                ])
            })
        ];
    }
    if (displayUuids.length === 0) {
        return [
            List.Item({
                id: "uuid-empty",
                title: t("uuidNoMatchTitle"),
                subtitle: t("uuidNoMatchSub"),
                icon: Icon.MagnifyingGlass,
                actions: ActionPanel({ title: t("actionsTitle") }, [
                    Action({ title: t("uuidClearFilter"), icon: Icon.Trash, onAction: () => onClearSearch(false) }),
                    Action({ title: t("uuidGenAction"), icon: Icon.Repeat, onAction: () => onRegenerate(count, version, false) })
                ])
            })
        ];
    }
    return displayUuids.map((uuid, index) => List.Item({
        id: `uuid-item-${index}`,
        title: uuid,
        subtitle: `#${index + 1} · ${version.toUpperCase()}`,
        icon: Icon.Key,
        accessories: [{ text: currentFormatLabel }, { text: t("uuidEnterCopyHint") }],
        actions: ActionPanel({ title: t("actionsTitle") }, [
            Action({ title: t("uuidCopyOne"), icon: Icon.CopyClipboard, onAction: () => onCopySingle(uuid) }),
            Action({ title: t("uuidCopyAll"), icon: Icon.Document, shortcut: { modifiers: ["ctrl"], key: "a" }, onAction: onCopyAll }),
            Action({ title: t("uuidGenAction"), icon: Icon.Repeat, shortcut: { modifiers: ["ctrl"], key: "r" }, onAction: () => onRegenerate(count, version, false) }),
            ActionPanel.Submenu({ title: t("uuidFormatSubmenu"), icon: Icon.Gear }, UUID_FORMATS.map((fmt) => Action({
                key: `fmt-${fmt}`,
                title: formatLabel(fmt),
                icon: fmt === format ? Icon.Check : Icon.Circle,
                onAction: () => onFormatChange(fmt)
            }))),
            ActionPanel.Submenu({ title: t("uuidCountSubmenu"), icon: Icon.List }, QUICK_COUNTS.map((cnt) => Action({
                key: `cnt-${cnt}`,
                title: t("uuidCountOption", { count: cnt }),
                icon: cnt === count ? Icon.Check : Icon.Circle,
                onAction: () => onRegenerate(cnt, version, false)
            })))
        ])
    }));
}
export default function GenUuidCommand() {
    useLocale();
    const [version, setVersion] = useState("v4");
    const [format, setFormat] = useState("standard");
    const [count, setCount] = useState(DEFAULT_BATCH_COUNT);
    const [searchText, setSearchText] = useState("");
    const [initial] = useState(createInitialBatch);
    const [rawUuids, setRawUuids] = useState(initial.uuids);
    const [error, setError] = useState(initial.error);
    const formattedUuids = rawUuids.map((id) => formatUuid(id, format));
    const trimmed = searchText.trim();
    const isNumericInput = trimmed.length > 0 && NUMERIC_INPUT_RE.test(trimmed);
    const regenerate = async (nextCount = count, nextVersion = version, silent = false) => {
        try {
            const fresh = generateUuidBatch({ version: nextVersion, format: "standard", count: nextCount });
            setRawUuids(fresh);
            setCount(fresh.length);
            setError("");
            if (!silent) {
                await showToast(Toast.Style.Success, t("uuidRegeneratedToast", { count: fresh.length, version: nextVersion.toUpperCase() }));
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setRawUuids([]);
            setError(message);
            if (!silent) {
                await showToast(Toast.Style.Failure, t("uuidGenFailed"), message);
            }
        }
    };
    const handleSearchChange = (text) => {
        setSearchText(text);
        const nextTrimmed = text.trim();
        if (!nextTrimmed) {
            if (error) {
                void regenerate(count, version, true);
            }
            return;
        }
        if (NUMERIC_INPUT_RE.test(nextTrimmed)) {
            const parsed = Number(nextTrimmed);
            if (/^\d+$/.test(nextTrimmed) && parsed >= 1 && parsed <= MAX_UUID_BATCH_COUNT) {
                void regenerate(parsed, version, true);
            }
            else {
                try {
                    generateUuidBatch({ version, format: "standard", count: nextTrimmed });
                }
                catch (err) {
                    setRawUuids([]);
                    setError(err instanceof Error ? err.message : String(err));
                }
            }
        }
    };
    const handleVersionChange = (next) => {
        if (!isUuidVersion(next))
            return;
        setVersion(next);
        const targetCount = isNumericInput ? trimmed : count;
        void regenerate(targetCount, next, false);
    };
    const handleFormatChange = async (next) => {
        setFormat(next);
        await showToast(Toast.Style.Success, t("uuidFormatSwitchedToast", { format: formatLabel(next) }));
    };
    const handleCopySingle = async (value) => {
        await Clipboard.copy(value);
        await showToast(Toast.Style.Success, t("uuidCopiedOneToast"));
    };
    const handleCopyAll = async () => {
        const list = displayUuids;
        if (list.length === 0)
            return;
        await Clipboard.copy(list.join("\n"));
        await showToast(Toast.Style.Success, t("uuidCopiedAllToast", { count: list.length }));
    };
    const displayUuids = isNumericInput
        ? formattedUuids
        : formattedUuids.filter((item) => trimmed ? item.toLowerCase().includes(trimmed.toLowerCase()) : true);
    const currentFormatLabel = formatLabel(format);
    const resultItems = buildResultItems({
        error,
        displayUuids,
        version,
        format,
        count,
        currentFormatLabel,
        isNumericInput,
        trimmed,
        onCopySingle: handleCopySingle,
        onCopyAll: handleCopyAll,
        onRegenerate: regenerate,
        onFormatChange: handleFormatChange,
        onClearSearch: (resetBatch) => {
            setSearchText("");
            if (resetBatch)
                void regenerate(DEFAULT_BATCH_COUNT, version, true);
        }
    });
    return List({
        navigationTitle: t("uuidNavTitle"),
        searchText,
        onSearchTextChange: handleSearchChange,
        searchBarPlaceholder: t("uuidPlaceholder"),
        searchBarAccessory: List.Dropdown({
            tooltip: t("uuidVersionTooltip"),
            value: version,
            onChange: handleVersionChange
        }, UUID_VERSIONS.map((ver) => List.Dropdown.Item({
            key: ver,
            value: ver,
            title: versionLabel(ver)
        })))
    }, [
        List.Section({
            title: t("uuidSectionResults", {
                count: displayUuids.length,
                version: version.toUpperCase(),
                format: currentFormatLabel
            })
        }, resultItems),
        List.Section({ title: t("uuidSectionFormats") }, UUID_FORMATS.map((fmt) => List.Item({
            id: `uuid-format-${fmt}`,
            title: formatLabel(fmt),
            subtitle: FORMAT_EXAMPLES[fmt],
            icon: fmt === format ? Icon.Check : Icon.Circle,
            accessories: [{ text: fmt === format ? t("uuidFormatSelected") : t("uuidFormatSwitchHint") }],
            actions: ActionPanel({ title: t("uuidFormatSubmenu") }, [
                Action({
                    title: t("uuidSetFormatAction", { format: formatLabel(fmt) }),
                    icon: Icon.Check,
                    onAction: () => handleFormatChange(fmt)
                }),
                Action({
                    title: t("uuidRegenerateWithFormat"),
                    icon: Icon.Repeat,
                    onAction: () => {
                        setFormat(fmt);
                        void regenerate(count, version, false);
                    }
                })
            ])
        })))
    ]);
}

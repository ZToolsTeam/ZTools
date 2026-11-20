import { List, ActionPanel, Action, Icon, showToast, Toast, Clipboard, useState, useEffect, useNavigation, useLocale } from "@ztools/declarative-ui";
import { parseTimeInput } from "./logic.js";
import { t } from "./i18n.js";
import WorldClockCommand from "./world-clock.js";
export { default as tzWorld } from "./world-clock.js";
export default function TimestampCommand() {
    useLocale();
    const { push } = useNavigation();
    const [searchText, setSearchText] = useState("");
    // 留空时展示的“当前时间”与输入内容的相对时间都依赖 now：每秒推进一次，卸载时清理
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    const isLive = !searchText.trim();
    const parsed = parseTimeInput(searchText, new Date(now));
    // 留空时按下动作那一刻重新取当前时间，避免复制到最多 1 秒前的旧值
    const pick = (key) => (isLive ? parseTimeInput("", new Date()) : parsed)[key];
    const handleCopy = async (key, label) => {
        const val = String(pick(key) ?? "");
        await Clipboard.copy(val);
        await showToast(Toast.Style.Success, t("copiedToast", { label, val }));
    };
    const resetToNow = async () => {
        const wasLive = isLive;
        setSearchText("");
        setNow(Date.now());
        await showToast(Toast.Style.Success, wasLive ? t("refreshedLiveToast") : t("resetLiveToast"));
    };
    return List({
        navigationTitle: t("navTitle"),
        actions: ActionPanel({}, [Action({ title: t("worldClockAction"), icon: Icon.Globe, onAction: () => push(WorldClockCommand) })]),
        searchBarPlaceholder: t("searchPlaceholder"),
        searchText,
        onSearchTextChange: (text) => setSearchText(text)
    }, [
        parsed.valid
            ? List.Section({ title: isLive ? t("sectionLive") : t("sectionParsed") }, [
                List.Item({
                    id: "item-seconds",
                    title: String(parsed.unixSeconds),
                    subtitle: t("secondsSubtitle"),
                    icon: Icon.Key,
                    accessories: [{ text: t("secondsAcc") }],
                    actions: ActionPanel({ title: t("actionsTitle") }, [
                        Action({
                            title: t("copySeconds"),
                            icon: Icon.CopyClipboard,
                            onAction: () => handleCopy("unixSeconds", t("labelSeconds"))
                        }),
                        Action({
                            title: t("refreshNow"),
                            icon: Icon.Repeat,
                            onAction: resetToNow
                        })
                    ])
                }),
                List.Item({
                    id: "item-ms",
                    title: String(parsed.unixMilliseconds),
                    subtitle: t("msSubtitle"),
                    icon: Icon.Key,
                    accessories: [{ text: t("msAcc") }],
                    actions: ActionPanel({ title: t("actionsTitle") }, [
                        Action({
                            title: t("copyMs"),
                            icon: Icon.CopyClipboard,
                            onAction: () => handleCopy("unixMilliseconds", t("labelMs"))
                        }),
                        Action({
                            title: t("refreshNow"),
                            icon: Icon.Repeat,
                            onAction: resetToNow
                        })
                    ])
                }),
                List.Item({
                    id: "item-local",
                    title: parsed.localDateTime || "",
                    subtitle: t("localSubtitle", { dayOfWeek: parsed.dayOfWeek || "" }),
                    icon: Icon.Calendar,
                    accessories: [{ text: parsed.dayOfWeek || t("localAccFallback") }],
                    actions: ActionPanel({ title: t("actionsTitle") }, [
                        Action({
                            title: t("copyLocal"),
                            icon: Icon.CopyClipboard,
                            onAction: () => handleCopy("localDateTime", t("labelLocal"))
                        }),
                        Action({
                            title: t("refreshNow"),
                            icon: Icon.Repeat,
                            onAction: resetToNow
                        })
                    ])
                }),
                List.Item({
                    id: "item-beijing",
                    title: parsed.beijingDateTime || "",
                    subtitle: t("beijingSubtitle"),
                    icon: Icon.Globe,
                    accessories: [{ text: "UTC+8" }],
                    actions: ActionPanel({ title: t("actionsTitle") }, [
                        Action({
                            title: t("copyBeijing"),
                            icon: Icon.CopyClipboard,
                            onAction: () => handleCopy("beijingDateTime", t("labelBeijing"))
                        })
                    ])
                }),
                List.Item({
                    id: "item-utc",
                    title: parsed.utcIso || "",
                    subtitle: t("utcSubtitle"),
                    icon: Icon.Document,
                    accessories: [{ text: "ISO 8601" }],
                    actions: ActionPanel({ title: t("actionsTitle") }, [
                        Action({
                            title: t("copyUtc"),
                            icon: Icon.CopyClipboard,
                            onAction: () => handleCopy("utcIso", t("labelUtc"))
                        })
                    ])
                }),
                List.Item({
                    id: "item-relative",
                    title: parsed.relativeTime || "",
                    subtitle: t("relativeSubtitle"),
                    icon: Icon.Clock,
                    accessories: [{ text: t("relativeAcc") }],
                    actions: ActionPanel({ title: t("actionsTitle") }, [
                        Action({
                            title: t("copyRelative"),
                            icon: Icon.CopyClipboard,
                            onAction: () => handleCopy("relativeTime", t("labelRelative"))
                        })
                    ])
                })
            ])
            : List.Section({ title: t("sectionError") }, [
                List.Item({
                    id: "item-error",
                    title: parsed.error || t("parseErrorFallback"),
                    subtitle: searchText,
                    icon: Icon.ExclamationMark,
                    accessories: [{ text: t("formatErrorAcc") }],
                    actions: ActionPanel({ title: t("actionsTitle") }, [
                        Action({
                            title: t("clearAndReset"),
                            icon: Icon.Repeat,
                            onAction: resetToNow
                        })
                    ])
                })
            ])
    ]);
}

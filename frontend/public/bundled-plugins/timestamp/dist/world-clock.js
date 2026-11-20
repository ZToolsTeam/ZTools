import { List, Form, ActionPanel, Action, Icon, Clipboard, showToast, Toast, useState, useEffect, useNavigation, useLocale } from "@ztools/declarative-ui";
import { parseTimeInput } from "./logic.js";
import { t } from "./i18n.js";
const CITY_NAMES_ZH = {
    "Asia/Shanghai": "北京 / 上海", "Asia/Hong_Kong": "香港", "Asia/Tokyo": "东京", "Asia/Seoul": "首尔",
    "Asia/Singapore": "新加坡", "Asia/Kolkata": "新德里", "Asia/Dubai": "迪拜", "Europe/London": "伦敦",
    "Europe/Paris": "巴黎", "Europe/Berlin": "柏林", "Europe/Moscow": "莫斯科", "America/New_York": "纽约",
    "America/Los_Angeles": "洛杉矶", "America/Chicago": "芝加哥", "America/Toronto": "多伦多",
    "America/Sao_Paulo": "圣保罗", "Australia/Sydney": "悉尼", "Pacific/Auckland": "奥克兰", "Africa/Cairo": "开罗", "UTC": "UTC"
};
const CITY_NAMES_EN = {
    "Asia/Shanghai": "Beijing / Shanghai", "Asia/Hong_Kong": "Hong Kong", "Asia/Tokyo": "Tokyo", "Asia/Seoul": "Seoul",
    "Asia/Singapore": "Singapore", "Asia/Kolkata": "New Delhi", "Asia/Dubai": "Dubai", "Europe/London": "London",
    "Europe/Paris": "Paris", "Europe/Berlin": "Berlin", "Europe/Moscow": "Moscow", "America/New_York": "New York",
    "America/Los_Angeles": "Los Angeles", "America/Chicago": "Chicago", "America/Toronto": "Toronto",
    "America/Sao_Paulo": "Sao Paulo", "Australia/Sydney": "Sydney", "Pacific/Auckland": "Auckland", "Africa/Cairo": "Cairo", "UTC": "UTC"
};
const CITY_NAMES_BY_LOCALE = {
    "zh-CN": CITY_NAMES_ZH,
    "en-US": CITY_NAMES_EN
};
const formatters = new Map();
export function worldTime(date, zone) {
    let formatter = formatters.get(zone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
        formatters.set(zone, formatter);
    }
    const parts = formatter.formatToParts(date);
    const value = (type) => parts.find(part => part.type === type)?.value || "";
    const time = `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
    return { time, offsetMinutes: Math.round((Date.parse(time.replace(" ", "T") + "Z") - Math.floor(date.getTime() / 1000) * 1000) / 60000) };
}
/** ascii=true 时用普通减号：复制出去的文本要能被其它程序当作时区偏移解析，U+2212 减号不行 */
export function zoneLabel(minutes, ascii = false) {
    const abs = Math.abs(minutes);
    return `${minutes < 0 ? (ascii ? "-" : "−") : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
function availableZones() {
    const intl = Intl;
    return [...new Set([...Object.keys(CITY_NAMES_ZH), ...(intl.supportedValuesOf?.("timeZone") || [])])];
}
function ReferenceTimeForm({ onSave }) {
    useLocale();
    const [text, setText] = useState("");
    const [error, setError] = useState(undefined);
    const { pop } = useNavigation();
    return Form({ navigationTitle: t("wcFormTitle"), actions: ActionPanel({}, [Action.SubmitForm({ title: t("wcFormSubmit"), onSubmit: () => {
                    if (!text.trim()) {
                        setError(t("wcFormRequired"));
                        return;
                    }
                    const parsed = parseTimeInput(text);
                    if (!parsed.valid || !parsed.date) {
                        setError(parsed.error);
                        return;
                    }
                    onSave(parsed.date);
                    pop();
                } })]) }, [Form.TextField({ id: "time", title: t("wcFormFieldTitle"), value: text, placeholder: "2026-03-08T12:00:00+08:00", error, onChange: value => { setText(value); setError(undefined); } }), Form.Description({ text: t("wcFormDesc") })]);
}
export default function WorldClockCommand() {
    const locale = useLocale();
    const cityNames = CITY_NAMES_BY_LOCALE[locale] ?? CITY_NAMES_BY_LOCALE["en-US"];
    const [query, setQuery] = useState("");
    const [reference, setReference] = useState("Asia/Shanghai");
    const [fixed, setFixed] = useState(null);
    const [now, setNow] = useState(Date.now());
    const [zones] = useState(availableZones);
    const { push } = useNavigation();
    useEffect(() => {
        if (fixed !== null)
            return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [fixed]);
    const date = new Date(fixed ?? now);
    const baseline = worldTime(date, reference).offsetMinutes;
    const actions = [
        Action({ title: t("wcConvertAction"), icon: Icon.Calendar, onAction: () => push(() => ReferenceTimeForm({ onSave: value => setFixed(value.getTime()) })) }),
        Action({ title: t("wcResetAction"), icon: Icon.Repeat, onAction: () => { setFixed(null); setNow(Date.now()); } })
    ];
    const referenceOptions = cityNames[reference] ? Object.keys(cityNames) : [...Object.keys(cityNames), reference];
    const filtered = (query.trim() ? zones : Object.keys(cityNames)).filter(zone => `${CITY_NAMES_ZH[zone] || ""} ${CITY_NAMES_EN[zone] || ""} ${zone}`.toLowerCase().includes(query.trim().toLowerCase()));
    const refLabel = cityNames[reference] || reference;
    return List({ navigationTitle: t("wcNavTitle"), searchText: query, onSearchTextChange: setQuery, searchBarPlaceholder: t("wcSearchPlaceholder"), searchBarAccessory: List.Dropdown({ tooltip: t("wcRefTooltip"), value: reference, onChange: value => { if (zones.includes(value))
                setReference(value); } }, referenceOptions.map(zone => List.Dropdown.Item({ value: zone, title: cityNames[zone] || zone }))), actions: ActionPanel({}, actions) }, [List.Section({ title: fixed === null ? t("wcSectionLive", { ref: refLabel }) : t("wcSectionFixed", { ref: refLabel }) }, filtered.map(zone => {
            const value = worldTime(date, zone);
            return List.Item({ id: zone, title: cityNames[zone] || zone, subtitle: `${value.time} · UTC${zoneLabel(value.offsetMinutes)}`, icon: Icon.Clock, accessories: [{ text: t("wcOffsetAcc", { offset: zoneLabel(value.offsetMinutes - baseline) }) }], actions: ActionPanel({}, [Action({ title: t("wcCopyLocal"), icon: Icon.CopyClipboard, onAction: async () => {
                            const current = worldTime(new Date(fixed ?? Date.now()), zone);
                            await Clipboard.copy(`${current.time} UTC${zoneLabel(current.offsetMinutes, true)} (${zone})`);
                            await showToast(Toast.Style.Success, t("wcCopiedLocalToast"));
                        } }), ...(zone === reference ? [] : [Action({ title: t("wcSetRef"), icon: Icon.Pin, onAction: () => setReference(zone) })]), ...actions]) });
        }))]);
}

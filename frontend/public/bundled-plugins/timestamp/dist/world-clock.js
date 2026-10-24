import { List, Form, ActionPanel, Action, Icon, Clipboard, showToast, Toast, useState, useEffect, useNavigation } from "@ztools/declarative-ui";
import { parseTimeInput } from "./logic.js";
const CITY_NAMES = {
    "Asia/Shanghai": "北京 / 上海", "Asia/Hong_Kong": "香港", "Asia/Tokyo": "东京", "Asia/Seoul": "首尔",
    "Asia/Singapore": "新加坡", "Asia/Kolkata": "新德里", "Asia/Dubai": "迪拜", "Europe/London": "伦敦",
    "Europe/Paris": "巴黎", "Europe/Berlin": "柏林", "Europe/Moscow": "莫斯科", "America/New_York": "纽约",
    "America/Los_Angeles": "洛杉矶", "America/Chicago": "芝加哥", "America/Toronto": "多伦多",
    "America/Sao_Paulo": "圣保罗", "Australia/Sydney": "悉尼", "Pacific/Auckland": "奥克兰", "Africa/Cairo": "开罗", "UTC": "UTC"
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
export function zoneLabel(minutes) {
    const abs = Math.abs(minutes);
    return `${minutes < 0 ? "−" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
function availableZones() {
    const intl = Intl;
    return [...new Set([...Object.keys(CITY_NAMES), ...(intl.supportedValuesOf?.("timeZone") || [])])];
}
function ReferenceTimeForm({ onSave }) {
    const [text, setText] = useState("");
    const [error, setError] = useState(undefined);
    const { pop } = useNavigation();
    return Form({ navigationTitle: "设置要换算的时刻", actions: ActionPanel({}, [Action.SubmitForm({ title: "换算时间", onSubmit: () => {
                    if (!text.trim()) {
                        setError("请输入时间戳或日期");
                        return;
                    }
                    const parsed = parseTimeInput(text);
                    if (!parsed.valid || !parsed.date) {
                        setError(parsed.error);
                        return;
                    }
                    onSave(parsed.date);
                    pop();
                } })]) }, [Form.TextField({ id: "time", title: "时间戳或日期", value: text, placeholder: "2026-03-08T12:00:00+08:00", error, onChange: value => { setText(value); setError(undefined); } }), Form.Description({ text: "带时区的日期按给定偏移换算；未写时区时按本机时区解释。" })]);
}
export default function WorldClockCommand() {
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
        Action({ title: "换算指定时间…", icon: Icon.Calendar, onAction: () => push(() => ReferenceTimeForm({ onSave: value => setFixed(value.getTime()) })) }),
        Action({ title: "恢复当前时间", icon: Icon.Repeat, onAction: () => { setFixed(null); setNow(Date.now()); } })
    ];
    // 默认只显示常用城市，搜索时涵盖运行时支持的全部 IANA 时区。
    const filtered = (query.trim() ? zones : Object.keys(CITY_NAMES)).filter(zone => `${CITY_NAMES[zone] || ""} ${zone}`.toLowerCase().includes(query.trim().toLowerCase()));
    return List({ navigationTitle: "世界时钟", searchText: query, onSearchTextChange: setQuery, searchBarPlaceholder: "搜索城市或 IANA 时区，如 纽约、Europe/Paris", searchBarAccessory: List.Dropdown({ tooltip: "时差参考时区", value: reference, onChange: value => { if (zones.includes(value))
                setReference(value); } }, zones.map(zone => List.Dropdown.Item({ value: zone, title: CITY_NAMES[zone] || zone }))), actions: ActionPanel({}, actions) }, [List.Section({ title: `${fixed === null ? "当前时间" : "指定时刻"} · 相对 ${CITY_NAMES[reference] || reference} 的时差` }, filtered.map(zone => {
            const value = worldTime(date, zone);
            return List.Item({ id: zone, title: CITY_NAMES[zone] || zone, subtitle: `${value.time} · UTC${zoneLabel(value.offsetMinutes)}`, icon: Icon.Clock, accessories: [{ text: `时差 ${zoneLabel(value.offsetMinutes - baseline)}` }], actions: ActionPanel({}, [Action({ title: "复制当地时间", icon: Icon.CopyClipboard, onAction: async () => {
                            const current = worldTime(new Date(fixed ?? Date.now()), zone);
                            await Clipboard.copy(`${current.time} UTC${zoneLabel(current.offsetMinutes)} (${zone})`);
                            await showToast(Toast.Style.Success, "已复制当地时间");
                        } }), ...actions]) });
        }))]);
}

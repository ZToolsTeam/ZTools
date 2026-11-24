import { List, Form, ActionPanel, Action, Icon, Clipboard, getLocale, showToast, Toast, useState, useEffect, useNavigation, useLocale } from "@ztools/declarative-ui";
import { parseTimeInput } from "./logic.js";
import { t } from "./i18n.js";
import { CITY_NAMES_ZH, WORLD_CITIES } from "./world-clock.zh-data.js";
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
const DEFAULT_FALLBACK_TIMEZONE = "Asia/Shanghai";
// 按 IANA 时区索引城市库，避免每次渲染线性扫描
const CITIES_BY_ZONE = new Map();
for (const city of WORLD_CITIES) {
    const bucket = CITIES_BY_ZONE.get(city.tz);
    if (bucket)
        bucket.push(city);
    else
        CITIES_BY_ZONE.set(city.tz, [city]);
}
const formatters = new Map();
export function worldTime(date, zone) {
    const locale = getLocale();
    const cacheKey = `${locale}|${zone}`;
    let formatter = formatters.get(cacheKey);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat(locale, {
            timeZone: zone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
            numberingSystem: "latn"
        });
        formatters.set(cacheKey, formatter);
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
/** 自动检测本机系统时区；取不到或不是合法 IANA 时区时才降级到 Asia/Shanghai */
export function detectLocalTimeZone(fallback = DEFAULT_FALLBACK_TIMEZONE) {
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz) {
            new Intl.DateTimeFormat("en", { timeZone: tz });
            return tz;
        }
    }
    catch {
        // 降级到 fallback
    }
    return fallback;
}
/** 计算目标时区相对参考时区的自然日差（如 -1 / 0 / +1） */
export function getDayDiff(date, zone, referenceZone) {
    const toDayIndex = (z) => {
        const [y, m, d] = worldTime(date, z).time.slice(0, 10).split("-").map(Number);
        return Date.UTC(y, m - 1, d) / 86400000;
    };
    return toDayIndex(zone) - toDayIndex(referenceZone);
}
/** 将跨日差值格式化为本地化短标签（+1天 / -1天 / +1d / -1d；同日返回空串） */
export function formatDayDiffLabel(dayDiff) {
    if (!dayDiff)
        return "";
    const days = Math.abs(dayDiff);
    return dayDiff > 0 ? t("wcDayDiffPlus", { days }) : t("wcDayDiffMinus", { days });
}
/** 根据当前语言解析某 IANA 时区的友好显示名称 */
export function resolveZoneLabel(zone, locale = getLocale()) {
    const isZh = locale === "zh-CN";
    const presets = CITY_NAMES_BY_LOCALE[locale] ?? CITY_NAMES_BY_LOCALE["en-US"];
    if (presets[zone])
        return presets[zone];
    const cities = CITIES_BY_ZONE.get(zone);
    if (cities && cities.length > 0) {
        return isZh ? cities[0].name : cities[0].en;
    }
    return zone;
}
function availableZones() {
    const intl = Intl;
    return [
        ...new Set([
            ...Object.keys(CITY_NAMES_ZH),
            ...WORLD_CITIES.map(city => city.tz),
            ...(intl.supportedValuesOf?.("timeZone") || [])
        ])
    ];
}
/**
 * 中英文城市 / 国家 / IANA 时区检索（按时区聚合去重，避免同时间刷屏）：
 * - 空查询返回常用主要时区列表；
 * - 有查询时同时检索 320+ 全球城市库（中/英文城市名、国家、IANA 时区）与宿主全部 IANA 时区。
 */
export function searchWorldZones(query, zones, locale = getLocale()) {
    const trimmed = query.trim().toLowerCase();
    const presets = CITY_NAMES_BY_LOCALE[locale] ?? CITY_NAMES_BY_LOCALE["en-US"];
    if (!trimmed) {
        return Object.keys(presets).map(zone => ({ zone, title: presets[zone] }));
    }
    const isZh = locale === "zh-CN";
    const matchedByZone = new Map();
    for (const city of WORLD_CITIES) {
        const matches = city.name.toLowerCase().includes(trimmed) ||
            city.en.toLowerCase().includes(trimmed) ||
            city.country.toLowerCase().includes(trimmed) ||
            city.tz.toLowerCase().includes(trimmed);
        if (!matches)
            continue;
        const label = isZh ? city.name : city.en;
        const list = matchedByZone.get(city.tz);
        if (list) {
            if (!list.includes(label))
                list.push(label);
        }
        else {
            matchedByZone.set(city.tz, [label]);
        }
    }
    const results = [];
    const seen = new Set();
    for (const [zone, labels] of matchedByZone) {
        seen.add(zone);
        results.push({ zone, title: labels.slice(0, 3).join(" / ") });
    }
    for (const zone of zones) {
        if (seen.has(zone))
            continue;
        const haystack = `${CITY_NAMES_ZH[zone] || ""} ${CITY_NAMES_EN[zone] || ""} ${zone}`.toLowerCase();
        if (!haystack.includes(trimmed))
            continue;
        seen.add(zone);
        results.push({ zone, title: resolveZoneLabel(zone, locale) });
    }
    return results;
}
function ReferenceTimeForm({ onSave }) {
    useLocale();
    const [text, setText] = useState("");
    const [error, setError] = useState(undefined);
    const { pop } = useNavigation();
    return Form({
        navigationTitle: t("wcFormTitle"),
        actions: ActionPanel({}, [
            Action.SubmitForm({
                title: t("wcFormSubmit"),
                onSubmit: () => {
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
                }
            })
        ])
    }, [
        Form.TextField({
            id: "time",
            title: t("wcFormFieldTitle"),
            value: text,
            placeholder: "2026-03-08T12:00:00+08:00",
            error,
            onChange: value => { setText(value); setError(undefined); }
        }),
        Form.Description({ text: t("wcFormDesc") })
    ]);
}
export default function WorldClockCommand() {
    const locale = useLocale();
    const cityNames = CITY_NAMES_BY_LOCALE[locale] ?? CITY_NAMES_BY_LOCALE["en-US"];
    const [query, setQuery] = useState("");
    const [reference, setReference] = useState(() => detectLocalTimeZone());
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
    const filtered = searchWorldZones(query, zones, locale);
    const refLabel = resolveZoneLabel(reference, locale);
    return List({
        navigationTitle: t("wcNavTitle"),
        searchText: query,
        onSearchTextChange: setQuery,
        searchBarPlaceholder: t("wcSearchPlaceholder"),
        searchBarAccessory: List.Dropdown({ tooltip: t("wcRefTooltip"), value: reference, onChange: value => { if (zones.includes(value))
                setReference(value); } }, referenceOptions.map(zone => List.Dropdown.Item({ value: zone, title: resolveZoneLabel(zone, locale) }))),
        actions: ActionPanel({}, actions)
    }, [
        List.Section({ title: fixed === null ? t("wcSectionLive", { ref: refLabel }) : t("wcSectionFixed", { ref: refLabel }) }, filtered.map(({ zone, title }) => {
            const value = worldTime(date, zone);
            const dayLabel = formatDayDiffLabel(getDayDiff(date, zone, reference));
            return List.Item({
                id: zone,
                title,
                subtitle: `${value.time} · UTC${zoneLabel(value.offsetMinutes)}`,
                icon: Icon.Clock,
                accessories: [
                    ...(dayLabel ? [{ text: dayLabel }] : []),
                    { text: t("wcOffsetAcc", { offset: zoneLabel(value.offsetMinutes - baseline) }) }
                ],
                actions: ActionPanel({}, [
                    Action({
                        title: t("wcCopyLocal"),
                        icon: Icon.CopyClipboard,
                        onAction: async () => {
                            const current = worldTime(new Date(fixed ?? Date.now()), zone);
                            await Clipboard.copy(`${current.time} UTC${zoneLabel(current.offsetMinutes, true)} (${zone})`);
                            await showToast(Toast.Style.Success, t("wcCopiedLocalToast"));
                        }
                    }),
                    ...(zone === reference ? [] : [Action({ title: t("wcSetRef"), icon: Icon.Pin, onAction: () => setReference(zone) })]),
                    ...actions
                ])
            });
        }))
    ]);
}

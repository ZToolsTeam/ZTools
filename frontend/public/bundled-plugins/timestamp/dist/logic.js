import { getLocale } from "@ztools/declarative-ui";
/**
 * ZTools 时间戳助手核心转换逻辑 (纯函数)
 */
const LOGIC_STRINGS = {
    "zh-CN": {
        justNow: "刚刚",
        nowJustNow: "现在 (刚刚)",
        weekdays: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
        secFuture: (n) => `${n} 秒后`,
        secPast: (n) => `${n} 秒前`,
        minFuture: (n) => `${n} 分钟后`,
        minPast: (n) => `${n} 分钟前`,
        hourFuture: (n) => `${n} 小时后`,
        hourPast: (n) => `${n} 小时前`,
        dayFuture: (n) => `${n} 天后`,
        dayPast: (n) => `${n} 天前`,
        monthFuture: (n) => `${n} 个月后`,
        monthPast: (n) => `${n} 个月前`,
        yearFuture: (n) => `${n} 年后`,
        yearPast: (n) => `${n} 年前`,
        errOverflow: "时间戳数值超出安全表示范围",
        errInvalidDate: (text) => `「${text}」不是一个存在的日期或时间`,
        errUnparseable: (text) => `无法解析的时间内容: "${text}"，支持秒/毫秒时间戳，或带年份的标准日期（如 2024-01-31 08:00:00、ISO 8601、RFC 2822）`,
        errYearRange: (year) => `年份超出合理范围 (${year})，请检查时间戳位数是否混淆`
    },
    "en-US": {
        justNow: "Just now",
        nowJustNow: "Now (Just now)",
        weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        secFuture: (n) => `in ${n}s`,
        secPast: (n) => `${n}s ago`,
        minFuture: (n) => `in ${n}m`,
        minPast: (n) => `${n}m ago`,
        hourFuture: (n) => `in ${n}h`,
        hourPast: (n) => `${n}h ago`,
        dayFuture: (n) => `in ${n}d`,
        dayPast: (n) => `${n}d ago`,
        monthFuture: (n) => `in ${n}mo`,
        monthPast: (n) => `${n}mo ago`,
        yearFuture: (n) => `in ${n}y`,
        yearPast: (n) => `${n}y ago`,
        errOverflow: "Timestamp value exceeds safe numeric range",
        errInvalidDate: (text) => `"${text}" is not a valid calendar date or time`,
        errUnparseable: (text) => `Unable to parse "${text}". Supports Unix timestamps (sec/ms) or standard dates (e.g. 2024-01-31 08:00:00, ISO 8601, RFC 2822)`,
        errYearRange: (year) => `Year (${year}) is out of supported range (1970-2200); check seconds vs. milliseconds`
    }
};
function currentStrings() {
    const loc = getLocale();
    return LOGIC_STRINGS[loc] ?? LOGIC_STRINGS["en-US"];
}
function pad(n) {
    return n < 10 ? "0" + n : String(n);
}
export function formatDateTime(d) {
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const h = pad(d.getHours());
    const min = pad(d.getMinutes());
    const s = pad(d.getSeconds());
    return `${y}-${m}-${day} ${h}:${min}:${s}`;
}
export function formatBeijingTime(d) {
    // 只读 UTC 字段，避免本地 DST 偏移在加八小时后发生变化。
    return new Date(d.getTime() + 3600000 * 8).toISOString().slice(0, 19).replace("T", " ");
}
export function getRelativeTime(d, now = new Date()) {
    const s = currentStrings();
    const diffSec = Math.round((d.getTime() - now.getTime()) / 1000);
    const absSec = Math.abs(diffSec);
    const isFuture = diffSec > 0;
    if (absSec < 5)
        return s.justNow;
    if (absSec < 60)
        return isFuture ? s.secFuture(absSec) : s.secPast(absSec);
    const diffMin = Math.round(absSec / 60);
    if (diffMin < 60)
        return isFuture ? s.minFuture(diffMin) : s.minPast(diffMin);
    const diffHour = Math.round(diffMin / 60);
    if (diffHour < 24)
        return isFuture ? s.hourFuture(diffHour) : s.hourPast(diffHour);
    const diffDay = Math.round(diffHour / 24);
    if (diffDay < 30)
        return isFuture ? s.dayFuture(diffDay) : s.dayPast(diffDay);
    const diffMonth = Math.round(diffDay / 30);
    if (diffMonth < 12)
        return isFuture ? s.monthFuture(diffMonth) : s.monthPast(diffMonth);
    const diffYear = Math.round(diffDay / 365);
    return isFuture ? s.yearFuture(diffYear) : s.yearPast(diffYear);
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = "(?:mon|tue|wed|thu|fri|sat|sun)";
const MONTH_NAMES = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)";
const ZONE = "(z|utc|gmt|ut|[+-]\\d{2}:?\\d{2})";
// 年-月-日[ 时:分[:秒[.毫秒]]][时区]：- / . 年月日 分隔，日期与时间之间用空格或 T（ISO 8601）
const YMD_RE = new RegExp("^(\\d{4})[-/.年](\\d{1,2})[-/.月](\\d{1,2})日?(?:[\\sT]+(\\d{1,2}):(\\d{1,2})(?::(\\d{1,2})(?:\\.(\\d{1,9}))?)?)?\\s*" + ZONE + "?$", "i");
// 美式 月/日/年[ 时:分[:秒]]
const US_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/;
// RFC 2822 / Date#toUTCString：[Tue, ]14 Nov 2023 22:13[:20] [GMT|+0800]
const RFC_RE = new RegExp("^(?:" + WEEKDAYS + ",?\\s+)?(\\d{1,2})\\s+" + MONTH_NAMES + "\\s+(\\d{4})\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*" + ZONE + "?$", "i");
// Date#toString：Tue Nov 14 2023 22:13:20 GMT+0800 (中国标准时间)
const JS_DATE_RE = new RegExp("^" + WEEKDAYS + "\\s+" + MONTH_NAMES + "\\s+(\\d{1,2})\\s+(\\d{4})\\s+(\\d{1,2}):(\\d{2}):(\\d{2})\\s+GMT([+-]\\d{4})(?:\\s+\\(.*\\))?$", "i");
function toInt(v) {
    return v ? parseInt(v, 10) : 0;
}
/** "Z"/"UTC"/"+08:00"/"-0500" → 偏移分钟；未写时区返回 null；格式合法但数值越界返回 NaN */
function parseOffset(zone) {
    if (!zone)
        return null;
    const z = zone.toLowerCase();
    if (z === "z" || z === "utc" || z === "gmt" || z === "ut")
        return 0;
    const m = z.match(/^([+-])(\d{2}):?(\d{2})$/);
    if (!m)
        return NaN;
    const h = parseInt(m[2], 10);
    const min = parseInt(m[3], 10);
    if (h > 23 || min > 59)
        return NaN;
    return (m[1] === "-" ? -1 : 1) * (h * 60 + min);
}
function fractionToMs(frac) {
    return frac ? parseInt((frac + "00").slice(0, 3), 10) : 0;
}
function withOffset(f, zone) {
    const off = parseOffset(zone);
    if (off !== null && isNaN(off))
        return { ...f, offsetMinutes: 0, badOffset: true };
    return { ...f, offsetMinutes: off };
}
/** 识别受支持的日期写法；不在白名单内返回 null */
function matchDateFields(text) {
    let m = text.match(YMD_RE);
    if (m) {
        return withOffset({
            year: toInt(m[1]), month: toInt(m[2]), day: toInt(m[3]),
            hour: toInt(m[4]), minute: toInt(m[5]), second: toInt(m[6]), millisecond: fractionToMs(m[7])
        }, m[8]);
    }
    m = text.match(US_RE);
    if (m) {
        return {
            year: toInt(m[3]), month: toInt(m[1]), day: toInt(m[2]),
            hour: toInt(m[4]), minute: toInt(m[5]), second: toInt(m[6]), millisecond: 0, offsetMinutes: null
        };
    }
    m = text.match(RFC_RE);
    if (m) {
        return withOffset({
            year: toInt(m[3]), month: MONTHS.indexOf(m[2].toLowerCase()) + 1, day: toInt(m[1]),
            hour: toInt(m[4]), minute: toInt(m[5]), second: toInt(m[6]), millisecond: 0
        }, m[7]);
    }
    m = text.match(JS_DATE_RE);
    if (m) {
        return withOffset({
            year: toInt(m[3]), month: MONTHS.indexOf(m[1].toLowerCase()) + 1, day: toInt(m[2]),
            hour: toInt(m[4]), minute: toInt(m[5]), second: toInt(m[6]), millisecond: 0
        }, m[7]);
    }
    return null;
}
/** 按字段构造日期；不存在的日期/时间（2 月 30 日、25 点、夏令时跳过的时刻）返回 null，不顺延 */
function buildExactDate(f) {
    if (f.badOffset)
        return null;
    if (f.offsetMinutes === null) {
        const local = new Date(f.year, f.month - 1, f.day, f.hour, f.minute, f.second, f.millisecond);
        const exact = local.getFullYear() === f.year && local.getMonth() === f.month - 1 && local.getDate() === f.day &&
            local.getHours() === f.hour && local.getMinutes() === f.minute && local.getSeconds() === f.second;
        return exact ? local : null;
    }
    const wall = new Date(Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second, f.millisecond));
    const exact = wall.getUTCFullYear() === f.year && wall.getUTCMonth() === f.month - 1 && wall.getUTCDate() === f.day &&
        wall.getUTCHours() === f.hour && wall.getUTCMinutes() === f.minute && wall.getUTCSeconds() === f.second;
    return exact ? new Date(wall.getTime() - f.offsetMinutes * 60000) : null;
}
/**
 * 解析用户输入的时间戳或日期字符串
 */
export function parseTimeInput(rawInput, referenceNow = new Date()) {
    const text = (rawInput || "").trim();
    const s = currentStrings();
    // 空输入默认当前时间
    if (!text) {
        const d = referenceNow;
        return {
            valid: true,
            date: d,
            unixSeconds: Math.floor(d.getTime() / 1000),
            unixMilliseconds: d.getTime(),
            localDateTime: formatDateTime(d),
            beijingDateTime: formatBeijingTime(d),
            utcIso: d.toISOString(),
            relativeTime: s.nowJustNow,
            dayOfWeek: s.weekdays[d.getDay()]
        };
    }
    let date = null;
    // 1. 纯数字时间戳判断
    if (/^-?\d+$/.test(text)) {
        const num = Number(text);
        if (isNaN(num)) {
            return { valid: false, error: s.errOverflow };
        }
        // 10 位数左右 (秒级)
        if (Math.abs(num) < 1e11) {
            date = new Date(num * 1000);
        }
        else {
            // 13 位数 (毫秒级)
            date = new Date(num);
        }
    }
    else {
        // 2. 只接受白名单内的日期写法并逐字段严格校验；不再交给宽松的 Date.parse，
        //    否则 "abc 1"、"version 3.2"、"Oct 21" 会被 V8 补成 2001 年的伪造日期
        const fields = matchDateFields(text);
        if (fields) {
            date = buildExactDate(fields);
            if (!date) {
                return { valid: false, error: s.errInvalidDate(text) };
            }
        }
    }
    if (!date || isNaN(date.getTime())) {
        return {
            valid: false,
            error: s.errUnparseable(text)
        };
    }
    // 边界保护：检查年份合理范围 (1970 ~ 2100)
    const fullYear = date.getUTCFullYear();
    if (fullYear < 1970 || fullYear > 2200) {
        return {
            valid: false,
            error: s.errYearRange(fullYear)
        };
    }
    return {
        valid: true,
        date,
        unixSeconds: Math.floor(date.getTime() / 1000),
        unixMilliseconds: date.getTime(),
        localDateTime: formatDateTime(date),
        beijingDateTime: formatBeijingTime(date),
        utcIso: date.toISOString(),
        relativeTime: getRelativeTime(date, referenceNow),
        dayOfWeek: s.weekdays[date.getDay()]
    };
}

export const SUPPORTED_CURRENCIES = [
    { code: "USD", name: "美元 (US Dollar)", symbol: "$", flag: "🇺🇸", centralBank: "Federal Reserve" },
    { code: "CNY", name: "人民币 (Chinese Yuan)", symbol: "¥", flag: "🇨🇳", centralBank: "People's Bank of China" },
    { code: "EUR", name: "欧元 (Euro)", symbol: "€", flag: "🇪🇺", centralBank: "European Central Bank" },
    { code: "JPY", name: "日元 (Japanese Yen)", symbol: "¥", flag: "🇯🇵", centralBank: "Bank of Japan" },
    { code: "GBP", name: "英镑 (British Pound)", symbol: "£", flag: "🇬🇧", centralBank: "Bank of England" },
    { code: "HKD", name: "港币 (Hong Kong Dollar)", symbol: "HK$", flag: "🇭🇰", centralBank: "Hong Kong Monetary Authority" },
    { code: "CAD", name: "加拿大元 (Canadian Dollar)", symbol: "CA$", flag: "🇨🇦", centralBank: "Bank of Canada" },
    { code: "AUD", name: "澳大利亚元 (Australian Dollar)", symbol: "A$", flag: "🇦🇺", centralBank: "Reserve Bank of Australia" },
    { code: "SGD", name: "新加坡元 (Singapore Dollar)", symbol: "S$", flag: "🇸🇬", centralBank: "Monetary Authority of Singapore" },
    { code: "CHF", name: "瑞士法郎 (Swiss Franc)", symbol: "CHF", flag: "🇨🇭", centralBank: "Swiss National Bank" }
];
// 基准汇率对 (锚定 1 USD)
export const USD_RATES = {
    USD: 1.0,
    CNY: 7.235,
    EUR: 0.918,
    JPY: 148.65,
    GBP: 0.772,
    HKD: 7.785,
    CAD: 1.354,
    AUD: 1.492,
    SGD: 1.308,
    CHF: 0.852
};
export function parseAmountAndCurrency(input, defaultCurrency = "USD") {
    const trimmed = input.trim();
    if (!trimmed) {
        return { amount: 100, currency: defaultCurrency };
    }
    // 匹配前缀符号
    if (trimmed.startsWith("$")) {
        const num = parseFloat(trimmed.slice(1));
        return { amount: isNaN(num) ? 100 : num, currency: "USD" };
    }
    if (trimmed.startsWith("¥")) {
        const num = parseFloat(trimmed.slice(1));
        return { amount: isNaN(num) ? 100 : num, currency: "CNY" };
    }
    if (trimmed.startsWith("€")) {
        const num = parseFloat(trimmed.slice(1));
        return { amount: isNaN(num) ? 100 : num, currency: "EUR" };
    }
    if (trimmed.startsWith("£")) {
        const num = parseFloat(trimmed.slice(1));
        return { amount: isNaN(num) ? 100 : num, currency: "GBP" };
    }
    // 匹配例如 "250 EUR" 或 "100"
    const match = trimmed.match(/^([\d.,]+)\s*([a-zA-Z]{3})?$/);
    if (match) {
        const num = parseFloat(match[1].replace(/,/g, ""));
        const code = match[2]?.toUpperCase();
        const validCode = code && USD_RATES[code] ? code : defaultCurrency;
        return { amount: isNaN(num) ? 100 : num, currency: validCode };
    }
    return { amount: 100, currency: defaultCurrency };
}
export function convertCurrency(amount, fromCode, toCode) {
    const rateFrom = USD_RATES[fromCode] || 1.0;
    const rateTo = USD_RATES[toCode] || 1.0;
    // 先转成 USD 再转成目标币种
    const inUsd = amount / rateFrom;
    return inUsd * rateTo;
}
export function calculateAllConversions(amount, baseCurrency) {
    return SUPPORTED_CURRENCIES.map((cur) => {
        const rateAgainstBase = convertCurrency(1, baseCurrency, cur.code);
        const inverseRate = convertCurrency(1, cur.code, baseCurrency);
        const converted = amount * rateAgainstBase;
        return {
            code: cur.code,
            name: cur.name,
            symbol: cur.symbol,
            flag: cur.flag,
            rateAgainstBase: Number(rateAgainstBase.toFixed(4)),
            inverseRate: Number(inverseRate.toFixed(4)),
            convertedAmount: Number(converted.toFixed(2)),
            formattedAmount: `${cur.symbol} ${converted.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            })}`,
            change24h: cur.code === baseCurrency ? "0.00%" : "+0.15%"
        };
    });
}

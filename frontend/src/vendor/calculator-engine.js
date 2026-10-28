// 由 scripts/sync-bundled-plugins.mjs 从 plugins/calculator/dist/calculator-engine.js 生成，请勿手改
/**
 * 实时数学计算与色彩检测引擎 (Safe Expression Evaluator & Color Inspector)
 * 纯算法实现，彻底禁止 eval() 与 new Function()，完全符合 AST 安全扫描规范
 */
import { calculatorPluginStorage as LocalStorage } from '../utils/calculatorPluginStorage.js';
const HISTORY_STORAGE_KEY = "ztools-calculator-history-v1";
/** 未置顶历史最多保留的条数；置顶项不受限制，不会被淘汰 */
export const MAX_RECENT_HISTORY = 100;
/** 单独一个数字（可带正负号、小数、科学计数法）：1e-9、-12.5、.5 */
const PLAIN_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
/** 单独一个整数（可带正负号） */
const PLAIN_INTEGER_RE = /^[+-]?\d+$/;
/** 单独一个带前缀的进制字面量：0xFF、0b1010、0o77 */
const RADIX_LITERAL_RE = /^(0x[0-9a-f]+|0b[01]+|0o[0-7]+)$/;
/** 换算里的数字：可带正负号，最多一个小数点 */
const UNIT_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
/**
 * 计算结果的显示格式：
 * - 0 与 -0 统一显示 0；
 * - 普通整数加千分位；
 * - 绝对值小于 1e-6 或不小于 1e21 用科学计数法（15 位有效数字），避免极小数被舍成 0；
 * - 其余小数保留 15 位有效数字（双精度可靠位数，去掉 0.1+0.2 这类浮点尾差）。
 */
export function formatCalculatorNumber(val) {
    if (val === 0)
        return "0";
    const abs = Math.abs(val);
    if (abs < 1e-6 || abs >= 1e21)
        return String(Number(val.toPrecision(15)));
    if (Number.isInteger(val))
        return val.toLocaleString("en-US");
    return val.toLocaleString("en-US", { maximumSignificantDigits: 15 });
}
/** 按小数位四舍五入，并把 -0 规范成 0 */
function roundTo(val, digits) {
    const rounded = parseFloat(val.toFixed(digits));
    return rounded === 0 ? 0 : rounded;
}
const FUNCTIONS = new Set([
    "sqrt", "cbrt", "sin", "cos", "tan", "asin", "acos", "atan",
    "log", "log10", "log2", "ln", "abs", "round", "floor", "ceil", "exp"
]);
const CONSTANTS = {
    pi: Math.PI,
    e: Math.E
};
function tokenize(expr) {
    const tokens = [];
    let i = 0;
    const s = expr.trim();
    // 隐式乘法：2(3)、2pi、(1+2)(3+4)、3sqrt(4)
    const pushImplicitMultiply = () => {
        const prev = tokens[tokens.length - 1];
        if (prev && (prev.type === "NUMBER" || prev.type === "CONST" || prev.type === "RPAREN")) {
            tokens.push({ type: "OP", value: "*" });
        }
    };
    while (i < s.length) {
        const c = s[i];
        if (/\s/.test(c)) {
            i++;
            continue;
        }
        if (/[0-9.]/.test(c)) {
            pushImplicitMultiply();
            let numStr = "";
            while (i < s.length && /[0-9.]/.test(s[i])) {
                numStr += s[i++];
            }
            // 科学计数法：1e21、2.5E-3
            const sci = s.slice(i).match(/^[eE][+-]?\d+/);
            if (sci) {
                numStr += sci[0];
                i += sci[0].length;
            }
            if ((numStr.match(/\./g) || []).length > 1 || numStr === ".")
                throw new Error(`数字格式不正确: "${numStr}"`);
            // 数字后的 % ：后面紧跟数字或括号时是取余（10 % 3），否则是百分号（50%）
            if (i < s.length && s[i] === "%" && !/^%\s*[0-9.(a-zA-Z]/.test(s.slice(i))) {
                i++;
                tokens.push({ type: "NUMBER", value: parseFloat(numStr) / 100 });
            }
            else {
                tokens.push({ type: "NUMBER", value: parseFloat(numStr) });
            }
            continue;
        }
        if (c === "*" && s[i + 1] === "*") {
            tokens.push({ type: "OP", value: "^" });
            i += 2;
            continue;
        }
        if (c === "+" || c === "-" || c === "*" || c === "/" || c === "^" || c === "%" || c === "×" || c === "÷") {
            // 出现在开头、左括号或运算符之后的 +/- 是正负号，不是加减
            const prev = tokens[tokens.length - 1];
            const isPrefix = !prev || prev.type === "OP" || prev.type === "NEG" || prev.type === "LPAREN" || prev.type === "FUNC";
            if (isPrefix && (c === "-" || c === "+")) {
                if (c === "-")
                    tokens.push({ type: "NEG", value: "neg" });
                i++;
                continue;
            }
            tokens.push({ type: "OP", value: c === "×" ? "*" : c === "÷" ? "/" : c });
            i++;
            continue;
        }
        if (c === "(") {
            pushImplicitMultiply();
            tokens.push({ type: "LPAREN", value: "(" });
            i++;
            continue;
        }
        if (c === ")") {
            tokens.push({ type: "RPAREN", value: ")" });
            i++;
            continue;
        }
        if (/[a-zA-Z]/.test(c)) {
            let word = "";
            while (i < s.length && /[a-zA-Z0-9]/.test(s[i])) {
                word += s[i++];
            }
            const lower = word.toLowerCase();
            if (FUNCTIONS.has(lower) || CONSTANTS[lower] !== undefined)
                pushImplicitMultiply();
            if (FUNCTIONS.has(lower)) {
                tokens.push({ type: "FUNC", value: lower });
            }
            else if (CONSTANTS[lower] !== undefined) {
                tokens.push({ type: "CONST", value: CONSTANTS[lower] });
            }
            else {
                throw new Error(`未知标识符: "${word}"`);
            }
            continue;
        }
        throw new Error(`非法输入字符: "${c}"`);
    }
    return tokens;
}
const PRECEDENCE = {
    "+": 1,
    "-": 1,
    "*": 2,
    "/": 2,
    "%": 2,
    neg: 2.5,
    "^": 3
};
function shuntingYard(tokens) {
    const output = [];
    const ops = [];
    for (const token of tokens) {
        if (token.type === "NUMBER" || token.type === "CONST") {
            output.push(token);
        }
        else if (token.type === "FUNC" || token.type === "NEG") {
            // 前缀运算（函数、负号）直接入栈，等右侧操作数就绪后再弹出
            ops.push(token);
        }
        else if (token.type === "OP") {
            const op = token.value;
            while (ops.length > 0 &&
                (ops[ops.length - 1].type === "OP" || ops[ops.length - 1].type === "NEG") &&
                (PRECEDENCE[ops[ops.length - 1].value] > PRECEDENCE[op] ||
                    (PRECEDENCE[ops[ops.length - 1].value] === PRECEDENCE[op] && op !== "^"))) {
                output.push(ops.pop());
            }
            ops.push(token);
        }
        else if (token.type === "LPAREN") {
            ops.push(token);
        }
        else if (token.type === "RPAREN") {
            while (ops.length > 0 && ops[ops.length - 1].type !== "LPAREN") {
                output.push(ops.pop());
            }
            if (ops.length === 0)
                throw new Error("括号不匹配");
            ops.pop(); // pop LPAREN
            if (ops.length > 0 && ops[ops.length - 1].type === "FUNC") {
                output.push(ops.pop());
            }
        }
    }
    while (ops.length > 0) {
        const top = ops.pop();
        if (top.type === "LPAREN" || top.type === "RPAREN") {
            throw new Error("括号不匹配");
        }
        output.push(top);
    }
    return output;
}
function evaluateRpn(rpn) {
    const stack = [];
    for (const token of rpn) {
        if (token.type === "NUMBER") {
            stack.push(token.value);
        }
        else if (token.type === "CONST") {
            stack.push(token.value);
        }
        else if (token.type === "NEG") {
            if (stack.length < 1)
                throw new Error("负号后缺少数字");
            stack.push(-stack.pop());
        }
        else if (token.type === "OP") {
            if (stack.length < 2)
                throw new Error("运算符参数不足");
            const b = stack.pop();
            const a = stack.pop();
            switch (token.value) {
                case "+":
                    stack.push(a + b);
                    break;
                case "-":
                    stack.push(a - b);
                    break;
                case "*":
                    stack.push(a * b);
                    break;
                case "/":
                    if (b === 0)
                        throw new Error("除数不能为零");
                    stack.push(a / b);
                    break;
                case "%":
                    if (b === 0)
                        throw new Error("除数不能为零");
                    stack.push(a % b);
                    break;
                case "^":
                    stack.push(Math.pow(a, b));
                    break;
                default: throw new Error(`未实现的运算符: ${token.value}`);
            }
        }
        else if (token.type === "FUNC") {
            if (stack.length < 1)
                throw new Error("函数参数不足");
            const arg = stack.pop();
            switch (token.value) {
                case "sqrt":
                    if (arg < 0)
                        throw new Error("负数没有实数平方根");
                    stack.push(Math.sqrt(arg));
                    break;
                case "cbrt":
                    stack.push(Math.cbrt(arg));
                    break;
                case "sin":
                    stack.push(Math.sin(arg));
                    break;
                case "cos":
                    stack.push(Math.cos(arg));
                    break;
                case "tan":
                    stack.push(Math.tan(arg));
                    break;
                case "asin":
                    stack.push(Math.asin(arg));
                    break;
                case "acos":
                    stack.push(Math.acos(arg));
                    break;
                case "atan":
                    stack.push(Math.atan(arg));
                    break;
                case "log":
                case "log10":
                    stack.push(Math.log10(arg));
                    break;
                case "log2":
                    stack.push(Math.log2(arg));
                    break;
                case "ln":
                    stack.push(Math.log(arg));
                    break;
                case "abs":
                    stack.push(Math.abs(arg));
                    break;
                case "round":
                    stack.push(Math.round(arg));
                    break;
                case "floor":
                    stack.push(Math.floor(arg));
                    break;
                case "ceil":
                    stack.push(Math.ceil(arg));
                    break;
                case "exp":
                    stack.push(Math.exp(arg));
                    break;
                default: throw new Error(`未实现的函数: ${token.value}`);
            }
        }
    }
    if (stack.length !== 1)
        throw new Error("计算表达式格式不完整");
    const result = stack[0];
    if (!Number.isFinite(result))
        throw new Error("计算结果溢出或无实数解");
    return result;
}
export function evaluateMathExpression(input) {
    if (!input || typeof input !== "string") {
        return { isCalculation: false, expression: "", answer: null, formattedAnswer: "" };
    }
    const trimmed = input.trim();
    const hasMathSignal = /[+\-*/%^()×÷]/.test(trimmed) || /^\d[\d.]*\s*pi$/i.test(trimmed) ||
        PLAIN_NUMBER_RE.test(trimmed) ||
        /^(sqrt|cbrt|sin|cos|tan|asin|acos|atan|log|log10|log2|ln|abs|round|floor|ceil|exp|pi|e)\b/i.test(trimmed);
    if (!hasMathSignal) {
        return { isCalculation: false, expression: trimmed, answer: null, formattedAnswer: "" };
    }
    try {
        const tokens = tokenize(trimmed);
        if (tokens.length === 0) {
            return { isCalculation: false, expression: trimmed, answer: null, formattedAnswer: "" };
        }
        const rpn = shuntingYard(tokens);
        const raw = evaluateRpn(rpn);
        const val = raw === 0 ? 0 : raw; // -0 规范成 0
        return {
            isCalculation: true,
            expression: trimmed,
            answer: val,
            // 单独一个整数（如进制换算的十进制结果填回）按 BigInt 原样显示：超过 2^53 的整数用 Number 会丢精度
            formattedAnswer: PLAIN_INTEGER_RE.test(trimmed)
                ? BigInt(trimmed).toLocaleString("en-US")
                : formatCalculatorNumber(val)
        };
    }
    catch (err) {
        return {
            isCalculation: true,
            expression: trimmed,
            answer: null,
            formattedAnswer: "",
            error: err instanceof Error ? err.message : String(err)
        };
    }
}
// =========================================================================
// 2. Unit Conversions (px<->rem, distance, mass, temperature, storage, radix)
// =========================================================================
const LENGTH_RATIOS = {
    m: 1,
    km: 1000,
    cm: 0.01,
    mm: 0.001,
    mi: 1609.344,
    miles: 1609.344,
    mile: 1609.344,
    ft: 0.3048,
    feet: 0.3048,
    foot: 0.3048,
    in: 0.0254,
    inch: 0.0254,
    inches: 0.0254,
    yd: 0.9144,
    yard: 0.9144,
    yards: 0.9144
};
const MASS_RATIOS = {
    g: 1,
    kg: 1000,
    mg: 0.001,
    lb: 453.59237,
    lbs: 453.59237,
    pound: 453.59237,
    pounds: 453.59237,
    oz: 28.349523125,
    ounce: 28.349523125,
    ounces: 28.349523125
};
const DIGITAL_RATIOS = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    tb: 1024 * 1024 * 1024 * 1024,
    pb: 1024 * 1024 * 1024 * 1024 * 1024
};
export function convertUnits(input, options = {}) {
    if (!input || typeof input !== "string")
        return null;
    const s = input.trim().toLowerCase();
    const remBase = options.remBase || 16;
    // 1. px <-> rem（数字先按宽松模式匹配，再严格校验，格式不对时给出明确错误而不是静默取前半段）
    const cssMatch = s.match(/^([+-]?[\d.]+)\s*(px|rem)\s*(?:to|in|=)\s*(px|rem)$/);
    if (cssMatch) {
        const from = cssMatch[2];
        const to = cssMatch[3];
        const val = parseUnitNumber(cssMatch[1]);
        if (val === null)
            return unitError(input, cssMatch[1], from, to, "css");
        if (from === to) {
            return {
                isConversion: true,
                expression: input.trim(),
                value: val,
                formattedAnswer: `${val} ${to}`,
                fromUnit: from,
                toUnit: to,
                category: "css"
            };
        }
        // value 与显示一致（舍入后的值），填回输入框后得到的就是界面上看到的数
        const resVal = from === "px" ? roundTo(val / remBase, 4) : roundTo(val * remBase, 2);
        if (!Number.isFinite(resVal))
            return unitOverflow(input, from, to, "css");
        return {
            isConversion: true,
            expression: input.trim(),
            value: resVal,
            formattedAnswer: `${resVal} ${to}`,
            fromUnit: from,
            toUnit: to,
            category: "css"
        };
    }
    // 2. Radix: 0xFF to dec, 255 to hex, 255 to bin, 0b1010 to dec, 0o77 to dec
    // 单独一个带前缀的进制字面量（0xFF、0b11111111）按「转十进制」处理：进制结果填回输入框后仍有结果行
    const literalMatch = s.match(RADIX_LITERAL_RE);
    if (literalMatch) {
        const num = BigInt(literalMatch[1]);
        return {
            isConversion: true,
            expression: input.trim(),
            value: Number(num),
            formattedAnswer: num.toString(10),
            fromUnit: "radix",
            toUnit: "dec",
            category: "radix"
        };
    }
    const radixMatch = s.match(/^(0x[0-9a-f]+|0b[01]+|0o[0-7]+|\d+)\s*(?:to|in|=)\s*(dec|hex|bin|oct)$/);
    if (radixMatch) {
        const rawVal = radixMatch[1];
        const targetRadix = radixMatch[2];
        // 用 BigInt 换算：超过 2^53 的整数用 Number 会丢精度（0xFFFFFFFFFFFFFFFF 会变成 18446744073709552000）
        // BigInt 原生识别 0x / 0b / 0o 前缀，正则已保证各进制只含合法数字
        let num;
        try {
            num = BigInt(rawVal);
        }
        catch {
            return null;
        }
        let ans = "";
        switch (targetRadix) {
            case "dec":
                ans = num.toString(10);
                break;
            case "hex":
                ans = "0x" + num.toString(16).toUpperCase();
                break;
            case "bin":
                ans = "0b" + num.toString(2);
                break;
            case "oct":
                ans = "0o" + num.toString(8);
                break;
        }
        return {
            isConversion: true,
            expression: input.trim(),
            value: Number(num),
            formattedAnswer: ans,
            fromUnit: "radix",
            toUnit: targetRadix,
            category: "radix"
        };
    }
    // 3. General units with pattern: "<number> <from> to/in <to>"
    const unitMatch = s.match(/^([+-]?[\d.]+)\s*([a-z]+)\s*(?:to|in|=)\s*([a-z]+)$/);
    if (unitMatch) {
        const from = unitMatch[2];
        const to = unitMatch[3];
        const category = getUnitCategory(from, to);
        // 不认识的单位组合不当作换算，交给后面的日期 / 算式判断
        if (!category)
            return null;
        const val = parseUnitNumber(unitMatch[1]);
        if (val === null)
            return unitError(input, unitMatch[1], from, to, category);
        // Temperature: c, f, k, celsius, fahrenheit, kelvin
        if (category === "temp") {
            const fromNorm = from.startsWith("c") ? "c" : from.startsWith("f") ? "f" : "k";
            const toNorm = to.startsWith("c") ? "c" : to.startsWith("f") ? "f" : "k";
            let cVal = val;
            if (fromNorm === "f")
                cVal = (val - 32) * (5 / 9);
            if (fromNorm === "k")
                cVal = val - 273.15;
            // 低于绝对零度（0 K = -273.15 °C）的温度不存在；留 1e-9 容差避免浮点误差误报
            if (cVal < -273.15 - 1e-9) {
                return {
                    isConversion: true,
                    expression: input.trim(),
                    value: NaN,
                    formattedAnswer: "",
                    fromUnit: from,
                    toUnit: to,
                    category,
                    error: "温度不能低于绝对零度（0 K / -273.15 °C / -459.67 °F）"
                };
            }
            let targetVal = cVal;
            if (toNorm === "f")
                targetVal = cVal * (9 / 5) + 32;
            if (toNorm === "k")
                targetVal = cVal + 273.15;
            const rounded = roundTo(targetVal, 2);
            if (!Number.isFinite(rounded))
                return unitOverflow(input, from, to, "temp");
            return {
                isConversion: true,
                expression: input.trim(),
                value: rounded,
                formattedAnswer: `${rounded} °${toNorm.toUpperCase()}`,
                fromUnit: from,
                toUnit: to,
                category: "temp"
            };
        }
        // Length
        if (LENGTH_RATIOS[from] && LENGTH_RATIOS[to]) {
            const inMeters = val * LENGTH_RATIOS[from];
            const targetVal = inMeters / LENGTH_RATIOS[to];
            const rounded = roundTo(targetVal, 4);
            if (!Number.isFinite(rounded))
                return unitOverflow(input, from, to, category);
            return {
                isConversion: true,
                expression: input.trim(),
                value: rounded,
                formattedAnswer: `${rounded} ${to}`,
                fromUnit: from,
                toUnit: to,
                category: "length"
            };
        }
        // Mass
        if (MASS_RATIOS[from] && MASS_RATIOS[to]) {
            const inGrams = val * MASS_RATIOS[from];
            const targetVal = inGrams / MASS_RATIOS[to];
            const rounded = roundTo(targetVal, 4);
            if (!Number.isFinite(rounded))
                return unitOverflow(input, from, to, category);
            return {
                isConversion: true,
                expression: input.trim(),
                value: rounded,
                formattedAnswer: `${rounded} ${to}`,
                fromUnit: from,
                toUnit: to,
                category: "mass"
            };
        }
        // Digital
        if (DIGITAL_RATIOS[from] && DIGITAL_RATIOS[to]) {
            const inBytes = val * DIGITAL_RATIOS[from];
            const targetVal = inBytes / DIGITAL_RATIOS[to];
            const rounded = roundTo(targetVal, 4);
            if (!Number.isFinite(rounded))
                return unitOverflow(input, from, to, category);
            return {
                isConversion: true,
                expression: input.trim(),
                value: rounded,
                formattedAnswer: `${rounded} ${to.toUpperCase()}`,
                fromUnit: from,
                toUnit: to,
                category: "digital"
            };
        }
    }
    return null;
}
const TEMP_UNITS = new Set(["c", "f", "k", "celsius", "fahrenheit", "kelvin"]);
function getUnitCategory(from, to) {
    if (TEMP_UNITS.has(from) && TEMP_UNITS.has(to))
        return "temp";
    if (LENGTH_RATIOS[from] && LENGTH_RATIOS[to])
        return "length";
    if (MASS_RATIOS[from] && MASS_RATIOS[to])
        return "mass";
    if (DIGITAL_RATIOS[from] && DIGITAL_RATIOS[to])
        return "digital";
    return null;
}
/** 严格解析换算数字：格式不对（1.5.5、.、1..2）或不是有限数时返回 null */
function parseUnitNumber(raw) {
    if (!UNIT_NUMBER_RE.test(raw))
        return null;
    const val = Number(raw);
    return Number.isFinite(val) ? val : null;
}
/** 换算结果超出双精度范围（如 1e308 km to mm）：报错，不能显示 Infinity */
function unitOverflow(input, from, to, category) {
    return {
        isConversion: true,
        expression: input.trim(),
        value: NaN,
        formattedAnswer: "",
        fromUnit: from,
        toUnit: to,
        category,
        error: "换算结果超出数值范围"
    };
}
function unitError(input, rawNumber, from, to, category) {
    return {
        isConversion: true,
        expression: input.trim(),
        value: NaN,
        formattedAnswer: "",
        fromUnit: from,
        toUnit: to,
        category,
        error: `数字格式不正确: "${rawNumber}"`
    };
}
// =========================================================================
// 3. Date Calculation（汇率换算已移除：没有实时汇率来源时不提供估算值）
// =========================================================================
const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const DATE_UNIT_SOURCE = "(days?|weeks?|months?|years?|hours?|mins?|minutes?)";
/** now / today 加减：now + 2 weeks、today - 3 days */
const RELATIVE_DATE_RE = new RegExp(`^(now|today)\\s*([+-])\\s*(\\d+)\\s*${DATE_UNIT_SOURCE}$`);
/** 日期字面量（日期结果的显示格式），可单独出现或接着加减：2026-11-05、2026-11-05 14:30 + 2 hours */
const LITERAL_DATE_RE = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})(?:\\s+(\\d{2}):(\\d{2}))?(?:\\s*([+-])\\s*(\\d+)\\s*${DATE_UNIT_SOURCE})?$`);
function pad2(n) {
    return String(n).padStart(2, "0");
}
function formatDateValue(d, withTime) {
    const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    return withTime ? `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : date;
}
function shiftDate(d, sign, count, unit) {
    if (unit.startsWith("min")) {
        d.setMinutes(d.getMinutes() + sign * count);
    }
    else if (unit.startsWith("hour")) {
        d.setHours(d.getHours() + sign * count);
    }
    else if (unit.startsWith("day")) {
        d.setDate(d.getDate() + sign * count);
    }
    else if (unit.startsWith("week")) {
        d.setDate(d.getDate() + sign * count * 7);
    }
    else if (unit.startsWith("month")) {
        d.setMonth(d.getMonth() + sign * count);
    }
    else if (unit.startsWith("year")) {
        d.setFullYear(d.getFullYear() + sign * count);
    }
}
/** 「星期四 · 14 天后」：日期字面量的说明 */
function describeDate(d) {
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((startOf(d) - startOf(new Date())) / 86400000);
    const rel = diff === 0 ? "今天" : diff > 0 ? `${diff} 天后` : `${-diff} 天前`;
    return `${WEEKDAYS[d.getDay()]} · ${rel}`;
}
function dateError(input, error) {
    return {
        isDate: true,
        expression: input.trim(),
        targetDate: new Date(NaN),
        formattedAnswer: "",
        details: "",
        error
    };
}
export function evaluateDateExpression(input) {
    if (!input || typeof input !== "string")
        return null;
    const s = input.trim().toLowerCase();
    // 1. now / today 加减
    const rel = s.match(RELATIVE_DATE_RE);
    if (rel) {
        const op = rel[2];
        const count = parseInt(rel[3], 10);
        const unit = rel[4];
        const target = new Date();
        shiftDate(target, op === "+" ? 1 : -1, count, unit);
        if (Number.isNaN(target.getTime()))
            return dateError(input, "日期超出可表示范围");
        return {
            isDate: true,
            expression: input.trim(),
            targetDate: target,
            formattedAnswer: formatDateValue(target, unit.startsWith("hour") || unit.startsWith("min")),
            details: `${input.trim()} (${op === "+" ? "未来" : "过去"} ${count} ${unit})`
        };
    }
    // 2. 日期字面量（可接着加减）：「将结果填入输入框」填回的就是这种格式，再次计算得到同一日期
    const lit = s.match(LITERAL_DATE_RE);
    if (!lit)
        return null;
    const [year, month, day] = [lit[1], lit[2], lit[3]].map(v => parseInt(v, 10));
    const hasTime = lit[4] !== undefined;
    const hour = hasTime ? parseInt(lit[4], 10) : 0;
    const minute = hasTime ? parseInt(lit[5], 10) : 0;
    const target = new Date(year, month - 1, day, hour, minute);
    // 2026-02-30、2026-13-01、25:00 这类不存在的日期报错，不能被 Date 自动进位成别的日期，也不能落到算式按减法求值
    if (hour > 23 || minute > 59 ||
        target.getFullYear() !== year || target.getMonth() !== month - 1 || target.getDate() !== day) {
        return dateError(input, `日期不存在: "${input.trim()}"`);
    }
    const op = lit[6];
    if (!op) {
        return {
            isDate: true,
            expression: input.trim(),
            targetDate: target,
            formattedAnswer: formatDateValue(target, hasTime),
            details: describeDate(target)
        };
    }
    const count = parseInt(lit[7], 10);
    const unit = lit[8];
    shiftDate(target, op === "+" ? 1 : -1, count, unit);
    if (Number.isNaN(target.getTime()))
        return dateError(input, "日期超出可表示范围");
    return {
        isDate: true,
        expression: input.trim(),
        targetDate: target,
        formattedAnswer: formatDateValue(target, hasTime || unit.startsWith("hour") || unit.startsWith("min")),
        details: `${describeDate(target)} (${op === "+" ? "往后" : "往前"} ${count} ${unit})`
    };
}
// =========================================================================
// 5. Color Inspector & Formats (HEX, RGB, HSL, CMYK, WCAG)
// =========================================================================
export function inspectColor(input) {
    if (!input || typeof input !== "string")
        return null;
    const s = input.trim().toLowerCase();
    let r = 0, g = 0, b = 0, a = 1;
    // 1. HEX 解析: #RGB, #RGBA, #RRGGBB, #RRGGBBAA
    const hexMatch = s.match(/^#([0-9a-f]{3,8})$/i);
    if (hexMatch) {
        const h = hexMatch[1];
        if (h.length === 3) {
            r = parseInt(h[0] + h[0], 16);
            g = parseInt(h[1] + h[1], 16);
            b = parseInt(h[2] + h[2], 16);
        }
        else if (h.length === 4) {
            r = parseInt(h[0] + h[0], 16);
            g = parseInt(h[1] + h[1], 16);
            b = parseInt(h[2] + h[2], 16);
            a = Math.round((parseInt(h[3] + h[3], 16) / 255) * 100) / 100;
        }
        else if (h.length === 6) {
            r = parseInt(h.slice(0, 2), 16);
            g = parseInt(h.slice(2, 4), 16);
            b = parseInt(h.slice(4, 6), 16);
        }
        else if (h.length === 8) {
            r = parseInt(h.slice(0, 2), 16);
            g = parseInt(h.slice(2, 4), 16);
            b = parseInt(h.slice(4, 6), 16);
            a = Math.round((parseInt(h.slice(6, 8), 16) / 255) * 100) / 100;
        }
        else {
            return null;
        }
    }
    else {
        // 2. RGB / RGBA 解析
        const rgbMatch = s.match(/^rgba?\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([\d.]+))?\s*\)$/i);
        if (rgbMatch) {
            r = Math.min(255, parseInt(rgbMatch[1], 10));
            g = Math.min(255, parseInt(rgbMatch[2], 10));
            b = Math.min(255, parseInt(rgbMatch[3], 10));
            if (rgbMatch[4] !== undefined)
                a = Math.max(0, Math.min(1, parseFloat(rgbMatch[4])));
        }
        else {
            // 3. HSL / HSLA 解析
            const hslMatch = s.match(/^hsla?\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%(?:\s*,\s*([\d.]+))?\s*\)$/i);
            if (hslMatch) {
                const h = parseInt(hslMatch[1], 10) % 360;
                const sat = Math.min(100, parseInt(hslMatch[2], 10)) / 100;
                const lit = Math.min(100, parseInt(hslMatch[3], 10)) / 100;
                if (hslMatch[4] !== undefined)
                    a = Math.max(0, Math.min(1, parseFloat(hslMatch[4])));
                const rgb = hslToRgbValues(h, sat, lit);
                r = rgb.r;
                g = rgb.g;
                b = rgb.b;
            }
            else {
                return null;
            }
        }
    }
    const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase();
    const rgb = a < 1 ? `rgba(${r}, ${g}, ${b}, ${a})` : `rgb(${r}, ${g}, ${b})`;
    const hslValues = rgbToHslValues(r, g, b);
    const hsl = a < 1
        ? `hsla(${hslValues.h}, ${hslValues.s}%, ${hslValues.l}%, ${a})`
        : `hsl(${hslValues.h}, ${hslValues.s}%, ${hslValues.l}%)`;
    const cmyk = rgbToCmykString(r, g, b);
    const lum = getLuminance(r, g, b);
    const contrastWhite = Math.round(((1 + 0.05) / (lum + 0.05)) * 100) / 100;
    const contrastBlack = Math.round(((lum + 0.05) / (0 + 0.05)) * 100) / 100;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="8" fill="${hex}" /></svg>`;
    const svgDataUri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    return {
        isColor: true,
        hex,
        rgb,
        hsl,
        cmyk,
        r,
        g,
        b,
        a,
        contrastWhite,
        contrastBlack,
        svgDataUri
    };
}
function hslToRgbValues(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r1 = 0, g1 = 0, b1 = 0;
    if (h < 60) {
        r1 = c;
        g1 = x;
    }
    else if (h < 120) {
        r1 = x;
        g1 = c;
    }
    else if (h < 180) {
        g1 = c;
        b1 = x;
    }
    else if (h < 240) {
        g1 = x;
        b1 = c;
    }
    else if (h < 300) {
        r1 = x;
        b1 = c;
    }
    else {
        r1 = c;
        b1 = x;
    }
    return {
        r: Math.round((r1 + m) * 255),
        g: Math.round((g1 + m) * 255),
        b: Math.round((b1 + m) * 255)
    };
}
function rgbToHslValues(r, g, b) {
    const rNorm = r / 255, gNorm = g / 255, bNorm = b / 255;
    const max = Math.max(rNorm, gNorm, bNorm), min = Math.min(rNorm, gNorm, bNorm);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case rNorm:
                h = (gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0);
                break;
            case gNorm:
                h = (bNorm - rNorm) / d + 2;
                break;
            case bNorm:
                h = (rNorm - gNorm) / d + 4;
                break;
        }
        h = Math.round(h * 60);
    }
    return { h, s: Math.round(s * 100), l: Math.round(l * 100) };
}
function rgbToCmykString(r, g, b) {
    const rNorm = r / 255, gNorm = g / 255, bNorm = b / 255;
    const k = 1 - Math.max(rNorm, gNorm, bNorm);
    if (k === 1)
        return "cmyk(0%, 0%, 0%, 100%)";
    const c = Math.round(((1 - rNorm - k) / (1 - k)) * 100);
    const m = Math.round(((1 - gNorm - k) / (1 - k)) * 100);
    const y = Math.round(((1 - bNorm - k) / (1 - k)) * 100);
    return `cmyk(${c}%, ${m}%, ${y}%, ${Math.round(k * 100)}%)`;
}
function getLuminance(r, g, b) {
    const a = [r, g, b].map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}
// =========================================================================
// 6. Unified Calculator Query Evaluator
// =========================================================================
export function evaluateCalculatorQuery(input, options = {}) {
    if (!input || typeof input !== "string" || !input.trim()) {
        return {
            type: "none",
            expression: "",
            formattedAnswer: ""
        };
    }
    const s = input.trim();
    // 1. Color check
    const color = inspectColor(s);
    if (color) {
        return {
            type: "color",
            expression: s,
            formattedAnswer: color.hex,
            // 半透明色填回 rgba(...)：只填 HEX 会丢掉透明度，再次识别就成了另一种颜色
            fillText: color.a < 1 ? color.rgb : color.hex,
            colorResult: color,
            details: `${color.rgb} | ${color.hsl} | ${color.cmyk}`
        };
    }
    // 2. Unit conversion check (px/rem, distance, mass, temp, storage, radix)
    const unit = convertUnits(s, options);
    if (unit && unit.isConversion) {
        if (unit.error) {
            return { type: "unit", expression: s, formattedAnswer: "", error: unit.error };
        }
        return {
            type: "unit",
            expression: s,
            formattedAnswer: unit.formattedAnswer,
            rawAnswer: unit.value,
            // 进制结果原样填回（0xFF、0b1010 单独出现时按转十进制计算；十进制整数按 BigInt 精确显示），
            // 其余换算填回不带单位的数值（与显示一致的舍入值），都能再次计算出同一数值
            fillText: unit.category === "radix" ? unit.formattedAnswer : String(unit.value),
            details: `单位换算 (${unit.category.toUpperCase()}): ${unit.fromUnit} -> ${unit.toUnit}`
        };
    }
    // 4. Date calculation check
    const dateRes = evaluateDateExpression(s);
    if (dateRes && dateRes.isDate) {
        if (dateRes.error) {
            return { type: "date", expression: s, formattedAnswer: "", error: dateRes.error };
        }
        return {
            type: "date",
            expression: s,
            formattedAnswer: dateRes.formattedAnswer,
            // 填回 2026-11-05 / 2026-11-05 14:30：日期字面量再次计算得到同一日期，不会被当成减法
            fillText: dateRes.formattedAnswer,
            rawAnswer: dateRes.targetDate,
            details: dateRes.details
        };
    }
    // 5. Math expression check
    const math = evaluateMathExpression(s);
    if (math.isCalculation) {
        return {
            type: "math",
            expression: s,
            formattedAnswer: math.formattedAnswer,
            rawAnswer: math.answer,
            // 去掉千分位，填回输入框后还能继续计算（786,432 → 786432）
            fillText: math.error ? undefined : math.formattedAnswer.replace(/,/g, ""),
            error: math.error
        };
    }
    return {
        type: "none",
        expression: s,
        formattedAnswer: ""
    };
}
// =========================================================================
// 7. Calculator History & Pinning Persistence
// =========================================================================
export async function getCalculatorHistory() {
    return parseCalculatorHistory(await LocalStorage.getItem(HISTORY_STORAGE_KEY));
}
/** 只有首次使用才返回空数组；损坏值保留，不能在它上面继续写入。 */
function parseCalculatorHistory(raw) {
    if (raw === undefined)
        return [];
    if (!Array.isArray(raw) || raw.some(item => !item || typeof item.id !== "string" || !item.id || typeof item.expression !== "string" ||
        typeof item.answer !== "string" || !["math", "unit", "currency", "date", "color"].includes(item.type) ||
        typeof item.timestamp !== "number" || !Number.isFinite(item.timestamp) || (item.pinned !== undefined && typeof item.pinned !== "boolean")) ||
        new Set(raw.map(item => item.id)).size !== raw.length)
        throw new Error("计算历史数据损坏，原数据已保留，请先恢复数据后重试");
    return raw;
}
async function changeCalculatorHistory(update) {
    if (typeof LocalStorage.updateItem !== "function")
        throw new Error("请升级 ZTools 以安全保存计算历史");
    return LocalStorage.updateItem(HISTORY_STORAGE_KEY, raw => update(parseCalculatorHistory(raw)));
}
export async function saveCalculatorHistory(items, expected = []) {
    parseCalculatorHistory(items);
    await changeCalculatorHistory(current => {
        if (JSON.stringify(current) !== JSON.stringify(expected))
            throw new Error("计算历史已变化，请重新读取后重试");
        return items;
    });
}
export async function addCalculatorHistory(expression, answer, type) {
    if (typeof globalThis.crypto?.randomUUID !== 'function') {
        throw new Error('无法生成唯一标识，请重启客户端后重试');
    }
    const id = `calc-${Date.now()}-${globalThis.crypto.randomUUID()}`, timestamp = Date.now();
    return changeCalculatorHistory(current => {
        // 同一算式保留最新 id 与置顶状态；只淘汰超过上限的未置顶历史。
        const existing = current.find(item => item.expression === expression);
        const newItem = { id: existing?.id || id, expression, answer, type, pinned: existing?.pinned === true, timestamp };
        let recentCount = 0;
        return [newItem, ...current.filter(item => item.expression !== expression)].filter(item => item.pinned || ++recentCount <= MAX_RECENT_HISTORY);
    });
}
export async function togglePinCalculatorHistory(id) {
    return changeCalculatorHistory(current => current.map(item => item.id === id ? { ...item, pinned: !item.pinned } : item));
}
export async function deleteCalculatorHistory(id) {
    return changeCalculatorHistory(current => current.filter(item => item.id !== id));
}
export async function clearCalculatorHistory() {
    await changeCalculatorHistory(() => []);
}

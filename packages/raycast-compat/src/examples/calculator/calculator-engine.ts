/**
 * 实时数学计算与色彩检测引擎 (Safe Expression Evaluator & Color Inspector)
 * 纯算法实现，彻底禁止 eval() 与 new Function()，完全符合 AST 安全扫描规范
 */
import { LocalStorage } from "../../api/storage.js";

export interface CalculationResult {
  isCalculation: boolean;
  expression: string;
  answer: number | null;
  formattedAnswer: string;
  error?: string;
}

export interface CalculatorColorResult {
  isColor: boolean;
  hex: string;
  rgb: string;
  hsl: string;
  cmyk: string;
  r: number;
  g: number;
  b: number;
  a: number;
  contrastWhite: number;
  contrastBlack: number;
  svgDataUri: string;
}

export interface UnitConversionResult {
  isConversion: boolean;
  expression: string;
  value: number;
  formattedAnswer: string;
  fromUnit: string;
  toUnit: string;
  category: "css" | "length" | "mass" | "temp" | "digital" | "radix";
  error?: string;
}

export interface CurrencyConversionResult {
  isCurrency: boolean;
  expression: string;
  amount: number;
  fromCurrency: string;
  toCurrency: string;
  convertedAmount: number;
  formattedAnswer: string;
  rate: number;
  error?: string;
}

export interface DateCalculationResult {
  isDate: boolean;
  expression: string;
  targetDate: Date;
  formattedAnswer: string;
  details: string;
  error?: string;
}

export interface CalculatorQueryResult {
  type: "math" | "unit" | "currency" | "date" | "color" | "none";
  expression: string;
  formattedAnswer: string;
  rawAnswer?: any;
  details?: string;
  colorResult?: CalculatorColorResult;
  error?: string;
}

export interface CalculatorHistoryItem {
  id: string;
  expression: string;
  answer: string;
  type: "math" | "unit" | "currency" | "date" | "color";
  pinned?: boolean;
  timestamp: number;
}

const HISTORY_STORAGE_KEY = "ztools-calculator-history-v1";

// =========================================================================
// 1. Math Expression Evaluator (Shunting-yard Algorithm & AST-safe Tokenizer)
// =========================================================================

type TokenType = "NUMBER" | "OP" | "LPAREN" | "RPAREN" | "FUNC" | "CONST";

interface Token {
  type: TokenType;
  value: string | number;
}

const FUNCTIONS = new Set([
  "sqrt", "cbrt", "sin", "cos", "tan", "asin", "acos", "atan",
  "log", "log10", "log2", "ln", "abs", "round", "floor", "ceil", "exp"
]);

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E
};

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = expr.trim();

  while (i < s.length) {
    const c = s[i];

    if (/\s/.test(c)) {
      i++;
      continue;
    }

    if (/[0-9.]/.test(c)) {
      let numStr = "";
      while (i < s.length && /[0-9.]/.test(s[i])) {
        numStr += s[i++];
      }
      // Check for percentage
      if (i < s.length && s[i] === "%") {
        i++;
        tokens.push({ type: "NUMBER", value: parseFloat(numStr) / 100 });
      } else {
        tokens.push({ type: "NUMBER", value: parseFloat(numStr) });
      }
      continue;
    }

    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "^" || c === "%") {
      // 区分负号与减号：如果 '-' 在表达式首部或紧随左括号或运算符，则视作负数单目运算
      if (c === "-") {
        const prev = tokens[tokens.length - 1];
        if (!prev || prev.type === "OP" || prev.type === "LPAREN") {
          // Unary minus: represented as 0 - x
          tokens.push({ type: "NUMBER", value: 0 });
          tokens.push({ type: "OP", value: "-" });
          i++;
          continue;
        }
      }
      tokens.push({ type: "OP", value: c });
      i++;
      continue;
    }

    if (c === "(") {
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
      if (FUNCTIONS.has(lower)) {
        tokens.push({ type: "FUNC", value: lower });
      } else if (CONSTANTS[lower] !== undefined) {
        tokens.push({ type: "CONST", value: CONSTANTS[lower] });
      } else {
        throw new Error(`未知标识符: "${word}"`);
      }
      continue;
    }

    throw new Error(`非法输入字符: "${c}"`);
  }

  return tokens;
}

const PRECEDENCE: Record<string, number> = {
  "+": 1,
  "-": 1,
  "*": 2,
  "/": 2,
  "%": 2,
  "^": 3
};

function shuntingYard(tokens: Token[]): Token[] {
  const output: Token[] = [];
  const ops: Token[] = [];

  for (const token of tokens) {
    if (token.type === "NUMBER" || token.type === "CONST") {
      output.push(token);
    } else if (token.type === "FUNC") {
      ops.push(token);
    } else if (token.type === "OP") {
      const op = token.value as string;
      while (
        ops.length > 0 &&
        ops[ops.length - 1].type === "OP" &&
        (PRECEDENCE[ops[ops.length - 1].value as string] > PRECEDENCE[op] ||
          (PRECEDENCE[ops[ops.length - 1].value as string] === PRECEDENCE[op] && op !== "^"))
      ) {
        output.push(ops.pop()!);
      }
      ops.push(token);
    } else if (token.type === "LPAREN") {
      ops.push(token);
    } else if (token.type === "RPAREN") {
      while (ops.length > 0 && ops[ops.length - 1].type !== "LPAREN") {
        output.push(ops.pop()!);
      }
      if (ops.length === 0) throw new Error("括号不匹配");
      ops.pop(); // pop LPAREN
      if (ops.length > 0 && ops[ops.length - 1].type === "FUNC") {
        output.push(ops.pop()!);
      }
    }
  }

  while (ops.length > 0) {
    const top = ops.pop()!;
    if (top.type === "LPAREN" || top.type === "RPAREN") {
      throw new Error("括号不匹配");
    }
    output.push(top);
  }

  return output;
}

function evaluateRpn(rpn: Token[]): number {
  const stack: number[] = [];

  for (const token of rpn) {
    if (token.type === "NUMBER") {
      stack.push(token.value as number);
    } else if (token.type === "CONST") {
      stack.push(token.value as number);
    } else if (token.type === "OP") {
      if (stack.length < 2) throw new Error("运算符参数不足");
      const b = stack.pop()!;
      const a = stack.pop()!;
      switch (token.value) {
        case "+": stack.push(a + b); break;
        case "-": stack.push(a - b); break;
        case "*": stack.push(a * b); break;
        case "/":
          if (b === 0) throw new Error("除数不能为零");
          stack.push(a / b);
          break;
        case "%": stack.push(a % b); break;
        case "^": stack.push(Math.pow(a, b)); break;
        default: throw new Error(`未实现的运算符: ${token.value}`);
      }
    } else if (token.type === "FUNC") {
      if (stack.length < 1) throw new Error("函数参数不足");
      const arg = stack.pop()!;
      switch (token.value) {
        case "sqrt":
          if (arg < 0) throw new Error("负数没有实数平方根");
          stack.push(Math.sqrt(arg));
          break;
        case "cbrt": stack.push(Math.cbrt(arg)); break;
        case "sin": stack.push(Math.sin(arg)); break;
        case "cos": stack.push(Math.cos(arg)); break;
        case "tan": stack.push(Math.tan(arg)); break;
        case "asin": stack.push(Math.asin(arg)); break;
        case "acos": stack.push(Math.acos(arg)); break;
        case "atan": stack.push(Math.atan(arg)); break;
        case "log":
        case "log10": stack.push(Math.log10(arg)); break;
        case "log2": stack.push(Math.log2(arg)); break;
        case "ln": stack.push(Math.log(arg)); break;
        case "abs": stack.push(Math.abs(arg)); break;
        case "round": stack.push(Math.round(arg)); break;
        case "floor": stack.push(Math.floor(arg)); break;
        case "ceil": stack.push(Math.ceil(arg)); break;
        case "exp": stack.push(Math.exp(arg)); break;
        default: throw new Error(`未实现的函数: ${token.value}`);
      }
    }
  }

  if (stack.length !== 1) throw new Error("计算表达式格式不完整");
  const result = stack[0];
  if (!Number.isFinite(result)) throw new Error("计算结果溢出或无实数解");
  return result;
}

export function evaluateMathExpression(input: string): CalculationResult {
  if (!input || typeof input !== "string") {
    return { isCalculation: false, expression: "", answer: null, formattedAnswer: "" };
  }

  const trimmed = input.trim();
  const hasMathSignal = /[+\-*/%^()]/.test(trimmed) ||
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
    const val = evaluateRpn(rpn);

    let formatted = "";
    if (Number.isInteger(val)) {
      formatted = val.toLocaleString("en-US");
    } else {
      const fixed = parseFloat(val.toFixed(8));
      formatted = fixed.toLocaleString("en-US", { maximumFractionDigits: 8 });
    }

    return {
      isCalculation: true,
      expression: trimmed,
      answer: val,
      formattedAnswer: formatted
    };
  } catch (err: any) {
    return {
      isCalculation: true,
      expression: trimmed,
      answer: null,
      formattedAnswer: "",
      error: err.message || String(err)
    };
  }
}

// =========================================================================
// 2. Unit Conversions (px<->rem, distance, mass, temperature, storage, radix)
// =========================================================================

const LENGTH_RATIOS: Record<string, number> = {
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

const MASS_RATIOS: Record<string, number> = {
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

const DIGITAL_RATIOS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  tb: 1024 * 1024 * 1024 * 1024,
  pb: 1024 * 1024 * 1024 * 1024 * 1024
};

export function convertUnits(
  input: string,
  options: { remBase?: number } = {}
): UnitConversionResult | null {
  if (!input || typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  const remBase = options.remBase || 16;

  // 1. px <-> rem
  const cssMatch = s.match(/^([\d.]+)\s*(px|rem)\s*(?:to|in|=)\s*(px|rem)$/);
  if (cssMatch) {
    const val = parseFloat(cssMatch[1]);
    const from = cssMatch[2];
    const to = cssMatch[3];
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
    const resVal = from === "px" ? val / remBase : val * remBase;
    const formatted = from === "px"
      ? `${parseFloat(resVal.toFixed(4))} rem`
      : `${parseFloat(resVal.toFixed(2))} px`;

    return {
      isConversion: true,
      expression: input.trim(),
      value: resVal,
      formattedAnswer: formatted,
      fromUnit: from,
      toUnit: to,
      category: "css"
    };
  }

  // 2. Radix: 0xFF to dec, 255 to hex, 255 to bin, 0b1010 to dec, 0o77 to dec
  const radixMatch = s.match(/^(0x[0-9a-f]+|0b[01]+|0o[0-7]+|\d+)\s*(?:to|in|=)\s*(dec|hex|bin|oct)$/);
  if (radixMatch) {
    const rawVal = radixMatch[1];
    const targetRadix = radixMatch[2];
    let num: number;
    if (rawVal.startsWith("0x")) {
      num = parseInt(rawVal.slice(2), 16);
    } else if (rawVal.startsWith("0b")) {
      num = parseInt(rawVal.slice(2), 2);
    } else if (rawVal.startsWith("0o")) {
      num = parseInt(rawVal.slice(2), 8);
    } else {
      num = parseInt(rawVal, 10);
    }

    if (isNaN(num)) return null;

    let ans = "";
    switch (targetRadix) {
      case "dec": ans = num.toString(10); break;
      case "hex": ans = "0x" + num.toString(16).toUpperCase(); break;
      case "bin": ans = "0b" + num.toString(2); break;
      case "oct": ans = "0o" + num.toString(8); break;
    }

    return {
      isConversion: true,
      expression: input.trim(),
      value: num,
      formattedAnswer: ans,
      fromUnit: "radix",
      toUnit: targetRadix,
      category: "radix"
    };
  }

  // 3. General units with pattern: "<number> <from> to/in <to>"
  const unitMatch = s.match(/^([\d.]+)\s*([a-z]+)\s*(?:to|in|=)\s*([a-z]+)$/);
  if (unitMatch) {
    const val = parseFloat(unitMatch[1]);
    const from = unitMatch[2];
    const to = unitMatch[3];

    // Temperature: c, f, k, celsius, fahrenheit, kelvin
    const tempUnits = new Set(["c", "f", "k", "celsius", "fahrenheit", "kelvin"]);
    if (tempUnits.has(from) && tempUnits.has(to)) {
      const fromNorm = from.startsWith("c") ? "c" : from.startsWith("f") ? "f" : "k";
      const toNorm = to.startsWith("c") ? "c" : to.startsWith("f") ? "f" : "k";
      let cVal = val;
      if (fromNorm === "f") cVal = (val - 32) * (5 / 9);
      if (fromNorm === "k") cVal = val - 273.15;

      let targetVal = cVal;
      if (toNorm === "f") targetVal = cVal * (9 / 5) + 32;
      if (toNorm === "k") targetVal = cVal + 273.15;

      const rounded = parseFloat(targetVal.toFixed(2));
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
      const rounded = parseFloat(targetVal.toFixed(4));
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
      const rounded = parseFloat(targetVal.toFixed(4));
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
      const rounded = parseFloat(targetVal.toFixed(4));
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

// =========================================================================
// 3. Currency Conversion (Estimates against USD base)
// =========================================================================

export const CURRENCY_RATES_USD: Record<string, number> = {
  USD: 1.0,
  CNY: 7.25,
  RMB: 7.25,
  EUR: 0.92,
  GBP: 0.78,
  JPY: 154.5,
  HKD: 7.78,
  CAD: 1.38,
  AUD: 1.52,
  SGD: 1.35,
  CHF: 0.88,
  KRW: 1380.0,
  BTC: 0.000015
};

const SYMBOL_MAP: Record<string, string> = {
  "$": "USD",
  "￥": "CNY",
  "€": "EUR",
  "£": "GBP"
};

export function convertCalculatorCurrency(input: string): CurrencyConversionResult | null {
  if (!input || typeof input !== "string") return null;
  const s = input.trim();

  // Pattern: "100 USD in CNY", "50 EUR to USD", "$100 in CNY"
  const m = s.match(/^([$￥€£]?)\s*([\d.]+)\s*([A-Za-z]{3}|[$￥€£]|RMB)?\s*(?:to|in|=)\s*([A-Za-z]{3}|[$￥€£]|RMB)$/i);
  if (!m) return null;

  const prefixSym = m[1];
  const amount = parseFloat(m[2]);
  let fromCode = (m[3] || (prefixSym ? SYMBOL_MAP[prefixSym] : "")).toUpperCase();
  let toCode = m[4].toUpperCase();

  if (SYMBOL_MAP[fromCode]) fromCode = SYMBOL_MAP[fromCode];
  if (SYMBOL_MAP[toCode]) toCode = SYMBOL_MAP[toCode];

  if (!fromCode || !CURRENCY_RATES_USD[fromCode] || !CURRENCY_RATES_USD[toCode]) {
    return null;
  }

  const inUsd = amount / CURRENCY_RATES_USD[fromCode];
  const converted = inUsd * CURRENCY_RATES_USD[toCode];
  const rate = CURRENCY_RATES_USD[toCode] / CURRENCY_RATES_USD[fromCode];

  const formattedAmount = converted >= 100
    ? converted.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : converted.toFixed(4);

  return {
    isCurrency: true,
    expression: input.trim(),
    amount,
    fromCurrency: fromCode,
    toCurrency: toCode,
    convertedAmount: converted,
    formattedAnswer: `${formattedAmount} ${toCode}`,
    rate
  };
}

// =========================================================================
// 4. Date & Time Arithmetic
// =========================================================================

export function evaluateDateExpression(input: string): DateCalculationResult | null {
  if (!input || typeof input !== "string") return null;
  const s = input.trim().toLowerCase();

  // Patterns: "now + 2 weeks", "today - 3 days", "now + 5 hours", "today + 1 month"
  const m = s.match(/^(now|today)\s*([+-])\s*(\d+)\s*(days?|weeks?|months?|years?|hours?|mins?|minutes?)$/);
  if (!m) return null;

  const op = m[2];
  const count = parseInt(m[3], 10);
  const unit = m[4];

  const now = new Date();
  const sign = op === "+" ? 1 : -1;

  if (unit.startsWith("min")) {
    now.setMinutes(now.getMinutes() + sign * count);
  } else if (unit.startsWith("hour")) {
    now.setHours(now.getHours() + sign * count);
  } else if (unit.startsWith("day")) {
    now.setDate(now.getDate() + sign * count);
  } else if (unit.startsWith("week")) {
    now.setDate(now.getDate() + sign * count * 7);
  } else if (unit.startsWith("month")) {
    now.setMonth(now.getMonth() + sign * count);
  } else if (unit.startsWith("year")) {
    now.setFullYear(now.getFullYear() + sign * count);
  }

  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");

  const formatted = unit.startsWith("hour") || unit.startsWith("min")
    ? `${yyyy}-${mm}-${dd} ${hh}:${min}`
    : `${yyyy}-${mm}-${dd}`;

  return {
    isDate: true,
    expression: input.trim(),
    targetDate: now,
    formattedAnswer: formatted,
    details: `${input.trim()} (${op === "+" ? "未来" : "过去"} ${count} ${unit})`
  };
}

// =========================================================================
// 5. Color Inspector & Formats (HEX, RGB, HSL, CMYK, WCAG)
// =========================================================================

export function inspectColor(input: string): CalculatorColorResult | null {
  if (!input || typeof input !== "string") return null;
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
    } else if (h.length === 4) {
      r = parseInt(h[0] + h[0], 16);
      g = parseInt(h[1] + h[1], 16);
      b = parseInt(h[2] + h[2], 16);
      a = Math.round((parseInt(h[3] + h[3], 16) / 255) * 100) / 100;
    } else if (h.length === 6) {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    } else if (h.length === 8) {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
      a = Math.round((parseInt(h.slice(6, 8), 16) / 255) * 100) / 100;
    } else {
      return null;
    }
  } else {
    // 2. RGB / RGBA 解析
    const rgbMatch = s.match(/^rgba?\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([\d.]+))?\s*\)$/i);
    if (rgbMatch) {
      r = Math.min(255, parseInt(rgbMatch[1], 10));
      g = Math.min(255, parseInt(rgbMatch[2], 10));
      b = Math.min(255, parseInt(rgbMatch[3], 10));
      if (rgbMatch[4] !== undefined) a = Math.max(0, Math.min(1, parseFloat(rgbMatch[4])));
    } else {
      // 3. HSL / HSLA 解析
      const hslMatch = s.match(/^hsla?\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%(?:\s*,\s*([\d.]+))?\s*\)$/i);
      if (hslMatch) {
        const h = parseInt(hslMatch[1], 10) % 360;
        const sat = Math.min(100, parseInt(hslMatch[2], 10)) / 100;
        const lit = Math.min(100, parseInt(hslMatch[3], 10)) / 100;
        if (hslMatch[4] !== undefined) a = Math.max(0, Math.min(1, parseFloat(hslMatch[4])));

        const rgb = hslToRgbValues(h, sat, lit);
        r = rgb.r;
        g = rgb.g;
        b = rgb.b;
      } else {
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

function hslToRgbValues(h: number, s: number, l: number) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0, g1 = 0, b1 = 0;
  if (h < 60) { r1 = c; g1 = x; }
  else if (h < 120) { r1 = x; g1 = c; }
  else if (h < 180) { g1 = c; b1 = x; }
  else if (h < 240) { g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255)
  };
}

function rgbToHslValues(r: number, g: number, b: number) {
  const rNorm = r / 255, gNorm = g / 255, bNorm = b / 255;
  const max = Math.max(rNorm, gNorm, bNorm), min = Math.min(rNorm, gNorm, bNorm);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rNorm: h = (gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0); break;
      case gNorm: h = (bNorm - rNorm) / d + 2; break;
      case bNorm: h = (rNorm - gNorm) / d + 4; break;
    }
    h = Math.round(h * 60);
  }
  return { h, s: Math.round(s * 100), l: Math.round(l * 100) };
}

function rgbToCmykString(r: number, g: number, b: number): string {
  const rNorm = r / 255, gNorm = g / 255, bNorm = b / 255;
  const k = 1 - Math.max(rNorm, gNorm, bNorm);
  if (k === 1) return "cmyk(0%, 0%, 0%, 100%)";
  const c = Math.round(((1 - rNorm - k) / (1 - k)) * 100);
  const m = Math.round(((1 - gNorm - k) / (1 - k)) * 100);
  const y = Math.round(((1 - bNorm - k) / (1 - k)) * 100);
  return `cmyk(${c}%, ${m}%, ${y}%, ${Math.round(k * 100)}%)`;
}

function getLuminance(r: number, g: number, b: number): number {
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

// =========================================================================
// 6. Unified Calculator Query Evaluator
// =========================================================================

export function evaluateCalculatorQuery(
  input: string,
  options: { remBase?: number } = {}
): CalculatorQueryResult {
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
      colorResult: color,
      details: `${color.rgb} | ${color.hsl} | ${color.cmyk}`
    };
  }

  // 2. Unit conversion check (px/rem, distance, mass, temp, storage, radix)
  const unit = convertUnits(s, options);
  if (unit && unit.isConversion) {
    return {
      type: "unit",
      expression: s,
      formattedAnswer: unit.formattedAnswer,
      rawAnswer: unit.value,
      details: `单位换算 (${unit.category.toUpperCase()}): ${unit.fromUnit} -> ${unit.toUnit}`
    };
  }

  // 3. Currency conversion check
  const currency = convertCalculatorCurrency(s);
  if (currency && currency.isCurrency) {
    return {
      type: "currency",
      expression: s,
      formattedAnswer: currency.formattedAnswer,
      rawAnswer: currency.convertedAmount,
      details: `汇率估算 (1 ${currency.fromCurrency} ≈ ${currency.rate.toFixed(4)} ${currency.toCurrency})`
    };
  }

  // 4. Date calculation check
  const dateRes = evaluateDateExpression(s);
  if (dateRes && dateRes.isDate) {
    return {
      type: "date",
      expression: s,
      formattedAnswer: dateRes.formattedAnswer,
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

export async function getCalculatorHistory(): Promise<CalculatorHistoryItem[]> {
  try {
    const raw = await LocalStorage.getItem(HISTORY_STORAGE_KEY);
    if (Array.isArray(raw)) {
      return raw as CalculatorHistoryItem[];
    }
  } catch {
    // fallback
  }
  return [];
}

export async function saveCalculatorHistory(
  items: CalculatorHistoryItem[]
): Promise<void> {
  await LocalStorage.setItem(HISTORY_STORAGE_KEY, items);
}

export async function addCalculatorHistory(
  expression: string,
  answer: string,
  type: CalculatorHistoryItem["type"]
): Promise<CalculatorHistoryItem[]> {
  const current = await getCalculatorHistory();
  // Filter out exact duplicate expression to keep recent at top
  const filtered = current.filter(item => item.expression !== expression);
  const newItem: CalculatorHistoryItem = {
    id: `calc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    expression,
    answer,
    type,
    pinned: false,
    timestamp: Date.now()
  };
  const updated = [newItem, ...filtered].slice(0, 100);
  await saveCalculatorHistory(updated);
  return updated;
}

export async function togglePinCalculatorHistory(
  id: string
): Promise<CalculatorHistoryItem[]> {
  const current = await getCalculatorHistory();
  const updated = current.map(item => {
    if (item.id === id) {
      return { ...item, pinned: !item.pinned };
    }
    return item;
  });
  await saveCalculatorHistory(updated);
  return updated;
}

export async function deleteCalculatorHistory(
  id: string
): Promise<CalculatorHistoryItem[]> {
  const current = await getCalculatorHistory();
  const updated = current.filter(item => item.id !== id);
  await saveCalculatorHistory(updated);
  return updated;
}

export async function clearCalculatorHistory(): Promise<void> {
  await LocalStorage.removeItem(HISTORY_STORAGE_KEY);
}

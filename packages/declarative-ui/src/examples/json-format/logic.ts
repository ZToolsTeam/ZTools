/**
 * JSON 格式化、深度校验与多语言全栈类型推导引擎
 * 对齐 Raycast 极客标准，提供行号/列号精准定位、TypeScript / Rust / Go 类型推导、
 * JSONPath 扁平提取与极速压缩能力。
 */

export interface JsonErrorInfo {
  line: number;
  column: number;
  offset: number;
  snippet: string;
  message: string;
}

export interface JsonStats {
  keys: number;
  depth: number;
  byteSize: number;
  minifiedSize: number;
  compressionRatio: number; // 节省百分比，例如 24.5 (%)
  arraysCount: number;
  objectsCount: number;
  primitivesCount: number;
}

export interface JsonValidationResult {
  valid: boolean;
  error?: string;
  errorInfo?: JsonErrorInfo;
  parsed?: any;
  stats?: JsonStats;
}

export interface JsonPathItem {
  path: string;
  value: any;
  displayValue: string;
  type: "string" | "number" | "boolean" | "null" | "array" | "object";
}



/**
 * 计算行号、列号与代码错误指示切片
 */
function extractErrorInfo(err: Error, raw: string): JsonErrorInfo {
  const msg = err.message || "";
  const lines = raw.split(/\r?\n/);
  let line = 1;
  let column = 1;
  let offset = 0;

  // 1. 优先提取 V8 中的 "(line X column Y)"
  const lineColMatch = msg.match(/line (\d+) column (\d+)/i);
  if (lineColMatch) {
    line = parseInt(lineColMatch[1], 10);
    column = parseInt(lineColMatch[2], 10);
    for (let i = 0; i < line - 1 && i < lines.length; i++) {
      offset += lines[i].length + 1;
    }
    offset += Math.max(0, column - 1);
  } else {
    // 2. 提取 "at position 123"
    const posMatch = msg.match(/at position (\d+)/i);
    if (posMatch) {
      offset = parseInt(posMatch[1], 10);
    } else {
      // 3. 提取 Node 20/22/24 中的错误片段与 token
      const tokenMatch = msg.match(/Unexpected token (?:'([^']+)'|(\S+))/);
      const token = tokenMatch ? (tokenMatch[1] || tokenMatch[2]) : null;

      // 匹配 "...snippet..." 或 "...snippet" 或 "snippet"
      const snippetMatch = msg.match(/(?:\.\.\.|")([\s\S]+?)(?:\.\.\.|"|\s+is not valid JSON)/);
      if (snippetMatch) {
        let needle = snippetMatch[1].replace(/\\n/g, "\n");
        let idx = raw.indexOf(needle);
        if (idx === -1) {
          // needle 可能两端被截断，逐步缩小查找最长公共子串
          for (let len = needle.length - 1; len >= 3; len--) {
            let found = false;
            for (let start = 0; start <= needle.length - len; start++) {
              const sub = needle.substring(start, start + len);
              const subIdx = raw.indexOf(sub);
              if (subIdx !== -1) {
                idx = subIdx;
                found = true;
                break;
              }
            }
            if (found) break;
          }
        }
        if (idx !== -1) {
          if (token) {
            const tokenIdx = raw.indexOf(token, idx);
            offset = tokenIdx !== -1 ? tokenIdx : idx;
          } else {
            offset = idx;
          }
        }
      } else if (/unexpected end of/i.test(msg)) {
        offset = raw.length;
      }
    }
    const safeOffset = Math.max(0, Math.min(raw.length, offset));
    const before = raw.slice(0, safeOffset);
    const beforeLines = before.split(/\r?\n/);
    line = beforeLines.length;
    column = beforeLines[beforeLines.length - 1].length + 1;
  }

  // 构造周围 3 行的错误切片
  const startLine = Math.max(1, line - 1);
  const endLine = Math.min(lines.length, line + 1);
  const snippetLines: string[] = [];

  for (let l = startLine; l <= endLine; l++) {
    const lineContent = lines[l - 1] ?? "";
    const linePrefix = l === line ? "> " : "  ";
    const lineNum = String(l).padStart(4, " ");
    snippetLines.push(`${linePrefix}${lineNum} | ${lineContent}`);
    if (l === line) {
      const caretIndent = " ".repeat(7 + Math.max(0, column - 1));
      snippetLines.push(`${caretIndent}^`);
    }
  }

  return {
    line,
    column,
    offset,
    snippet: snippetLines.join("\n"),
    message: `${msg} at line ${line}, column ${column}`
  };
}

/**
 * 校验 JSON 语法并返回即时行号/列号定位与统计指标
 */
export function validateJson(raw: string): JsonValidationResult {
  if (!raw || !raw.trim()) {
    return {
      valid: false,
      error: "Empty JSON content",
      errorInfo: {
        line: 1,
        column: 1,
        offset: 0,
        snippet: "  1 | \n      ^",
        message: "Empty JSON content at line 1, column 1"
      }
    };
  }

  try {
    const parsed = JSON.parse(raw);
    const stats = calculateStats(raw, parsed);
    return {
      valid: true,
      parsed,
      stats
    };
  } catch (err: any) {
    const errorInfo = extractErrorInfo(err, raw);
    return {
      valid: false,
      error: errorInfo.message,
      errorInfo
    };
  }
}

/**
 * JSON 格式化与美化 (支持 2 空格、4 空格、Tab 制表符)
 */
export function formatJson(raw: string | any, indent: number | "tab" | string = 2): string {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const indentValue = indent === "tab" || indent === "\t" ? "\t" : Number(indent) || 2;
    return JSON.stringify(parsed, null, indentValue);
  } catch {
    return typeof raw === "string" ? raw : String(raw);
  }
}

/**
 * 极速压缩 JSON 为单行
 */
export function minifyJson(raw: string | any): string {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return JSON.stringify(parsed);
  } catch {
    return typeof raw === "string" ? raw : String(raw);
  }
}

/**
 * 统计 JSON 深度、键数量、体积与压缩指标
 */
function calculateStats(raw: string, obj: any): JsonStats {
  let keyCount = 0;
  let maxDepth = 0;
  let arraysCount = 0;
  let objectsCount = 0;
  let primitivesCount = 0;

  function traverse(node: any, depth: number) {
    if (depth > maxDepth) maxDepth = depth;
    if (node === null || typeof node !== "object") {
      primitivesCount++;
      return;
    }

    if (Array.isArray(node)) {
      arraysCount++;
      for (const item of node) {
        traverse(item, depth + 1);
      }
    } else {
      objectsCount++;
      const keys = Object.keys(node);
      keyCount += keys.length;
      for (const k of keys) {
        traverse(node[k], depth + 1);
      }
    }
  }

  traverse(obj, 1);

  const rawBytes = typeof raw === "string" ? new TextEncoder().encode(raw).length : 0;
  const minified = JSON.stringify(obj);
  const minifiedSize = new TextEncoder().encode(minified).length;
  const byteSize = rawBytes || minifiedSize;
  const saved = byteSize > minifiedSize ? ((byteSize - minifiedSize) / byteSize) * 100 : 0;

  return {
    keys: keyCount,
    depth: maxDepth,
    byteSize,
    minifiedSize,
    compressionRatio: Number(saved.toFixed(1)),
    arraysCount,
    objectsCount,
    primitivesCount
  };
}

/**
 * 递归将 JSON 结构自动推导为干净规范的 TypeScript Interface
 */
export function jsonToTsInterface(raw: string | any, rootName = "RootObject"): string {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const interfaces: string[] = [];
    const generatedNames = new Set<string>();

    function capitalize(s: string) {
      if (!s) return "Item";
      return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function inferType(val: any, parentKey: string): string {
      if (val === null) return "any";
      if (val === undefined) return "undefined";
      const t = typeof val;
      if (t === "string" || t === "number" || t === "boolean") {
        return t;
      }
      if (Array.isArray(val)) {
        if (val.length === 0) return "any[]";
        const first = val[0];
        if (typeof first === "object" && first !== null) {
          const childName = capitalize(parentKey.replace(/s$/, "")) + "Item";
          generateInterface(childName, first);
          return `${childName}[]`;
        }
        return `${inferType(first, parentKey)}[]`;
      }
      if (t === "object") {
        const childName = capitalize(parentKey);
        generateInterface(childName, val);
        return childName;
      }
      return "any";
    }

    function generateInterface(name: string, obj: any) {
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return;
      if (generatedNames.has(name)) return;
      generatedNames.add(name);

      const lines: string[] = [];
      lines.push(`export interface ${name} {`);

      for (const [key, val] of Object.entries(obj)) {
        const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
        const inferred = inferType(val, key);
        lines.push(`  ${safeKey}: ${inferred};`);
      }

      lines.push("}");
      interfaces.push(lines.join("\n"));
    }

    if (Array.isArray(parsed)) {
      if (parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null) {
        generateInterface(rootName + "Item", parsed[0]);
        interfaces.push(`export type ${rootName} = ${rootName}Item[];`);
      } else {
        return `export type ${rootName} = any[];`;
      }
    } else {
      generateInterface(rootName, parsed);
    }

    return interfaces.join("\n\n");
  } catch (err: any) {
    return `// Failed to generate TypeScript interface: ${err?.message || "Invalid JSON"}`;
  }
}

/**
 * 递归将 JSON 结构自动推导为规范的 Rust Struct (serde)
 */
export function jsonToRustStruct(raw: string | any, rootName = "RootObject"): string {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const structs: string[] = [];
    const generatedNames = new Set<string>();

    const RUST_KEYWORDS = new Set([
      "as", "break", "const", "continue", "crate", "else", "enum", "extern", "false",
      "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut",
      "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait",
      "true", "type", "unsafe", "use", "where", "while", "async", "await", "dyn"
    ]);

    function toSnakeCase(str: string): string {
      return str
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[^a-zA-Z0-9_]/g, "_")
        .toLowerCase();
    }

    function toPascalCase(str: string): string {
      if (!str) return "Item";
      return str
        .replace(/[^a-zA-Z0-9]/g, " ")
        .split(" ")
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join("");
    }

    function inferRustType(val: any, fieldKey: string): string {
      if (val === null || val === undefined) return "Option<serde_json::Value>";
      if (typeof val === "boolean") return "bool";
      if (typeof val === "number") {
        return Number.isInteger(val) ? "i64" : "f64";
      }
      if (typeof val === "string") return "String";
      if (Array.isArray(val)) {
        if (val.length === 0) return "Vec<serde_json::Value>";
        const first = val[0];
        if (typeof first === "object" && first !== null) {
          const childName = toPascalCase(fieldKey.replace(/s$/, "")) + "Item";
          generateRustStruct(childName, first);
          return `Vec<${childName}>`;
        }
        return `Vec<${inferRustType(first, fieldKey)}>`;
      }
      if (typeof val === "object") {
        const childName = toPascalCase(fieldKey);
        generateRustStruct(childName, val);
        return childName;
      }
      return "serde_json::Value";
    }

    function generateRustStruct(name: string, obj: any) {
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return;
      if (generatedNames.has(name)) return;
      generatedNames.add(name);

      const lines: string[] = [];
      lines.push("#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]");
      lines.push(`pub struct ${name} {`);

      for (const [key, val] of Object.entries(obj)) {
        let fieldName = toSnakeCase(key);
        if (RUST_KEYWORDS.has(fieldName) || fieldName === "r#type") {
          fieldName = `r#${fieldName}`;
        }
        const needsRename = key !== fieldName && !fieldName.startsWith("r#");
        if (needsRename) {
          lines.push(`    #[serde(rename = "${key}")]`);
        }
        const rustType = inferRustType(val, key);
        lines.push(`    pub ${fieldName}: ${rustType},`);
      }

      lines.push("}");
      structs.push(lines.join("\n"));
    }

    if (Array.isArray(parsed)) {
      if (parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null) {
        generateRustStruct(rootName + "Item", parsed[0]);
        structs.push(`pub type ${rootName} = Vec<${rootName}Item>;`);
      } else {
        return `pub type ${rootName} = Vec<serde_json::Value>;`;
      }
    } else {
      generateRustStruct(rootName, parsed);
    }

    return "use serde::{Deserialize, Serialize};\n\n" + structs.join("\n\n");
  } catch (err: any) {
    return `// Failed to generate Rust struct: ${err?.message || "Invalid JSON"}`;
  }
}

/**
 * 递归将 JSON 结构自动推导为规范的 Go Struct
 */
export function jsonToGoStruct(raw: string | any, rootName = "RootObject"): string {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const structs: string[] = [];
    const generatedNames = new Set<string>();

    function toPascalCase(str: string): string {
      if (!str) return "Item";
      return str
        .replace(/[^a-zA-Z0-9]/g, " ")
        .split(" ")
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join("");
    }

    function inferGoType(val: any, fieldKey: string): string {
      if (val === null || val === undefined) return "interface{}";
      if (typeof val === "boolean") return "bool";
      if (typeof val === "number") {
        return Number.isInteger(val) ? "int64" : "float64";
      }
      if (typeof val === "string") return "string";
      if (Array.isArray(val)) {
        if (val.length === 0) return "[]interface{}";
        const first = val[0];
        if (typeof first === "object" && first !== null) {
          const childName = toPascalCase(fieldKey.replace(/s$/, "")) + "Item";
          generateGoStruct(childName, first);
          return `[]${childName}`;
        }
        return `[]${inferGoType(first, fieldKey)}`;
      }
      if (typeof val === "object") {
        const childName = toPascalCase(fieldKey);
        generateGoStruct(childName, val);
        return childName;
      }
      return "interface{}";
    }

    function generateGoStruct(name: string, obj: any) {
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return;
      if (generatedNames.has(name)) return;
      generatedNames.add(name);

      const lines: string[] = [];
      lines.push(`type ${name} struct {`);

      for (const [key, val] of Object.entries(obj)) {
        const fieldName = toPascalCase(key);
        const goType = inferGoType(val, key);
        lines.push(`\t${fieldName}\t${goType}\t\`json:"${key}"\``);
      }

      lines.push("}");
      structs.push(lines.join("\n"));
    }

    if (Array.isArray(parsed)) {
      if (parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null) {
        generateGoStruct(rootName + "Item", parsed[0]);
        structs.push(`type ${rootName} []${rootName}Item`);
      } else {
        return `type ${rootName} []interface{}`;
      }
    } else {
      generateGoStruct(rootName, parsed);
    }

    return structs.join("\n\n");
  } catch (err: any) {
    return `// Failed to generate Go struct: ${err?.message || "Invalid JSON"}`;
  }
}

/**
 * 递归抽取扁平化的 JSONPath 路径列表（如 $.data.users[0].id）
 */
export function extractJsonPaths(parsed: any, prefix = "$", maxItems = 150): JsonPathItem[] {
  const items: JsonPathItem[] = [];

  function walk(node: any, currentPath: string) {
    if (items.length >= maxItems) return;

    if (node === null) {
      items.push({ path: currentPath, value: null, displayValue: "null", type: "null" });
      return;
    }

    const t = typeof node;
    if (t === "string") {
      items.push({ path: currentPath, value: node, displayValue: JSON.stringify(node), type: "string" });
      return;
    }
    if (t === "number") {
      items.push({ path: currentPath, value: node, displayValue: String(node), type: "number" });
      return;
    }
    if (t === "boolean") {
      items.push({ path: currentPath, value: node, displayValue: String(node), type: "boolean" });
      return;
    }

    if (Array.isArray(node)) {
      items.push({
        path: currentPath,
        value: node,
        displayValue: `Array(${node.length})`,
        type: "array"
      });
      for (let i = 0; i < node.length; i++) {
        walk(node[i], `${currentPath}[${i}]`);
      }
      return;
    }

    if (t === "object") {
      items.push({
        path: currentPath,
        value: node,
        displayValue: `Object{${Object.keys(node).length}}`,
        type: "object"
      });
      for (const [key, val] of Object.entries(node)) {
        const pathPart = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
        walk(val, `${currentPath}${pathPart}`);
      }
    }
  }

  walk(parsed, prefix);
  return items;
}

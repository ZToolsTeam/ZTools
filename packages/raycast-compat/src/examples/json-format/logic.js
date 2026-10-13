/**
 * JSON 格式化、校验与 TypeScript 接口生成逻辑
 */
export function validateJson(raw) {
    if (!raw || !raw.trim()) {
        return { valid: false, error: "Empty JSON content" };
    }
    try {
        const parsed = JSON.parse(raw);
        const stats = calculateStats(parsed);
        return {
            valid: true,
            parsed,
            stats
        };
    }
    catch (err) {
        return {
            valid: false,
            error: err?.message || "Invalid JSON syntax"
        };
    }
}
export function formatJson(raw, indent = 2) {
    try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return JSON.stringify(parsed, null, indent);
    }
    catch {
        return raw;
    }
}
export function minifyJson(raw) {
    try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return JSON.stringify(parsed);
    }
    catch {
        return raw;
    }
}
function calculateStats(obj) {
    let keyCount = 0;
    let maxDepth = 0;
    function traverse(node, depth) {
        if (depth > maxDepth)
            maxDepth = depth;
        if (typeof node === "object" && node !== null) {
            if (Array.isArray(node)) {
                for (const item of node) {
                    traverse(item, depth + 1);
                }
            }
            else {
                const keys = Object.keys(node);
                keyCount += keys.length;
                for (const k of keys) {
                    traverse(node[k], depth + 1);
                }
            }
        }
    }
    traverse(obj, 1);
    const byteSize = new TextEncoder().encode(JSON.stringify(obj)).length;
    return { keys: keyCount, depth: maxDepth, byteSize };
}
/**
 * 递归将 JSON 对象转换为干净规范的 TypeScript Interface
 */
export function jsonToTsInterface(raw, rootName = "RootObject") {
    try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        const interfaces = [];
        function capitalize(s) {
            return s.charAt(0).toUpperCase() + s.slice(1);
        }
        function inferType(val, parentKey) {
            if (val === null)
                return "any";
            if (val === undefined)
                return "undefined";
            const t = typeof val;
            if (t === "string" || t === "number" || t === "boolean") {
                return t;
            }
            if (Array.isArray(val)) {
                if (val.length === 0)
                    return "any[]";
                const itemType = inferType(val[0], parentKey + "Item");
                return `${itemType}[]`;
            }
            if (t === "object") {
                const childName = capitalize(parentKey);
                generateInterface(childName, val);
                return childName;
            }
            return "any";
        }
        function generateInterface(name, obj) {
            if (typeof obj !== "object" || obj === null || Array.isArray(obj))
                return;
            const lines = [];
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
                generateInterface(rootName, parsed[0]);
                interfaces.push(`export type ${rootName}List = ${rootName}[];`);
            }
            else {
                return `export type ${rootName} = any[];`;
            }
        }
        else {
            generateInterface(rootName, parsed);
        }
        return interfaces.join("\n\n");
    }
    catch (err) {
        return `// Failed to generate TypeScript interface: ${err?.message || "Invalid JSON"}`;
    }
}

/**
 * 声明式视图的文件输入过滤（拖入 / Ctrl+V 粘贴）。
 *
 * 文件夹以主进程确认的 directories 列表为准，不按名称后缀猜测：
 * 名称里带点的文件夹（如 2026.11_报销票据）不会被当成后缀不匹配的文件，
 * 没有后缀的普通文件也不会因为插件允许文件夹而被误放行。
 */

/** 统一扩展名写法：小写、带前导点；空值返回空字符串 */
export function normalizeAllowedExtension(ext) {
  const trimmed = String(ext || "").trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function matchesExtension(filePath, extensions) {
  if (extensions.length === 0) return true;
  const base = String(filePath || "").split(/[\\/]/).pop() || "";
  if (base.lastIndexOf(".") <= 0) return false;
  const lowerBase = base.toLowerCase();
  return extensions.some((ext) => lowerBase.endsWith(ext));
}

/**
 * @param {unknown} rawFiles 主进程下发的已授权路径
 * @param {unknown} rawDirectories 主进程确认为文件夹的路径（rawFiles 的子集）
 * @param {{ extensions?: unknown, allowDirectories?: unknown } | null | undefined} config 插件 fileInput 配置
 * @returns {{ files: string[], directories: string[], rejected: number }}
 */
export function filterIncomingFiles(rawFiles, rawDirectories, config) {
  const paths = Array.isArray(rawFiles)
    ? rawFiles.filter((f) => typeof f === "string" && f.trim().length > 0).map((f) => f.trim())
    : [];
  const directorySet = new Set(
    Array.isArray(rawDirectories)
      ? rawDirectories.filter((d) => typeof d === "string" && d.trim().length > 0).map((d) => d.trim())
      : []
  );
  const allowDirectories = config?.allowDirectories === true;
  const extensions = Array.isArray(config?.extensions)
    ? config.extensions.map(normalizeAllowedExtension).filter(Boolean)
    : [];

  const files = [];
  const directories = [];
  let rejected = 0;
  for (const filePath of paths) {
    if (directorySet.has(filePath)) {
      if (allowDirectories) {
        files.push(filePath);
        directories.push(filePath);
      } else {
        rejected += 1;
      }
      continue;
    }
    if (matchesExtension(filePath, extensions)) files.push(filePath);
    else rejected += 1;
  }
  return { files, directories, rejected };
}

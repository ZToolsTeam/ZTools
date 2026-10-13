import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SearchFilesArgs {
  query: string;
  directory?: string;
  maxResults?: number;
  fileTypes?: string[];
  caseSensitive?: boolean;
  contentMatch?: boolean;
}

export interface MatchedFileInfo {
  path: string;
  name: string;
  extension: string;
  size: number;
  modifiedTime: string;
  isDirectory: boolean;
  snippet?: string;
}

export interface SearchFilesResult {
  query: string;
  searchedDirectory: string;
  totalFound: number;
  files: MatchedFileInfo[];
}

export async function searchFiles(args: SearchFilesArgs): Promise<SearchFilesResult> {
  const query = args.query.trim();
  if (!query) {
    throw new Error('Search query cannot be empty');
  }

  const baseDir = path.resolve(args.directory || process.cwd());
  const maxResults = Math.min(Math.max(1, args.maxResults || 20), 100);
  const caseSensitive = !!args.caseSensitive;
  const targetExtensions = args.fileTypes ? args.fileTypes.map(e => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`)) : null;
  const contentMatch = !!args.contentMatch;

  if (!fs.existsSync(baseDir)) {
    throw new Error(`Directory does not exist: "${baseDir}"`);
  }

  const matches: MatchedFileInfo[] = [];
  const normalizedQuery = caseSensitive ? query : query.toLowerCase();

  // 递归遍历辅助函数（带深度与条目防护）
  const traverse = (currentDir: string, depth: number): void => {
    if (matches.length >= maxResults || depth > 8) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return; // 权限受限或无法访问目录跳过
    }

    for (const entry of entries) {
      if (matches.length >= maxResults) break;

      // 默认忽略常见的庞大无关目录
      if (
        entry.isDirectory() &&
        (entry.name === '.git' ||
          entry.name === 'node_modules' ||
          entry.name === '.vite' ||
          entry.name === 'dist' ||
          entry.name === 'out')
      ) {
        if (!normalizedQuery.includes(entry.name.toLowerCase())) {
          continue;
        }
      }

      const fullPath = path.join(currentDir, entry.name);
      const ext = path.extname(entry.name).toLowerCase();
      const nameToMatch = caseSensitive ? entry.name : entry.name.toLowerCase();

      if (entry.isFile()) {
        if (targetExtensions && !targetExtensions.includes(ext)) {
          continue;
        }

        let isMatch = nameToMatch.includes(normalizedQuery);
        let snippet: string | undefined;

        // 如果文件名未命中但允许内容搜索，且文件较小（<1MB），检查内容匹配
        if (!isMatch && contentMatch) {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size < 1024 * 1024) {
              const content = fs.readFileSync(fullPath, 'utf-8');
              const searchContent = caseSensitive ? content : content.toLowerCase();
              const matchIdx = searchContent.indexOf(normalizedQuery);
              if (matchIdx !== -1) {
                isMatch = true;
                const start = Math.max(0, matchIdx - 30);
                const end = Math.min(content.length, matchIdx + normalizedQuery.length + 30);
                snippet = content.slice(start, end).replace(/\r?\n/g, ' ');
              }
            }
          } catch {}
        }

        if (isMatch) {
          try {
            const stat = fs.statSync(fullPath);
            matches.push({
              path: fullPath,
              name: entry.name,
              extension: ext,
              size: stat.size,
              modifiedTime: stat.mtime.toISOString(),
              isDirectory: false,
              snippet
            });
          } catch {}
        }
      } else if (entry.isDirectory()) {
        if (nameToMatch.includes(normalizedQuery)) {
          try {
            const stat = fs.statSync(fullPath);
            matches.push({
              path: fullPath,
              name: entry.name,
              extension: '',
              size: stat.size,
              modifiedTime: stat.mtime.toISOString(),
              isDirectory: true
            });
          } catch {}
        }

        traverse(fullPath, depth + 1);
      }
    }
  };

  traverse(baseDir, 0);

  return {
    query,
    searchedDirectory: baseDir,
    totalFound: matches.length,
    files: matches
  };
}

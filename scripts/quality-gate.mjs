#!/usr/bin/env node
// ZTools 分级代码审查与质量门禁（配合 .agent/skills/rex-code-review/SKILL.md）：
//
// 【两级审查机制：写完极速扫 + 提交/推送完整扫】
// - L1 极速静态扫描（--fast，代码刚写完后立即触发）：
//   仅扫描当前改动文件及增量行，聚焦原则性硬伤 + 单文件内大段复制粘贴，跳过跨文件/同目录兄弟比对，耗时 < 50ms。
// - L2 完整质量扫描（--staged 提交 / --push 推送 / 默认 full）：
//   执行完整 6 大原则性维度扫描 + 同目录兄弟文件感知的跨文件大段重复代码克隆检测 + Git 中文提交说明校验。
//
// 【审查尺度：抓大放小（6 大原则性问题必拦 hard；文件行数、函数行数、复杂度、代码排版等软性细节一律不拦）】
// - 抓大（hard 阻断级）：
//   1. 假数据、假成功与吞错：生产空 catch {}、硬编码私人路径/假 IP (D:\Local\Roaming\Tencent / 192.168.1.108)、假微信 ID (wxid_geek_primary)、假录屏会话 (rec_sim_*)、真实宿主返回 simulated: true、Math.random() 生成生产 ID/PID、UTF-8 BOM / \uFFFD 乱码
//   2. 架构越层与封装边界：声明式插件直操 DOM/CSS (document.* / .style / .css 文件)、页面视图层 (views/**) 直调 fetch/axios/@/api、前端渲染层直导 Node 原生模块、后端路由层 (routes/**) 直写裸 SQL、新增显式 any
//   3. UI 黄金法则与配色红线：界面混入系统彩色 Emoji 或带圈数字 ①~⑳、列表上方堆叠 MetricGrid/wizardSteps/segmentedControl、彩色比例条 distributionBar、searchBarAccessory 与 filterBar.groups 重复筛选、EXT_COLORS/Color.* 彩虹色、业务样式硬编码 #hex 色值、Vue <style> 缺 scoped/module
//   4. AST 安全护栏：动态 eval()、new Function()、原型链 constructor.constructor 逃逸、十六进制转义混淆 (\x..) 与 _0x 混淆变量
//   5. 大段重复代码克隆：单文件内、跨变更文件或与同目录未修改兄弟文件之间连续 ≥ 16 行有效逻辑代码（≥ 320 字符）的复制粘贴块
//   6. 提交规范：非中文或缺失标准类型前缀的 Git 提交说明
// - 放小（warning 建议或免检，绝不阻断提交/推送）：
//   文件行数、template/script/style 局部行数、函数行数（>200/>300 行）、圈复杂度、模板嵌套层数、内联 :style 一律仅作 warning 提示；CSS 空格/分号等排版细节直接免检。

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function resolveModuleFromWorkspace(pkgName) {
  const probePaths = [
    join(repoRoot, 'package.json'),
    join(repoRoot, 'electron-client', 'package.json'),
    join(repoRoot, 'frontend', 'package.json'),
    join(repoRoot, 'packages', 'declarative-ui', 'package.json'),
  ];
  for (const probe of probePaths) {
    if (!existsSync(probe)) continue;
    try {
      const req = createRequire(probe);
      return req(pkgName);
    } catch {
      // 继续尝试下一个子工程目录
    }
  }
  const fallbackReq = createRequire(import.meta.url);
  return fallbackReq(pkgName);
}

const ts = resolveModuleFromWorkspace('typescript');
const { parse: parseSfc } = resolveModuleFromWorkspace('@vue/compiler-sfc');

const CODE_EXTENSIONS = new Set(['.vue', '.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx', '.scss', '.css']);
const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx']);
const CLONE_CHECK_EXTENSIONS = new Set(['.vue', '.ts', '.tsx', '.mts', '.js', '.mjs', '.jsx']);
const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.less', '.sass', '.styl']);

const IGNORED_PATH_PREFIXES = [
  'node_modules/',
  'dist/',
  'out/',
  'bin/',
  'coverage/',
  'release/',
  'DLLPlugins/',
  'installer/',
  'official-website/',
  'docs/',
  'frontend/node_modules/',
  'frontend/dist/',
  'frontend/public/',
  'electron-client/node_modules/',
  'electron-client/out/',
  'electron-client/dist/',
  'electron-client/native/',
  'backend/node_modules/',
  'backend/dist/',
  'backend/admin/node_modules/',
  'backend/admin/dist/',
  'packages/declarative-ui/dist/',
  'packages/ai-mcp/dist/',
  'packages/sync-crypto/dist/',
  'plugins/node_modules/',
  'plugins/create-plugin/node_modules/',
  '.git/',
  '.codegraph/',
  '.agent/',
];

const MANAGED_ROOT_PREFIXES = [
  'packages/',
  'electron-client/src/',
  'frontend/src/',
  'plugins/',
  'backend/src/',
  'backend/admin/src/',
  'src/',
  'scripts/',
  'tests/',
];

const SUBMODULE_REPOS = ['electron-client', 'frontend', 'plugins', 'backend'];

// 聚焦真正的大段逻辑复制粘贴（连续 ≥ 16 行有效非空逻辑代码且 ≥ 320 字符）
export const DEFAULT_MIN_DUPLICATE_LINES = 16;
export const DEFAULT_MIN_DUPLICATE_CHARS = 320;
const MAX_SIBLING_BASELINE_FILES_PER_DIR = 15;

const NODE_FORBIDDEN_IN_RENDERER = new Set([
  'fs',
  'fs/promises',
  'child_process',
  'net',
  'tls',
  'dgram',
  'cluster',
  'worker_threads',
  'os',
  'sqlite',
]);

// 允许的不带色彩的纯文本几何/单色符号
const ALLOWED_PICTOGRAPHICS = new Set(['©', '®', '™', 'ℹ']);

const COMMIT_SUBJECT_PATTERN = /^(?:feat|fix|refactor|style|perf|test|docs|chore|build|ci|revert)(?:\([^)]+\))?!?:\s+(.+)$/;

export function toPosixPath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return '';
  return filePath.split(sep).join('/').replace(/\\/g, '/').replace(/^\.\//, '');
}

export function isManagedCodeFile(filePath) {
  const normalized = toPosixPath(filePath);
  if (!normalized || !CODE_EXTENSIONS.has(extname(normalized))) return false;
  if (normalized.endsWith('.d.ts')) return false;
  if (
    normalized.includes('/node_modules/')
    || normalized.includes('/dist/')
    || normalized.includes('/out/')
    || normalized.includes('/.git/')
  ) {
    return false;
  }
  if (IGNORED_PATH_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) {
    return false;
  }
  return MANAGED_ROOT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isTestOrFixtureFile(filePath) {
  const normalized = toPosixPath(filePath);
  return (
    normalized.startsWith('tests/')
    || normalized.startsWith('scripts/')
    || normalized.includes('/tests/')
    || normalized.includes('/__tests__/')
    || normalized.includes('/__testing__/')
    || normalized.includes('/fixtures/')
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized)
  );
}

export function isDeclarativePluginFile(filePath) {
  const normalized = toPosixPath(filePath);
  return (
    normalized.startsWith('packages/declarative-ui/src/examples/')
    || /^plugins\/(?!create-plugin\/)[^/]+\/src\//.test(normalized)
    || normalized.startsWith('plugins/create-plugin/src/plugins/')
  );
}

export function validateCommitSubject(subject) {
  const trimmed = String(subject ?? '').trim();
  if (!trimmed) {
    return {
      valid: false,
      message: 'Git 提交说明不能为空，必须遵循「类型前缀: 中文说明」格式（ZTOOLS-STD-10）。',
    };
  }
  if (/^Merge\s+/i.test(trimmed) || /^Revert\s+"/i.test(trimmed)) {
    return { valid: true, message: '' };
  }
  const match = trimmed.match(COMMIT_SUBJECT_PATTERN);
  if (!match) {
    return {
      valid: false,
      message: `提交说明 "${trimmed}" 不符合规范前缀格式（如 feat: / fix: / refactor: / test: / docs: / chore: 中文说明）。`,
    };
  }
  const description = match[1].trim();
  if (!/[\u4e00-\u9fa5]/.test(description)) {
    return {
      valid: false,
      message: `提交说明 "${trimmed}" 冒号后必须使用中文概括本次改动与目的，严禁纯英文描述（ZTOOLS-STD-10）。`,
    };
  }
  return { valid: true, message: '' };
}

function normalizeSourceEntries(sources) {
  if (!Array.isArray(sources)) return [];
  const entries = [];
  for (const item of sources) {
    if (!item || typeof item !== 'object') continue;
    const rawFile = typeof item.file === 'string' ? item.file : typeof item.path === 'string' ? item.path : '';
    const file = toPosixPath(rawFile);
    if (!file || (!CODE_EXTENSIONS.has(extname(file)) && !STYLE_EXTENSIONS.has(extname(file))) || file.endsWith('.d.ts')) {
      continue;
    }
    const source = typeof item.source === 'string' ? item.source : typeof item.content === 'string' ? item.content : '';
    let rawBuffer = Buffer.isBuffer(item.rawBuffer) ? item.rawBuffer : null;
    if (!rawBuffer && item.hasBom === true) {
      rawBuffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source, 'utf8')]);
    }
    entries.push({ file, rawBuffer, source, baselineOnly: Boolean(item.baselineOnly) });
  }
  return entries;
}

function git(args, options = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.GIT_DIR;
  delete cleanEnv.GIT_WORK_TREE;
  delete cleanEnv.GIT_INDEX_FILE;
  delete cleanEnv.GIT_PREFIX;
  return execFileSync('git', args, {
    cwd: options.cwd ?? repoRoot,
    encoding: options.encoding ?? 'utf8',
    env: cleanEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024,
  });
}

function tryGit(args, options = {}) {
  try {
    return git(args, options);
  } catch {
    return null;
  }
}

function parseNullList(output) {
  if (!output) return [];
  return output.split('\0').filter(Boolean).map(toPosixPath);
}

function parseUnifiedDiffChangedLines(diffText, trackedFiles = [], pathPrefix = '') {
  const changedLinesByFile = new Map();
  for (const tracked of trackedFiles) {
    const normalized = toPosixPath(pathPrefix ? `${pathPrefix}/${tracked}` : tracked);
    if (normalized) {
      changedLinesByFile.set(normalized, new Set());
    }
  }
  if (!diffText) return changedLinesByFile;

  let currentFile = null;
  let currentNewLine = 0;

  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith('+++ b/')) {
      const innerPath = rawLine.slice(6).trim();
      currentFile = toPosixPath(pathPrefix ? `${pathPrefix}/${innerPath}` : innerPath);
      if (!changedLinesByFile.has(currentFile)) {
        changedLinesByFile.set(currentFile, new Set());
      }
      continue;
    }
    if (rawLine.startsWith('@@ ')) {
      const match = rawLine.match(/\+(\d+)(?:,(\d+))?/);
      if (match) {
        currentNewLine = Number.parseInt(match[1], 10);
      }
      continue;
    }
    if (!currentFile) continue;
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      changedLinesByFile.get(currentFile)?.add(currentNewLine);
      currentNewLine += 1;
    } else if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      // 删除行不推进新文件行号
    } else if (rawLine.startsWith(' ')) {
      currentNewLine += 1;
    }
  }

  return changedLinesByFile;
}

function resolvePushBaseCommit(cwd = repoRoot) {
  const headSha = tryGit(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd })?.trim();
  if (process.env.QUALITY_GATE_BASE) {
    const explicit = tryGit(['rev-parse', '--verify', `${process.env.QUALITY_GATE_BASE}^{commit}`], { cwd })?.trim();
    if (explicit) return explicit;
  }

  const upstreamSha = tryGit(['rev-parse', '--verify', '@{upstream}^{commit}'], { cwd })?.trim();
  if (upstreamSha) {
    return upstreamSha;
  }

  for (const fallbackBranch of ['origin/master', 'origin/main']) {
    const mergeBase = tryGit(['merge-base', 'HEAD', fallbackBranch], { cwd })?.trim();
    if (mergeBase && mergeBase !== headSha) {
      return mergeBase;
    }
  }

  return tryGit(['rev-parse', '--verify', 'HEAD~1^{commit}'], { cwd })?.trim() ?? headSha;
}

function collectSingleRepoScope(mode, cwd, pathPrefix = '') {
  const withPrefix = (rel) => toPosixPath(pathPrefix ? `${pathPrefix}/${rel}` : rel);

  if (mode === 'staged') {
    const rawFiles = parseNullList(tryGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd }));
    const files = rawFiles.map(withPrefix).filter(isManagedCodeFile);
    const diffText = tryGit(['diff', '--cached', '--unified=0', '--diff-filter=ACMR'], { cwd }) ?? '';
    return {
      fixedPoint: 'staged',
      files,
      changedLinesByFile: parseUnifiedDiffChangedLines(diffText, rawFiles, pathPrefix),
      commitSubjects: [],
    };
  }

  if (mode === 'push') {
    const base = resolvePushBaseCommit(cwd);
    const committedRaw = base
      ? parseNullList(tryGit(['diff', '--name-only', '--diff-filter=ACMR', '-z', `${base}...HEAD`], { cwd }))
      : [];
    const files = [...new Set(committedRaw)]
      .map(withPrefix)
      .filter((file) => isManagedCodeFile(file) && existsSync(resolve(cwd, pathPrefix ? file.slice(pathPrefix.length + 1) : file)));

    const committedDiff = base
      ? (tryGit(['diff', '--unified=0', '--diff-filter=ACMR', `${base}...HEAD`], { cwd }) ?? '')
      : '';
    const changedLinesByFile = parseUnifiedDiffChangedLines(committedDiff, committedRaw, pathPrefix);
    const logOut = base ? (tryGit(['log', `${base}..HEAD`, '--format=%s'], { cwd }) ?? '') : '';
    const commitSubjects = logOut
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    return {
      fixedPoint: base ?? 'HEAD',
      files,
      changedLinesByFile,
      commitSubjects,
    };
  }

  // working 模式
  const trackedChanged = parseNullList(tryGit(['diff', '--name-only', '--diff-filter=ACMR', '-z', 'HEAD'], { cwd }));
  const stagedChanged = parseNullList(tryGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd }));
  const untracked = parseNullList(tryGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd }));
  const allRaw = [...new Set([...trackedChanged, ...stagedChanged, ...untracked])];
  const files = allRaw
    .map(withPrefix)
    .filter((file) => isManagedCodeFile(file) && existsSync(resolve(cwd, pathPrefix ? file.slice(pathPrefix.length + 1) : file)));
  const diffText = tryGit(['diff', '--unified=0', '--diff-filter=ACMR', 'HEAD'], { cwd }) ?? '';
  const changedLinesByFile = parseUnifiedDiffChangedLines(diffText, [...trackedChanged, ...stagedChanged], pathPrefix);
  for (const untrackedFile of untracked) {
    const prefixed = withPrefix(untrackedFile);
    if (isManagedCodeFile(prefixed)) {
      changedLinesByFile.delete(prefixed);
    }
  }
  return {
    fixedPoint: 'working',
    files,
    changedLinesByFile,
    commitSubjects: [],
  };
}

function collectTargetScope(mode, explicitFiles = [], cwd = repoRoot, tier = 'full') {
  if (mode === 'files') {
    const files = [...new Set(explicitFiles.filter((f) => typeof f === 'string' && f.trim()))]
      .map(toPosixPath)
      .filter((f) => CODE_EXTENSIONS.has(extname(f)) && !f.endsWith('.d.ts') && existsSync(resolve(cwd, f)))
      .sort();
    return {
      fixedPoint: tier === 'fast' ? 'fast-files' : (tryGit(['rev-parse', 'HEAD'], { cwd })?.trim() ?? 'files'),
      files,
      changedLinesByFile: null,
      commitSubjects: [],
    };
  }

  const rootScope = collectSingleRepoScope(mode, cwd, '');
  const allFiles = new Set(rootScope.files);
  const mergedChangedLines = new Map(rootScope.changedLinesByFile);
  const allCommitSubjects = [...rootScope.commitSubjects];

  // 当在父仓库运行时，若子模块存在未提交/已暂存改动，一并纳入扫描范围（但跳过 push 模式对未修改子模块历史 HEAD~1 的回溯）
  if (resolve(cwd) === repoRoot && (mode === 'staged' || mode === 'working')) {
    for (const sub of SUBMODULE_REPOS) {
      const subDir = join(cwd, sub);
      if (!existsSync(join(subDir, '.git'))) continue;
      const subScope = collectSingleRepoScope(mode, subDir, sub);
      for (const f of subScope.files) allFiles.add(f);
      for (const [k, v] of subScope.changedLinesByFile.entries()) {
        mergedChangedLines.set(k, v);
      }
      for (const subj of subScope.commitSubjects) {
        if (!allCommitSubjects.includes(subj)) allCommitSubjects.push(subj);
      }
    }
  }

  return {
    fixedPoint: rootScope.fixedPoint,
    files: [...allFiles].sort(),
    changedLinesByFile: mergedChangedLines,
    commitSubjects: allCommitSubjects,
  };
}

function readTargetFile(file, mode, cwd = repoRoot) {
  const normalized = toPosixPath(file);
  if (mode === 'staged') {
    if (resolve(cwd) === repoRoot) {
      for (const sub of SUBMODULE_REPOS) {
        if (normalized.startsWith(`${sub}/`) && existsSync(join(cwd, sub, '.git'))) {
          const innerRel = normalized.slice(sub.length + 1);
          const subBuf = tryGit(['show', `:${innerRel}`], { cwd: join(cwd, sub), encoding: 'buffer' });
          if (subBuf) {
            return {
              file: normalized,
              rawBuffer: subBuf,
              source: subBuf.toString('utf8'),
            };
          }
        }
      }
    }
    const buffer = tryGit(['show', `:${normalized}`], { cwd, encoding: 'buffer' });
    if (buffer) {
      return {
        file: normalized,
        rawBuffer: buffer,
        source: buffer.toString('utf8'),
      };
    }
  }
  const absPath = resolve(cwd, file);
  const rawBuffer = readFileSync(absPath);
  return {
    file: normalized,
    rawBuffer,
    source: rawBuffer.toString('utf8'),
  };
}

/**
 * 在 L2 完整扫描模式（commit / push / working）下，收集变更文件同目录下的未修改兄弟文件作为克隆对比基座，
 * 防止从同目录隔壁文件大段复制粘贴而因隔壁文件未在 git diff 中漏检。
 */
function collectSiblingBaselineSources(targetFiles, changedLinesByFile, cwd = repoRoot) {
  if (!changedLinesByFile || targetFiles.length === 0) return [];
  const targetSet = new Set(targetFiles.map(toPosixPath));
  const visitedDirs = new Set();
  const siblingSources = [];

  for (const targetFile of targetSet) {
    if (!CLONE_CHECK_EXTENSIONS.has(extname(targetFile)) || isTestOrFixtureFile(targetFile)) continue;
    const relDir = toPosixPath(dirname(targetFile));
    if (!relDir || relDir === '.' || visitedDirs.has(relDir)) continue;
    visitedDirs.add(relDir);

    const absDir = resolve(cwd, relDir);
    if (!existsSync(absDir)) continue;

    let entries = [];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    let countInDir = 0;
    for (const entry of entries) {
      if (countInDir >= MAX_SIBLING_BASELINE_FILES_PER_DIR) break;
      if (!entry.isFile()) continue;
      const siblingRel = toPosixPath(join(relDir, entry.name));
      if (targetSet.has(siblingRel)) continue;
      if (!isManagedCodeFile(siblingRel) || !CLONE_CHECK_EXTENSIONS.has(extname(siblingRel)) || isTestOrFixtureFile(siblingRel)) {
        continue;
      }
      try {
        const rawBuffer = readFileSync(resolve(cwd, siblingRel));
        changedLinesByFile.set(siblingRel, new Set()); // 未修改基座文件：0 变更行，不会触发自身报错
        siblingSources.push({
          file: siblingRel,
          rawBuffer,
          source: rawBuffer.toString('utf8'),
          baselineOnly: true,
        });
        countInDir += 1;
      } catch {
        // 忽略读取异常的兄弟文件
      }
    }
  }

  return siblingSources;
}

function isLineInChangedScope(file, line, changedLinesByFile) {
  if (!changedLinesByFile) return true;
  const lineSet = changedLinesByFile.get(toPosixPath(file));
  if (!lineSet) return true;
  return lineSet.has(line);
}

function isRangeInChangedScope(file, startLine, endLine, changedLinesByFile) {
  if (!changedLinesByFile) return true;
  const lineSet = changedLinesByFile.get(toPosixPath(file));
  if (!lineSet) return true;
  for (let line = startLine; line <= endLine; line += 1) {
    if (lineSet.has(line)) return true;
  }
  return false;
}

function stripBlockCommentsPreservingLines(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\r\n]/g, ' '));
}

function normalizeCloneLine(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('//')) return '';
  if (/^(?:import|export\s+type|type\s+\w+|interface\s+\w+)\b/.test(trimmed)) return '';
  if (/^(?:<\/?(?:template|script|style)[^>]*>|[{}()[\];,]+)$/.test(trimmed)) return '';
  return trimmed.replace(/\s+/g, ' ');
}

function extractNormalizedLinesForCloneDetection(file, source) {
  let targetText = source;
  if (file.endsWith('.vue')) {
    const { descriptor } = parseSfc(source, { filename: file });
    const lines = new Array(source.split(/\r?\n/).length).fill('');
    const fillBlock = (block) => {
      if (!block?.content) return;
      const startLine = block.loc.start.line;
      const blockLines = block.content.split(/\r?\n/);
      for (let i = 0; i < blockLines.length; i += 1) {
        const lineIndex = startLine + i - 1;
        if (lineIndex >= 0 && lineIndex < lines.length) {
          lines[lineIndex] = blockLines[i];
        }
      }
    };
    fillBlock(descriptor.template);
    fillBlock(descriptor.script);
    fillBlock(descriptor.scriptSetup);
    targetText = lines.join('\n');
  }

  const stripped = stripBlockCommentsPreservingLines(targetText);
  const rawLines = stripped.split(/\r?\n/);
  const effectiveLines = [];

  for (let index = 0; index < rawLines.length; index += 1) {
    const normalized = normalizeCloneLine(rawLines[index]);
    if (!normalized) continue;
    effectiveLines.push({
      lineNumber: index + 1,
      text: normalized,
    });
  }

  return effectiveLines;
}

function resolveBuildDomain(file) {
  const normalized = toPosixPath(file);
  // 内置声明式插件三处同步镜像各自归属独立构建域，使镜像间合法同步不误报，同域不同插件间复制粘贴正常拦截
  if (normalized.startsWith('packages/declarative-ui/src/examples/')) return 'declarative-ui-examples';
  if (normalized.startsWith('plugins/create-plugin/src/plugins/')) return 'plugins-create-template';
  if (normalized.startsWith('plugins/')) return 'plugins-standalone';
  if (normalized.startsWith('packages/declarative-ui/')) return 'declarative-ui';
  if (normalized.startsWith('packages/ai-mcp/')) return 'ai-mcp';
  if (normalized.startsWith('packages/sync-crypto/')) return 'sync-crypto';
  if (normalized.startsWith('packages/ztools-plugins-spec/')) return 'ztools-plugins-spec';
  if (normalized.startsWith('electron-client/')) return 'electron-client';
  if (normalized.startsWith('backend/admin/')) return 'backend-admin';
  if (normalized.startsWith('backend/')) return 'backend';
  if (normalized.startsWith('frontend/') || normalized.startsWith('src/')) return 'frontend-src';
  return 'other';
}

/**
 * 归一化滑动窗口重复代码检测器
 * - L1 极速模式（intraFileOnly: true）：仅检测单文件内复制粘贴，耗时 < 5ms
 * - L2 完整模式（intraFileOnly: false）：同时检测单文件内、跨变更文件与同目录兄弟文件大段克隆
 */
export function detectDuplicateBlocks(
  sources,
  {
    minLines = DEFAULT_MIN_DUPLICATE_LINES,
    minChars = DEFAULT_MIN_DUPLICATE_CHARS,
    changedLinesByFile = null,
    intraFileOnly = false,
  } = {},
) {
  const validSources = normalizeSourceEntries(sources);
  const windowMap = new Map();

  for (const { file, source } of validSources) {
    const normalizedFile = toPosixPath(file);
    if (!CLONE_CHECK_EXTENSIONS.has(extname(normalizedFile)) || isTestOrFixtureFile(normalizedFile)) {
      continue;
    }
    if (source.includes('quality-ignore-clone')) continue;

    const effective = extractNormalizedLinesForCloneDetection(normalizedFile, source);
    if (effective.length < minLines) continue;
    const domain = resolveBuildDomain(normalizedFile);
    const scopePrefix = intraFileOnly ? `${normalizedFile}` : `${domain}`;

    for (let i = 0; i <= effective.length - minLines; i += 1) {
      const slice = effective.slice(i, i + minLines);
      const fingerprint = slice.map((item) => item.text).join('\n');
      if (fingerprint.length < minChars) continue;

      const key = `${scopePrefix}::${fingerprint}`;
      const occurrence = {
        file: normalizedFile,
        domain,
        startEffectiveIndex: i,
        endEffectiveIndex: i + minLines - 1,
        startLine: slice[0].lineNumber,
        endLine: slice[slice.length - 1].lineNumber,
        charCount: fingerprint.length,
        preview: slice.slice(0, 3).map((item) => item.text).join(' | '),
      };

      const bucket = windowMap.get(key);
      if (bucket) {
        bucket.push(occurrence);
      } else {
        windowMap.set(key, [occurrence]);
      }
    }
  }

  const rawPairs = [];
  for (const occurrences of windowMap.values()) {
    if (occurrences.length < 2) continue;
    const first = occurrences[0];
    for (let idx = 1; idx < occurrences.length; idx += 1) {
      const current = occurrences[idx];
      if (
        first.file === current.file
        && Math.abs(first.startEffectiveIndex - current.startEffectiveIndex) < minLines
      ) {
        continue;
      }
      rawPairs.push({ primary: first, duplicate: current });
    }
  }

  rawPairs.sort((a, b) => {
    if (a.duplicate.file !== b.duplicate.file) return a.duplicate.file.localeCompare(b.duplicate.file);
    if (a.primary.file !== b.primary.file) return a.primary.file.localeCompare(b.primary.file);
    if (a.duplicate.startEffectiveIndex !== b.duplicate.startEffectiveIndex) {
      return a.duplicate.startEffectiveIndex - b.duplicate.startEffectiveIndex;
    }
    return a.primary.startEffectiveIndex - b.primary.startEffectiveIndex;
  });

  const mergedClones = [];
  for (const pair of rawPairs) {
    const previous = mergedClones[mergedClones.length - 1];
    if (
      previous
      && previous.primary.file === pair.primary.file
      && previous.duplicate.file === pair.duplicate.file
      && pair.duplicate.startEffectiveIndex <= previous.duplicate.endEffectiveIndex + 1
      && pair.primary.startEffectiveIndex <= previous.primary.endEffectiveIndex + 1
    ) {
      previous.primary.endEffectiveIndex = Math.max(previous.primary.endEffectiveIndex, pair.primary.endEffectiveIndex);
      previous.primary.endLine = Math.max(previous.primary.endLine, pair.primary.endLine);
      previous.duplicate.endEffectiveIndex = Math.max(
        previous.duplicate.endEffectiveIndex,
        pair.duplicate.endEffectiveIndex,
      );
      previous.duplicate.endLine = Math.max(previous.duplicate.endLine, pair.duplicate.endLine);
      previous.effectiveLines =
        previous.duplicate.endEffectiveIndex - previous.duplicate.startEffectiveIndex + 1;
    } else {
      mergedClones.push({
        scope: pair.primary.file === pair.duplicate.file ? 'intra-file' : 'cross-file',
        primary: { ...pair.primary },
        duplicate: { ...pair.duplicate },
        effectiveLines: minLines,
      });
    }
  }

  return mergedClones.filter((clone) => {
    const touchesPrimary = isRangeInChangedScope(
      clone.primary.file,
      clone.primary.startLine,
      clone.primary.endLine,
      changedLinesByFile,
    );
    const touchesDuplicate = isRangeInChangedScope(
      clone.duplicate.file,
      clone.duplicate.startLine,
      clone.duplicate.endLine,
      changedLinesByFile,
    );
    return touchesPrimary || touchesDuplicate;
  });
}

function checkEncodingAndBom(file, rawBuffer, source, violations) {
  if (
    rawBuffer
    && rawBuffer.length >= 3
    && rawBuffer[0] === 0xef
    && rawBuffer[1] === 0xbb
    && rawBuffer[2] === 0xbf
  ) {
    violations.push({
      file,
      line: 1,
      ruleId: 'quality/encoding-utf8-nobom',
      standardId: 'ZTOOLS-STD-8',
      severity: 'hard',
      message: '文件包含 UTF-8 BOM 头（0xEF 0xBB 0xBF），必须以 UTF-8 无 BOM 格式保存。',
    });
  } else if (source.startsWith('\uFEFF')) {
    violations.push({
      file,
      line: 1,
      ruleId: 'quality/encoding-utf8-nobom',
      standardId: 'ZTOOLS-STD-8',
      severity: 'hard',
      message: '文件包含 BOM 字符（\\uFEFF），必须以 UTF-8 无 BOM 格式保存。',
    });
  }

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes('\uFFFD')) {
      violations.push({
        file,
        line: i + 1,
        ruleId: 'quality/encoding-no-garbled-text',
        standardId: 'ZTOOLS-STD-8',
        severity: 'hard',
        message: '检测到 Unicode 替换字符（\\uFFFD 乱码），请按 UTF-8 无 BOM 修复根因。',
      });
    }
  }
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node)
  );
}

function countEffectiveLinesInRange(lines, startLine, endLine) {
  let count = 0;
  for (let line = startLine; line <= endLine; line += 1) {
    const text = (lines[line - 1] ?? '').trim();
    if (!text || text.startsWith('//') || text.startsWith('/*') || text.startsWith('*')) continue;
    count += 1;
  }
  return count;
}

function detectColorEmoji(line) {
  const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
  const matches = line.match(emojiRegex);
  if (!matches) return null;
  for (const ch of matches) {
    if (!ALLOWED_PICTOGRAPHICS.has(ch) && ch.codePointAt(0) > 0x2600) {
      const cp = ch.codePointAt(0);
      const isAllowedMonoSymbol =
        cp === 0x2713 // ✓
        || cp === 0x2714 // ✔
        || cp === 0x2715 // ✕
        || cp === 0x2716 // ✖
        || cp === 0x2717 // ✗
        || cp === 0x2718 // ✘
        || cp === 0x2605 // ★
        || cp === 0x2606 // ☆
        || (cp >= 0x2794 && cp <= 0x27be); // arrows
      if (!isAllowedMonoSymbol || cp >= 0x1f300 || cp === 0x26a0 || cp === 0x26a1 || cp === 0x2699) {
        return ch;
      }
    }
  }
  return null;
}

function checkVueSfcStructure(file, source, descriptor, isFastTier, violations) {
  if (!descriptor.template && !descriptor.script && !descriptor.scriptSetup) {
    violations.push({
      file,
      line: 1,
      ruleId: 'vue-arch/vue-parse',
      standardId: 'ZTOOLS-STD-8',
      severity: 'hard',
      message: 'Vue SFC 文件解析失败或未包含有效的 <template> / <script> 块。',
    });
    return;
  }

  // 原则性红线（hard）：Vue 组件必须使用 <script setup>（除非只有纯模板）
  if (descriptor.script && !descriptor.scriptSetup && !source.includes('vue-arch-ignore-setup')) {
    violations.push({
      file,
      line: descriptor.script.loc.start.line,
      ruleId: 'vue-arch/vue-script-setup',
      standardId: 'ZTOOLS-STD-8',
      severity: 'hard',
      message: 'Vue 3 组件必须优先使用 <script setup lang="ts"> Composition API，禁止使用旧式 <script> Options API。',
    });
  }

  // 原则性红线（hard）：业务 Vue 组件 <style> 必须声明 scoped 或 module，防止污染全局样式
  const isRootAppVue = /(?:^|\/)App\.vue$/.test(file);
  if (!isRootAppVue && Array.isArray(descriptor.styles)) {
    for (const styleBlock of descriptor.styles) {
      if (!styleBlock.scoped && !styleBlock.module) {
        violations.push({
          file,
          line: styleBlock.loc.start.line,
          ruleId: 'vue-arch/vue-style-scope',
          standardId: 'ZTOOLS-STD-8',
          severity: 'hard',
          message: 'Vue 组件 <style> 标签必须添加 scoped 或 module 属性，防止全局样式污染。',
        });
      }
    }
  }

  // L2 完整扫描模式下补充软性架构建议（抓大放小：行数、内联 :style 仅作 warning，绝不阻断提交/推送）
  if (!isFastTier) {
    const totalLines = source.split(/\r?\n/).length;
    if (totalLines > 500) {
      violations.push({
        file,
        line: 1,
        ruleId: 'vue-arch/vue-max-lines',
        standardId: 'ZTOOLS-STD-8',
        severity: 'warning',
        message: `Vue 文件总行数达到 ${totalLines} 行（超过 500 行建议阈值），建议按子组件或 composable 拆分（软性提示，不阻断提交）。`,
      });
    }

    if (descriptor.template?.content) {
      const tplLines = descriptor.template.content.split(/\r?\n/);
      const tplOffset = descriptor.template.loc.start.line - 1;
      for (let idx = 0; idx < tplLines.length; idx += 1) {
        const tplLine = tplLines[idx];
        if (/(?:^|\s):style\s*=/.test(tplLine) || /(?:^|\s)v-bind:style\s*=/.test(tplLine)) {
          violations.push({
            file,
            line: tplOffset + idx + 1,
            ruleId: 'vue-arch/vue-dynamic-style',
            standardId: 'ZTOOLS-STD-7',
            severity: 'warning',
            message: '检测到模板内动态 :style 绑定，建议评估是否可通过 CSS class 或主题变量替代（软性提示，不阻断提交）。',
          });
          break;
        }
      }
    }
  }
}

function checkTypeScriptAstAndBoundaries(file, scriptCode, lineOffset, fullSourceLines, changedLinesByFile, violations) {
  const isTest = isTestOrFixtureFile(file);
  if (isTest) return;

  const isJsx = file.endsWith('.tsx') || file.endsWith('.jsx');
  const scriptKind = isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, scriptCode, ts.ScriptTarget.Latest, true, scriptKind);

  const isViewFile = /^(?:frontend\/src\/(?:views|pages)|backend\/admin\/src\/(?:views|pages)|src\/(?:views|pages))\//.test(file);
  const isRendererFile =
    file.startsWith('frontend/src/')
    || file.startsWith('backend/admin/src/')
    || file.startsWith('src/views/')
    || file.startsWith('src/components/')
    || file.startsWith('src/declarative/');
  const isPluginFile = isDeclarativePluginFile(file);

  const getLineNumber = (pos) => lineOffset + sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

  const visit = (node) => {
    const nodeStartLine = getLineNumber(node.getStart(sourceFile));
    const nodeEndLine = getLineNumber(node.getEnd());

    // 1. 原则性红线（hard）：禁止生产代码空 catch {} 静默吞掉异常 (ZTOOLS-STD-1)
    if (ts.isCatchClause(node) && node.block.statements.length === 0) {
      const blockText = scriptCode.slice(node.block.getStart(sourceFile) + 1, node.block.getEnd() - 1).trim();
      const hasInnerComment = blockText.includes('//') || blockText.includes('/*');
      if (!hasInnerComment && isRangeInChangedScope(file, nodeStartLine, nodeEndLine, changedLinesByFile)) {
        violations.push({
          file,
          line: nodeStartLine,
          ruleId: 'quality/no-empty-catch',
          standardId: 'ZTOOLS-STD-1',
          severity: 'hard',
          message: '禁止空 catch {} 静默吞掉异常；必须记录错误并向用户反馈或继续抛出。',
        });
      }
    }

    // 2. 原则性红线（hard）：禁止在本次新增/修改行中显式使用 any (ZTOOLS-STD-8)
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const rawLine = fullSourceLines[nodeStartLine - 1] ?? '';
      if (
        !rawLine.includes('quality-ignore-any:')
        && isLineInChangedScope(file, nodeStartLine, changedLinesByFile)
      ) {
        violations.push({
          file,
          line: nodeStartLine,
          ruleId: 'quality/no-explicit-any',
          standardId: 'ZTOOLS-STD-8',
          severity: 'hard',
          message: '禁止显式使用 any；请定义具体 Interface / Type 或使用 unknown 后收窄。',
        });
      }
    }

    // 3. 软性细节（warning，不阻断提交/推送）：单函数有效行数超 200 行仅作拆分提醒
    if (isFunctionLike(node) && node.body) {
      const effectiveLines = countEffectiveLinesInRange(fullSourceLines, nodeStartLine, nodeEndLine);
      if (effectiveLines > 200 && isRangeInChangedScope(file, nodeStartLine, nodeEndLine, changedLinesByFile)) {
        violations.push({
          file,
          line: nodeStartLine,
          ruleId: 'quality/function-size-warning',
          standardId: 'ZTOOLS-STD-8',
          severity: 'warning',
          message: `单个函数有效代码达到 ${effectiveLines} 行（超过 200 行预警线），建议按职责评估拆分（软性提示，不阻断提交）。`,
        });
      }
    }

    // 4. 架构越层与封装原则（hard）：
    //    - 页面视图层禁止直接导入 @/api、axios
    //    - 前端渲染层禁止直接导入 Node 原生模块（必须通过 window.ztools 安全桥接）
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const importSource = node.moduleSpecifier.text;
      if (
        isViewFile
        && file.endsWith('.vue')
        && (/^(?:@\/|(?:\.\.?\/)+)api(?:\/|$)/.test(importSource) || importSource === 'axios')
        && isLineInChangedScope(file, nodeStartLine, changedLinesByFile)
      ) {
        violations.push({
          file,
          line: nodeStartLine,
          ruleId: 'quality/view-no-direct-api',
          standardId: 'ZTOOLS-STD-8',
          severity: 'hard',
          message: `页面视图层 (${file}) 禁止直接导入 ${importSource}，请通过 store、service、composable 或 window.ztools 访问接口。`,
        });
      }

      const cleanMod = importSource.replace(/^node:/, '');
      if (
        isRendererFile
        && (importSource.startsWith('node:') || NODE_FORBIDDEN_IN_RENDERER.has(cleanMod))
        && isLineInChangedScope(file, nodeStartLine, changedLinesByFile)
      ) {
        violations.push({
          file,
          line: nodeStartLine,
          ruleId: 'quality/renderer-no-node-builtins',
          standardId: 'ZTOOLS-STD-8',
          severity: 'hard',
          message: `前端渲染层 (${file}) 禁止直接导入 Node 原生模块 "${importSource}"，必须通过 Preload window.ztools 安全桥接调用。`,
        });
      }
    }

    // 5. 架构越层（hard）：页面视图层禁止直接调用底层 fetch(...)
    if (
      isViewFile
      && file.endsWith('.vue')
      && ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'fetch'
      && isLineInChangedScope(file, nodeStartLine, changedLinesByFile)
    ) {
      violations.push({
        file,
        line: nodeStartLine,
        ruleId: 'quality/view-no-direct-api',
        standardId: 'ZTOOLS-STD-8',
        severity: 'hard',
        message: `页面视图层 (${file}) 禁止直接调用底层 fetch()，请封装至 service / composable 或 window.ztools 层。`,
      });
    }

    // 6. 纯声明式 UI 红线（hard）：严禁声明式插件直接操作原生 DOM 或修改元素 style (ZTOOLS-STD-2)
    if (isPluginFile && isLineInChangedScope(file, nodeStartLine, changedLinesByFile)) {
      if (
        ts.isPropertyAccessExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'document'
        && ['createElement', 'querySelector', 'querySelectorAll', 'getElementById', 'body', 'head'].includes(node.name.text)
      ) {
        violations.push({
          file,
          line: nodeStartLine,
          ruleId: 'quality/plugin-no-dom-access',
          standardId: 'ZTOOLS-STD-2',
          severity: 'hard',
          message: `声明式插件禁止直接操作原生 DOM (document.${node.name.text})；必须使用 @ztools/declarative-ui 组件。`,
        });
      }
      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left)
        && (
          ['innerHTML', 'outerHTML'].includes(node.left.name.text)
          || (ts.isPropertyAccessExpression(node.left.expression) && node.left.expression.name.text === 'style')
        )
      ) {
        violations.push({
          file,
          line: nodeStartLine,
          ruleId: 'quality/plugin-no-dom-access',
          standardId: 'ZTOOLS-STD-2',
          severity: 'hard',
          message: '声明式插件禁止直接修改 DOM innerHTML/outerHTML 或元素 style 属性；必须使用 @ztools/declarative-ui。',
        });
      }
    }

    // 7. AST 安全红线（hard）：严禁动态 eval() 或 new Function() (ZTOOLS-STD-8)
    if (isLineInChangedScope(file, nodeStartLine, changedLinesByFile)) {
      if (
        ts.isCallExpression(node)
        && (
          (ts.isIdentifier(node.expression) && (node.expression.text === 'eval' || node.expression.text === 'Function'))
          || (
            ts.isPropertyAccessExpression(node.expression)
            && ts.isIdentifier(node.expression.expression)
            && ['window', 'globalThis', 'global'].includes(node.expression.expression.text)
            && (node.expression.name.text === 'eval' || node.expression.name.text === 'Function')
          )
        )
      ) {
        violations.push({
          file,
          line: nodeStartLine,
          ruleId: 'quality/security-no-dynamic-eval',
          standardId: 'ZTOOLS-STD-8',
          severity: 'hard',
          message: '严禁使用动态 eval() 或 Function() 动态构造执行代码（ZTOOLS-STD-8）。',
        });
      }
      if (
        ts.isNewExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'Function'
      ) {
        violations.push({
          file,
          line: nodeStartLine,
          ruleId: 'quality/security-no-dynamic-eval',
          standardId: 'ZTOOLS-STD-8',
          severity: 'hard',
          message: '严禁使用 new Function() 动态编译构造代码（ZTOOLS-STD-8）。',
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function checkLineLevelRules(file, source, changedLinesByFile, violations) {
  const isTest = isTestOrFixtureFile(file);
  if (isTest) return;

  const isPlugin = isDeclarativePluginFile(file);
  const isUiIndex = isPlugin && /\/index\.(?:ts|tsx|js|jsx)$/.test(file);
  const isFrontendOrView =
    file.startsWith('frontend/src/')
    || file.startsWith('backend/admin/src/')
    || file.startsWith('src/');
  const isThemeStyleFile =
    /(?:^|\/)(?:theme|variables|main|style|dark-theme|tokens)\.(?:css|scss|less)$/.test(file)
    || file.includes('tailwind.config');
  const isBackendRoute =
    file.startsWith('backend/src/routes/')
    || file.startsWith('src/routes/');

  // 声明式插件严禁包含 .css / .scss / .less 样式文件 (ZTOOLS-STD-2)
  if (isPlugin && STYLE_EXTENSIONS.has(extname(file))) {
    violations.push({
      file,
      line: 1,
      ruleId: 'quality/plugin-no-style-file',
      standardId: 'ZTOOLS-STD-2',
      severity: 'hard',
      message: `声明式插件禁止包含自定义样式文件 (${file})；视图必须完全由 @ztools/declarative-ui 语义化组件渲染。`,
    });
    return;
  }

  const stripped = stripBlockCommentsPreservingLines(source);
  const lines = stripped.split(/\r?\n/);
  const rawLines = source.split(/\r?\n/);

  let insideStyleBlock = file.endsWith('.scss') || file.endsWith('.css');

  // 单一信源检查：同一声明式插件内禁止同时使用 searchBarAccessory 与 filterBar.groups (ZTOOLS-STD-5)
  if (
    isPlugin
    && /searchBarAccessory/.test(stripped)
    && /filterBar[\s\S]{0,400}\bgroups\s*:/.test(stripped)
  ) {
    const groupsLineIdx = lines.findIndex((l) => /\bgroups\s*:/.test(l));
    const reportLine = groupsLineIdx >= 0 ? groupsLineIdx + 1 : 1;
    if (isLineInChangedScope(file, reportLine, changedLinesByFile)) {
      violations.push({
        file,
        line: reportLine,
        ruleId: 'quality/ui-no-duplicate-filter',
        standardId: 'ZTOOLS-STD-5',
        severity: 'hard',
        message: '已有 searchBarAccessory 下拉筛选时，严禁再在 filterBar 中传入 groups 胶囊筛选行（违反单一信源原则）。',
      });
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const lineNumber = i + 1;
    const rawLine = rawLines[i] ?? '';
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (file.endsWith('.vue')) {
      if (/<style\b/i.test(rawLine)) insideStyleBlock = true;
      if (/<\/style>/i.test(rawLine)) {
        insideStyleBlock = false;
        continue;
      }
    }

    if (!trimmed || trimmed.startsWith('//')) continue;
    const inChangedScope = isLineInChangedScope(file, lineNumber, changedLinesByFile);
    if (!inChangedScope) continue;

    // 1. 原则性红线（hard）：禁止使用 Math.random() 生成生产 ID / PID / Token / 会话标识 (ZTOOLS-STD-1)
    if (
      /Math\.random\s*\(\s*\)/.test(line)
      && /(?:\b(?:id|uuid|token|pid|sessionId|idempotency|serial_no|serialNo|taskId)\b|(?:Id|ID|Uuid|UUID|Token|Pid|PID|SessionId|SerialNo)\b)/.test(line)
      && !rawLine.includes('quality-ignore-random:')
    ) {
      violations.push({
        file,
        line: lineNumber,
        ruleId: 'quality/no-insecure-random-id',
        standardId: 'ZTOOLS-STD-1',
        severity: 'hard',
        message: '禁止使用 Math.random() 生成生产标识、PID、会话 ID 或任务单号；请使用真实系统返回或加密随机源。',
      });
    }

    // 2. 原则性红线（hard）：禁止硬编码私人路径、固定假局域网 IP、假微信 ID、假录屏会话或 simulated: true (ZTOOLS-STD-1)
    if (
      !rawLine.includes('quality-ignore-stub:')
      && (
        line.includes('D:\\Local\\Roaming\\Tencent')
        || line.includes('D:\\\\Local\\\\Roaming\\\\Tencent')
        || line.includes('192.168.1.108')
        || /\bwxid_geek_primary\b/.test(line)
        || /['"`]rec_sim_/.test(line)
        || /\bsimulated\s*:\s*true\b/.test(line)
      )
    ) {
      violations.push({
        file,
        line: lineNumber,
        ruleId: 'quality/no-fake-host-data',
        standardId: 'ZTOOLS-STD-1',
        severity: 'hard',
        message: '严禁硬编码私人路径 (D:\\Local\\Roaming\\Tencent)、固定假 IP (192.168.1.108)、虚构演示 ID 或返回 simulated: true 伪造成功（ZTOOLS-STD-1）。',
      });
    }

    // 3. 安全红线（hard）：禁止十六进制转义混淆与 obfuscator 变量 (ZTOOLS-STD-8)
    const hexEscapes = line.match(/\\x[0-9a-fA-F]{2}/g);
    if ((hexEscapes && hexEscapes.length >= 3) || /\b_0x[0-9a-fA-F]{4,8}\b/.test(line)) {
      violations.push({
        file,
        line: lineNumber,
        ruleId: 'quality/security-no-hex-obfuscation',
        standardId: 'ZTOOLS-STD-8',
        severity: 'hard',
        message: '检测到十六进制转义序列 (\\x..) 或 _0x 混淆变量特征，严禁提交混淆代码（ZTOOLS-STD-8）。',
      });
    }

    // 4. 声明式插件 UI 黄金法则红线（hard）：禁止顶栏堆叠 MetricGrid / distributionBar / wizardSteps / segmentedControl (ZTOOLS-STD-4 / STD-5)
    if (isPlugin || isUiIndex) {
      if (/\bMetricGrid\b|\bmetricGrid\s*[:=]|\bwizardSteps\s*:|\bsegmentedControl\s*[:=]/.test(line)) {
        violations.push({
          file,
          line: lineNumber,
          ruleId: 'quality/ui-no-metric-grid',
          standardId: 'ZTOOLS-STD-4',
          severity: 'hard',
          message: '严禁在声明式插件 List 上传入 MetricGrid / wizardSteps / segmentedControl（违反列表主权与顶栏 <=20% 高度红线）。',
        });
      }
      if (/\bDistributionBar\b|\bdistributionBar\s*[:=]/.test(line)) {
        violations.push({
          file,
          line: lineNumber,
          ruleId: 'quality/ui-no-distribution-bar',
          standardId: 'ZTOOLS-STD-5',
          severity: 'hard',
          message: '严禁在声明式插件 List 上传入彩色比例条 distributionBar（违反单一信源与去彩虹化红线）。',
        });
      }
      if (
        !rawLine.includes('ui-color-exempt:')
        && (
          /\bconst\s+EXT_COLORS\s*=/.test(line)
          || /\b(?:tintColor|color)\s*:\s*Color\.(?:Blue|Green|Orange|Purple|Yellow|Magenta)\b/.test(line)
        )
      ) {
        violations.push({
          file,
          line: lineNumber,
          ruleId: 'quality/ui-no-rainbow-color',
          standardId: 'ZTOOLS-STD-7',
          severity: 'hard',
          message: '严禁使用 EXT_COLORS 或给普通图标/标签赋予彩虹色 Color.*（违反 90% 灰阶单色原则，仅高危告警可用 Color.Red）。',
        });
      }
    }

    // 5. 零彩色 Emoji 污染红线（hard）：插件与前端视图严禁混入系统彩色 Emoji 或带圈数字 ①~⑳ (ZTOOLS-STD-7)
    if ((isPlugin || isFrontendOrView) && !rawLine.includes('emoji-exempt:')) {
      const emoji = detectColorEmoji(line);
      const circledMatch = line.match(/[①-⑳]/u);
      if (emoji || circledMatch) {
        const badChar = emoji ?? circledMatch[0];
        violations.push({
          file,
          line: lineNumber,
          ruleId: 'quality/ui-no-colorful-emoji',
          standardId: 'ZTOOLS-STD-7',
          severity: 'hard',
          message: `界面代码中检测到禁止的彩色 Emoji 或带圈符号 "${badChar}"；请统一使用单色 SVG 图标或纯文本符号（ZTOOLS-STD-7）。`,
        });
      }
    }

    // 6. UI 主题令牌红线（hard）：禁止在业务样式新增行中硬编码 #hex 色值 (ZTOOLS-STD-7)
    if (
      isFrontendOrView
      && insideStyleBlock
      && !isThemeStyleFile
      && !rawLine.includes('style-ratchet-exempt:')
    ) {
      const hexMatch = line.match(/#[0-9a-fA-F]{3,8}\b/);
      if (hexMatch) {
        violations.push({
          file,
          line: lineNumber,
          ruleId: 'quality/ui-no-hardcoded-color',
          standardId: 'ZTOOLS-STD-7',
          severity: 'hard',
          message: `禁止在业务样式中新增硬编码色值 ${hexMatch[0]}；请使用项目 CSS 主题变量令牌（如 var(--rc-*) / var(--ztools-*)）。`,
        });
      }
    }

    // 7. 后端分层边界红线（hard）：禁止在路由层直接编写裸 SQL 语句 (ZTOOLS-STD-8)
    if (
      isBackendRoute
      && /\b(?:SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.test(line)
      && !rawLine.includes('quality-ignore-sql:')
    ) {
      violations.push({
        file,
        line: lineNumber,
        ruleId: 'quality/route-no-raw-sql',
        standardId: 'ZTOOLS-STD-8',
        severity: 'hard',
        message: `后端路由层 (${file}) 禁止直接编写裸 SQL 语句；请将数据库查询与事务下沉至 services/ 或 db/ 层。`,
      });
    }
  }
}

export function analyzeSourceFiles(
  sources,
  {
    tier = 'full',
    changedLinesByFile = null,
    commitSubjects = [],
    minDuplicateLines = DEFAULT_MIN_DUPLICATE_LINES,
    minDuplicateChars = DEFAULT_MIN_DUPLICATE_CHARS,
  } = {},
) {
  const validSources = normalizeSourceEntries(sources);
  const targetSources = validSources.filter((item) => !item.baselineOnly);
  const violations = [];
  const isFastTier = tier === 'fast';

  // 1. 校验 Git 提交信息格式（若提供）
  if (Array.isArray(commitSubjects)) {
    for (const subject of commitSubjects) {
      const check = validateCommitSubject(subject);
      if (!check.valid) {
        violations.push({
          file: 'COMMIT_EDITMSG',
          line: 1,
          ruleId: 'quality/commit-message-format',
          standardId: 'ZTOOLS-STD-10',
          severity: 'hard',
          message: check.message,
        });
      }
    }
  }

  for (const { file, rawBuffer, source } of targetSources) {
    const normalizedFile = toPosixPath(file);
    checkEncodingAndBom(normalizedFile, rawBuffer, source, violations);

    const fullSourceLines = source.split(/\r?\n/);

    // 2. Vue SFC 与 TS/JS 增量 AST 原则性检查
    if (normalizedFile.endsWith('.vue')) {
      const { descriptor } = parseSfc(source, { filename: normalizedFile });
      checkVueSfcStructure(normalizedFile, source, descriptor, isFastTier, violations);

      if (descriptor.script?.content) {
        checkTypeScriptAstAndBoundaries(
          normalizedFile,
          descriptor.script.content,
          descriptor.script.loc.start.line - 1,
          fullSourceLines,
          changedLinesByFile,
          violations,
        );
      }
      if (descriptor.scriptSetup?.content) {
        checkTypeScriptAstAndBoundaries(
          normalizedFile,
          descriptor.scriptSetup.content,
          descriptor.scriptSetup.loc.start.line - 1,
          fullSourceLines,
          changedLinesByFile,
          violations,
        );
      }
    } else if (SCRIPT_EXTENSIONS.has(extname(normalizedFile))) {
      checkTypeScriptAstAndBoundaries(normalizedFile, source, 0, fullSourceLines, changedLinesByFile, violations);
    }

    // 3. 行级原则性红线检查（假数据、UI 黄金法则、零 Emoji、主题令牌、路由分层）
    checkLineLevelRules(normalizedFile, source, changedLinesByFile, violations);
  }

  // 4. 重复代码检测（L1 极速模式仅查单文件内大段复制粘贴；L2 完整模式同时检测跨文件及同目录兄弟文件大段克隆）
  const duplicateBlocks = detectDuplicateBlocks(validSources, {
    minLines: minDuplicateLines,
    minChars: minDuplicateChars,
    changedLinesByFile,
    intraFileOnly: isFastTier,
  });

  for (const clone of duplicateBlocks) {
    const duplicateInScope = isRangeInChangedScope(
      clone.duplicate.file,
      clone.duplicate.startLine,
      clone.duplicate.endLine,
      changedLinesByFile,
    );
    const reportTarget = duplicateInScope ? clone.duplicate : clone.primary;
    const otherSide = duplicateInScope ? clone.primary : clone.duplicate;
    const sameFile = clone.primary.file === clone.duplicate.file;
    const locationDesc = sameFile
      ? `同文件第 ${otherSide.startLine}-${otherSide.endLine} 行`
      : `${otherSide.file}:${otherSide.startLine}-${otherSide.endLine}`;
    violations.push({
      file: reportTarget.file,
      line: reportTarget.startLine,
      ruleId: 'quality/no-duplicate-code',
      standardId: 'ZTOOLS-STD-8',
      severity: 'hard',
      message: `检测到连续 ${clone.effectiveLines} 行大段重复代码块（与 ${locationDesc} 克隆，预览: "${reportTarget.preview.slice(0, 80)}..."）。请提取至公共 shared、service、composable 或组件模块复用。`,
    });
  }

  const hardViolations = violations.filter((v) => v.severity === 'hard');
  const warnings = violations.filter((v) => v.severity === 'warning');

  return {
    schema: 'rex.standards-spec-review.v1',
    format: 'rex.standards-spec-review.v1',
    tier,
    verdict: hardViolations.length === 0 ? 'passed' : 'changes_requested',
    passed: hardViolations.length === 0,
    checkedFileCount: targetSources.length,
    duplicateBlocksDetected: duplicateBlocks.length,
    errorCount: hardViolations.length,
    warningCount: warnings.length,
    hardViolations,
    smellAdvisories: warnings,
    violations,
    duplicateBlocks,
    automatedGate: {
      tier,
      passed: hardViolations.length === 0,
      duplicateBlocksDetected: duplicateBlocks.length,
    },
    standards: {
      hardCount: hardViolations.length,
      judgementCount: warnings.length,
      findings: violations,
    },
    spec: {
      status: 'pending_subagent_verification',
      findingCount: 0,
      findings: [],
    },
  };
}

export function runQualityGate({ mode = 'working', tier = 'full', files = [], json = false, cwd = repoRoot } = {}) {
  const startTime = performance.now();
  const scope = collectTargetScope(mode, files, cwd, tier);
  const targetSources = scope.files.map((file) => readTargetFile(file, mode, cwd));
  const siblingBaselineSources =
    tier === 'full' ? collectSiblingBaselineSources(scope.files, scope.changedLinesByFile, cwd) : [];
  const report = analyzeSourceFiles([...targetSources, ...siblingBaselineSources], {
    tier,
    changedLinesByFile: scope.changedLinesByFile,
    commitSubjects: scope.commitSubjects,
  });
  const durationMs = Math.round(performance.now() - startTime);

  const payload = {
    fixedPoint: scope.fixedPoint,
    mode,
    durationMs,
    targetScope: scope.files,
    ...report,
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  const tierLabel = tier === 'fast' ? 'L1 极速静态扫描' : 'L2 完整质量扫描';

  if (scope.files.length === 0 && scope.commitSubjects.length === 0) {
    console.log(`[quality-gate:${tier}] (${mode}, ${durationMs}ms) 没有需要检查的受管源码变更。`);
    return payload;
  }

  for (const violation of report.violations) {
    const prefix = violation.severity === 'hard' ? '✖ [HARD]' : '⚠ [WARN]';
    console.error(
      `${prefix} ${violation.file}:${violation.line} [${violation.standardId} / ${violation.ruleId}] ${violation.message}`,
    );
  }

  if (!report.passed) {
    console.error(
      `\n[quality-gate:${tier}] ${tierLabel}未通过 (${durationMs}ms)：已检查 ${report.checkedFileCount} 个文件，发现 ${report.errorCount} 个重大原则性错误（含 ${report.duplicateBlocksDetected} 处大段重复代码）、${report.warningCount} 个软性建议。请修复 [HARD] 项后重试。`,
    );
  } else {
    const warnSuffix = report.warningCount > 0 ? `（另有 ${report.warningCount} 个软性建议不阻断）` : '';
    console.log(
      `[quality-gate:${tier}] ${tierLabel}通过 (${durationMs}ms)：已检查 ${report.checkedFileCount} 个文件，0 个重大原则性错误，0 处大段重复代码${warnSuffix}。`,
    );
  }

  return payload;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const tier = args.includes('--fast') ? 'fast' : 'full';
  const filesIdx = args.indexOf('--files');
  let mode = 'working';
  let explicitFiles = [];

  if (filesIdx >= 0) {
    mode = 'files';
    explicitFiles = args.slice(filesIdx + 1).filter((arg) => !arg.startsWith('--'));
  } else if (args.includes('--staged')) {
    mode = 'staged';
  } else if (args.includes('--push')) {
    mode = 'push';
  }

  const result = runQualityGate({ mode, tier, files: explicitFiles, json });
  if (!result.passed) {
    process.exitCode = 1;
  }
}

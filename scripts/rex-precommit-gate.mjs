#!/usr/bin/env node
/**
 * ZTools Rex Code Review Pre-Commit Gate (scripts/rex-precommit-gate.mjs)
 *
 * 在 git commit 提交前（或通过 --all-plugins 全量扫描时）对变动代码执行
 * rex-code-review (ZTOOLS-STD-1 ~ ZTOOLS-STD-8) 硬性红线静态门禁检查。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), '..');

const TARGET_35_PLUGINS = new Set([
  'lan-share',
  'network-adapter',
  'network-rescue',
  'context-menu',
  'wechat-multi',
  'flow-guard',
  'window-management',
  'window-manager',
  'system',
  'system-tools',
  'process-monitor',
  'kill-process',
  'hardware-info',
  'clipboard-history',
  'clipboard-manager',
  'multi-download',
  'video-downloader',
  'mover',
  'data-recovery',
  'shredder',
  'system-backup',
  'sqlite-plugin',
  'wechat-cleaner',
  'qq-cleaner',
  'boost',
  'software-manager',
  'disk-analyzer',
  'cleaner',
  'batch-rename',
  'file-compare',
  'ocr',
  'record',
  'ai-image',
  'ai-video',
  'batch-video',
  'batch-audio',
  'pdf',
  'screenshots',
  'screenshot',
  'color-picker',
  'screen-color-picker',
]);

// 允许的不带色彩的纯文本符号（排除版权/商标等非表情字符）
const ALLOWED_PICTOGRAPHICS = new Set(['©', '®', '™', 'ℹ', '⚙', '⚠']);

function hasColorEmoji(line) {
  // 检测常见彩色 Emoji 范围 (Emoticons, Misc Symbols and Pictographs, Transport/Map, Supplemental Symbols)
  const emojiRegex = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
  const matches = line.match(emojiRegex);
  if (!matches) return null;
  for (const ch of matches) {
    if (!ALLOWED_PICTOGRAPHICS.has(ch) && ch.codePointAt(0) > 0x2600) {
      // 允许纯几何单色符号如 ✓ ✔ ✕ ✖ ★ ☆ ● ○ ◆ ◇ ▶ ▸ ▪ ▫ ➔ ➜ ⌘ ↵ ⌫ ⌦ ⇧ ⌃ ⌥ ↑ ↓ ← →
      const cp = ch.codePointAt(0);
      const isAllowedMonoSymbol =
        cp === 0x2713 || // ✓
        cp === 0x2714 || // ✔
        cp === 0x2715 || // ✕
        cp === 0x2716 || // ✖
        cp === 0x2717 || // ✗
        cp === 0x2718 || // ✘
        cp === 0x2605 || // ★
        cp === 0x2606 || // ☆
        cp === 0x26a1 || // ⚡ check below
        (cp >= 0x2794 && cp <= 0x27be); // arrows
      if (!isAllowedMonoSymbol || cp >= 0x1f300 || cp === 0x26a0 || cp === 0x26a1 || cp === 0x2699) {
        return ch;
      }
    }
  }
  return null;
}

function isTarget35PluginFile(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  const m1 = norm.match(/^packages\/declarative-ui\/src\/examples\/([^/]+)\/[^/]+\.(ts|tsx)$/);
  if (m1 && TARGET_35_PLUGINS.has(m1[1])) return { plugin: m1[1], kind: 'examples' };

  const m2 = norm.match(/^plugins\/([^/]+)\/src\/[^/]+\.(ts|tsx)$/);
  if (m2 && TARGET_35_PLUGINS.has(m2[1])) return { plugin: m2[1], kind: 'plugins' };

  const m3 = norm.match(/^plugins\/create-plugin\/src\/plugins\/([^/]+)\/[^/]+\.(ts|tsx)$/);
  if (m3 && TARGET_35_PLUGINS.has(m3[1])) return { plugin: m3[1], kind: 'create-plugin' };

  return null;
}

function scanPluginFile(absPath, relPath) {
  const findings = [];
  if (!fs.existsSync(absPath)) return findings;
  const content = fs.readFileSync(absPath, 'utf8');
  const lines = content.split(/\r?\n/);
  const isUiIndex = /\/index\.(ts|tsx)$/.test(relPath.replace(/\\/g, '/'));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    // [ZTOOLS-STD-1] 禁止硬编码私人路径与固定假局域网 IP
    if (line.includes('D:\\Local\\Roaming\\Tencent') || line.includes('D:\\\\Local\\\\Roaming\\\\Tencent')) {
      findings.push({
        ruleId: 'ZTOOLS-STD-1',
        file: relPath,
        line: lineNo,
        message: '发现硬编码私人路径 D:\\Local\\Roaming\\Tencent',
      });
    }
    if (line.includes('192.168.1.108')) {
      findings.push({
        ruleId: 'ZTOOLS-STD-1',
        file: relPath,
        line: lineNo,
        message: '发现硬编码假局域网 IP 192.168.1.108',
      });
    }

    // [ZTOOLS-STD-4 / STD-5] UI 顶栏禁止 metricGrid / distributionBar / wizardSteps / segmentedControl
    if (isUiIndex) {
      if (/\bmetricGrid\s*[:=]/.test(line)) {
        findings.push({
          ruleId: 'ZTOOLS-STD-4',
          file: relPath,
          line: lineNo,
          message: '严禁在声明式插件 List 上传入大尺寸统计卡片 metricGrid（违反顶栏 <=20% 高度红线）',
        });
      }
      if (/\bdistributionBar\s*[:=]/.test(line)) {
        findings.push({
          ruleId: 'ZTOOLS-STD-5',
          file: relPath,
          line: lineNo,
          message: '严禁在声明式插件 List 上传入彩色比例条 distributionBar（违反单一信源与去彩虹化红线）',
        });
      }
      if (/\bwizardSteps\s*:/.test(line)) {
        findings.push({
          ruleId: 'ZTOOLS-STD-4',
          file: relPath,
          line: lineNo,
          message: '严禁在声明式插件 filterBar 中堆叠 wizardSteps 步骤条（违反顶栏 <=20% 高度红线）',
        });
      }
      if (/\bsegmentedControl\s*[:=]/.test(line)) {
        findings.push({
          ruleId: 'ZTOOLS-STD-4',
          file: relPath,
          line: lineNo,
          message: '严禁在声明式插件 List 上额外堆叠 segmentedControl（违反三大标准布局极简顶栏契约）',
        });
      }
    }

    // [ZTOOLS-STD-7] 禁止彩色 Emoji 与带圈数字 ①~⑳ 与 EXT_COLORS 彩虹数组
    const emoji = hasColorEmoji(line);
    if (emoji) {
      findings.push({
        ruleId: 'ZTOOLS-STD-7',
        file: relPath,
        line: lineNo,
        message: `发现系统彩色 Emoji "${emoji}"（违反零彩色 Emoji 污染红线）`,
      });
    }
    const circledMatch = line.match(/[①-⑳]/u);
    if (circledMatch) {
      findings.push({
        ruleId: 'ZTOOLS-STD-7',
        file: relPath,
        line: lineNo,
        message: `发现带圈数字符号 "${circledMatch[0]}"（请使用纯文本或标准序号）`,
      });
    }
    if (/\bconst\s+EXT_COLORS\s*=/.test(line)) {
      findings.push({
        ruleId: 'ZTOOLS-STD-7',
        file: relPath,
        line: lineNo,
        message: '发现 EXT_COLORS 彩虹色循环数组（违反 90% 灰阶单色去彩虹化原则）',
      });
    }
  }

  return findings;
}

function collectChangedFiles() {
  const files = new Set();
  const repos = ['.', 'electron-client', 'frontend', 'plugins'];
  const cleanGitEnv = { ...process.env };
  delete cleanGitEnv.GIT_DIR;
  delete cleanGitEnv.GIT_WORK_TREE;
  delete cleanGitEnv.GIT_INDEX_FILE;
  delete cleanGitEnv.GIT_PREFIX;
  for (const repo of repos) {
    const repoDir = path.join(ROOT_DIR, repo);
    if (!fs.existsSync(repoDir)) continue;
    try {
      const out = execSync('git status --porcelain', {
        cwd: repoDir,
        encoding: 'utf8',
        env: cleanGitEnv,
      });
      for (const line of out.split(/\r?\n/)) {
        if (!line || line.length < 4) continue;
        const rawPath = line.slice(3).trim().replace(/^"|"$/g, '');
        const finalRel = repo === '.' ? rawPath : `${repo}/${rawPath}`;
        files.add(finalRel.replace(/\\/g, '/'));
      }
    } catch {
      // ignore
    }
  }
  return Array.from(files);
}

function collectAll35PluginFiles() {
  const results = [];
  const exRoot = path.join(ROOT_DIR, 'packages/declarative-ui/src/examples');
  if (fs.existsSync(exRoot)) {
    for (const dir of fs.readdirSync(exRoot)) {
      if (!TARGET_35_PLUGINS.has(dir)) continue;
      const fullDir = path.join(exRoot, dir);
      if (!fs.statSync(fullDir).isDirectory()) continue;
      for (const f of fs.readdirSync(fullDir)) {
        if (f.endsWith('.ts') || f.endsWith('.tsx')) {
          results.push(`packages/declarative-ui/src/examples/${dir}/${f}`);
        }
      }
    }
  }
  return results;
}

const args = process.argv.slice(2);
const scanAll = args.includes('--all-plugins');
const targetRelFiles = scanAll ? collectAll35PluginFiles() : collectChangedFiles();

const allFindings = [];
let scannedCount = 0;

for (const rel of targetRelFiles) {
  const info = isTarget35PluginFile(rel);
  if (!info) continue;
  scannedCount++;
  const abs = path.join(ROOT_DIR, rel);
  allFindings.push(...scanPluginFile(abs, rel));
}

if (allFindings.length > 0) {
  console.error(`\n[rex-code-review precommit gate] ❌ 检测到 ${allFindings.length} 项硬性规范违规（已扫描 ${scannedCount} 个目标插件文件）：`);
  for (const f of allFindings.slice(0, 50)) {
    console.error(`  - [${f.ruleId}] ${f.file}:${f.line} -> ${f.message}`);
  }
  if (allFindings.length > 50) {
    console.error(`  ... 以及其余 ${allFindings.length - 50} 项违规`);
  }
  process.exit(1);
} else {
  console.log(`[rex-code-review precommit gate] ✅ 通过 ZTools 硬性红线静态门禁检查（已扫描 ${scannedCount} 个目标插件文件，0 违规）`);
}

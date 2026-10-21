import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runRexCodeReviewGate } from '../.agent/skills/rex-code-review/scripts/review-gate.mjs';
import {
  analyzeSourceFiles,
  detectDuplicateBlocks,
  runQualityGate,
  validateCommitSubject,
} from './quality-gate.mjs';

test('合规的 Vue SFC、声明式 UI 插件与 Electron 服务代码通过全量门禁并返回 rex.standards-spec-review.v1 passed 信封', async () => {
  const sources = [
    {
      file: 'frontend/src/views/launcher/components/LauncherSearchBar.vue',
      source: `<template>
  <section class="launcher-search-bar" :style="{ '--bar-height': barHeight }">
    <button class="action-btn" @click="handleTrigger">
      <span>{{ buttonLabel }}</span>
    </button>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useLauncherStore } from '../../stores/useLauncherStore';

const store = useLauncherStore();
const buttonLabel = '执行指令';
const barHeight = computed(() => '44px');

function handleTrigger() {
  store.triggerSelected();
}
</script>

<style scoped>
.launcher-search-bar {
  display: flex;
  height: var(--bar-height);
  background: var(--rc-bg-elevated);
  color: var(--rc-text-primary);
  border-bottom: 1px solid var(--rc-border-subtle);
}
</style>
`,
    },
    {
      file: 'packages/declarative-ui/src/examples/kill-process/helper.ts',
      source: `export interface ProcessRowInput {
  pid: number;
  name: string;
  memoryBytes: number;
}

export function formatProcessSummary(input: ProcessRowInput): string {
  const mb = (input.memoryBytes / (1024 * 1024)).toFixed(1);
  return \`\${input.name} (PID \${input.pid}) · \${mb} MB\`;
}
`,
    },
  ];

  const report = await runRexCodeReviewGate(sources, {
    fixedPoint: 'HEAD',
    commitSubjects: ['feat: 新增启动器搜索栏组件与进程摘要格式化工具'],
  });

  assert.equal(report.schema, 'rex.standards-spec-review.v1');
  assert.equal(report.verdict, 'passed');
  assert.equal(report.automatedGate.passed, true);
  assert.equal(report.automatedGate.duplicateBlocksDetected, 0);
  assert.equal(report.standards.hardCount, 0);
});

test('抓大放小：函数行数(>300行)、Vue 文件总行数(>500行)、内联:style、CSS排版细节等软性细节仅作 warning 或免检，绝不阻断提交', () => {
  const longLines = Array.from({ length: 320 }, (_, idx) => `  const stepValue${idx} = ${idx};`).join('\n');
  const extraComments = Array.from({ length: 200 }, (_, idx) => `// 软性行数填充注释 ${idx}`).join('\n');
  const report = analyzeSourceFiles([
    {
      file: 'frontend/src/views/settings/SoftDetailPanel.vue',
      source: `<template>
  <div class="soft-detail-panel" :style="{ width: dynamicWidth }">内容</div>
</template>

<script setup lang="ts">
const dynamicWidth = '240px';
export function longPipelineBuilder(input: Record<string, unknown>) {
${longLines}
  return { input, stepValue0 };
}
${extraComments}
</script>

<style scoped>
.soft-detail-panel {
  color:var(--rc-text-primary);
  background: var(--rc-bg-panel);
}
</style>
`,
    },
  ]);

  assert.equal(report.passed, true);
  assert.equal(report.verdict, 'passed');
  assert.equal(report.errorCount, 0);
  const warningRules = report.smellAdvisories.map((w) => w.ruleId);
  assert.ok(warningRules.includes('quality/function-size-warning'));
  assert.ok(warningRules.includes('vue-arch/vue-dynamic-style'));
  assert.ok(warningRules.includes('vue-arch/vue-max-lines'));
});

test('拦截 UTF-8 BOM 头与 Unicode 替换符乱码 (ZTOOLS-STD-8)', () => {
  const report = analyzeSourceFiles([
    {
      file: 'electron-client/src/main/services/bomService.ts',
      hasBom: true,
      source: 'export const label = "正常文本";\n',
    },
    {
      file: 'electron-client/src/main/services/garbledService.ts',
      source: 'export const broken = "包含乱码\uFFFD字符";\n',
    },
  ]);

  assert.equal(report.passed, false);
  const ruleIds = report.hardViolations.map((v) => v.ruleId);
  assert.ok(ruleIds.includes('quality/encoding-utf8-nobom'));
  assert.ok(ruleIds.includes('quality/encoding-no-garbled-text'));
});

test('拦截代码原则性违规：空 catch 吞错、显式 any、假数据/假成功与 Math.random 生成生产 ID (ZTOOLS-STD-1 / ZTOOLS-STD-8)', () => {
  const report = analyzeSourceFiles([
    {
      file: 'packages/declarative-ui/src/examples/record/badRecorder.ts',
      source: `export function startRecordSession(payload: any) {
  const sessionId = 'rec_' + Math.random();
  const fallbackDir = 'D:\\\\Local\\\\Roaming\\\\Tencent\\\\WeChat';
  try {
    return { ok: true, simulated: true, sessionId, fallbackDir, payload };
  } catch {}
}
`,
    },
  ]);

  assert.equal(report.passed, false);
  const ruleIds = report.hardViolations.map((v) => v.ruleId);
  assert.ok(ruleIds.includes('quality/no-explicit-any'));
  assert.ok(ruleIds.includes('quality/no-insecure-random-id'));
  assert.ok(ruleIds.includes('quality/no-fake-host-data'));
  assert.ok(ruleIds.includes('quality/no-empty-catch'));
});

test('拦截声明式插件与前端 UI 原则性违规：彩色 Emoji、MetricGrid、distributionBar、重复筛选、彩虹色、插件直操 DOM/CSS、业务硬编码 #hex 与 Vue 缺 scoped (ZTOOLS-STD-2 ~ STD-7)', () => {
  const report = analyzeSourceFiles([
    {
      file: 'packages/declarative-ui/src/examples/disk-analyzer/index.tsx',
      source: `import { Color } from '@ztools/declarative-ui';

const EXT_COLORS = [Color.Purple, Color.Blue];

export function renderBadPlugin() {
  const styleEl = document.createElement('style');
  styleEl.innerHTML = '.bad { color: red }';
  return {
    title: '🚀 磁盘空间分析 ①',
    metricGrid: [{ label: '总容量', value: '1TB' }],
    distributionBar: [{ label: '视频', ratio: 0.5 }],
    searchBarAccessory: { type: 'Dropdown' },
    filterBar: {
      summaryText: '扫描完成',
      groups: [{ id: 'all', title: '全部' }],
    },
    tag: { value: '大文件', color: Color.Purple },
    EXT_COLORS,
  };
}
`,
    },
    {
      file: 'packages/declarative-ui/src/examples/disk-analyzer/custom.css',
      source: `.custom-plugin { color: var(--rc-text-primary); }\n`,
    },
    {
      file: 'frontend/src/views/settings/BadThemePanel.vue',
      source: `<template>
  <div class="bad-theme-panel">🗑️ 清理缓存</div>
</template>

<script lang="ts">
export default {
  name: 'BadThemePanel',
};
</script>

<style>
.bad-theme-panel {
  background: #2b2d31;
  color: #5865f2;
}
</style>
`,
    },
  ]);

  assert.equal(report.passed, false);
  const ruleIds = report.hardViolations.map((v) => v.ruleId);
  assert.ok(ruleIds.includes('quality/plugin-no-dom-access'));
  assert.ok(ruleIds.includes('quality/plugin-no-style-file'));
  assert.ok(ruleIds.includes('quality/ui-no-colorful-emoji'));
  assert.ok(ruleIds.includes('quality/ui-no-metric-grid'));
  assert.ok(ruleIds.includes('quality/ui-no-distribution-bar'));
  assert.ok(ruleIds.includes('quality/ui-no-duplicate-filter'));
  assert.ok(ruleIds.includes('quality/ui-no-rainbow-color'));
  assert.ok(ruleIds.includes('quality/ui-no-hardcoded-color'));
  assert.ok(ruleIds.includes('vue-arch/vue-script-setup'));
  assert.ok(ruleIds.includes('vue-arch/vue-style-scope'));
});

test('允许全局主题文件定义 #hex 色值，且允许声明式插件在真正高危告警处使用 Color.Red 与单色几何符号 ✓/✗', () => {
  const report = analyzeSourceFiles([
    {
      file: 'frontend/src/styles/theme.css',
      source: `:root {
  --rc-bg-elevated: #1e1f22;
  --rc-text-primary: #f2f3f5;
}
`,
    },
    {
      file: 'packages/declarative-ui/src/examples/disk-analyzer/statusTag.ts',
      source: `import { Color } from '@ztools/declarative-ui';

export function buildCriticalDiskTag() {
  return {
    title: '[✓] 系统主分区 (C:) 空间告警',
    tag: { value: '96% 高危', color: Color.Red },
  };
}
`,
    },
  ]);

  assert.equal(report.passed, true);
  assert.equal(report.errorCount, 0);
});

test('拦截架构越层与安全红线：视图层直调 @/api 或 fetch、Renderer 直导 Node 原生模块、后端路由层直写裸 SQL、动态 eval/new Function 与十六进制混淆 (ZTOOLS-STD-8)', () => {
  const report = analyzeSourceFiles([
    {
      file: 'frontend/src/views/market/BadMarketView.vue',
      source: `<template>
  <div class="market-view">{{ statusText }}</div>
</template>

<script setup lang="ts">
import fs from 'node:fs';
import { fetchPluginList } from '@/api/market';

const statusText = '插件市场';
async function loadMarketDirect() {
  void fs;
  void fetchPluginList;
  return fetch('/api/plugins');
}
void loadMarketDirect;
</script>

<style scoped>
.market-view {
  color: var(--rc-text-primary);
}
</style>
`,
    },
    {
      file: 'backend/src/routes/badFeedbackRoute.ts',
      source: `export async function listFeedbacksInRoute(db: { query: (sql: string) => Promise<unknown> }, code: string) {
  const obf = "\\x65\\x76\\x61\\x6c";
  const fn = new Function(code);
  eval(obf);
  void fn;
  return db.query('SELECT id, content FROM feedbacks WHERE status = 1');
}
`,
    },
  ]);

  assert.equal(report.passed, false);
  const ruleIds = report.hardViolations.map((v) => v.ruleId);
  assert.ok(ruleIds.includes('quality/view-no-direct-api'));
  assert.ok(ruleIds.includes('quality/renderer-no-node-builtins'));
  assert.ok(ruleIds.includes('quality/route-no-raw-sql'));
  assert.ok(ruleIds.includes('quality/security-no-dynamic-eval'));
  assert.ok(ruleIds.includes('quality/security-no-hex-obfuscation'));
});

test('分级扫描 (L1 fast vs L2 full)：L1 极速查文件内克隆，L2 完整扫描拦截跨文件连续 >= 16 行大段重复代码块，且三处插件镜像同步不误报 (ZTOOLS-STD-8)', () => {
  const repeatedBlock = [
    '  const normalizedKeyword = rawQuery.trim().toLowerCase();',
    '  const categoryFilter = options.category ?? "all";',
    '  const sortField = options.sortBy ?? "memoryDesc";',
    '  const minSizeBytes = Number(options.minSizeMb ?? 50) * 1024 * 1024;',
    '  const maxLimit = Math.min(Math.max(Number(options.limit ?? 100), 10), 500);',
    '  const includeSystem = Boolean(options.includeSystem ?? false);',
    '  const protectedRoots = ["C:\\\\Windows", "C:\\\\Program Files", "C:\\\\Program Files (x86)"];',
    '  if (protectedRoots.some((root) => normalizedKeyword.startsWith(root.toLowerCase()))) {',
    '    throw new Error("SECURITY_GUARD: 严禁扫描或清理系统受保护核心目录");',
    '  }',
    '  const safeTimeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 5000;',
    '  const hostAvailable = Boolean(options.isRealElectronHost);',
    '  const executionChannel = hostAvailable ? "ipc:native-scanner" : "fallback:empty";',
    '  const requestEnvelope = { keyword: normalizedKeyword, categoryFilter, sortField, minSizeBytes, maxLimit, includeSystem };',
    '  const traceMetadata = { requestedAt: Date.now(), safeTimeoutMs, executionChannel };',
    '  const finalSummary = `${categoryFilter}:${sortField}:${maxLimit}:${executionChannel}`;',
    '  return { requestEnvelope, traceMetadata, finalSummary };',
  ].join('\n');

  const fileA = `export function buildDiskScanRequest(rawQuery: string, options: Record<string, unknown>) {\n${repeatedBlock}\n}\n`;
  const fileB = `export function buildCleanerScanRequest(rawQuery: string, options: Record<string, unknown>) {\n${repeatedBlock}\n}\n`;

  // 1. L1 极速扫描 (tier: 'fast') 仅查单文件内克隆，跨文件跳过以保持毫秒级响应
  const fastReport = analyzeSourceFiles(
    [
      { file: 'electron-client/src/main/services/diskScanService.ts', source: fileA },
      { file: 'electron-client/src/main/services/cleanerScanService.ts', source: fileB },
    ],
    { tier: 'fast' },
  );
  assert.equal(fastReport.passed, true);
  assert.equal(fastReport.duplicateBlocksDetected, 0);

  // 2. L2 完整扫描 (tier: 'full') 精准拦截同构建域跨文件大段重复代码块
  const fullReport = analyzeSourceFiles(
    [
      { file: 'electron-client/src/main/services/diskScanService.ts', source: fileA },
      { file: 'electron-client/src/main/services/cleanerScanService.ts', source: fileB },
    ],
    { tier: 'full' },
  );
  assert.equal(fullReport.passed, false);
  assert.equal(fullReport.duplicateBlocksDetected, 1);
  assert.ok(fullReport.hardViolations.some((v) => v.ruleId === 'quality/no-duplicate-code' && v.standardId === 'ZTOOLS-STD-8'));

  // 3. 内置声明式插件在三处镜像目录（examples / plugins / create-plugin）同步相同代码时，不应误报跨镜像克隆
  const mirrorSyncReport = analyzeSourceFiles(
    [
      { file: 'packages/declarative-ui/src/examples/disk-analyzer/scanHelper.ts', source: fileA },
      { file: 'plugins/disk-analyzer/src/scanHelper.ts', source: fileA },
      { file: 'plugins/create-plugin/src/plugins/disk-analyzer/scanHelper.ts', source: fileA },
    ],
    { tier: 'full' },
  );
  assert.equal(mirrorSyncReport.passed, true);
  assert.equal(mirrorSyncReport.duplicateBlocksDetected, 0);

  // 4. 当克隆区间不在本次变更行内时，不应误报阻塞
  const unchangedMap = new Map([
    ['electron-client/src/main/services/diskScanService.ts', new Set([1])],
    ['electron-client/src/main/services/cleanerScanService.ts', new Set([1])],
  ]);
  const scopedClones = detectDuplicateBlocks(
    [
      { file: 'electron-client/src/main/services/diskScanService.ts', source: fileA },
      { file: 'electron-client/src/main/services/cleanerScanService.ts', source: fileB },
    ],
    { changedLinesByFile: unchangedMap },
  );
  assert.equal(scopedClones.length, 0);
});

test('校验 Git 提交说明中文规范：放行标准中文提交，拦截纯英文或无类型前缀提交 (ZTOOLS-STD-10)', () => {
  assert.equal(validateCommitSubject('feat: 新增代码审查与推送质量门禁').valid, true);
  assert.equal(validateCommitSubject('fix(declarative-ui): 修复进程管理器列表筛选状态同步问题').valid, true);
  assert.equal(validateCommitSubject('Merge branch "main" into dev').valid, true);

  const englishOnly = validateCommitSubject('feat: add code review skill and pre-push gate');
  assert.equal(englishOnly.valid, false);
  assert.match(englishOnly.message, /中文/);

  const missingPrefix = validateCommitSubject('修复托盘唤醒闪烁问题');
  assert.equal(missingPrefix.valid, false);
  assert.match(missingPrefix.message, /前缀/);
});

test('真实临时 Git 仓库集成测试：验证提交(staged)自动对比同目录未修改兄弟文件的重复代码，且推送(push)拦截原则性违规', () => {
  const tempRepo = mkdtempSync(join(tmpdir(), 'ztools-quality-gate-repo-'));
  try {
    execFileSync('git', ['init'], { cwd: tempRepo });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempRepo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempRepo });

    const sharedLines = Array.from(
      { length: 17 },
      (_, idx) => `  const normalizedMetric${idx} = Number(input.metric${idx} ?? ${idx}) * 2 + ${idx};`,
    ).join('\n');

    mkdirSync(join(tempRepo, 'electron-client', 'src', 'main', 'services'), { recursive: true });
    writeFileSync(
      join(tempRepo, 'electron-client', 'src', 'main', 'services', 'existingHostService.ts'),
      `export function runExistingHostFlow(input: Record<string, unknown>) {\n${sharedLines}\n  return normalizedMetric0;\n}\n`,
      'utf8',
    );
    execFileSync('git', ['add', 'electron-client/src/main/services/existingHostService.ts'], { cwd: tempRepo });
    execFileSync('git', ['commit', '-m', 'feat: 初始化宿主基础服务'], { cwd: tempRepo });

    // 1. 新增同目录文件 copiedHostService.ts，直接从 existingHostService.ts 复制粘贴 17 行代码并暂存
    //    即使 existingHostService.ts 本次未修改，staged 完整扫描也会自动加载同目录兄弟文件抓出克隆！
    writeFileSync(
      join(tempRepo, 'electron-client', 'src', 'main', 'services', 'copiedHostService.ts'),
      `export function runCopiedHostFlow(input: Record<string, unknown>) {\n${sharedLines}\n  return normalizedMetric0;\n}\n`,
      'utf8',
    );
    execFileSync('git', ['add', 'electron-client/src/main/services/copiedHostService.ts'], { cwd: tempRepo });

    const stagedCloneFail = runQualityGate({ mode: 'staged', tier: 'full', cwd: tempRepo, json: true });
    assert.equal(stagedCloneFail.passed, false);
    assert.equal(stagedCloneFail.duplicateBlocksDetected, 1);
    assert.equal(stagedCloneFail.hardViolations[0].file, 'electron-client/src/main/services/copiedHostService.ts');
    assert.equal(stagedCloneFail.hardViolations[0].ruleId, 'quality/no-duplicate-code');

    // 2. 将 copiedHostService.ts 改为正常复用后暂存，验证 staged 完整扫描通过
    writeFileSync(
      join(tempRepo, 'electron-client', 'src', 'main', 'services', 'copiedHostService.ts'),
      `import { runExistingHostFlow } from './existingHostService';\nexport function runCopiedHostFlow(input: Record<string, unknown>) {\n  return runExistingHostFlow(input);\n}\n`,
      'utf8',
    );
    execFileSync('git', ['add', 'electron-client/src/main/services/copiedHostService.ts'], { cwd: tempRepo });

    const stagedPass = runQualityGate({ mode: 'staged', tier: 'full', cwd: tempRepo, json: true });
    assert.equal(stagedPass.passed, true);
    execFileSync('git', ['commit', '-m', 'feat: 复用宿主基础服务避免重复代码'], { cwd: tempRepo });

    // 3. 提交一笔包含纯英文 commit message 和显式 any 的改动，验证 push 模式阻断
    writeFileSync(
      join(tempRepo, 'electron-client', 'src', 'main', 'services', 'copiedHostService.ts'),
      `export function runCopiedHostFlow(input: any) {\n  return input;\n}\n`,
      'utf8',
    );
    execFileSync('git', ['add', 'electron-client/src/main/services/copiedHostService.ts'], { cwd: tempRepo });
    execFileSync('git', ['commit', '-m', 'fix: use any type in host service'], { cwd: tempRepo });

    const pushFail = runQualityGate({ mode: 'push', tier: 'full', cwd: tempRepo, json: true });
    assert.equal(pushFail.passed, false);
    const ruleIds = pushFail.hardViolations.map((v) => v.ruleId);
    assert.ok(ruleIds.includes('quality/commit-message-format'));
    assert.ok(ruleIds.includes('quality/no-explicit-any'));
  } finally {
    rmSync(tempRepo, { recursive: true, force: true });
  }
});

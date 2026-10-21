#!/usr/bin/env node
/**
 * ZTools 35+ 本地声明式插件三端目录强制同步脚本 (ZTOOLS-STD-8)
 *
 * 将 `packages/declarative-ui/src/examples/<dir>` 同步至脚手架模板 `plugins/create-plugin/src/plugins/<templateDir>`。
 *
 * 注意：插件源码已改为以 `plugins/<pluginDir>/src` 为准（可在插件目录内独立编译、由 CI 从源码构建发布），
 * 本脚本不再覆盖 `plugins/<pluginDir>/src`。修改插件请直接改 `plugins/<pluginDir>/src`，
 * 然后在插件仓库运行 `node scripts/build-declarative.mjs <pluginDir>` 重新生成 dist/。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const EXAMPLES_ROOT = path.join(ROOT_DIR, 'packages', 'declarative-ui', 'src', 'examples');
const PLUGINS_ROOT = path.join(ROOT_DIR, 'plugins');
const CREATE_PLUGIN_ROOT = path.join(ROOT_DIR, 'plugins', 'create-plugin', 'src', 'plugins');

// 移除源码目录中历史遗留的编译产物 .js 文件
const STALE_JS_FILES = [
  path.join(EXAMPLES_ROOT, 'screen-color-picker', 'converter.js'),
  path.join(EXAMPLES_ROOT, 'kill-process', 'process-manager.js'),
  path.join(PLUGINS_ROOT, 'color-picker', 'src', 'converter.js'),
  path.join(PLUGINS_ROOT, 'screen-color-picker', 'src', 'converter.js'),
  path.join(PLUGINS_ROOT, 'kill-process', 'src', 'process-manager.js'),
];

for (const staleFile of STALE_JS_FILES) {
  if (fs.existsSync(staleFile)) {
    fs.unlinkSync(staleFile);
  }
}

// 35+ 插件三端映射表
const PLUGIN_SYNC_MAP = [
  // 公共 IPC 桥接层
  { example: 'shared', plugins: ['shared'], createPlugins: ['shared'], isShared: true },

  // 布局一 (11 + 1 款)
  { example: 'lan-share', plugins: ['lan-share'], createPlugins: ['lan-share'] },
  { example: 'network-adapter', plugins: ['network-adapter'], createPlugins: ['network-adapter'] },
  { example: 'network-rescue', plugins: ['network-rescue'], createPlugins: ['network-rescue'] },
  { example: 'context-menu', plugins: ['context-menu'], createPlugins: ['context-menu'] },
  { example: 'wechat-multi', plugins: ['wechat-multi'], createPlugins: ['wechat-multi'] },
  { example: 'flow-guard', plugins: ['flow-guard'], createPlugins: ['flow-guard'] },
  { example: 'window-management', plugins: ['window-manager'], createPlugins: ['window-manager'] },
  { example: 'system', plugins: ['system-tools'], createPlugins: ['system-tools'] },
  { example: 'process-monitor', plugins: ['process-monitor'], createPlugins: ['process-monitor'] },
  { example: 'kill-process', plugins: ['kill-process'], createPlugins: ['kill-process'] },
  { example: 'hardware-info', plugins: ['hardware-info'], createPlugins: ['hardware-info'] },
  { example: 'clipboard-history', plugins: ['clipboard-manager'], createPlugins: ['clipboard-manager'] },

  // 布局二 (14 款)
  { example: 'multi-download', plugins: ['multi-download'], createPlugins: ['multi-download'] },
  { example: 'video-downloader', plugins: ['video-downloader'], createPlugins: ['video-downloader'] },
  { example: 'mover', plugins: ['mover'], createPlugins: ['mover'] },
  { example: 'data-recovery', plugins: ['data-recovery'], createPlugins: ['data-recovery'] },
  { example: 'shredder', plugins: ['shredder'], createPlugins: ['shredder'] },
  { example: 'system-backup', plugins: ['system-backup'], createPlugins: ['system-backup'] },
  { example: 'sqlite-plugin', plugins: ['sqlite-plugin'], createPlugins: ['sqlite-plugin'] },
  { example: 'wechat-cleaner', plugins: ['wechat-cleaner'], createPlugins: ['wechat-cleaner'] },
  { example: 'qq-cleaner', plugins: ['qq-cleaner'], createPlugins: ['qq-cleaner'] },
  { example: 'boost', plugins: ['boost'], createPlugins: ['boost'] },
  { example: 'software-manager', plugins: ['software-manager'], createPlugins: ['software-manager'] },
  { example: 'disk-analyzer', plugins: ['disk-analyzer'], createPlugins: ['disk-analyzer'] },
  { example: 'cleaner', plugins: ['cleaner'], createPlugins: ['cleaner'] },
  { example: 'batch-rename', plugins: ['batch-rename'], createPlugins: ['batch-rename'] },

  // 布局三 (9 款)。文本对比、颜色转换、JSON、计算器、二维码、便签由客户端内置插件（plugins/<id>）提供，
  // 不再在 examples 里保留重复实现，也不从这里同步。
  { example: 'ocr', plugins: ['ocr'], createPlugins: ['ocr'] },
  { example: 'record', plugins: ['record'], createPlugins: ['record'] },
  { example: 'ai-image', plugins: ['ai-image'], createPlugins: ['ai-image'] },
  { example: 'ai-video', plugins: ['ai-video'], createPlugins: ['ai-video'] },
  { example: 'batch-video', plugins: ['batch-video'], createPlugins: ['batch-video'] },
  { example: 'batch-audio', plugins: ['batch-audio'], createPlugins: ['batch-audio'] },
  { example: 'pdf', plugins: ['pdf'], createPlugins: ['pdf'] },
  { example: 'screenshots', plugins: ['screenshot'], createPlugins: ['screenshot'] },
  { example: 'screen-color-picker', plugins: ['screen-color-picker'], createPlugins: ['screen-color-picker'] },
];

let syncedFileCount = 0;

for (const item of PLUGIN_SYNC_MAP) {
  const srcDir = path.join(EXAMPLES_ROOT, item.example);
  if (!fs.existsSync(srcDir)) {
    console.error(`[sync-35-plugins] Source directory missing: ${srcDir}`);
    process.exit(1);
  }

  const tsFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

  // 同步到 plugins/create-plugin/src/plugins/<dir>
  for (const templateName of item.createPlugins) {
    const destDir = path.join(CREATE_PLUGIN_ROOT, templateName);
    fs.mkdirSync(destDir, { recursive: true });
    for (const file of tsFiles) {
      const content = fs.readFileSync(path.join(srcDir, file), 'utf8');
      fs.writeFileSync(path.join(destDir, file), content, 'utf8');
      syncedFileCount++;
    }
  }
}

console.log(`[sync-35-plugins] ✅ 已同步 ${PLUGIN_SYNC_MAP.length} 组脚手架模板（共写入 ${syncedFileCount} 个文件；plugins/<id>/src 不再被覆盖）`);


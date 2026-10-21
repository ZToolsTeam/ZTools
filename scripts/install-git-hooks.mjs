import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let isGitRepository = false;
try {
  execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoRoot, stdio: 'ignore' });
  isGitRepository = true;
} catch {
  console.log('当前目录不是 Git 工作区，跳过本地 Hook 安装。');
}

if (isGitRepository) {
  try {
    execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: repoRoot, stdio: 'ignore' });
    console.log('ZTools Git 提交与推送质量门禁已启用：core.hooksPath=.githooks');
  } catch (error) {
    console.error('Git Hook 安装失败：', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

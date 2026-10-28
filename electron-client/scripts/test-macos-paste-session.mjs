import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 测试替身覆盖权限、焦点与发送操作，不启动监听会话，也不输入真实按键。
if (process.platform !== 'darwin') {
  console.log('NOT_RUN: 原生粘贴会话边界测试需要 macOS')
} else {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-paste-session-test-'))
  try {
    const executable = path.join(output, 'paste-session-test')
    const source = fileURLToPath(new URL('../native/ZToolsMacClipboard/paste_session_test.mm', import.meta.url))
    execFileSync('/usr/bin/xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-Wall', '-Wextra', '-Werror',
      '-framework', 'AppKit', '-framework', 'Foundation', '-framework', 'ApplicationServices',
      '-framework', 'Carbon', source, '-o', executable], { stdio: 'inherit', timeout: 120_000, shell: false })
    execFileSync(executable, [], { stdio: 'inherit', timeout: 15_000, shell: false })
  } finally { fs.rmSync(output, { recursive: true, force: true }) }
}

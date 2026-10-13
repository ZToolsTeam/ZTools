/**
 * API 测试 - 文件系统 API (ztools.fs)
 * 测试文件读写、目录操作等
 */

module.exports = async (runner) => {
  await runner.runSuite('API: 文件系统', [
    {
      name: 'fs.getCurrentDirectory 获取当前目录',
      fn: async (cdp, assert) => {
        const dir = await cdp.evaluate('(async()=>await ztools.fs.getCurrentDirectory())()')
        assert.ok(dir, '当前目录不应为空')
        assert.typeOf(dir, 'string', '目录应为字符串')
      }
    },
    {
      name: 'fs.fileExists 检测已知文件',
      fn: async (cdp, assert) => {
        // 当前目录是 bin/Data，ZTools exe 在 bin/ 下
        const exists = await cdp.evaluate(
          '(async function(){ var dir = await ztools.fs.getCurrentDirectory(); var exePath = dir.replace(/\\\\Data$/i, "") + "\\\\ZTools_Debug.exe"; var r = await ztools.fs.fileExists(exePath); if (!r) { exePath = dir.replace(/\\\\Data$/i, "") + "\\\\ZTools.exe"; r = await ztools.fs.fileExists(exePath); } return r; })()'
        )
        assert.ok(exists === true, 'ZTools exe 应存在于 bin 目录')
      }
    },
    {
      name: 'fs.fileExists 检测不存在的文件',
      fn: async (cdp, assert) => {
        const exists = await cdp.evaluate(
          '(async()=>await ztools.fs.fileExists("C:\\\\nonexistent_file_12345.txt"))()'
        )
        assert.ok(exists === false || !exists, '不存在的文件应返回 false')
      }
    },
    {
      name: 'fs.directoryExists 检测已知目录',
      fn: async (cdp, assert) => {
        const exists = await cdp.evaluate(
          '(async()=>await ztools.fs.directoryExists("C:\\\\Windows"))()'
        )
        assert.ok(exists === true, 'C:\\Windows 应存在')
      }
    },
    {
      name: 'fs.writeFile + readFile 读写文件',
      fn: async (cdp, assert) => {
        const content = 'hello from cdp test'
        const result = await cdp.evaluate(
          `(async function(){
            var dir = await ztools.fs.getCurrentDirectory();
            var f = dir + "\\\\__test_" + Date.now() + ".txt";
            await ztools.fs.writeFile(f, "${content}");
            var read = await ztools.fs.readFile(f);
            await ztools.fs.deleteFile(f);
            return read;
          })()`
        )
        assert.equal(result, content, '读取内容应与写入一致')
      }
    },
    {
      name: 'fs.getDirectoryContents 列出目录内容',
      fn: async (cdp, assert) => {
        const raw = await cdp.evaluate(
          '(async function(){ var dir = await ztools.fs.getCurrentDirectory(); var r = await ztools.fs.getDirectoryContents(dir); return JSON.stringify({ isArray: Array.isArray(r), length: Array.isArray(r) ? r.length : -1 }); })()'
        )
        const info = JSON.parse(raw)
        assert.ok(info.isArray, '目录内容应为数组')
        assert.gt(info.length, 0, '当前目录不应为空')
      }
    }
  ])
}

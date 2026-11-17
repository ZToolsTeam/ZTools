import { describe, it, expect } from 'vitest'
import { filterIncomingFiles, normalizeAllowedExtension } from '../fileInputFilter.js'

describe('声明式视图文件输入过滤', () => {
  it('名称带点的文件夹以主进程确认的 directories 为准放行，不按后缀误拦', () => {
    const result = filterIncomingFiles(
      ['D:\\票据\\2026.11_报销票据', 'D:\\票据\\a.pdf'],
      ['D:\\票据\\2026.11_报销票据'],
      { extensions: ['.pdf'], allowDirectories: true }
    )
    expect(result).toEqual({
      files: ['D:\\票据\\2026.11_报销票据', 'D:\\票据\\a.pdf'],
      directories: ['D:\\票据\\2026.11_报销票据'],
      rejected: 0
    })
  })

  it('没有后缀的普通文件在允许文件夹时不再被误放行', () => {
    const result = filterIncomingFiles(['D:\\src\\Makefile', 'D:\\src\\assets'], ['D:\\src\\assets'], {
      extensions: ['png'],
      allowDirectories: true
    })
    expect(result.files).toEqual(['D:\\src\\assets'])
    expect(result.directories).toEqual(['D:\\src\\assets'])
    expect(result.rejected).toBe(1)
  })

  it('插件未允许文件夹时，文件夹计入拒绝数', () => {
    const result = filterIncomingFiles(['D:\\dir', 'D:\\a.PNG'], ['D:\\dir'], { extensions: ['.png'] })
    expect(result).toEqual({ files: ['D:\\a.PNG'], directories: [], rejected: 1 })
  })

  it('未限制扩展名时接收全部普通文件', () => {
    const result = filterIncomingFiles(['/tmp/a', '/tmp/b.txt'], undefined, {})
    expect(result).toEqual({ files: ['/tmp/a', '/tmp/b.txt'], directories: [], rejected: 0 })
  })

  it('畸形输入安全降级：非数组、空字符串与非字符串项被忽略', () => {
    expect(filterIncomingFiles(null, null, null)).toEqual({ files: [], directories: [], rejected: 0 })
    expect(filterIncomingFiles(['', '  ', 42, ' /tmp/x.png '], [42, ''], { extensions: ['.png'] })).toEqual({
      files: ['/tmp/x.png'],
      directories: [],
      rejected: 0
    })
  })

  it('扩展名写法统一为小写带点', () => {
    expect(normalizeAllowedExtension('PNG')).toBe('.png')
    expect(normalizeAllowedExtension(' .Jpg ')).toBe('.jpg')
    expect(normalizeAllowedExtension('')).toBe('')
    expect(normalizeAllowedExtension(undefined)).toBe('')
  })
})

/**
 * 第三方无自带图标插件的中文/英文名称关键词 → 品牌线性图形匹配表。
 * 仅导出纯静态常量数据（符合 *.zh-data.js 约定），严禁包含函数、UI 渲染逻辑或业务报错。
 * 按顺序匹配，越具体的关键词越靠前。
 */
export const KEYWORD_GLYPHS = Object.freeze([
  ['剪贴板', 'clipboard'], ['截图', 'crop'], ['录屏', 'video'], ['录音', 'audio'],
  ['二维码', 'qr'], ['ocr', 'ocr'], ['文字识别', 'ocr'],
  ['定时关机', 'clock'], ['关机', 'power'], ['待办', 'check'], ['备忘', 'note'], ['便签', 'note'], ['笔记', 'note'],
  ['身份验证', 'key'], ['验证器', 'key'], ['2fa', 'key'], ['hosts', 'link'], ['base64', 'hash'],
  ['时间戳', 'clock'], ['万年历', 'clock'], ['日历', 'clock'], ['时钟', 'clock'],
  ['翻译', 'translate'], ['计算', 'calculator'], ['取色', 'color'], ['颜色', 'color'], ['json', 'json'], ['正则', 'terminal'],
  ['金额', 'currency'], ['汇率', 'currency'], ['编码', 'hash'],
  ['清理', 'broom'], ['清除', 'broom'], ['垃圾', 'trash'], ['粉碎', 'trash'], ['卸载', 'trash'],
  ['进程', 'process'], ['内存', 'process'], ['硬件', 'process'], ['监控', 'pulse'], ['测速', 'gauge'], ['加速', 'gauge'], ['优化', 'gauge'],
  ['磁盘', 'disk'], ['硬盘', 'disk'], ['数据库', 'disk'], ['sql', 'disk'],
  ['备份', 'archive'], ['恢复', 'update'], ['同步', 'update'], ['压缩', 'compress'], ['解压', 'compress'],
  ['重命名', 'rename'], ['搜索', 'filesearch'], ['查找', 'filesearch'], ['文件夹', 'folder'], ['文件', 'folder'],
  ['图片', 'image'], ['图像', 'image'], ['视频', 'video'], ['音频', 'audio'], ['音乐', 'audio'], ['pdf', 'pdf'], ['发票', 'invoice'],
  ['网络', 'wifi'], ['wifi', 'wifi'], ['下载', 'download'], ['代理', 'link'], ['链接', 'link'],
  ['安全', 'shield'], ['加密', 'lock'], ['密码', 'lock'],
  ['窗口', 'window'], ['快捷键', 'keyboard'], ['键盘', 'keyboard'], ['软件', 'package'], ['启动', 'power'], ['应用', 'apps'],
  ['对比', 'diff'], ['文本', 'plaintext'], ['markdown', 'book'], ['代码', 'terminal'], ['开发', 'terminal'], ['git', 'branch'],
  ['数字', 'hash'], ['设置', 'settings'], ['管理', 'settings'], ['工具', 'wrench']
])

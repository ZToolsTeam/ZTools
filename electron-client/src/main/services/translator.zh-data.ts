/**
 * 翻译服务静态语种原生名与本地离线中英高频词典（纯静态领域词库，无业务或渲染逻辑）
 */

export interface SupportedLanguage {
  readonly code: string
  readonly name: string
  readonly nativeName: string
}

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  { code: 'auto', name: 'Auto Detect', nativeName: '自动检测' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano' }
]

/**
 * 本地离线高频词汇与短语词典（毫秒级离线自愈）
 */
export const OFFLINE_DICTIONARY: Record<string, Record<string, string>> = {
  'zh-CN': {
    'hello': '你好',
    'world': '世界',
    'hello world': '你好，世界',
    'good morning': '早上好',
    'good night': '晚安',
    'thank you': '谢谢你',
    'thanks': '多谢',
    'yes': '是',
    'no': '否',
    'ok': '好的',
    'cancel': '取消',
    'confirm': '确认',
    'error': '错误',
    'success': '成功',
    'warning': '警告',
    'save': '保存',
    'delete': '删除',
    'copy': '复制',
    'paste': '粘贴',
    'loading': '加载中',
    'settings': '设置',
    'help': '帮助',
    'quit': '退出',
    'search': '搜索',
    'invoice': '发票',
    'reimbursement': '报销',
    'attachment': '附件',
    'deadline': '截止日期',
    'meeting': '会议',
    'schedule': '日程安排',
    'contract': '合同',
    'approval': '审批',
    'budget': '预算',
    'quarterly report': '季度报告',
    'please find attached': '请查收附件',
    'looking forward to your reply': '期待您的回复'
  },
  'en': {
    '你好': 'Hello',
    '世界': 'World',
    '你好，世界': 'Hello, World',
    '早上好': 'Good morning',
    '晚安': 'Good night',
    '谢谢': 'Thank you',
    '谢谢你': 'Thank you',
    '是': 'Yes',
    '否': 'No',
    '好的': 'OK',
    '取消': 'Cancel',
    '确认': 'Confirm',
    '错误': 'Error',
    '成功': 'Success',
    '警告': 'Warning',
    '保存': 'Save',
    '删除': 'Delete',
    '复制': 'Copy',
    '粘贴': 'Paste',
    '加载中': 'Loading',
    '设置': 'Settings',
    '帮助': 'Help',
    '退出': 'Quit',
    '搜索': 'Search',
    '发票': 'Invoice',
    '报销': 'Reimbursement',
    '附件': 'Attachment',
    '截止日期': 'Deadline',
    '会议': 'Meeting',
    '日程安排': 'Schedule',
    '合同': 'Contract',
    '审批': 'Approval',
    '预算': 'Budget',
    '季度报告': 'Quarterly report',
    '请查收附件': 'Please find attached',
    '期待您的回复': 'Looking forward to your reply',
    '请在截止日期前提交报告': 'Please submit the report before the deadline',
    '报销发票': 'Reimbursement invoice'
  }
}

export type GitHelperMode = 'emergency' | 'commit' | 'gitignore'

export interface GitEmergencyItem {
  id: string
  title: string
  category: 'commit' | 'branch' | 'merge' | 'reset' | 'stash' | 'tag'
  categoryLabel: string
  tags: string[]
  pinyinKeywords: string[]
  safetyLevel: '安全无损' | '注意检查' | '有损警告'
  difficulty: '小白推荐' | '中等' | '专家慎用'
  primaryCommand: string
  steps: Array<{
    title: string
    cmd: string
    explain: string
  }>
  principle: string
  minGitVersion?: string
}

export interface CommitTypeItem {
  type: string
  chineseMeaning: string
  description: string
  examples: string[]
}

export interface GitignoreStackTemplate {
  id: string
  name: string
  category: string
  rules: string[]
}

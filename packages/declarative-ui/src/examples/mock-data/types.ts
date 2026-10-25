export type MockDataTab = 'single' | 'batch'

export interface MockSingleItem {
  id: string
  fieldKey: string
  label: string
  value: string
  category: string
  standard: string
  formatType: string
  breakdownMarkdown: string
  algorithmNote: string
}

export interface MockUserRecord {
  id: string
  name: string
  gender: '男' | '女'
  age: number
  idCard: string
  phone: string
  email: string
  companyName: string
  creditCode: string
  bankCard: string
  address: string
  createdAt: string
}

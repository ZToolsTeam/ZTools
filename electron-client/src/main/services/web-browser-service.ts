/**
 * ZTools Web, URLs, Browser & Contacts Service (M1.5-24)
 * 
 * 逆向参考依据：
 * - 源码提取自 Raycast Windows `backend/index.mjs`
 *   - key: `web-searches` (google, bing, duckduckgo)
 *   - key: `urls` (quickOpen: 'Open in Browser')
 *   - key: `browser` (installBrowserExtension, aiExtension)
 *   - key: `contacts` (search: 'Search Contacts', dynamicCommands: contact: openInContacts, callContact, sendEmail, copyPhone)
 * 
 * 本地化工程改造：
 * - 深度集成国内高频开发者搜索（百度 Baidu、GitHub、Bilibili、知乎 Zhihu、MDN 文档、必应 Bing、谷歌 Google）；
 * - 智能 URL 识别与秒开（自动补齐协议头、过滤畸形字符、支持剪贴板网址一键直达）；
 * - 活跃浏览器（Chrome / Edge / Arc）当前 Tab URL 极速提取（通过 UIAccess 穿透）；
 * - 纯本地 SQLite 极客通讯录（支持多电话/邮箱/公司/拼音首字母模糊搜索与一键呼出/发信）。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { shell } from 'electron'
import type { SidecarManager, BrowserUrlInfo } from './sidecar-manager.js'
import { extractPinyinAndAcronym } from './pinyin-helper.js'

export type SearchEngineKey = 'google' | 'baidu' | 'bing' | 'duckduckgo' | 'github' | 'bilibili' | 'zhihu' | 'mdn'

export interface SearchEngineMeta {
  key: SearchEngineKey
  name: string
  urlTemplate: string
  icon: string
  pinyin: string
}

export const SEARCH_ENGINES: Record<SearchEngineKey, SearchEngineMeta> = {
  baidu: { key: 'baidu', name: '百度搜索', urlTemplate: 'https://www.baidu.com/s?wd={query}', icon: 'paw', pinyin: 'baidusousuo' },
  bing: { key: 'bing', name: '微软必应', urlTemplate: 'https://www.bing.com/search?q={query}', icon: 'globe', pinyin: 'bing' },
  google: { key: 'google', name: 'Google 搜索', urlTemplate: 'https://www.google.com/search?q={query}', icon: 'google', pinyin: 'googlesousuo' },
  duckduckgo: { key: 'duckduckgo', name: 'DuckDuckGo', urlTemplate: 'https://duckduckgo.com/?q={query}', icon: 'shield', pinyin: 'duckduckgo' },
  github: { key: 'github', name: 'GitHub 代码库', urlTemplate: 'https://github.com/search?q={query}', icon: 'code', pinyin: 'githubdaimaku' },
  bilibili: { key: 'bilibili', name: '哔哩哔哩', urlTemplate: 'https://search.bilibili.com/all?keyword={query}', icon: 'video', pinyin: 'bilibili' },
  zhihu: { key: 'zhihu', name: '知乎', urlTemplate: 'https://www.zhihu.com/search?type=content&q={query}', icon: 'book', pinyin: 'zhihu' },
  mdn: { key: 'mdn', name: 'MDN Web 文档', urlTemplate: 'https://developer.mozilla.org/zh-CN/search?q={query}', icon: 'document', pinyin: 'mdnwendang' }
}

export interface ContactRecord {
  id: string
  name: string
  organization?: string | undefined
  phone?: string | undefined
  email?: string | undefined
  notes?: string | undefined
  pinyin: string
  createdAt: number
  updatedAt: number
}

export interface WebBrowserServiceOptions {
  dbPath?: string | undefined
  sidecarManager?: SidecarManager | null | undefined
}

export class WebBrowserService {
  private readonly db: DatabaseSync
  private readonly sidecars: SidecarManager | null

  constructor(options: WebBrowserServiceOptions = {}) {
    this.sidecars = options.sidecarManager ?? null

    const dbPath = options.dbPath || ':memory:'
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
    this.db = new DatabaseSync(dbPath)
    this.initDatabase()
  }

  private initDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        organization TEXT,
        phone TEXT,
        email TEXT,
        notes TEXT,
        pinyin TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  /**
   * M1.5-24.1: 网页搜索引擎直达 (web-searches)
   */
  public async searchWeb(engineKey: SearchEngineKey, query: string): Promise<{ url: string; opened: boolean }> {
    const raw = (query || '').trim()
    if (!raw) throw new Error('Search query cannot be empty')

    const engine = SEARCH_ENGINES[engineKey] || SEARCH_ENGINES.baidu
    const targetUrl = engine.urlTemplate.replace('{query}', encodeURIComponent(raw))

    try {
      await shell.openExternal(targetUrl)
      return { url: targetUrl, opened: true }
    } catch {
      return { url: targetUrl, opened: false }
    }
  }

  public listSearchEngines(): SearchEngineMeta[] {
    return Object.values(SEARCH_ENGINES)
  }

  /**
   * M1.5-24.2: 极速打开 URL 网址 (urls.quickOpen)
   */
  public async quickOpenUrl(inputUrl: string): Promise<{ url: string; opened: boolean }> {
    let url = (inputUrl || '').trim()
    if (!url) throw new Error('URL cannot be empty')

    // 自动补全 http/https 协议
    if (!/^https?:\/\//i.test(url) && !url.startsWith('ztools://')) {
      url = `https://${url}`
    }

    try {
      new URL(url) // 格式合法性校验
    } catch {
      throw new Error(`Invalid URL format: ${url}`)
    }

    try {
      await shell.openExternal(url)
      return { url, opened: true }
    } catch {
      return { url, opened: false }
    }
  }

  /**
   * M1.5-24.3: 提取当前活跃浏览器 Tab URL (browser)
   */
  public async getActiveBrowserUrl(): Promise<BrowserUrlInfo> {
    if (this.sidecars) {
      try {
        return await this.sidecars.getBrowserUrl()
      } catch (err) {
        console.warn('[WebBrowserService] getBrowserUrl failed:', err)
      }
    }
    return {
      found: false,
      url: '',
      browser: 'none'
    }
  }

  /**
   * M1.5-24.4: 本地通讯录管理 (contacts)
   */
  public createContact(input: { name: string; organization?: string; phone?: string; email?: string; notes?: string }): ContactRecord {
    const name = input.name?.trim()
    if (!name) throw new Error('Contact name is required')

    const id = randomUUID()
    const organization = input.organization?.trim() || ''
    const phone = input.phone?.trim() || ''
    const email = input.email?.trim() || ''
    const notes = input.notes?.trim() || ''

    const { pinyin: py, acronym } = extractPinyinAndAcronym(`${name} ${organization}`)
    const pinyin = `${py} ${acronym}`.trim()
    const now = Date.now()

    this.db.prepare(`
      INSERT INTO contacts (id, name, organization, phone, email, notes, pinyin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, organization, phone, email, notes, pinyin, now, now)

    return {
      id,
      name,
      organization: organization || undefined,
      phone: phone || undefined,
      email: email || undefined,
      notes: notes || undefined,
      pinyin,
      createdAt: now,
      updatedAt: now
    }
  }

  public listContacts(search?: string, limit = 50): ContactRecord[] {
    let sql = 'SELECT * FROM contacts'
    const params: any[] = []

    if (search && search.trim()) {
      const q = search.trim().toLowerCase()
      sql += ' WHERE LOWER(name) LIKE ? OR pinyin LIKE ? OR LOWER(organization) LIKE ? OR phone LIKE ? OR LOWER(email) LIKE ?'
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
    }

    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as any[]
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      organization: r.organization || undefined,
      phone: r.phone || undefined,
      email: r.email || undefined,
      notes: r.notes || undefined,
      pinyin: r.pinyin,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }))
  }

  public deleteContact(id: string): boolean {
    const res = this.db.prepare('DELETE FROM contacts WHERE id = ?').run(id)
    return res.changes > 0
  }

  public stop(): void {
    try {
      this.db.close()
    } catch {
      // 容错
    }
  }
}

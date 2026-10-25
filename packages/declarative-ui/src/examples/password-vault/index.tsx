import React, {
  List,
  Form,
  ActionPanel,
  Action,
  Icon,
  Clipboard,
  LocalStorage,
  showToast,
  Toast,
  useNavigation,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef
} from '../../index.js'
import type { EncryptedVaultEnvelope, VaultCategory, VaultEntry, VaultNewEntryInput } from './types.js'
import {
  copySecretWithAutoClear,
  createVaultEntry,
  decryptVaultEntries,
  encryptVaultEntries,
  generateSecurePassword,
  validateMasterPassword,
  validateNewEntryInput
} from './vault-crypto.js'

export * from './types.js'
export * from './vault-crypto.js'

const VAULT_STORAGE_KEY = 'ztools.password-vault.envelope.v1'

function getCategoryIcon(category: VaultCategory): Icon {
  switch (category) {
    case 'login':
      return Icon.Globe
    case 'apikey':
      return Icon.Key
    case 'server':
      return Icon.Terminal
    case 'license':
      return Icon.Document
    default:
      return Icon.Lock
  }
}

interface VaultEntryFormProps {
  initialPassword?: string
  onSave: (input: VaultNewEntryInput) => Promise<void>
}

export function VaultEntryForm({ initialPassword = '', onSave }: VaultEntryFormProps) {
  const { pop } = useNavigation()
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<VaultCategory>('login')
  const [username, setUsername] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [secretPlain, setSecretPlain] = useState(initialPassword)
  const [note, setNote] = useState('')

  const handleGenerate = useCallback(async () => {
    const pwd = generateSecurePassword(20, true)
    setSecretPlain(pwd)
    await showToast({
      style: Toast.Style.Success,
      title: '已填入 20 位高强度随机密码'
    })
  }, [])

  const handleSubmit = useCallback(async () => {
    const input: VaultNewEntryInput = {
      title,
      category,
      username,
      endpoint,
      secretPlain,
      note
    }
    const check = validateNewEntryInput(input)
    if (!check.valid) {
      await showToast({
        style: Toast.Style.Failure,
        title: '无法保存凭据',
        message: check.error
      })
      return
    }
    await onSave(input)
    pop()
  }, [title, category, username, endpoint, secretPlain, note, onSave, pop])

  return (
    <Form
      navigationTitle="新建加密凭据"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="加密保存至保险箱" icon={Icon.Lock} onSubmit={handleSubmit} />
          <Action title="生成 20 位随机密码填入" icon={Icon.Wand} onAction={handleGenerate} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="凭据名称"
        placeholder="例如：GitHub 主账号 / DeepSeek API Key / 生产数据库"
        value={title}
        onChange={setTitle}
      />
      <Form.Dropdown
        id="category"
        title="凭据分类"
        value={category}
        onChange={(v: string) => setCategory(v as VaultCategory)}
      >
        <Form.Dropdown.Item value="login" title="网站与应用账号" icon={Icon.Globe} />
        <Form.Dropdown.Item value="apikey" title="API Key 与访问令牌" icon={Icon.Key} />
        <Form.Dropdown.Item value="server" title="服务器与数据库密码" icon={Icon.Terminal} />
        <Form.Dropdown.Item value="license" title="软件激活码与备忘" icon={Icon.Document} />
      </Form.Dropdown>
      <Form.TextField
        id="username"
        title="用户名 / 标识"
        placeholder="账号、邮箱、Key 名称或 root"
        value={username}
        onChange={setUsername}
      />
      <Form.TextField
        id="endpoint"
        title="网址 / 主机地址"
        placeholder="例如：https://github.com 或 10.0.0.12:5432"
        value={endpoint}
        onChange={setEndpoint}
      />
      <Form.PasswordField
        id="secretPlain"
        title="密码 / Secret"
        placeholder="输入敏感密码、API Secret 或激活码（AES-256-GCM 加密存储）"
        value={secretPlain}
        onChange={setSecretPlain}
      />
      <Form.TextArea
        id="note"
        title="加密备注"
        placeholder="两步验证恢复码或到期提醒说明（随密文一同加密）"
        value={note}
        onChange={setNote}
      />
    </Form>
  )
}

export interface PasswordVaultProps {
  featureCode?: string
  initialUnlockedEntries?: VaultEntry[]
  initialMasterPassword?: string
}

export function PasswordVault({
  featureCode = 'vault-list',
  initialUnlockedEntries,
  initialMasterPassword
}: PasswordVaultProps = {}) {
  const { push } = useNavigation()
  const [isLoading, setIsLoading] = useState<boolean>(!initialUnlockedEntries)
  const [hasExistingVault, setHasExistingVault] = useState<boolean>(false)
  const [storedEnvelope, setStoredEnvelope] = useState<EncryptedVaultEnvelope | null>(null)
  const [masterPassword, setMasterPassword] = useState<string>(initialMasterPassword || '')
  const [passwordInput, setPasswordInput] = useState<string>('')
  const [isUnlocked, setIsUnlocked] = useState<boolean>(Boolean(initialUnlockedEntries))
  const [entries, setEntries] = useState<VaultEntry[]>(initialUnlockedEntries || [])
  const [searchText, setSearchText] = useState<string>('')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [revealedId, setRevealedId] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string>('')

  const mountedRef = useRef<boolean>(true)
  const clearTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const timer of clearTimersRef.current) {
        clearTimeout(timer)
      }
      clearTimersRef.current = []
    }
  }, [])

  useEffect(() => {
    if (initialUnlockedEntries) {
      return
    }
    let active = true
    ;(async () => {
      try {
        const raw = await LocalStorage.getItem<string>(VAULT_STORAGE_KEY)
        if (!active || !mountedRef.current) return
        if (raw) {
          const parsed = JSON.parse(raw) as EncryptedVaultEnvelope
          setStoredEnvelope(parsed)
          setHasExistingVault(true)
        } else {
          setHasExistingVault(false)
        }
      } catch {
        if (active && mountedRef.current) {
          setHasExistingVault(false)
        }
      } finally {
        if (active && mountedRef.current) {
          setIsLoading(false)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [initialUnlockedEntries])

  const persistEntries = useCallback(
    async (pwd: string, nextEntries: VaultEntry[]) => {
      const envelope = await encryptVaultEntries(pwd, nextEntries)
      await LocalStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(envelope))
      if (mountedRef.current) {
        setStoredEnvelope(envelope)
        setHasExistingVault(true)
      }
    },
    []
  )

  const handleUnlockOrInitialize = useCallback(async () => {
    setAuthError('')
    const check = validateMasterPassword(passwordInput)
    if (!check.valid) {
      setAuthError(check.error || '主密码长度至少 6 位')
      await showToast({
        style: Toast.Style.Failure,
        title: '主密码格式不合法',
        message: check.error
      })
      return
    }

    try {
      if (hasExistingVault && storedEnvelope) {
        const decrypted = await decryptVaultEntries(passwordInput, storedEnvelope)
        if (!mountedRef.current) return
        setMasterPassword(passwordInput)
        setEntries(decrypted)
        setIsUnlocked(true)
        setPasswordInput('')
        await showToast({
          style: Toast.Style.Success,
          title: '保险箱已解锁',
          message: `成功解密 ${decrypted.length} 项凭据`
        })
      } else {
        await persistEntries(passwordInput, [])
        if (!mountedRef.current) return
        setMasterPassword(passwordInput)
        setEntries([])
        setIsUnlocked(true)
        setPasswordInput('')
        await showToast({
          style: Toast.Style.Success,
          title: '加密保险箱初始化完成',
          message: '所有凭据均使用 PBKDF2 + AES-256-GCM 离线加密存储'
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (mountedRef.current) {
        setAuthError('主密码错误，无法解密保险箱数据')
      }
      await showToast({
        style: Toast.Style.Failure,
        title: '主密码错误，无法解密保险箱数据',
        message: msg
      })
    }
  }, [passwordInput, hasExistingVault, storedEnvelope, persistEntries])

  const handleLockVault = useCallback(async () => {
    setIsUnlocked(false)
    setMasterPassword('')
    setEntries([])
    setRevealedId(null)
    await showToast({
      style: Toast.Style.Success,
      title: '保险箱已锁定，内存密钥已销毁'
    })
  }, [])

  const handleSaveEntry = useCallback(
    async (input: VaultNewEntryInput) => {
      const created = createVaultEntry(input)
      const next = [created, ...entries]
      if (masterPassword) {
        await persistEntries(masterPassword, next)
      }
      if (mountedRef.current) {
        setEntries(next)
      }
      await showToast({
        style: Toast.Style.Success,
        title: '凭据已加密保存',
        message: created.title
      })
    },
    [entries, masterPassword, persistEntries]
  )

  const handleDeleteEntry = useCallback(
    async (id: string) => {
      const next = entries.filter((e: VaultEntry) => e.id !== id)
      if (masterPassword) {
        await persistEntries(masterPassword, next)
      }
      if (mountedRef.current) {
        setEntries(next)
      }
      await showToast({
        style: Toast.Style.Success,
        title: '已从加密保险箱中移除该凭据'
      })
    },
    [entries, masterPassword, persistEntries]
  )

  const handleCopySecretWithAutoClear = useCallback(async (item: VaultEntry) => {
    await copySecretWithAutoClear(
      item.secretPlain,
      {
        copy: (text) => Clipboard.copy(text),
        readText: () => Clipboard.readText(),
        clear: () => Clipboard.clear()
      },
      {
        ttlMs: 30000,
        scheduleTimer: (fn, ms) => {
          const timer = setTimeout(fn, ms)
          clearTimersRef.current.push(timer)
          return timer
        }
      }
    )
    await showToast({
      style: Toast.Style.Success,
      title: '已复制密码 / Secret',
      message: '将在 30 秒后自动清空剪贴板痕迹'
    })
  }, [])

  const handleQuickGeneratePassword = useCallback(async () => {
    const generated = generateSecurePassword(20, true)
    await copySecretWithAutoClear(
      generated,
      {
        copy: (text) => Clipboard.copy(text),
        readText: () => Clipboard.readText(),
        clear: () => Clipboard.clear()
      },
      {
        ttlMs: 30000,
        scheduleTimer: (fn, ms) => {
          const timer = setTimeout(fn, ms)
          clearTimersRef.current.push(timer)
          return timer
        }
      }
    )
    await showToast({
      style: Toast.Style.Success,
      title: '已生成 20 位高强度随机密码并复制',
      message: '将在 30 秒后自动清空剪贴板痕迹'
    })
  }, [])

  const filteredEntries = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    return entries.filter((item: VaultEntry) => {
      if (categoryFilter !== 'all' && item.category !== categoryFilter) {
        return false
      }
      if (!q) return true
      return (
        item.title.toLowerCase().includes(q) ||
        item.username.toLowerCase().includes(q) ||
        item.endpoint.toLowerCase().includes(q) ||
        item.note.toLowerCase().includes(q)
      )
    })
  }, [entries, searchText, categoryFilter])

  if (!isUnlocked) {
    return (
      <Form
        isLoading={isLoading}
        navigationTitle={hasExistingVault ? '解锁密码保险箱' : '初始化密码保险箱'}
        actions={
          <ActionPanel>
            <Action.SubmitForm
              title={hasExistingVault ? '解锁保险箱' : '设置主密码并创建保险箱'}
              icon={Icon.Lock}
              onSubmit={handleUnlockOrInitialize}
            />
            <Action
              title="生成 20 位随机密码复制到剪贴板"
              icon={Icon.Wand}
              onAction={handleQuickGeneratePassword}
            />
          </ActionPanel>
        }
      >
        <Form.Description
          title="加密架构说明"
          text={
            hasExistingVault
              ? '请输入主密码以派生 AES-256-GCM 密钥解密本地保险箱。主密码绝不落盘或上传。'
              : '首次使用请设置至少 6 位的主密码（PBKDF2 100,000 次迭代 + AES-256-GCM 本地零明文加密）。'
          }
        />
        <Form.PasswordField
          id="masterPassword"
          title="主密码 (Master Password)"
          placeholder="输入主密码以解锁或初始化本地保险箱..."
          value={passwordInput}
          onChange={setPasswordInput}
          error={authError || undefined}
        />
      </Form>
    )
  }

  return (
    <List
      isLoading={isLoading}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索账号标题、用户名、网址域名或 API Key 名称..."
      searchBarAccessory={
        <List.Dropdown value={categoryFilter} onChange={setCategoryFilter} tooltip="按凭据类型筛选">
          <List.Dropdown.Item title="全部加密凭据" value="all" icon={Icon.Lock} />
          <List.Dropdown.Item title="网站与应用账号" value="login" icon={Icon.Globe} />
          <List.Dropdown.Item title="API Key 与访问令牌" value="apikey" icon={Icon.Key} />
          <List.Dropdown.Item title="服务器与数据库密码" value="server" icon={Icon.Terminal} />
          <List.Dropdown.Item title="软件激活码与备忘" value="license" icon={Icon.Document} />
        </List.Dropdown>
      }
      filterBar={{
        summaryText: `保险箱已解锁 (AES-256-GCM) · 共加密保管 ${entries.length} 项凭据 · 复制后 30 秒自动清剪贴板`,
        actions: [
          {
            id: 'new-entry',
            title: '新建凭据',
            onAction: () =>
              push(
                <VaultEntryForm
                  initialPassword={
                    featureCode === 'vault-generator' ? generateSecurePassword(20, true) : ''
                  }
                  onSave={handleSaveEntry}
                />
              )
          },
          { id: 'lock-vault', title: '立即锁定', onAction: handleLockVault }
        ]
      }}
    >
      {filteredEntries.map((item: VaultEntry) => (
        <List.Item
          key={item.id}
          id={item.id}
          title={item.title}
          subtitle={`${item.username || item.endpoint || '私密条目'}${item.note ? ` · ${item.note}` : ''}`}
          icon={getCategoryIcon(item.category)}
          accessories={[
            { tag: item.categoryLabel },
            { text: revealedId === item.id ? item.secretPlain : '••••••••••••' },
            { text: item.updatedAtShort }
          ]}
          actions={
            <ActionPanel>
              <Action
                title="复制密码 / Secret（30秒后自动清剪贴板）"
                icon={Icon.Key}
                onAction={() => handleCopySecretWithAutoClear(item)}
              />
              {item.username && (
                <Action.CopyToClipboard title="复制用户名 / 账号" content={item.username} />
              )}
              <Action
                title={revealedId === item.id ? '隐藏明文密码' : '临时显示明文密码'}
                icon={Icon.Eye}
                shortcut={{ modifiers: ['cmd'], key: 'h' }}
                onAction={() => setRevealedId((cur: string | null) => (cur === item.id ? null : item.id))}
              />
              <Action.Push
                title="新建加密凭据"
                icon={Icon.Plus}
                shortcut={{ modifiers: ['cmd'], key: 'n' }}
                target={<VaultEntryForm onSave={handleSaveEntry} />}
              />
              <Action
                title="立即生成 20 位高强度随机密码并复制"
                icon={Icon.Wand}
                shortcut={{ modifiers: ['cmd'], key: 'g' }}
                onAction={handleQuickGeneratePassword}
              />
              <Action
                title="删除此凭据"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={{ modifiers: ['ctrl'], key: 'backspace' }}
                onAction={() => handleDeleteEntry(item.id)}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}

export const PasswordVaultCommand = PasswordVault
export default PasswordVault

export function VaultEntryDetailView(props?: Record<string, unknown>) {
  return <Form navigationTitle="凭据详情" />
}
export function VaultUnlockForm(props?: Record<string, unknown>) {
  return <Form navigationTitle="解锁保险箱" />
}
export function VaultImportCsvForm(props?: Record<string, unknown>) {
  return <Form navigationTitle="导入 CSV 凭据" />
}

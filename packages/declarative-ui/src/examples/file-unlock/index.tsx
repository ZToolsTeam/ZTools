import React, {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  Toast,
  confirmAlert,
  showToast,
  useEffect,
  useMemo,
  useState
} from '../../index.js'
import {
  copyProcessInfoToClipboard,
  detectClipboardCandidatePath,
  filterLockingProcesses,
  inspectTargetLocks,
  listRemovableDrives,
  looksLikeFilePath,
  openUnlockedTarget,
  revealLockedTargetInFolder,
  revealProcessExecutableInFolder,
  sanitizeInputPath,
  unlockAllProcesses,
  unlockAndTrashTarget,
  unlockSingleProcess
} from './unlock-service.js'
import type {
  LockingProcessItem,
  RemovableDriveItem,
  UnlockProcessFilter
} from './types.js'

function extractBaseName(targetPath: string): string {
  const cleaned = sanitizeInputPath(targetPath).replace(/[\\/]+$/, '')
  if (!cleaned) return '未指定路径'
  if (/^[a-zA-Z]:$/.test(cleaned)) return `${cleaned}\\`
  const parts = cleaned.split(/[\\/]/)
  return parts[parts.length - 1] || cleaned
}

export default function FileUnlockCommand(props?: {
  initialPath?: string
  featureCode?: string
  hostOverride?: unknown
}) {
  const [targetPath, setTargetPath] = useState<string>(
    sanitizeInputPath(props?.initialPath ?? '')
  )
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [processFilter, setProcessFilter] = useState<UnlockProcessFilter>('all')
  const [processes, setProcesses] = useState<LockingProcessItem[]>([])
  const [removableDrives, setRemovableDrives] = useState<RemovableDriveItem[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [lastError, setLastError] = useState<string>('')

  const runInspection = async (rawPath: string) => {
    const cleaned = sanitizeInputPath(rawPath)
    if (!cleaned) {
      setProcesses([])
      setLastError('')
      return
    }
    setIsLoading(true)
    setLastError('')
    try {
      const res = await inspectTargetLocks(cleaned, props?.hostOverride)
      if (!res.ok) {
        setProcesses([])
        setLastError(res.error || '目标路径检测失败')
        await showToast({
          style: Toast.Style.Failure,
          title: '无法扫描目标路径',
          message: res.error || '请检查路径是否存在或是否有访问权限'
        })
        return
      }
      setTargetPath(res.targetPath)
      setProcesses(res.processes)
      setLastError('')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    let seq = 0

    const init = async () => {
      const mySeq = ++seq
      setIsLoading(true)
      try {
        const [clipCandidate, drives] = await Promise.all([
          props?.initialPath
            ? Promise.resolve(sanitizeInputPath(props.initialPath))
            : detectClipboardCandidatePath(props?.hostOverride),
          listRemovableDrives(props?.hostOverride)
        ])
        if (cancelled || mySeq !== seq) return
        setRemovableDrives(drives)

        const initialTarget =
          clipCandidate ||
          (props?.featureCode === 'usb-unlock' && drives[0]?.mount ? drives[0].mount : '')

        if (initialTarget) {
          setTargetPath(initialTarget)
          const res = await inspectTargetLocks(initialTarget, props?.hostOverride)
          if (cancelled || mySeq !== seq) return
          if (res.ok) {
            setTargetPath(res.targetPath)
            setProcesses(res.processes)
            setLastError('')
          } else {
            setProcesses([])
            setLastError(res.error || '')
          }
        }
      } finally {
        if (!cancelled && mySeq === seq) {
          setIsLoading(false)
        }
      }
    }

    void init()
    return () => {
      cancelled = true
    }
  }, [props?.initialPath, props?.featureCode, props?.hostOverride])

  const killableCount = useMemo(
    () => processes.filter((p) => !p.isProtected).length,
    [processes]
  )

  const filteredProcesses = useMemo(
    () => filterLockingProcesses(processes, processFilter, searchQuery),
    [processes, processFilter, searchQuery]
  )

  const handleSearchChange = (text: string) => {
    setSearchQuery(text)
    if (looksLikeFilePath(text)) {
      const nextTarget = sanitizeInputPath(text)
      setTargetPath(nextTarget)
      void runInspection(nextTarget)
    }
  }

  const handleUnlockSingle = async (proc: LockingProcessItem, trashAfterUnlock = false) => {
    if (proc.isProtected) {
      await showToast({
        style: Toast.Style.Failure,
        title: '安全策略拦截',
        message: `${proc.name} (PID ${proc.pid}) 为系统关键保护进程，严禁强制结束`
      })
      return
    }

    const actionTitle = trashAfterUnlock
      ? `确认结束进程 ${proc.name} (PID ${proc.pid}) 并将目标移入回收站？`
      : `确认结束占用进程 ${proc.name} (PID ${proc.pid})？`

    const confirmed = await confirmAlert({
      title: actionTitle,
      message:
        proc.serviceTypeLabel === '资源管理器'
          ? '检测到资源管理器占用，解锁后将自动平滑重启 explorer.exe，桌面不会黑屏。'
          : `目标路径: ${targetPath}\n进程路径: ${proc.executablePath}`
    })
    if (!confirmed) return

    const res = await unlockSingleProcess(
      proc,
      targetPath,
      { trashAfterUnlock },
      props?.hostOverride
    )

    if (!res.ok) {
      await showToast({
        style: Toast.Style.Failure,
        title:
          res.errorCode === 'PROCESS_IDENTITY_MISMATCH'
            ? '进程 PID 已变更，已拦截误杀'
            : res.errorCode === 'PROCESS_PROTECTED'
              ? '系统关键保护进程禁止终止'
              : '解除占用失败',
        message: res.error || '请尝试使用管理员权限运行'
      })
      if (res.errorCode === 'PROCESS_IDENTITY_MISMATCH' && targetPath) {
        await runInspection(targetPath)
      }
      return
    }

    await showToast({
      style: Toast.Style.Success,
      title: res.trashed
        ? `已解锁并移入回收站: ${extractBaseName(targetPath)}`
        : `已解除进程占用: ${proc.name}`,
      message: res.explorerRestarted ? '已平滑重启 Windows 资源管理器' : `PID ${proc.pid} 已释放句柄`
    })

    if (res.trashed) {
      setProcesses([])
    } else if (targetPath) {
      await runInspection(targetPath)
    }
  }

  const handleUnlockAll = async (trashAfterUnlock = false) => {
    if (!targetPath) {
      await showToast({
        style: Toast.Style.Animated,
        title: '请先输入或选择被占用的文件或文件夹路径'
      })
      return
    }

    if (processes.length > 0 && killableCount === 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: '无法强制解锁系统核心进程',
        message: '当前所有占用进程均为系统关键保护进程，受安全策略保护'
      })
      return
    }

    const confirmed = await confirmAlert({
      title: trashAfterUnlock
        ? `确认结束 ${killableCount} 个占用进程并将「${extractBaseName(targetPath)}」移入回收站？`
        : `确认一键结束 ${killableCount} 个可安全终止的占用进程？`,
      message: `目标路径: ${targetPath}`
    })
    if (!confirmed) return

    const res = trashAfterUnlock
      ? await unlockAndTrashTarget(processes, targetPath, props?.hostOverride)
      : await unlockAllProcesses(processes, targetPath, {}, props?.hostOverride)

    if (!res.ok) {
      await showToast({
        style: Toast.Style.Failure,
        title: '批量解锁未完全成功',
        message: res.error || '部分进程需要管理员权限或已变更'
      })
      await runInspection(targetPath)
      return
    }

    await showToast({
      style: Toast.Style.Success,
      title: res.trashed
        ? `已全部解锁并移入回收站`
        : `已解除 ${res.unlockedCount} 个进程占用`,
      message:
        res.skippedProtectedCount > 0
          ? `已跳过 ${res.skippedProtectedCount} 个系统关键保护进程`
          : extractBaseName(targetPath)
    })

    if (res.trashed) {
      setProcesses([])
    } else {
      await runInspection(targetPath)
    }
  }

  const summaryText = useMemo(() => {
    if (!targetPath) {
      return '粘贴或选择被占用的文件、文件夹或外接移动磁盘以检测占用进程'
    }
    if (lastError) {
      return `目标: ${extractBaseName(targetPath)} | 检测异常: ${lastError}`
    }
    if (processes.length === 0) {
      return `目标: ${extractBaseName(targetPath)} | 未发现句柄占用，可安全删除、重命名或弹出`
    }
    return `目标: ${extractBaseName(targetPath)} | 发现 ${processes.length} 个占用进程（可结束 ${killableCount} 个）`
  }, [targetPath, lastError, processes.length, killableCount])

  return (
    <List
      navigationTitle="文件解锁"
      isLoading={isLoading}
      isShowingDetail={false}
      searchBarPlaceholder="粘贴或拖入被占用的文件/文件夹/盘符路径，或搜索进程名..."
      onSearchTextChange={handleSearchChange}
      searchBarAccessory={
        <List.Dropdown
          tooltip="按进程类型筛选"
          value={processFilter}
          onChange={(val: string) => setProcessFilter(val as UnlockProcessFilter)}
        >
          <List.Dropdown.Item title="全部占用进程" value="all" />
          <List.Dropdown.Item title="可安全结束" value="killable" />
          <List.Dropdown.Item title="系统保护进程" value="protected" />
        </List.Dropdown>
      }
      filterBar={{
        summaryText,
        actions: [
          {
            id: 'unlock-all',
            title: '一键全部解锁',
            style: 'primary',
            onAction: () => {
              void handleUnlockAll(false)
            }
          },
          {
            id: 'unlock-and-trash',
            title: '解锁并移入回收站',
            style: 'destructive',
            onAction: () => {
              void handleUnlockAll(true)
            }
          }
        ]
      }}
    >
      {removableDrives.length > 0 && (
        <List.Section
          title="外接移动磁盘快捷检测"
          subtitle={`${removableDrives.length} 个设备`}
        >
          {removableDrives.map((drive) => (
            <List.Item
              key={`drive-${drive.mount}`}
              id={`drive-${drive.mount}`}
              icon={Icon.HardDrive}
              title={`${drive.label} (${drive.mount})`}
              subtitle={`可用 ${drive.freeText} / 总计 ${drive.totalText}`}
              accessories={[{ text: targetPath === drive.mount ? '当前检测目标' : '检测谁占用了此磁盘' }]}
              actions={
                <ActionPanel>
                  <Action
                    title="检测此移动磁盘的占用进程"
                    icon={Icon.MagnifyingGlass}
                    onAction={() => {
                      setTargetPath(drive.mount)
                      void runInspection(drive.mount)
                    }}
                  />
                  <Action
                    title="在文件管理器中打开此磁盘"
                    icon={Icon.Folder}
                    onAction={() => {
                      void openUnlockedTarget(drive.mount, props?.hostOverride)
                    }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {filteredProcesses.length === 0 ? (
        <List.Section title="检测结果">
          <List.Item
            id="empty-status"
            icon={lastError ? Icon.ExclamationMark : Icon.CheckCircle}
            title={
              !targetPath
                ? '请粘贴被锁定的文件、文件夹或盘符路径'
                : lastError
                  ? '目标路径无法完成占用检测'
                  : '当前路径未被任何进程占用'
            }
            subtitle={
              !targetPath
                ? '在顶部搜索框直接粘贴完整路径（如 D:\\report.docx），即可毫秒级定位占用元凶'
                : lastError
                  ? lastError
                  : '您可以直接删除、重命名该文件，或安全弹出外接移动磁盘'
            }
            actions={
              targetPath ? (
                <ActionPanel>
                  <Action
                    title="重新扫描占用状态"
                    icon={Icon.ArrowClockwise}
                    shortcut={{ modifiers: ['ctrl'], key: 'r' }}
                    onAction={() => {
                      void runInspection(targetPath)
                    }}
                  />
                  <Action
                    title="定位被检测文件所在目录"
                    icon={Icon.Folder}
                    onAction={() => {
                      void revealLockedTargetInFolder(targetPath, props?.hostOverride)
                    }}
                  />
                  <Action
                    title="移入回收站"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    onAction={() => {
                      void handleUnlockAll(true)
                    }}
                  />
                </ActionPanel>
              ) : undefined
            }
          />
        </List.Section>
      ) : (
        <List.Section
          title="占用进程列表"
          subtitle={`${filteredProcesses.length} 个进程`}
        >
          {filteredProcesses.map((proc) => (
            <List.Item
              key={proc.id}
              id={proc.id}
              icon={proc.isProtected ? Icon.Shield : Icon.Terminal}
              title={proc.name}
              subtitle={`PID ${proc.pid} · ${proc.executablePath}`}
              accessories={
                proc.isProtected
                  ? [{ tag: { value: '系统保护', color: Color.Red } }]
                  : [{ text: proc.serviceTypeLabel }]
              }
              actions={
                <ActionPanel>
                  <Action
                    title="结束占用进程（解锁）"
                    icon={Icon.LockUnlocked}
                    onAction={() => {
                      void handleUnlockSingle(proc, false)
                    }}
                  />
                  <Action
                    title="结束进程并删除目标文件"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    onAction={() => {
                      void handleUnlockSingle(proc, true)
                    }}
                  />
                  <Action
                    title="定位进程程序所在目录"
                    icon={Icon.Folder}
                    onAction={() => {
                      void revealProcessExecutableInFolder(proc.executablePath, props?.hostOverride)
                    }}
                  />
                  <Action
                    title="定位被锁文件所在目录"
                    icon={Icon.Folder}
                    onAction={() => {
                      void revealLockedTargetInFolder(targetPath || proc.lockedPath, props?.hostOverride)
                    }}
                  />
                  <Action
                    title="复制占用进程信息"
                    icon={Icon.Clipboard}
                    shortcut={{ modifiers: ['ctrl'], key: 'c' }}
                    onAction={async () => {
                      const text = `${proc.name} (PID ${proc.pid}) - ${proc.executablePath} -> ${proc.lockedPath}`
                      await copyProcessInfoToClipboard(text, props?.hostOverride)
                      await showToast({
                        style: Toast.Style.Success,
                        title: '已复制占用进程信息'
                      })
                    }}
                  />
                  <Action
                    title="重新扫描占用状态"
                    icon={Icon.ArrowClockwise}
                    shortcut={{ modifiers: ['ctrl'], key: 'r' }}
                    onAction={() => {
                      void runInspection(targetPath)
                    }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
    </List>
  )
}

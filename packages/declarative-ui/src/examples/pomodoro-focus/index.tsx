import React, {
  Action,
  ActionPanel,
  Color,
  Form,
  Icon,
  List,
  Toast,
  showToast,
  useEffect,
  useMemo,
  useRef,
  useState,
  useNavigation
} from '../../index.js'
import {
  DEFAULT_COUNTDOWNS,
  FOCUS_DURATION_MS,
  PomodoroTimerEngine,
  enrichAndSortCountdowns,
  formatRemainingMmSs,
  validateCountdownInput
} from './pomodoro-service.js'
import type { CountdownCategory, CountdownItem } from './types.js'

export * from './types.js'
export * from './pomodoro-service.js'

export function CountdownForm({
  initialItem,
  onSave
}: {
  initialItem?: CountdownItem
  onSave: (item: CountdownItem) => void
}) {
  const { pop } = useNavigation()
  const [title, setTitle] = useState(initialItem?.title ?? '')
  const [targetDate, setTargetDate] = useState(initialItem?.targetDate ?? '2026-12-31')
  const [category, setCategory] = useState<CountdownCategory>(initialItem?.category ?? 'work')
  const [isRecurring, setIsRecurring] = useState<boolean>(initialItem?.isRecurring ?? false)

  const handleSubmit = async () => {
    const check = validateCountdownInput({ title, targetDate, category })
    if (!check.valid) {
      await showToast({
        style: Toast.Style.Failure,
        title: check.error || '请填写合法的倒数日信息'
      })
      return
    }
    onSave({
      id: initialItem?.id || `cd-${Date.now()}`,
      title: title.trim(),
      targetDate: targetDate.trim(),
      category,
      isRecurring,
      createdAt: initialItem?.createdAt || Date.now()
    })
    await showToast({
      style: Toast.Style.Success,
      title: '倒数日已保存'
    })
    pop()
  }

  return (
    <Form
      navigationTitle={initialItem ? '编辑倒数日' : '新建倒数日'}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存倒数日" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="日程名称"
        placeholder="如：版本发版上线 / 每月发薪日"
        value={title}
        onChange={setTitle}
      />
      <Form.TextField
        id="targetDate"
        title="目标日期 (YYYY-MM-DD)"
        placeholder="2026-10-31"
        value={targetDate}
        onChange={setTargetDate}
      />
      <Form.Dropdown
        id="category"
        title="日程分类"
        value={category}
        onChange={(v) => setCategory(v as CountdownCategory)}
      >
        <Form.Dropdown.Item title="工作与项目发布" value="work" />
        <Form.Dropdown.Item title="发薪与财务还款" value="finance" />
        <Form.Dropdown.Item title="生活与纪念日" value="life" />
      </Form.Dropdown>
      <Form.Checkbox
        id="isRecurring"
        label="按月固定日期循环推算（适合每月发薪日/账单日）"
        value={isRecurring}
        onChange={setIsRecurring}
      />
    </Form>
  )
}

function getCategoryIcon(category: CountdownCategory): Icon {
  switch (category) {
    case 'work':
      return Icon.Bolt
    case 'finance':
      return Icon.Document
    default:
      return Icon.Pin
  }
}

export interface PomodoroFocusCommandProps {
  featureCode?: string
  initialCountdowns?: CountdownItem[]
  referenceDate?: string
}

const COUNTDOWN_STORAGE_KEY = 'ztools:pomodoro-countdowns-v1'

function loadPersistedCountdowns(fallback: CountdownItem[]): CountdownItem[] {
  try {
    const g = globalThis as Record<string, unknown>
    const ls = g.localStorage as { getItem?: (k: string) => string | null } | undefined
    const raw = ls?.getItem?.(COUNTDOWN_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as CountdownItem[]
      }
    }
  } catch {
    // ignore storage read error
  }
  return fallback
}

function persistCountdowns(items: CountdownItem[]): void {
  try {
    const g = globalThis as Record<string, unknown>
    const ls = g.localStorage as { setItem?: (k: string, v: string) => void } | undefined
    ls?.setItem?.(COUNTDOWN_STORAGE_KEY, JSON.stringify(items))
  } catch {
    // ignore storage write error
  }
}

async function notifyHostFocus(method: string, params: Record<string, unknown> = {}): Promise<void> {
  try {
    const g = globalThis as Record<string, unknown>
    const win = (typeof window !== 'undefined' ? window : g) as Record<string, unknown>
    const electron = win.__ztoolsElectron as
      | {
          transport?: {
            invoke?: (m: string, p?: Record<string, unknown>) => Promise<unknown>
            methods?: Record<string, (p?: Record<string, unknown>) => Promise<unknown>>
          }
        }
      | undefined
    if (typeof electron?.transport?.methods?.[method] === 'function') {
      await electron.transport.methods[method](params)
    } else if (typeof electron?.transport?.invoke === 'function') {
      await electron.transport.invoke(method, params)
    }
  } catch {
    // ignore optional host sync error
  }
}

export function PomodoroFocusCommand(props: PomodoroFocusCommandProps = {}) {
  const { push } = useNavigation()
  const engineRef = useRef<PomodoroTimerEngine>(
    new PomodoroTimerEngine(
      {
        phase: props.featureCode === 'pomodoro-start' ? 'focus' : 'idle',
        startTime: Date.now(),
        durationMs: FOCUS_DURATION_MS,
        completedCycles: 1
      },
      (title, body) => {
        void showToast({ style: Toast.Style.Success, title, message: body })
        void notifyHostFocus('system_notify', { title, message: body })
      }
    )
  )

  const [pomoState, setPomoState] = useState(() => engineRef.current.getState())
  const [remainingMs, setRemainingMs] = useState(() => engineRef.current.getRemainingMs())
  const [countdowns, setCountdowns] = useState<CountdownItem[]>(() =>
    props.initialCountdowns ?? loadPersistedCountdowns(DEFAULT_COUNTDOWNS)
  )
  const [selectedCategory, setSelectedCategory] = useState<'all' | CountdownCategory>('all')
  const [searchText, setSearchText] = useState<string>('')

  useEffect(() => {
    const timer = setInterval(() => {
      const res = engineRef.current.tick(Date.now())
      setPomoState(res.state)
      setRemainingMs(res.remainingMs)
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [])

  const isRunning = pomoState.phase !== 'idle' && pomoState.pausedRemainingMs === undefined

  const handleTogglePomodoro = async () => {
    if (pomoState.phase === 'idle') {
      const next = engineRef.current.startFocus(Date.now())
      setPomoState(next)
      setRemainingMs(engineRef.current.getRemainingMs())
      void notifyHostFocus('focus_start', { durationMinutes: 25, title: '25分钟深度专注' })
      await showToast({
        style: Toast.Style.Success,
        title: '已开启 25 分钟极简专注番茄钟'
      })
    } else if (pomoState.pausedRemainingMs === undefined) {
      const next = engineRef.current.pause(Date.now())
      setPomoState(next)
      setRemainingMs(engineRef.current.getRemainingMs())
      void notifyHostFocus('focus_pause')
      await showToast({
        style: Toast.Style.Success,
        title: '已暂停当前番茄钟'
      })
    } else {
      const next = engineRef.current.resume(Date.now())
      setPomoState(next)
      setRemainingMs(engineRef.current.getRemainingMs())
      void notifyHostFocus('focus_resume')
      await showToast({
        style: Toast.Style.Success,
        title: '已恢复专注计时'
      })
    }
  }

  const handleResetPomodoro = async () => {
    const next = engineRef.current.reset()
    setPomoState(next)
    setRemainingMs(FOCUS_DURATION_MS)
    void notifyHostFocus('focus_cancel')
    await showToast({
      style: Toast.Style.Success,
      title: '番茄钟已重置'
    })
  }

  const enrichedCountdowns = useMemo(
    () => enrichAndSortCountdowns(countdowns, props.referenceDate ?? new Date()),
    [countdowns, props.referenceDate]
  )

  const filteredCountdowns = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    return enrichedCountdowns.filter((item) => {
      if (selectedCategory !== 'all' && item.category !== selectedCategory) return false
      if (!q) return true
      return (
        item.title.toLowerCase().includes(q) ||
        item.targetDateFormatted.toLowerCase().includes(q)
      )
    })
  }, [enrichedCountdowns, selectedCategory, searchText])

  const formattedRemaining = formatRemainingMmSs(remainingMs)
  const pomodoroStateText =
    pomoState.phase === 'focus'
      ? `深度专注中 (${formattedRemaining})`
      : pomoState.phase === 'short_break'
        ? `短休恢复中 (${formattedRemaining})`
        : pomoState.phase === 'long_break'
          ? `长休恢复中 (${formattedRemaining})`
          : `就绪待命 (今日已完成 ${pomoState.completedCycles} 个番茄)`

  return (
    <List
      navigationTitle="番茄倒数"
      isLoading={false}
      isShowingDetail={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索重要日程倒数日或启动 25 分钟专注番茄钟..."
      searchBarAccessory={
        <List.Dropdown
          value={selectedCategory}
          onChange={(val) => setSelectedCategory(val as 'all' | CountdownCategory)}
          tooltip="筛选日程类别"
        >
          <List.Dropdown.Item title="全部日程与倒数" value="all" icon={Icon.List} />
          <List.Dropdown.Item title="工作与项目发布" value="work" icon={Icon.Bolt} />
          <List.Dropdown.Item title="发薪与财务还款" value="finance" icon={Icon.Document} />
          <List.Dropdown.Item title="生活与纪念日" value="life" icon={Icon.Pin} />
        </List.Dropdown>
      }
      filterBar={{
        summaryText: `专注状态: ${pomodoroStateText} · 共 ${filteredCountdowns.length} 个倒数日程`,
        actions: [
          {
            id: 'toggle-pomo',
            title: isRunning ? '暂停专注' : '开始专注 (25m)',
            onAction: () => {
              void handleTogglePomodoro()
            }
          },
          {
            id: 'new-countdown',
            title: '新建倒数日',
            onAction: () =>
              push(
                <CountdownForm
                  onSave={(created) =>
                    setCountdowns((prev) => {
                      const next = [created, ...prev]
                      persistCountdowns(next)
                      return next
                    })
                  }
                />
              )
          }
        ]
      }}
    >
      <List.Section title="当前番茄工作钟 (Micro-Focus)">
        <List.Item
          id="pomodoro-timer"
          title={
            pomoState.phase === 'focus'
              ? '25 分钟深度专注进行中'
              : '点击或按回车开启 25 分钟极简番茄专注'
          }
          subtitle={`基于系统物理时钟防休眠漂移 · 今日已完成 ${pomoState.completedCycles} 轮专注`}
          icon={isRunning ? Icon.Bolt : Icon.Play}
          accessories={[
            { tag: pomoState.phase === 'focus' ? '专注中' : '25:00 标准轮次' },
            { text: formattedRemaining }
          ]}
          actions={
            <ActionPanel>
              <Action
                title={isRunning ? '暂停当前番茄钟' : '立即开始专注 (25分钟)'}
                icon={Icon.Play}
                onAction={handleTogglePomodoro}
              />
              <Action
                title="重置番茄钟"
                icon={Icon.ArrowClockwise}
                shortcut={{ modifiers: ['cmd'], key: 'r' }}
                onAction={handleResetPomodoro}
              />
            </ActionPanel>
          }
        />
      </List.Section>

      <List.Section title={`重要日程与节点倒数 (${filteredCountdowns.length} 项)`}>
        {filteredCountdowns.map((item) => (
          <List.Item
            key={item.id}
            id={item.id}
            title={item.title}
            subtitle={item.targetDateFormatted}
            icon={getCategoryIcon(item.category)}
            accessories={[
              item.isRecurring ? { tag: '每月循环' } : {},
              item.daysLeft >= 0 && item.daysLeft <= 3
                ? { tag: { value: item.daysLeftText, color: Color.Red } }
                : { text: item.daysLeftText }
            ]}
            actions={
              <ActionPanel>
                <Action
                  title="编辑此倒数日"
                  icon={Icon.Pencil}
                  onAction={() =>
                    push(
                      <CountdownForm
                        initialItem={item}
                        onSave={(updated) =>
                          setCountdowns((prev) => {
                            const next = prev.map((x) => (x.id === updated.id ? updated : x))
                            persistCountdowns(next)
                            return next
                          })
                        }
                      />
                    )
                  }
                />
                <Action.CopyToClipboard
                  title="复制天数摘要"
                  content={`${item.title}: ${item.daysLeftText} (${item.targetDateFormatted})`}
                />
                <Action
                  title="删除此倒数日"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  onAction={() =>
                    setCountdowns((prev) => {
                      const next = prev.filter((x) => x.id !== item.id)
                      persistCountdowns(next)
                      return next
                    })
                  }
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  )
}

export default PomodoroFocusCommand

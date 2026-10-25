import React, {
  Action,
  ActionPanel,
  Color,
  Detail,
  Form,
  Icon,
  List,
  Toast,
  showToast,
  useEffect,
  useNavigation,
  useState
} from '../../index.js'
import {
  CLEAN_DURATION_PRESETS,
  defaultKeyboardLockManager,
  formatCleanDuration
} from './keyboard-lock-service.js'
import type { CleanDurationPreset } from './types.js'

export * from './types.js'
export * from './keyboard-lock-service.js'

export function CleanKeyboardDetailView({
  preset,
  onStateChange,
  hostOverride
}: {
  preset?: CleanDurationPreset
  onStateChange?: () => void
  hostOverride?: unknown
}) {
  const state = defaultKeyboardLockManager.getState()
  const stats = defaultKeyboardLockManager.getStats()

  const markdown = `
# ${state.status === 'locked' ? '键盘正在锁定清洁中' : `键盘清洁防误触锁 (${preset?.title || '就绪'})`}

> **紧急解锁热键**: 随时按下 \`${state.emergencyShortcut.display}\` 即可立即解除键盘锁定。

---

### 当前状态
- **锁状态**: \`${state.status.toUpperCase()}\`
- **剩余时间**: \`${state.status === 'locked' ? formatCleanDuration(state.remainingSeconds) : formatCleanDuration(preset?.seconds)}\`
- **本次已拦截误触按键**: \`${state.blockedKeystrokes} 次\` ${state.lastBlockedKey ? `(最近拦截: \`${state.lastBlockedKey}\`)` : ''}

### 历史清洁统计
- **累计清洁次数**: \`${stats.totalSessions} 次\`
- **累计锁定时长**: \`${formatCleanDuration(stats.totalCleanedSeconds)}\`
- **累计防误触拦截**: \`${stats.totalBlockedKeystrokes} 次按键\`
`

  return (
    <Detail
      navigationTitle="键盘清洁锁详情"
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.TagList title="锁定状态">
            <Detail.Metadata.TagList.Item
              text={state.status === 'locked' ? 'LOCKED (已锁定)' : 'UNLOCKED (正常输入)'}
              color={state.status === 'locked' ? Color.Red : Color.SecondaryText}
            />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Label
            title="紧急解锁热键"
            text={state.emergencyShortcut.display}
            icon={Icon.Key}
          />
          <Detail.Metadata.Label
            title="本次拦截按键"
            text={`${state.blockedKeystrokes} 次`}
            icon={Icon.Shield}
          />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label
            title="累计清洁会话"
            text={`${stats.totalSessions} 次`}
            icon={Icon.Clock}
          />
          <Detail.Metadata.Label
            title="累计拦截误触"
            text={`${stats.totalBlockedKeystrokes} 次`}
            icon={Icon.Checkmark}
          />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          {state.status === 'locked' ? (
            <Action
              title="立即解锁键盘 (Unlock Keyboard)"
              icon={Icon.Unlock}
              shortcut={{ modifiers: ['ctrl'], key: 'u' }}
              onAction={async () => {
                const res = await defaultKeyboardLockManager.unlockKeyboard('manual', hostOverride)
                await showToast(
                  res.success ? Toast.Style.Success : Toast.Style.Failure,
                  res.message
                )
                onStateChange?.()
              }}
            />
          ) : (
            <Action
              title={`立即锁定 (${preset?.title || '30 秒'})`}
              icon={Icon.Lock}
              onAction={async () => {
                const res = await defaultKeyboardLockManager.lockKeyboard(
                  preset ? preset.seconds : 30,
                  {
                    presetTitle: preset?.title,
                    icon: preset?.icon,
                    hostOverride
                  }
                )
                await showToast(
                  res.success ? Toast.Style.Success : Toast.Style.Failure,
                  res.message
                )
                onStateChange?.()
              }}
            />
          )}
        </ActionPanel>
      }
    />
  )
}

export function CustomDurationForm({
  onLocked,
  hostOverride
}: {
  onLocked?: () => void
  hostOverride?: unknown
}) {
  const { pop } = useNavigation()

  return (
    <Form
      navigationTitle="自定义键盘清洁锁定时长"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="启动键盘锁定"
            icon={Icon.Lock}
            onSubmit={async (values: Record<string, unknown>) => {
              const seconds = Number(values.seconds)
              const res = await defaultKeyboardLockManager.lockKeyboard(seconds, {
                presetTitle: `自定义 ${seconds} 秒清洁锁`,
                icon: 'custom',
                hostOverride
              })
              if (!res.success) {
                await showToast(Toast.Style.Failure, res.message)
                return
              }
              await showToast(Toast.Style.Success, res.message)
              onLocked?.()
              pop()
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="seconds"
        title="锁定时长 (秒)"
        placeholder="输入正整数秒数，如 45、90、180..."
        defaultValue="45"
      />
    </Form>
  )
}

export function CleanKeyboardCommand(props?: {
  featureCode?: string
  hostOverride?: unknown
}) {
  const [, setTickVersion] = useState(0)
  const refresh = () => setTickVersion((v) => v + 1)
  const { push } = useNavigation()

  const state = defaultKeyboardLockManager.getState()
  const stats = defaultKeyboardLockManager.getStats()

  // 锁定期间每秒推进倒计时，并在组件卸载时成对清理定时器
  useEffect(() => {
    if (state.status !== 'locked' || state.remainingSeconds === null) {
      return
    }
    const timer = setInterval(() => {
      void defaultKeyboardLockManager.tick(1).then(() => {
        refresh()
      })
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [state.status, state.remainingSeconds])

  return (
    <List
      navigationTitle="键盘清洁防误触锁 (Clean Keyboard)"
      searchBarPlaceholder="选择键盘锁定时长 (清洁键盘、擦屏幕、防猫踩键盘)..."
      filterBar={{
        summaryText:
          state.status === 'locked'
            ? `键盘锁定中 (剩余 ${formatCleanDuration(state.remainingSeconds)}) | 本次已拦截 ${state.blockedKeystrokes} 次按键`
            : `键盘正常输入未锁定 | 累计防误触拦截 ${stats.totalBlockedKeystrokes} 次按键`,
        actions:
          state.status === 'locked'
            ? [
                {
                  id: 'unlock-now',
                  title: '立即解锁键盘 (Ctrl+U)',
                  style: 'danger',
                  onAction: async () => {
                    const res = await defaultKeyboardLockManager.unlockKeyboard(
                      'manual',
                      props?.hostOverride
                    )
                    await showToast(
                      res.success ? Toast.Style.Success : Toast.Style.Failure,
                      res.message
                    )
                    refresh()
                  }
                },
                {
                  id: 'view-stats',
                  title: '查看清洁统计',
                  style: 'secondary',
                  onAction: () => {
                    push(
                      <CleanKeyboardDetailView
                        onStateChange={refresh}
                        hostOverride={props?.hostOverride}
                      />
                    )
                  }
                }
              ]
            : [
                {
                  id: 'lock-30s',
                  title: '立即锁定 30 秒',
                  style: 'primary',
                  onAction: async () => {
                    const res = await defaultKeyboardLockManager.lockKeyboard(30, {
                      presetTitle: '30 秒标准清洁',
                      icon: '30s',
                      hostOverride: props?.hostOverride
                    })
                    await showToast(
                      res.success ? Toast.Style.Success : Toast.Style.Failure,
                      res.message
                    )
                    refresh()
                  }
                },
                {
                  id: 'lock-2m',
                  title: '锁定 2 分钟',
                  style: 'secondary',
                  onAction: async () => {
                    const res = await defaultKeyboardLockManager.lockKeyboard(120, {
                      presetTitle: '2 分钟键帽清理',
                      icon: '2m',
                      hostOverride: props?.hostOverride
                    })
                    await showToast(
                      res.success ? Toast.Style.Success : Toast.Style.Failure,
                      res.message
                    )
                    refresh()
                  }
                }
              ]
      }}
    >
      {state.status === 'locked' && (
        <List.Section title="当前处于键盘锁定状态 (按 Ctrl+U 紧急解锁)">
          <List.Item
            id="active-lock-banner"
            icon={{ source: Icon.Lock, tintColor: Color.Red }}
            title={`正在执行: ${state.activePresetTitle || '键盘清洁锁'}`}
            subtitle={`剩余时间: ${formatCleanDuration(state.remainingSeconds)} · 已拦截误触: ${state.blockedKeystrokes} 次`}
            accessories={[
              { tag: { value: 'LOCKED', color: Color.Red } },
              { text: `按 ${state.emergencyShortcut.display} 立即解锁` }
            ]}
            actions={
              <ActionPanel>
                <Action
                  title="立即解锁键盘 (Unlock Now)"
                  icon={Icon.Unlock}
                  shortcut={{ modifiers: ['ctrl'], key: 'u' }}
                  onAction={async () => {
                    const res = await defaultKeyboardLockManager.unlockKeyboard(
                      'manual',
                      props?.hostOverride
                    )
                    await showToast(
                      res.success ? Toast.Style.Success : Toast.Style.Failure,
                      res.message
                    )
                    refresh()
                  }}
                />
                <Action.Push
                  title="查看锁定详情看板"
                  icon={Icon.Eye}
                  target={
                    <CleanKeyboardDetailView
                      onStateChange={refresh}
                      hostOverride={props?.hostOverride}
                    />
                  }
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      <List.Section
        title="预设清洁锁定时长 (Lock Duration Presets)"
        subtitle={`共 ${CLEAN_DURATION_PRESETS.length} 个档位`}
      >
        {CLEAN_DURATION_PRESETS.map((preset) => (
          <List.Item
            key={preset.id}
            id={preset.id}
            icon={Icon.Clock}
            title={preset.title}
            subtitle={preset.subtitle}
            accessories={[
              ...(preset.recommended ? [{ tag: '推荐' }] : []),
              { text: preset.display }
            ]}
            actions={
              <ActionPanel>
                <Action
                  title={`锁定键盘: ${preset.display}`}
                  icon={Icon.Lock}
                  onAction={async () => {
                    const res = await defaultKeyboardLockManager.lockKeyboard(preset.seconds, {
                      presetTitle: preset.title,
                      icon: preset.icon,
                      hostOverride: props?.hostOverride
                    })
                    await showToast(
                      res.success ? Toast.Style.Success : Toast.Style.Failure,
                      res.message
                    )
                    refresh()
                  }}
                />
                <Action.Push
                  title="自定义任意锁定时长..."
                  icon={Icon.Clock}
                  shortcut={{ modifiers: ['ctrl'], key: 't' }}
                  target={
                    <CustomDurationForm
                      onLocked={refresh}
                      hostOverride={props?.hostOverride}
                    />
                  }
                />
                <Action.Push
                  title="查看清洁锁详情与历史统计"
                  icon={Icon.BarChart}
                  target={
                    <CleanKeyboardDetailView
                      preset={preset}
                      onStateChange={refresh}
                      hostOverride={props?.hostOverride}
                    />
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

export default CleanKeyboardCommand

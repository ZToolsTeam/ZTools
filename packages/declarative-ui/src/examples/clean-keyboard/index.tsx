/**
 * Clean Keyboard (键盘清洁防误触锁) 声明式主视图
 *
 * 借鉴 Raycast 官方 `extensions/clean-keyboard/src/clean-keyboard.tsx` 改造：
 * - 完整保留原版 8 档预设时长与清洁图标 (🪥, 🧽, 🧼, 🚿, 🛁, 🧹, 🫧, 🤯)
 * - 支持锁定期间实时显示倒计时、已拦截误触按键数与 `Ctrl + U` 紧急解锁
 * - 支持自定义锁定时长表单与清洁历史统计看板
 */

import React from "../../index.js";
import {
  List,
  Detail,
  Form,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  useNavigation
} from "../../index.js";
import { useState } from "../../runtime/hooks.js";
import { CleanDurationPreset } from "./types.js";
import {
  CLEAN_DURATION_PRESETS,
  defaultKeyboardLockManager,
  formatCleanDuration
} from "./keyboard-lock-service.js";

export * from "./types.js";
export * from "./keyboard-lock-service.js";

/**
 * 锁定状态详情与清洁统计视图
 */
export function CleanKeyboardDetailView({
  preset,
  onStateChange
}: {
  preset?: CleanDurationPreset;
  onStateChange?: () => void;
}) {
  const state = defaultKeyboardLockManager.getState();
  const stats = defaultKeyboardLockManager.getStats();

  const markdown = `
# ${state.status === "locked" ? `🔒 键盘正在锁定清洁中 ${state.activeIcon || "🧼"}` : `🧼 键盘清洁防误触锁 (${preset?.title || "就绪"})`}

> **紧急解锁热键**: 随时按下 \`${state.emergencyShortcut.display}\` 即可立即解除键盘锁定。

---

### 当前状态
- **锁状态**: \`${state.status.toUpperCase()}\`
- **剩余时间**: \`${state.status === "locked" ? formatCleanDuration(state.remainingSeconds) : formatCleanDuration(preset?.seconds)}\`
- **本次已拦截误触按键**: \`${state.blockedKeystrokes} 次\` ${state.lastBlockedKey ? `(最近拦截: \`${state.lastBlockedKey}\`)` : ""}

### 历史清洁统计
- **累计清洁次数**: \`${stats.totalSessions} 次\`
- **累计锁定时长**: \`${formatCleanDuration(stats.totalCleanedSeconds)}\`
- **累计防误触拦截**: \`${stats.totalBlockedKeystrokes} 次按键\`
`;

  return (
    <Detail
      navigationTitle="键盘清洁锁详情"
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.TagList title="锁定状态">
            <Detail.Metadata.TagList.Item
              text={state.status === "locked" ? "LOCKED (已锁定)" : "UNLOCKED (正常输入)"}
              color={state.status === "locked" ? Color.Red : Color.Green}
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
          {state.status === "locked" ? (
            <Action
              title="立即解锁键盘 (Unlock Keyboard)"
              icon={Icon.Unlock}
              shortcut={{ modifiers: ["ctrl"], key: "u" }}
              onAction={async () => {
                const res = await defaultKeyboardLockManager.unlockKeyboard("manual");
                await showToast(
                  res.success ? Toast.Style.Success : Toast.Style.Failure,
                  res.message
                );
                onStateChange?.();
              }}
            />
          ) : (
            <Action
              title={`立即锁定 (${preset?.title || "30 秒"})`}
              icon={Icon.Lock}
              onAction={async () => {
                const res = await defaultKeyboardLockManager.lockKeyboard(
                  preset ? preset.seconds : 30,
                  { presetTitle: preset?.title, icon: preset?.icon }
                );
                await showToast(
                  res.success ? Toast.Style.Success : Toast.Style.Failure,
                  res.message
                );
                onStateChange?.();
              }}
            />
          )}
        </ActionPanel>
      }
    />
  );
}

/**
 * 自定义锁定时长表单
 */
export function CustomDurationForm({ onLocked }: { onLocked?: () => void }) {
  const { pop } = useNavigation();

  return (
    <Form
      navigationTitle="自定义键盘清洁锁定时长"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="启动键盘锁定"
            icon={Icon.Lock}
            onSubmit={async (values: Record<string, any>) => {
              const seconds = Number(values.seconds);
              const res = await defaultKeyboardLockManager.lockKeyboard(seconds, {
                presetTitle: `自定义 ${seconds} 秒清洁锁`,
                icon: "🧼"
              });
              if (!res.success) {
                await showToast(Toast.Style.Failure, res.message);
                return;
              }
              await showToast(Toast.Style.Success, res.message);
              onLocked?.();
              pop();
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
  );
}

/**
 * 键盘清洁防误触锁主命令组件 (对应 Raycast `clean-keyboard.tsx` 的 Command)
 */
export default function CleanKeyboardCommand() {
  const [, setTickVersion] = useState(0);
  const refresh = () => setTickVersion((v) => v + 1);

  const state = defaultKeyboardLockManager.getState();
  const stats = defaultKeyboardLockManager.getStats();

  return (
    <List
      navigationTitle="键盘清洁防误触锁 (Clean Keyboard)"
      searchBarPlaceholder="选择键盘锁定时长 (清洁键盘、擦屏幕、防猫踩键盘)..."
    >
      {state.status === "locked" && (
        <List.Section title="🔒 当前正在锁定清洁中">
          <List.Item
            key="active-lock-banner"
            icon={{ source: Icon.Lock, tintColor: Color.Red }}
            title={`正在锁定键盘: ${state.activePresetTitle || "清洁模式"}`}
            subtitle={`剩余: ${formatCleanDuration(state.remainingSeconds)} • 已拦截 ${state.blockedKeystrokes} 次按键 • 按 ${state.emergencyShortcut.display} 立即解锁`}
            accessories={[{ tag: { value: "LOCKED", color: Color.Red } }]}
            actions={
              <ActionPanel>
                <Action
                  title="立即解锁键盘 (Unlock Keyboard)"
                  icon={Icon.Unlock}
                  shortcut={{ modifiers: ["ctrl"], key: "u" }}
                  onAction={async () => {
                    const res = await defaultKeyboardLockManager.unlockKeyboard("manual");
                    await showToast(Toast.Style.Success, res.message);
                    refresh();
                  }}
                />
                <Action.Push
                  title="查看锁定详情面板"
                  icon={Icon.Eye}
                  target={<CleanKeyboardDetailView onStateChange={refresh} />}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      <List.Section
        title="预设清洁锁定时长 (Durations)"
        subtitle={`累计已拦截 ${stats.totalBlockedKeystrokes} 次误触`}
      >
        {CLEAN_DURATION_PRESETS.map((preset) => (
          <List.Item
            key={preset.id}
            icon={preset.icon}
            title={preset.title}
            subtitle={preset.subtitle}
            accessories={[
              preset.recommended
                ? { tag: { value: "常用推荐", color: Color.Green } }
                : {},
              { text: preset.display }
            ]}
            actions={
              <ActionPanel>
                <Action
                  title="锁定键盘 (Lock Keyboard)"
                  icon={Icon.Lock}
                  onAction={async () => {
                    const res = await defaultKeyboardLockManager.lockKeyboard(preset.seconds, {
                      presetTitle: preset.title,
                      icon: preset.icon
                    });
                    await showToast(
                      res.success ? Toast.Style.Success : Toast.Style.Failure,
                      res.message
                    );
                    refresh();
                  }}
                />
                <Action.Push
                  title="查看详情与统计"
                  icon={Icon.Info}
                  target={<CleanKeyboardDetailView preset={preset} onStateChange={refresh} />}
                />
                <Action.Push
                  title="自定义锁定时长..."
                  icon={Icon.Clock}
                  shortcut={{ modifiers: ["ctrl"], key: "n" }}
                  target={<CustomDurationForm onLocked={refresh} />}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}

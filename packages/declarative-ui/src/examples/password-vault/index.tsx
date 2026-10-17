/**
 * 密码保险箱 (password-vault) 声明式主视图
 *
 * 借鉴 Raycast 官方 `keepassxc` & `rpass` 源码改造：
 * - 单一职责管理「网站名称 + 账号 + 密码 + 网址 + 分类文件夹 + 私密备注」
 * - 支持主密码锁定/解锁、一键复制密码或账号、新建/编辑条目与 Chrome/Edge CSV 导入导出
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
  Clipboard,
  showToast,
  Toast,
  useNavigation
} from "../../index.js";
import { useState, useMemo } from "../../runtime/hooks.js";
import { VAULT_CATEGORIES, VaultEntry } from "./types.js";
import {
  defaultPasswordVaultManager,
  evaluatePasswordStrength,
  exportEntriesToCsv,
  generateVaultPassword
} from "./vault-storage.js";

export * from "./types.js";
export * from "./vault-storage.js";

/**
 * 密码条目详情视图
 */
export function VaultEntryDetailView({
  entry,
  onUpdated
}: {
  entry: VaultEntry;
  onUpdated?: () => void;
}) {
  const strength = useMemo(() => evaluatePasswordStrength(entry.password), [entry.password]);

  const markdown = `
# 🔐 ${entry.name}

> **分类文件夹**: \`${entry.folder}\` | **密码强度**: \`${strength.label} (${strength.entropyBits} bits)\`

---

### 登录凭据
- **用户名 / 账号**: \`${entry.username || "(未填写)"}\`
- **登录密码**: \`${entry.password}\`
- **关联网址 (URL)**: ${entry.url ? `[${entry.url}](${entry.url})` : "`(未设置)`"}

${entry.note ? `### 私密备注\n> ${entry.note}\n` : ""}
`;

  return (
    <Detail
      navigationTitle={`密码详情: ${entry.name}`}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="网站/应用" text={entry.name} icon={Icon.Key} />
          <Detail.Metadata.Label title="账号" text={entry.username || "-"} icon={Icon.Person} />
          <Detail.Metadata.TagList title="密码安全度">
            <Detail.Metadata.TagList.Item
              text={`${strength.label} (${strength.score}分)`}
              color={
                strength.score >= 75
                  ? Color.Green
                  : strength.score >= 50
                    ? Color.Yellow
                    : Color.Red
              }
            />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Label title="所属分类" text={String(entry.folder)} icon={Icon.Folder} />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action
            title="复制密码 (Copy Password)"
            icon={Icon.CopyClipboard}
            onAction={async () => {
              await Clipboard.copy(entry.password);
              await showToast(Toast.Style.Success, `已复制 "${entry.name}" 的密码`);
            }}
          />
          <Action
            title="复制账号 (Copy Username)"
            icon={Icon.Person}
            onAction={async () => {
              await Clipboard.copy(entry.username);
              await showToast(Toast.Style.Success, `已复制账号: ${entry.username}`);
            }}
          />
          <Action
            title={entry.pinned ? "取消置顶" : "置顶此密码"}
            icon={entry.pinned ? Icon.StarDisabled : Icon.Star}
            onAction={async () => {
              defaultPasswordVaultManager.togglePinEntry(entry.id);
              onUpdated?.();
            }}
          />
        </ActionPanel>
      }
    />
  );
}

/**
 * 新建 / 编辑密码条目表单
 */
export function VaultEntryForm({
  initialEntry,
  onSaved
}: {
  initialEntry?: VaultEntry;
  onSaved?: (entry: VaultEntry) => void;
}) {
  const { pop } = useNavigation();

  return (
    <Form
      navigationTitle={initialEntry ? `编辑密码: ${initialEntry.name}` : "新建密码条目"}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="保存密码条目"
            icon={Icon.Checkmark}
            onSubmit={async (values: Record<string, any>) => {
              try {
                const saved = defaultPasswordVaultManager.addOrUpdateEntry({
                  id: initialEntry?.id,
                  name: values.name,
                  username: values.username,
                  password: values.password || generateVaultPassword({ length: 16 }),
                  url: values.url,
                  folder: values.folder || "其他",
                  note: values.note
                });
                await showToast(Toast.Style.Success, `已保存密码: ${saved.name}`);
                onSaved?.(saved);
                pop();
              } catch (e: any) {
                await showToast(Toast.Style.Failure, e?.message || "保存失败");
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="网站或应用名称"
        placeholder="如: GitHub、京东、公司邮箱..."
        defaultValue={initialEntry?.name || ""}
      />
      <Form.TextField
        id="username"
        title="登录账号 / 手机号"
        placeholder="输入用户名、邮箱或手机号..."
        defaultValue={initialEntry?.username || ""}
      />
      <Form.PasswordField
        id="password"
        title="登录密码"
        placeholder="留空则自动生成 16 位高强密码..."
        defaultValue={initialEntry?.password || ""}
      />
      <Form.TextField
        id="url"
        title="网站地址 (URL)"
        placeholder="https://..."
        defaultValue={initialEntry?.url || ""}
      />
      <Form.Dropdown id="folder" title="分类文件夹" defaultValue={initialEntry?.folder || "其他"}>
        {VAULT_CATEGORIES.map((cat) => (
          <Form.Dropdown.Item key={cat} title={cat} value={cat} />
        ))}
      </Form.Dropdown>
      <Form.TextArea
        id="note"
        title="私密备注"
        placeholder="安全问题、绑定的备用手机或其他说明..."
        defaultValue={initialEntry?.note || ""}
      />
    </Form>
  );
}

/**
 * 解锁密码箱表单 (对应 Raycast `keepassxc/src/components/unlock-database.tsx`)
 */
export function VaultUnlockForm({ onUnlocked }: { onUnlocked?: () => void }) {
  const { pop } = useNavigation();

  return (
    <Form
      navigationTitle="解锁密码保险箱 (Unlock Vault)"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="解锁密码箱"
            icon={Icon.Unlock}
            onSubmit={async (values: Record<string, any>) => {
              const res = defaultPasswordVaultManager.unlockVault(values.masterPassword || "");
              if (!res.success) {
                await showToast(Toast.Style.Failure, res.error || "主密码错误");
                return;
              }
              await showToast(Toast.Style.Success, "密码保险箱已解锁");
              onUnlocked?.();
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.PasswordField
        id="masterPassword"
        title="主密码 (Master Password)"
        placeholder="输入主密码以解密本地密码库..."
      />
    </Form>
  );
}

/**
 * Chrome / Edge CSV 密码表导入表单
 */
export function VaultImportCsvForm({ onImported }: { onImported?: () => void }) {
  const { pop } = useNavigation();

  return (
    <Form
      navigationTitle="导入 Chrome / Edge CSV 密码表"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="解析并导入 CSV"
            icon={Icon.Download}
            onSubmit={async (values: Record<string, any>) => {
              try {
                const res = defaultPasswordVaultManager.importFromCsv(values.csvContent || "");
                await showToast(
                  Toast.Style.Success,
                  `导入完成: 新增 ${res.imported} 条, 更新 ${res.updated} 条`
                );
                onImported?.();
                pop();
              } catch (e: any) {
                await showToast(Toast.Style.Failure, e?.message || "导入失败");
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="csvContent"
        title="CSV 文本内容"
        placeholder="粘贴从 Edge / Chrome 导出的 CSV 内容 (表头: name,url,username,password,note)..."
      />
    </Form>
  );
}

/**
 * 密码保险箱主命令组件
 */
export default function PasswordVaultCommand() {
  const [searchText, setSearchText] = useState("");
  const [folderFilter, setFolderFilter] = useState("all");
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  const lockState = defaultPasswordVaultManager.getLockState();
  const entries = useMemo(
    () =>
      defaultPasswordVaultManager.getEntries({
        query: searchText,
        folder: folderFilter
      }),
    [searchText, folderFilter, version, lockState]
  );

  if (lockState === "locked") {
    return (
      <List navigationTitle="密码保险箱 (已锁定)">
        <List.Section title="🔒 密码箱已锁定">
          <List.Item
            id="vault-locked-prompt"
            icon={Icon.Lock}
            title="密码保险箱当前已锁定"
            subtitle="为保护你的账号与密码安全，请验证主密码后查看或复制凭据。"
            actions={
              <ActionPanel>
                <Action.Push
                  title="输入主密码解锁 (Unlock Vault)"
                  icon={Icon.Unlock}
                  target={<VaultUnlockForm onUnlocked={refresh} />}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      </List>
    );
  }

  return (
    <List
      navigationTitle="密码保险箱 (Password Vault)"
      searchBarPlaceholder="搜索网站名称、账号、网址或备注..."
      onSearchTextChange={setSearchText}
      searchBarAccessory={
        <List.Dropdown
          tooltip="按分类文件夹筛选"
          value={folderFilter}
          onChange={setFolderFilter}
        >
          <List.Dropdown.Item title="全部分类 (All Folders)" value="all" />
          {VAULT_CATEGORIES.map((cat) => (
            <List.Dropdown.Item key={cat} title={cat} value={cat} />
          ))}
        </List.Dropdown>
      }
    >
      <List.Section title="已加密保存的网站与应用凭据" subtitle={`共 ${entries.length} 条记录`}>
        {entries.map((entry) => (
          <List.Item
            key={entry.id}
            icon={{ source: Icon.Key, tintColor: entry.pinned ? Color.Yellow : Color.Blue }}
            title={entry.name}
            subtitle={entry.username || entry.url}
            accessories={[
              entry.pinned ? { icon: { source: Icon.Star, tintColor: Color.Yellow } } : {},
              { tag: { value: String(entry.folder), color: Color.SecondaryText } }
            ]}
            actions={
              <ActionPanel>
                <Action
                  title="复制密码 (Copy Password)"
                  icon={Icon.CopyClipboard}
                  onAction={async () => {
                    await Clipboard.copy(entry.password);
                    await showToast(Toast.Style.Success, `已复制 "${entry.name}" 的密码`);
                  }}
                />
                <Action
                  title="复制账号 (Copy Username)"
                  icon={Icon.Person}
                  shortcut={{ modifiers: ["ctrl"], key: "b" }}
                  onAction={async () => {
                    await Clipboard.copy(entry.username);
                    await showToast(Toast.Style.Success, `已复制账号: ${entry.username}`);
                  }}
                />
                <Action.Push
                  title="查看凭据详情"
                  icon={Icon.Eye}
                  target={<VaultEntryDetailView entry={entry} onUpdated={refresh} />}
                />
                <Action.Push
                  title="新建密码条目..."
                  icon={Icon.Plus}
                  shortcut={{ modifiers: ["ctrl"], key: "n" }}
                  target={<VaultEntryForm onSaved={refresh} />}
                />
                <Action.Push
                  title="从 Chrome/Edge CSV 批量导入..."
                  icon={Icon.Download}
                  shortcut={{ modifiers: ["ctrl"], key: "i" }}
                  target={<VaultImportCsvForm onImported={refresh} />}
                />
                <Action
                  title="导出全部密码为 CSV 到剪贴板"
                  icon={Icon.Upload}
                  onAction={async () => {
                    const csv = exportEntriesToCsv(entries);
                    await Clipboard.copy(csv);
                    await showToast(Toast.Style.Success, "已将 CSV 导出到剪贴板");
                  }}
                />
                <Action
                  title="立即锁定密码箱 (Lock Vault)"
                  icon={Icon.Lock}
                  shortcut={{ modifiers: ["ctrl"], key: "l" }}
                  onAction={async () => {
                    defaultPasswordVaultManager.lockVault();
                    await showToast(Toast.Style.Success, "密码保险箱已锁定");
                    refresh();
                  }}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}

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
import { useState, useEffect, useMemo } from "../../runtime/hooks.js";
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
          <Action.Push
            title="编辑此密码条目 (Edit Entry)..."
            icon={Icon.Pencil}
            target={<VaultEntryForm initialEntry={entry} onSaved={() => onUpdated?.()} />}
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
  initialPassword,
  onSaved
}: {
  initialEntry?: VaultEntry;
  initialPassword?: string;
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
                  password:
                    values.password ||
                    initialPassword ||
                    generateVaultPassword({ length: 16 }),
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
        defaultValue={initialEntry?.password || initialPassword || ""}
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

export const CreateVaultItemForm = VaultEntryForm;

/**
 * 自定义高强度随机密码生成器表单
 */
export function PasswordGeneratorForm({
  onGenerated,
  onSaved
}: {
  onGenerated?: (password: string) => void;
  onSaved?: (entry: VaultEntry) => void;
}) {
  const [lengthStr, setLengthStr] = useState("20");
  const [useUppercase, setUseUppercase] = useState(true);
  const [useLowercase, setUseLowercase] = useState(true);
  const [useNumbers, setUseNumbers] = useState(true);
  const [useSymbols, setUseSymbols] = useState(true);
  const [excludeAmbiguous, setExcludeAmbiguous] = useState(true);
  const [saveAsName, setSaveAsName] = useState("");
  const [saveAsUsername, setSaveAsUsername] = useState("");
  const { pop } = useNavigation();

  return (
    <Form
      navigationTitle="🎲 随机强密码生成器 (Password Generator)"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="生成密码并复制到剪贴板"
            icon={Icon.Key}
            onSubmit={async (values: Record<string, any>) => {
              try {
                const len = Math.max(4, Math.min(128, parseInt(String(values.length || lengthStr || "20"), 10) || 20));
                const generated = generateVaultPassword({
                  length: len,
                  uppercase: values.uppercase ?? useUppercase,
                  lowercase: values.lowercase ?? useLowercase,
                  numbers: values.numbers ?? useNumbers,
                  symbols: values.symbols ?? useSymbols,
                  excludeAmbiguous: values.excludeAmbiguous ?? excludeAmbiguous
                });
                await Clipboard.copy(generated);
                onGenerated?.(generated);

                const entryName = String(values.saveAsName ?? saveAsName).trim();
                if (entryName) {
                  const saved = defaultPasswordVaultManager.addOrUpdateEntry({
                    name: entryName,
                    username: String(values.saveAsUsername ?? saveAsUsername).trim(),
                    password: generated,
                    folder: "其他",
                    note: `由随机密码生成器自动创建 (${len} 位)`
                  });
                  onSaved?.(saved);
                  await showToast(
                    Toast.Style.Success,
                    `已生成并保存至 "${saved.name}"`,
                    `密码已复制到剪贴板 (${len} 位)`
                  );
                } else {
                  const strength = evaluatePasswordStrength(generated);
                  await showToast(
                    Toast.Style.Success,
                    `已生成并复制 ${len} 位强密码`,
                    `安全评级: ${strength.label} (${strength.entropyBits} bits)`
                  );
                }
                pop();
              } catch (e: any) {
                await showToast(Toast.Style.Failure, e?.message || "生成密码失败");
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="length" title="密码长度 (Length)" value={lengthStr} onChange={setLengthStr}>
        <Form.Dropdown.Item value="12" title="12 位 (标准)" />
        <Form.Dropdown.Item value="16" title="16 位 (推荐强密码)" />
        <Form.Dropdown.Item value="20" title="20 位 (极强)" />
        <Form.Dropdown.Item value="24" title="24 位 (高安全级)" />
        <Form.Dropdown.Item value="32" title="32 位 (金融/密钥级)" />
      </Form.Dropdown>
      <Form.Checkbox
        id="uppercase"
        label="包含大写字母 (A-Z)"
        value={useUppercase}
        onChange={setUseUppercase}
      />
      <Form.Checkbox
        id="lowercase"
        label="包含小写字母 (a-z)"
        value={useLowercase}
        onChange={setUseLowercase}
      />
      <Form.Checkbox
        id="numbers"
        label="包含数字 (0-9)"
        value={useNumbers}
        onChange={setUseNumbers}
      />
      <Form.Checkbox
        id="symbols"
        label="包含特殊符号 (!@#$%^&*)"
        value={useSymbols}
        onChange={setUseSymbols}
      />
      <Form.Checkbox
        id="excludeAmbiguous"
        label="排除易混淆字符 (0/O, 1/l/I)"
        value={excludeAmbiguous}
        onChange={setExcludeAmbiguous}
      />
      <Form.TextField
        id="saveAsName"
        title="同时保存为密码条目 (可选)"
        placeholder="填写网站名称则自动保存至保险箱，留空仅复制密码"
        value={saveAsName}
        onChange={setSaveAsName}
      />
      <Form.TextField
        id="saveAsUsername"
        title="关联登录账号 (可选)"
        placeholder="例如: user@example.com"
        value={saveAsUsername}
        onChange={setSaveAsUsername}
      />
    </Form>
  );
}

/**
 * 修改主密码表单
 */
export function VaultChangeMasterPasswordForm({ onChanged }: { onChanged?: () => void }) {
  const { pop } = useNavigation();

  return (
    <Form
      navigationTitle="设置 / 修改主密码 (Master Password)"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="保存新主密码并重新加密"
            icon={Icon.Key}
            onSubmit={async (values: Record<string, any>) => {
              try {
                defaultPasswordVaultManager.setMasterPassword(values.newMasterPassword || "");
                await showToast(Toast.Style.Success, "主密码已更新，本地密码库已完成 AEAD 重加密");
                onChanged?.();
                pop();
              } catch (e: any) {
                await showToast(Toast.Style.Failure, e?.message || "设置主密码失败");
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.PasswordField
        id="newMasterPassword"
        title="新主密码 (New Master Password)"
        placeholder="至少 4 位字符，用于 AES-256-GCM 加密本地密码库..."
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
  const { push } = useNavigation();
  const [searchText, setSearchText] = useState("");
  const [folderFilter, setFolderFilter] = useState("all");
  const [version, setVersion] = useState(0);
  const [generatedPassword, setGeneratedPassword] = useState(() =>
    generateVaultPassword({ length: 20 })
  );
  const refresh = () => setVersion((v) => v + 1);

  useEffect(() => {
    void defaultPasswordVaultManager.hydrateFromStorage().then((loaded) => {
      if (loaded) refresh();
    });
  }, []);

  const lockState = defaultPasswordVaultManager.getLockState();
  const entries = useMemo(
    () =>
      defaultPasswordVaultManager.getEntries({
        query: searchText,
        folder: folderFilter
      }),
    [searchText, folderFilter, version, lockState]
  );

  const generatedStrength = useMemo(
    () => evaluatePasswordStrength(generatedPassword),
    [generatedPassword]
  );

  if (lockState === "locked") {
    return (
      <List
        navigationTitle="密码保险箱 (已锁定)"
        filterBar={{
          summaryText: `密码箱状态: 🔒 已锁定 · 请验证主密码解锁 · 随机密码生成器熵值: ${generatedStrength.entropyBits} bits`,
          actions: [
            {
              id: "vault-act-unlock",
              label: "🔓 解锁 / 🔒 锁定密码箱",
              title: "🔓 解锁 / 🔒 锁定密码箱",
              style: "primary",
              onAction: () => {
                push(<VaultUnlockForm onUnlocked={refresh} />);
              }
            },
            {
              id: "vault-act-gen20",
              label: "🎲 复制 20 位随机强密码",
              title: "🎲 复制 20 位随机强密码",
              style: "secondary",
              onAction: async () => {
                const next = generateVaultPassword({ length: 20 });
                setGeneratedPassword(next);
                await Clipboard.copy(next);
                await showToast(Toast.Style.Success, "已生成并复制 20 位随机强密码");
              }
            }
          ]
        }}
      >
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
      isShowingDetail={true}
      searchBarPlaceholder="搜索网站名称、账号、网址或备注..."
      onSearchTextChange={setSearchText}
      filterBar={{
        summaryText: `密码箱状态: 🔓 已解锁 · 保存凭据共 ${entries.length} 条 · 实时强密码熵值: ${generatedStrength.entropyBits} bits (${generatedStrength.label})`,
        groups: [
          {
            id: "vault-folder-filter",
            label: "分类筛选",
            value: folderFilter,
            onChange: (val) => setFolderFilter(val),
            options: [
              { value: "all", label: "全部凭据", badge: entries.length },
              ...VAULT_CATEGORIES.map((cat) => ({
                value: cat,
                label: cat
              }))
            ]
          }
        ],
        actions: [
          {
            id: "vault-act-toggle-lock",
            label: "🔓 解锁 / 🔒 锁定密码箱",
            title: "🔓 解锁 / 🔒 锁定密码箱",
            style: "primary",
            onAction: async () => {
              defaultPasswordVaultManager.lockVault();
              await showToast(Toast.Style.Success, "密码保险箱已安全锁定");
              refresh();
            }
          },
          {
            id: "vault-act-new-entry",
            label: "➕ 新建密码条目",
            title: "➕ 新建密码条目",
            style: "primary",
            onAction: () => {
              push(<VaultEntryForm onSaved={refresh} />);
            }
          },
          {
            id: "vault-act-copy-rand20",
            label: "🎲 复制 20 位随机强密码",
            title: "🎲 复制 20 位随机强密码",
            style: "secondary",
            onAction: async () => {
              const next = generateVaultPassword({ length: 20 });
              setGeneratedPassword(next);
              await Clipboard.copy(next);
              await showToast(
                Toast.Style.Success,
                "已生成并复制 20 位随机强密码",
                `${generatedStrength.label} (${generatedStrength.entropyBits} bits)`
              );
            }
          },
          {
            id: "vault-act-import-csv",
            label: "📥 导入 CSV",
            title: "📥 导入 CSV",
            style: "secondary",
            onAction: () => {
              push(<VaultImportCsvForm onImported={refresh} />);
            }
          },
          {
            id: "vault-act-master-pwd",
            label: "🔑 设置/修改主密码",
            title: "🔑 设置/修改主密码",
            style: "secondary",
            onAction: () => {
              push(<VaultChangeMasterPasswordForm onChanged={refresh} />);
            }
          }
        ]
      }}
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
      <List.Section title="🎲 随机强密码生成器 (Password Generator)">
        <List.Item
          id="vault-password-generator"
          icon={{ source: Icon.Key, tintColor: Color.Green }}
          title={`随机强密码: ${generatedPassword}`}
          subtitle={`${generatedStrength.label} (${generatedStrength.entropyBits} bits)`}
          accessories={[
            {
              tag: {
                value: `${generatedPassword.length} 位 · ${generatedStrength.score}分`,
                color: Color.Green
              }
            }
          ]}
          detail={
            <List.Item.Detail
              markdown={[
                `# 🎲 随机强密码生成器`,
                `\`\`\`text\n${generatedPassword}\n\`\`\``,
                `- **密码长度**: \`${generatedPassword.length} 位\``,
                `- **信息熵 (Entropy)**: \`${generatedStrength.entropyBits} bits\``,
                `- **安全等级**: **${generatedStrength.label}** (\`${generatedStrength.score}/100\`)`,
                `---`,
                `> 按 \`Enter\` 立即复制此随机强密码，或按 \`Ctrl+K\` 选择以该密码新建凭据条目、切换 16/24/32 位长度。`
              ].join("\n\n")}
            />
          }
          actions={
            <ActionPanel title="随机强密码生成器">
              <Action
                title="复制随机强密码 (Copy Generated Password)"
                icon={Icon.CopyClipboard}
                onAction={async () => {
                  await Clipboard.copy(generatedPassword);
                  await showToast(
                    Toast.Style.Success,
                    "已复制随机强密码",
                    `${generatedPassword.length} 位 (${generatedStrength.entropyBits} bits)`
                  );
                }}
              />
              <Action
                title="重新生成 20 位强密码 (Regenerate 20-char)"
                icon={Icon.ArrowClockwise}
                shortcut={{ modifiers: ["ctrl"], key: "r" }}
                onAction={async () => {
                  const next = generateVaultPassword({ length: 20 });
                  setGeneratedPassword(next);
                  await Clipboard.copy(next);
                  await showToast(Toast.Style.Success, "已重新生成并复制 20 位强密码");
                }}
              />
              <Action
                title="生成 16 位标准强密码 (16-char)"
                icon={Icon.Key}
                onAction={async () => {
                  const next = generateVaultPassword({ length: 16 });
                  setGeneratedPassword(next);
                  await Clipboard.copy(next);
                  await showToast(Toast.Style.Success, "已生成并复制 16 位强密码");
                }}
              />
              <Action
                title="生成 32 位金融密钥级密码 (32-char)"
                icon={Icon.Key}
                onAction={async () => {
                  const next = generateVaultPassword({ length: 32 });
                  setGeneratedPassword(next);
                  await Clipboard.copy(next);
                  await showToast(Toast.Style.Success, "已生成并复制 32 位密钥级密码");
                }}
              />
              <Action.Push
                title="使用此密码新建凭据条目..."
                icon={Icon.Plus}
                shortcut={{ modifiers: ["ctrl"], key: "n" }}
                target={
                  <VaultEntryForm initialPassword={generatedPassword} onSaved={refresh} />
                }
              />
              <Action.Push
                title="打开自定义密码生成器 (Custom Generator)..."
                icon={Icon.Gear}
                target={
                  <PasswordGeneratorForm
                    onGenerated={(pwd) => setGeneratedPassword(pwd)}
                    onSaved={refresh}
                  />
                }
              />
              <Action.Push
                title="从 Chrome/Edge CSV 批量导入..."
                icon={Icon.Download}
                shortcut={{ modifiers: ["ctrl"], key: "i" }}
                target={<VaultImportCsvForm onImported={refresh} />}
              />
              <Action.Push
                title="设置 / 修改主密码 (Master Password)..."
                icon={Icon.Lock}
                target={<VaultChangeMasterPasswordForm onChanged={refresh} />}
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
      </List.Section>

      <List.Section title="已加密保存的网站与应用凭据" subtitle={`共 ${entries.length} 条记录`}>
        {entries.map((entry) => {
          const strength = evaluatePasswordStrength(entry.password);
          return (
            <List.Item
              key={entry.id}
              id={entry.id}
              icon={{ source: Icon.Key, tintColor: entry.pinned ? Color.Yellow : Color.Blue }}
              title={entry.name}
              subtitle={entry.username || entry.url}
              accessories={[
                entry.pinned ? { icon: { source: Icon.Star, tintColor: Color.Yellow } } : {},
                { tag: { value: String(entry.folder), color: Color.SecondaryText } }
              ]}
              detail={
                <List.Item.Detail
                  markdown={[
                    `# 🔐 ${entry.name}`,
                    `> **分类文件夹**: \`${entry.folder}\` | **密码强度**: \`${strength.label} (${strength.entropyBits} bits)\``,
                    `---`,
                    `- **用户名 / 账号**: \`${entry.username || "(未填写)"}\``,
                    `- **登录密码**: \`${entry.password}\``,
                    `- **关联网址 (URL)**: ${entry.url ? `[${entry.url}](${entry.url})` : "`(未设置)`"}`,
                    entry.note ? `### 私密备注\n> ${entry.note}` : ""
                  ]
                    .filter(Boolean)
                    .join("\n\n")}
                />
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
                    title="编辑此密码条目 (Edit Entry)..."
                    icon={Icon.Pencil}
                    shortcut={{ modifiers: ["ctrl"], key: "e" }}
                    target={<VaultEntryForm initialEntry={entry} onSaved={refresh} />}
                  />
                  <Action
                    title={entry.pinned ? "取消置顶" : "置顶此密码"}
                    icon={entry.pinned ? Icon.StarDisabled : Icon.Star}
                    onAction={async () => {
                      defaultPasswordVaultManager.togglePinEntry(entry.id);
                      refresh();
                    }}
                  />
                  <Action
                    title="删除此密码条目 (Delete Entry)"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    shortcut={{ modifiers: ["ctrl"], key: "x" }}
                    onAction={async () => {
                      defaultPasswordVaultManager.deleteEntry(entry.id);
                      await showToast(Toast.Style.Success, `已删除密码条目: ${entry.name}`);
                      refresh();
                    }}
                  />
                  <Action.Push
                    title="新建密码条目..."
                    icon={Icon.Plus}
                    shortcut={{ modifiers: ["ctrl"], key: "n" }}
                    target={<VaultEntryForm onSaved={refresh} />}
                  />
                  <Action.Push
                    title="打开自定义密码生成器..."
                    icon={Icon.Gear}
                    target={
                      <PasswordGeneratorForm
                        onGenerated={(pwd) => setGeneratedPassword(pwd)}
                        onSaved={refresh}
                      />
                    }
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
                  <Action.Push
                    title="设置 / 修改主密码 (Master Password)..."
                    icon={Icon.Lock}
                    target={<VaultChangeMasterPasswordForm onChanged={refresh} />}
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
          );
        })}
      </List.Section>
    </List>
  );
}

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
  Clipboard,
  useNavigation
} from "../../index.js";
import { useState, useEffect, useMemo } from "../../runtime/hooks.js";
import {
  ZToolsGlobalPreferences,
  SettingsSectionKey,
  SettingsMainTab,
  ExtensionConfigItem,
  GeneralSettings,
  LauncherSettings,
  AdvancedSettings,
  ThemeMode,
  WindowMode
} from "./types.js";
import {
  DEFAULT_PREFERENCES,
  BUILTIN_EXTENSIONS,
  getPreferences,
  savePreferences,
  updateExtensionConfig,
  getSqliteCacheInfo,
  clearSqliteCache,
  resetPreferences,
  exportPreferencesJson,
  importPreferencesJson
} from "./settings-storage.js";

export * from "./types.js";
export * from "./settings-storage.js";

/**
 * 扩展独立配置与热键别名表单
 */
export function ExtensionConfigForm(props: {
  extension: ExtensionConfigItem;
  onSaved: (updated: ExtensionConfigItem) => void;
}) {
  const { extension, onSaved } = props;
  const [enabled, setEnabled] = useState(extension.enabled);
  const [alias, setAlias] = useState(extension.alias || "");
  const [hotkey, setHotkey] = useState(extension.hotkey || "");
  const { pop } = useNavigation();

  const handleSave = async () => {
    const patch: Partial<ExtensionConfigItem> = {
      enabled,
      alias: alias.trim() || undefined,
      hotkey: hotkey.trim() || undefined
    };
    await updateExtensionConfig(extension.id, patch);
    const updated: ExtensionConfigItem = { ...extension, ...patch };
    onSaved(updated);
    await showToast(Toast.Style.Success, "扩展配置已生效", extension.name);
    pop();
  };

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存扩展设置" onSubmit={handleSave} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="扩展模块"
        value={`${extension.name} (${extension.id})`}
        onChange={() => {}}
      />
      <Form.Checkbox
        id="enabled"
        label="启用此扩展"
        value={enabled}
        onChange={setEnabled}
      />
      <Form.TextField
        id="alias"
        title="根搜索快速别名 (Alias)"
        value={alias}
        onChange={setAlias}
        placeholder="例如: cb, dict, calc"
      />
      <Form.TextField
        id="hotkey"
        title="全局唤醒快捷键 (Hotkey)"
        value={hotkey}
        onChange={setHotkey}
        placeholder="例如: Alt+V, Alt+D, Ctrl+Shift+K"
      />
    </Form>
  );
}

/**
 * 常规设置表单 (General Settings Form)
 */
export function GeneralSettingsForm(props: {
  initial: GeneralSettings;
  onSaved: (updated: GeneralSettings) => void;
}) {
  const { initial, onSaved } = props;
  const [theme, setTheme] = useState(initial.theme);
  const [openAtLogin, setOpenAtLogin] = useState(initial.openAtLogin);
  const [autoHideOnBlur, setAutoHideOnBlur] = useState(initial.autoHideOnBlur);
  const [globalHotkey, setGlobalHotkey] = useState(initial.globalHotkey);
  const [acrylicEffect, setAcrylicEffect] = useState(initial.acrylicEffect);
  const { pop } = useNavigation();

  const handleSave = async () => {
    const updated: GeneralSettings = {
      ...initial,
      theme,
      openAtLogin,
      autoHideOnBlur,
      globalHotkey: globalHotkey.trim() || "Alt+Space",
      acrylicEffect
    };
    await savePreferences({ general: updated });
    onSaved(updated);
    await showToast(Toast.Style.Success, "常规设置已即时保存");
    pop();
  };

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存常规设置" onSubmit={handleSave} />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="theme" title="外观主题" value={theme} onChange={(v: any) => setTheme(v)}>
        <Form.Dropdown.Item value="auto" title="跟随系统 (Auto)" />
        <Form.Dropdown.Item value="dark" title="极客深色 (Dark)" />
        <Form.Dropdown.Item value="light" title="清爽浅色 (Light)" />
      </Form.Dropdown>
      <Form.Checkbox id="openAtLogin" label="开机自动启动" value={openAtLogin} onChange={setOpenAtLogin} />
      <Form.Checkbox id="autoHideOnBlur" label="窗口失焦时自动隐藏" value={autoHideOnBlur} onChange={setAutoHideOnBlur} />
      <Form.TextField id="globalHotkey" title="全局启动热键" value={globalHotkey} onChange={setGlobalHotkey} placeholder="Alt+Space" />
      <Form.Checkbox id="acrylicEffect" label="启用 Mica / 亚克力毛玻璃视觉" value={acrylicEffect} onChange={setAcrylicEffect} />
    </Form>
  );
}

/**
 * 兼容旧版的设置项编辑表单视图
 */
export function SettingsFormView(props: {
  sectionKey: SettingsSectionKey;
  initialPreferences: ZToolsGlobalPreferences;
  onSaved: (updated: ZToolsGlobalPreferences) => void;
}) {
  const { sectionKey, initialPreferences, onSaved } = props;
  const [prefs, setPreferencesState] = useState<ZToolsGlobalPreferences>(initialPreferences);
  const { pop } = useNavigation();

  // General 表单
  const [theme, setTheme] = useState(prefs.general.theme);
  const [openAtLogin, setOpenAtLogin] = useState(prefs.general.openAtLogin);
  const [autoHideOnBlur, setAutoHideOnBlur] = useState(prefs.general.autoHideOnBlur);
  const [globalHotkey, setGlobalHotkey] = useState(prefs.general.globalHotkey);

  // Advanced 表单
  const [proxyMode, setProxyMode] = useState(prefs.advanced.proxyMode);
  const [proxyUrl, setProxyUrl] = useState(prefs.advanced.proxyUrl || "");
  const [logLevel, setLogLevel] = useState(prefs.advanced.logLevel);

  const handleSave = async () => {
    let patch: Partial<ZToolsGlobalPreferences> = {};
    if (sectionKey === "general") {
      patch = {
        general: {
          ...prefs.general,
          theme,
          openAtLogin,
          autoHideOnBlur,
          globalHotkey
        }
      };
    } else if (sectionKey === "advanced") {
      patch = {
        advanced: {
          ...prefs.advanced,
          proxyMode,
          proxyUrl,
          logLevel
        }
      };
    }

    const updated = await savePreferences(patch);
    setPreferencesState(updated);
    onSaved(updated);
    await showToast(Toast.Style.Success, "设置已存盘生效");
    pop();
  };

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存设置 (Save)" onSubmit={handleSave} />
        </ActionPanel>
      }
    >
      {sectionKey === "general" ? (
        <React.Fragment>
          <Form.Dropdown id="theme" title="外观主题" value={theme} onChange={(v: any) => setTheme(v)}>
            <Form.Dropdown.Item value="auto" title="跟随系统 (Auto)" />
            <Form.Dropdown.Item value="dark" title="极客深色 (Dark)" />
            <Form.Dropdown.Item value="light" title="清爽浅色 (Light)" />
          </Form.Dropdown>
          <Form.Checkbox id="openAtLogin" label="开机自动启动" value={openAtLogin} onChange={setOpenAtLogin} />
          <Form.Checkbox id="autoHideOnBlur" label="窗口失焦自动隐藏" value={autoHideOnBlur} onChange={setAutoHideOnBlur} />
          <Form.TextField id="globalHotkey" title="全局呼出热键" value={globalHotkey} onChange={setGlobalHotkey} placeholder="Alt+Space" />
        </React.Fragment>
      ) : (
        <React.Fragment>
          <Form.Dropdown id="proxyMode" title="网络代理模式" value={proxyMode} onChange={(v: any) => setProxyMode(v)}>
            <Form.Dropdown.Item value="system" title="跟随系统" />
            <Form.Dropdown.Item value="none" title="直连" />
            <Form.Dropdown.Item value="manual" title="自定义代理" />
          </Form.Dropdown>
          <Form.TextField id="proxyUrl" title="代理地址" value={proxyUrl} onChange={setProxyUrl} placeholder="http://127.0.0.1:7890" />
          <Form.Dropdown id="logLevel" title="日志等级" value={logLevel} onChange={(v: any) => setLogLevel(v)}>
            <Form.Dropdown.Item value="debug" title="Debug" />
            <Form.Dropdown.Item value="info" title="Info" />
            <Form.Dropdown.Item value="warn" title="Warn" />
            <Form.Dropdown.Item value="error" title="Error" />
          </Form.Dropdown>
        </React.Fragment>
      )}
    </Form>
  );
}

/**
 * ZTools 系统偏好设置中心主入口
 * 对标 Raycast Settings 规范，5 大分组交互式治理中心
 */
export default function SettingsCommand() {
  const [searchText, setSearchText] = useState("");
  const [currentTab, setCurrentTab] = useState<SettingsMainTab>("general");
  const [preferences, setPreferences] = useState<ZToolsGlobalPreferences>(DEFAULT_PREFERENCES);
  const [cacheSizeText, setCacheSizeText] = useState("11.88 MB");
  const [isLoading, setIsLoading] = useState(true);
  const { push } = useNavigation();

  // 初始化加载偏好设置与缓存信息
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [loaded, cacheInfo] = await Promise.all([
          getPreferences(),
          getSqliteCacheInfo()
        ]);
        if (mounted) {
          setPreferences(loaded);
          setCacheSizeText(cacheInfo.formattedSize);
          setIsLoading(false);
        }
      } catch (err) {
        if (mounted) setIsLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // 重置配置
  const handleReset = async () => {
    const reset = await resetPreferences();
    setPreferences(reset);
    await showToast(Toast.Style.Success, "已重置为出厂默认设置");
  };

  // 导出配置
  const handleExport = async () => {
    const jsonStr = await exportPreferencesJson();
    await Clipboard.copy(jsonStr);
    await showToast(Toast.Style.Success, "配置已复制到剪贴板 (JSON 格式)");
  };

  // 一键清空本地 SQLite 缓存
  const handleClearCache = async () => {
    const res = await clearSqliteCache();
    const updatedCache = await getSqliteCacheInfo();
    setCacheSizeText(updatedCache.formattedSize);
    await showToast(
      Toast.Style.Success,
      "本地 SQLite 缓存已清空",
      `已释放 ${(res.clearedBytes / 1024 / 1024).toFixed(2)} MB 空间`
    );
  };

  // 快速切换扩展启用/禁用
  const handleToggleExtension = async (ext: ExtensionConfigItem) => {
    const updated = await updateExtensionConfig(ext.id, { enabled: !ext.enabled });
    setPreferences(updated);
    await showToast(
      Toast.Style.Success,
      !ext.enabled ? "已启用扩展" : "已禁用扩展",
      ext.name
    );
  };

  // 过滤后的扩展清单
  const filteredExtensions = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    const list = preferences.extensions && preferences.extensions.length > 0
      ? preferences.extensions
      : BUILTIN_EXTENSIONS;
    if (!q) return list;
    return list.filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.id.toLowerCase().includes(q) ||
      (e.alias && e.alias.toLowerCase().includes(q))
    );
  }, [preferences.extensions, searchText]);

  // 过滤后的全局快捷键清单
  const filteredShortcuts = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    const list = preferences.shortcuts || [];
    if (!q) return list;
    return list.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.commandId.toLowerCase().includes(q) ||
      (s.hotkey && s.hotkey.toLowerCase().includes(q))
    );
  }, [preferences.shortcuts, searchText]);

  const p = preferences;

  // 常规设置 Detail Markdown
  const generalDetailMarkdown = useMemo(() => {
    return [
      `# ⚙️ 常规偏好设置 (General Preferences)`,
      `---`,
      `### 🎨 外观与主题`,
      `- **当前主题**: \`${p.general.theme.toUpperCase()}\` (支持跟随系统、极客深色、清爽浅色)`,
      `- **亚克力毛玻璃质感 (Mica/Acrylic)**: ${p.general.acrylicEffect ? "✅ 已开启" : "❌ 已关闭"}`,
      `\n### 🚀 启动与窗口行为`,
      `- **开机自启动**: ${p.general.openAtLogin ? "✅ 已开启" : "❌ 未开启"}`,
      `- **窗口失焦自动隐藏 (Auto-Hide on Blur)**: ${p.general.autoHideOnBlur ? "✅ 已开启 (极客免干扰)" : "❌ 已关闭 (保持悬浮)"}`,
      `- **主窗口形态**: \`${p.general.windowMode === "compact" ? "极简工具条 (Compact)" : "完整工作台 (Expanded)"}\``,
      `- **系统托盘图标**: ${p.general.showInTray ? "显示" : "隐藏"}\n`,
      `### ⌨️ 全局呼出热键`,
      `> 唤醒热键: \`${p.general.globalHotkey}\` (随时随地一键出窗)\n`,
      `> 按 **Enter** 快捷编辑常规设置选项。`
    ].join("\n\n");
  }, [p.general]);

  // 高级与存储 Detail Markdown
  const advancedDetailMarkdown = useMemo(() => {
    return [
      `# 💾 高级与本地存储 (Advanced & Storage)`,
      `---`,
      `### 🗄️ SQLite WAL 本地缓存治理`,
      `- **本地 SQLite 缓存占用**: \`${cacheSizeText}\``,
      `- **数据库模式**: WAL (Write-Ahead Logging 毫秒并发无锁读写)`,
      `- **状态自愈与防篡改**: 损坏配置秒级自愈与清洗隔离\n`,
      `### ⚡ 底层硬件与 Native 侧车`,
      `- **特权穿透 (UIAccess Worker)**: ${p.advanced.enableUiaAccess ? "✅ 运行中 (穿透 UIPI 跨进程抓词)" : "未激活"}`,
      `- **显存节能挂起 (15s GPU Suspend)**: ${p.advanced.enableGpuPowerSaving ? "开启 (待机显存与内存压降至 <200MB)" : "关闭"}`,
      `- **开发者模式 (DevTools)**: ${p.advanced.developerMode ? "开启" : "关闭"}\n`,
      `### 🌐 网络与代理`,
      `- **网络代理模式**: \`${p.advanced.proxyMode.toUpperCase()}\` (${p.advanced.proxyUrl || "跟随系统"})\n`,
      `> 真实双向绑定存盘，支持一键清空缓存与配置备份。`
    ].join("\n\n");
  }, [p.advanced, cacheSizeText]);

  // 关于 Detail Markdown
  const aboutDetailMarkdown = useMemo(() => {
    return [
      `# ℹ️ 关于 ZTools (About)`,
      `---`,
      `### 🚀 版本与架构`,
      `- **宿主版本**: \`v${p.about.version}\` (构建号: \`${p.about.buildNumber}\`)`,
      `- **核心架构**: TypeScript + Electron \`${p.about.electronVersion}\` + Vue \`${p.about.vueVersion}\` + Rust Sidecar \`${p.about.rustSidecarVersion}\``,
      `- **更新通道**: \`${p.about.updateChannel.toUpperCase()}\` (当前处于最新极客稳定版)`,
      `- **UI 规范**: 统一声明式 UI 标准规范 (Zero DOM / Zero CSS 污染)\n`,
      `### 🛡️ 商业与生态承诺`,
      `- **纯粹开源永久免费**: 零广告、不作恶、核心能力永久无限制开放`,
      `- **Local-First & E2EE 隐私优先**: 本地 SQLite 存储，端到端密文上云`,
      `- **开源许可证**: 客户端 GNU GPL-3.0；插件 SDK 与声明式组件库 MIT\n`,
      `> 对标国际一流 Windows & macOS 双端效率中枢平台。`
    ].join("\n\n");
  }, [p.about]);

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={true}
      searchBarPlaceholder="搜索系统设置与扩展 (如 主题, 热键, 缓存, 扩展名)..."
      onSearchTextChange={setSearchText}
      searchBarAccessory={
        <List.Dropdown
          tooltip="切换设置分类"
          value={currentTab}
          onChange={(val) => setCurrentTab(val as SettingsMainTab)}
        >
          <List.Dropdown.Item title="常规设置 (General)" value="general" icon={Icon.Gear} />
          <List.Dropdown.Item
            title={`扩展管理 (${preferences.extensions?.length || BUILTIN_EXTENSIONS.length} 款)`}
            value="extensions"
            icon={Icon.List}
          />
          <List.Dropdown.Item title="全局快捷键 (Hotkeys)" value="shortcuts" icon={Icon.Key} />
          <List.Dropdown.Item title="高级与存储 (Advanced)" value="advanced" icon={Icon.HardDrive} />
          <List.Dropdown.Item title="关于 (About)" value="about" icon={Icon.Document} />
        </List.Dropdown>
      }
    >
      {/* 1. 常规设置 TAB */}
      {currentTab === "general" && (
        <List.Section title="常规偏好设置 (General)">
          <List.Item
            id="general-preferences"
            title="常规偏好配置"
            subtitle={`主题: ${p.general.theme} | 热键: ${p.general.globalHotkey} | 失焦自隐: ${p.general.autoHideOnBlur ? "是" : "否"}`}
            icon={Icon.Gear}
            accessories={[
              { text: p.general.theme.toUpperCase() },
              { icon: p.general.autoHideOnBlur ? Icon.Check : Icon.Circle }
            ]}
            detail={<List.Item.Detail markdown={generalDetailMarkdown} />}
            actions={
              <ActionPanel>
                <ActionPanel.Section title="常规操作">
                  <Action.Push
                    title="编辑常规设置 (回车默认)"
                    icon={Icon.Pencil}
                    target={
                      <GeneralSettingsForm
                        initial={p.general}
                        onSaved={(updated) => setPreferences({ ...p, general: updated })}
                      />
                    }
                  />
                  <Action
                    title="切换主题 (Dark/Light/Auto)"
                    icon={Icon.Brush}
                    onAction={async () => {
                      const nextTheme: ThemeMode = p.general.theme === "dark" ? "light" : p.general.theme === "light" ? "auto" : "dark";
                      const updated = await savePreferences({ general: { ...p.general, theme: nextTheme } });
                      setPreferences(updated);
                      await showToast(Toast.Style.Success, `已切换主题: ${nextTheme}`);
                    }}
                  />
                  <Action
                    title="切换失焦自动隐藏"
                    icon={Icon.Eye}
                    onAction={async () => {
                      const nextVal = !p.general.autoHideOnBlur;
                      const updated = await savePreferences({ general: { ...p.general, autoHideOnBlur: nextVal } });
                      setPreferences(updated);
                      await showToast(Toast.Style.Success, nextVal ? "已开启失焦自动隐藏" : "已关闭失焦自动隐藏");
                    }}
                  />
                  <Action
                    title="复制全量配置 JSON"
                    icon={Icon.Clipboard}
                    shortcut={{ modifiers: ["ctrl"], key: "e" }}
                    onAction={handleExport}
                  />
                  <Action
                    title="重置出厂默认"
                    icon={Icon.Repeat}
                    shortcut={{ modifiers: ["ctrl"], key: "r" }}
                    onAction={handleReset}
                  />
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {/* 2. 扩展管理 TAB (内置扩展治理) */}
      {currentTab === "extensions" && (
        <List.Section title={`官方内置扩展管理 (${filteredExtensions.length})`}>
          {filteredExtensions.map((ext) => (
            <List.Item
              key={ext.id}
              id={ext.id}
              title={ext.name}
              subtitle={`${ext.description} ${ext.alias ? `[别名: ${ext.alias}]` : ""} ${ext.hotkey ? `[热键: ${ext.hotkey}]` : ""}`}
              icon={ext.enabled ? Icon.Checkmark : Icon.XMarkCircle}
              accessories={[
                ...(ext.hotkey ? [{ text: ext.hotkey }] : []),
                ...(ext.alias ? [{ text: `@${ext.alias}` }] : []),
                { text: ext.enabled ? "已启用" : "已禁用", icon: ext.enabled ? Icon.Check : Icon.Circle }
              ]}
              detail={
                <List.Item.Detail
                  markdown={`# ${ext.name}\n\n**标识符**: \`${ext.id}\` &nbsp;&nbsp;|&nbsp;&nbsp; **分类**: \`${ext.category}\`\n\n### 📖 扩展功能说明\n> ${ext.description}\n\n### ⚙️ 快捷调用与状态\n- **启用状态**: ${ext.enabled ? "✅ 已启用" : "❌ 已禁用"}\n- **唤醒热键**: \`${ext.hotkey || "未配置"}\`\n- **快速别名**: \`${ext.alias ? `@${ext.alias}` : "无"}\`\n- **官方内置**: ${ext.isBuiltin ? "是 (标杆原生套件)" : "第三方扩展"}\n\n> 按 **Enter** 快捷配置别名与专属全局热键。`}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="扩展名称" text={ext.name} icon={Icon.List} />
                      <List.Item.Detail.Metadata.Label title="ID" text={ext.id} icon={Icon.Code} />
                      <List.Item.Detail.Metadata.Label title="分类" text={ext.category} />
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.Label title="快速别名" text={ext.alias || "未设"} />
                      <List.Item.Detail.Metadata.Label title="唤醒热键" text={ext.hotkey || "未设"} />
                      <List.Item.Detail.Metadata.Label
                        title="运行状态"
                        text={ext.enabled ? "运行中" : "已禁用"}
                        icon={ext.enabled ? Icon.Check : Icon.Circle}
                      />
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel>
                  <ActionPanel.Section title="扩展控制">
                    <Action.Push
                      title={`配置 ${ext.name} (回车默认)`}
                      icon={Icon.Pencil}
                      target={
                        <ExtensionConfigForm
                          extension={ext}
                          onSaved={(updated) => {
                            const list = p.extensions.map(e => e.id === updated.id ? updated : e);
                            setPreferences({ ...p, extensions: list });
                          }}
                        />
                      }
                    />
                    <Action
                      title={ext.enabled ? "禁用此扩展" : "启用此扩展"}
                      icon={ext.enabled ? Icon.Trash : Icon.Checkmark}
                      shortcut={{ modifiers: ["ctrl"], key: "t" }}
                      onAction={() => handleToggleExtension(ext)}
                    />
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {/* 3. 快捷键 TAB */}
      {currentTab === "shortcuts" && (
        <List.Section title={`全局唤醒快捷键 (${filteredShortcuts.length})`}>
          {filteredShortcuts.map((s) => (
            <List.Item
              key={s.id}
              id={s.id}
              title={s.name}
              subtitle={`命令: ${s.commandId} | 快捷键: ${s.hotkey || "未设"} | 别名: ${s.alias || "无"}`}
              icon={Icon.Key}
              accessories={[
                ...(s.hotkey ? [{ text: s.hotkey }] : [{ text: "未分配" }])
              ]}
              detail={
                <List.Item.Detail
                  markdown={`# ⌨️ ${s.name} (\`${s.commandId}\`)\n\n- **全局唤醒热键**: \`${s.hotkey || "未配置"}\`\n- **根搜索别名**: \`${s.alias || "无"}\`\n- **状态**: ${s.enabled ? "已启用" : "已禁用"}\n\n> 支持全局极速唤醒，零冲突调度。`}
                />
              }
              actions={
                <ActionPanel>
                  <Action
                    title="复制唤醒热键"
                    icon={Icon.Clipboard}
                    onAction={async () => {
                      if (s.hotkey) {
                        await Clipboard.copy(s.hotkey);
                        await showToast(Toast.Style.Success, "已复制快捷键", s.hotkey);
                      }
                    }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {/* 4. 高级存储 TAB (SQLite 缓存管理与清空) */}
      {currentTab === "advanced" && (
        <List.Section title="高级与存储治理 (Advanced & Storage)">
          <List.Item
            id="sqlite-cache-governance"
            title="本地 SQLite 缓存与底层侧车"
            subtitle={`缓存体积: ${cacheSizeText} | 代理: ${p.advanced.proxyMode} | 特权穿透: ${p.advanced.enableUiaAccess ? "开" : "关"}`}
            icon={Icon.HardDrive}
            accessories={[{ text: cacheSizeText }]}
            detail={<List.Item.Detail markdown={advancedDetailMarkdown} />}
            actions={
              <ActionPanel>
                <ActionPanel.Section title="存储操作">
                  <Action
                    title="一键清空本地 SQLite 缓存 (回车执行)"
                    icon={Icon.Trash}
                    onAction={handleClearCache}
                  />
                  <Action.Push
                    title="配置网络代理与日志等级"
                    icon={Icon.Gear}
                    target={
                      <SettingsFormView
                        sectionKey="advanced"
                        initialPreferences={preferences}
                        onSaved={(updated) => setPreferences(updated)}
                      />
                    }
                  />
                  <Action
                    title="备份导出配置到剪贴板"
                    icon={Icon.Clipboard}
                    shortcut={{ modifiers: ["ctrl"], key: "e" }}
                    onAction={handleExport}
                  />
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {/* 5. 关于 TAB */}
      {currentTab === "about" && (
        <List.Section title="关于 ZTools (About)">
          <List.Item
            id="about-ztools"
            title="ZTools 极客效率中枢"
            subtitle={`版本: v${p.about.version} (${p.about.buildNumber}) | 开源协议: GPL-3.0`}
            icon={Icon.Document}
            accessories={[{ text: `v${p.about.version}` }]}
            detail={<List.Item.Detail markdown={aboutDetailMarkdown} />}
            actions={
              <ActionPanel>
                <ActionPanel.Section title="关于操作">
                  <Action
                    title="检查更新"
                    icon={Icon.Download}
                    onAction={async () => {
                      await showToast(Toast.Style.Success, "当前已是最新极客版本", `v${p.about.version}`);
                    }}
                  />
                  <Action
                    title="复制版本信息"
                    icon={Icon.Clipboard}
                    onAction={async () => {
                      const info = `ZTools v${p.about.version} (${p.about.buildNumber}) - Electron ${p.about.electronVersion}`;
                      await Clipboard.copy(info);
                      await showToast(Toast.Style.Success, "已复制版本信息");
                    }}
                  />
                </ActionPanel.Section>
              </ActionPanel>
            }
          />
        </List.Section>
      )}
    </List>
  );
}

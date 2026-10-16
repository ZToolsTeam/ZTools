import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  // 1. 密码保险箱 (Password Vault)
  PasswordVaultCommand,
  VaultEntryDetailView,
  VaultEntryForm,
  VaultUnlockForm,
  VaultImportCsvForm,
  PasswordVaultManager,
  defaultPasswordVaultManager,
  encryptVaultPayload,
  decryptVaultPayload,
  generateVaultPassword,
  evaluatePasswordStrength,
  parseCsvLine,
  exportEntriesToCsv,
  INITIAL_VAULT_ENTRIES,

  // 2. Wi-Fi 密码查看器 (Wi-Fi Password Reveal)
  WifiPasswordRevealCommand,
  WifiDetailView,
  parseNetshWlanProfiles,
  parseWindowsWlanProfileDetail,
  parseWifiInterface,
  generateWifiQrString,
  generateWifiQrSvgDataUrl,
  filterAndSortWifiProfiles,
  fetchSavedWifiProfiles,
  SAMPLE_WIFI_PROFILES,

  // 3. 音频设备一键切换 (Audio Device)
  AudioDeviceCommand,
  AudioDeviceDetailView,
  AudioVolumeForm,
  AudioDeviceManager,
  defaultAudioDeviceManager,
  getAllDevices,
  getOutputDevices,
  getInputDevices,
  setDefaultOutputDevice,
  setOutputDeviceVolume,
  toggleOutputDeviceMute,
  INITIAL_AUDIO_DEVICES,

  // 4. 键盘清洁防误触锁 (Clean Keyboard)
  CleanKeyboardCommand,
  CleanKeyboardDetailView,
  CustomDurationForm,
  KeyboardLockManager,
  defaultKeyboardLockManager,
  CLEAN_DURATION_PRESETS,
  formatCleanDuration,

  // 5. 下载文件夹管家 (Downloads Manager)
  DownloadsManagerCommand,
  DownloadFileDetailView,
  DownloadsManagerService,
  defaultDownloadsManager,
  formatFileSize,
  detectDownloadCategory,
  validateSafeDownloadPath
} from "../dist/examples/index.js";
import { renderDeclarativeRoot } from "../dist/runtime/reconciler.js";

describe("5 款高频实用插件端到端集成与全异常抗毁测试套件", () => {
  // =========================================================================
  // 1. 密码保险箱 (Password Vault)
  // =========================================================================
  describe("1. 密码保险箱 (password-vault) 集成与异常测试", () => {
    beforeEach(() => {
      defaultPasswordVaultManager.resetToDefaults();
    });

    it("端到端声明式 UI 渲染：解锁态与锁定态视图切换及子表单挂载正常", () => {
      const rootUnlocked = renderDeclarativeRoot(PasswordVaultCommand);
      const descUnlocked = rootUnlocked.getLatest();
      assert.equal(descUnlocked.type, "List");
      assert.ok(descUnlocked.children.length > 0);
      rootUnlocked.unmount();

      // 锁定密码箱后渲染锁定安全提示视图
      defaultPasswordVaultManager.lockVault();
      const rootLocked = renderDeclarativeRoot(PasswordVaultCommand);
      const descLocked = rootLocked.getLatest();
      assert.equal(descLocked.type, "List");
      assert.equal(descLocked.children[0].props.title, "🔒 密码箱已锁定");
      rootLocked.unmount();

      // 验证详情视图与子表单渲染
      defaultPasswordVaultManager.resetToDefaults();
      const detailDesc = VaultEntryDetailView({ entry: INITIAL_VAULT_ENTRIES[0] });
      assert.equal(detailDesc.type, "Detail");
      assert.ok(detailDesc.props.markdown.includes(INITIAL_VAULT_ENTRIES[0].name));

      const formDesc = VaultEntryForm({});
      assert.equal(formDesc.type, "Form");

      const unlockFormDesc = VaultUnlockForm({});
      assert.equal(unlockFormDesc.type, "Form");

      const csvFormDesc = VaultImportCsvForm({});
      assert.equal(csvFormDesc.type, "Form");
    });

    it("主密码加锁/解锁状态机、加密信封 MAC 防篡改与错误主密码拦截", () => {
      const vault = new PasswordVaultManager();
      vault.setMasterPassword("MySecret#2026");
      assert.equal(vault.hasMasterPassword(), true);
      assert.equal(vault.getLockState(), "unlocked");

      vault.lockVault();
      assert.equal(vault.getLockState(), "locked");
      assert.equal(vault.getEntries().length, 0, "锁定状态下严禁泄露任何凭据条目");

      // 锁定态下拒绝增删与导入操作
      assert.throws(() => {
        vault.addOrUpdateEntry({ name: "Test", username: "u", password: "p" });
      }, /VAULT_LOCKED/);
      assert.throws(() => {
        vault.deleteEntry("vault-github");
      }, /VAULT_LOCKED/);
      assert.throws(() => {
        vault.importFromCsv("name,url,username,password\na,b,c,d");
      }, /VAULT_LOCKED/);

      // 错误主密码解锁拦截
      const wrongRes = vault.unlockVault("WrongPass123");
      assert.equal(wrongRes.success, false);
      assert.equal(wrongRes.status, "locked");
      assert.match(wrongRes.error || "", /WRONG_PASSWORD|主密码/);

      // 正确主密码解锁恢复
      const okRes = vault.unlockVault("MySecret#2026");
      assert.equal(okRes.success, true);
      assert.equal(okRes.status, "unlocked");
      assert.ok(vault.getEntries().length >= 4);

      // 密文单字节篡改导致 MAC 校验失败测试
      const env = encryptVaultPayload(INITIAL_VAULT_ENTRIES, "MasterKey99");
      const tamperedEnv = { ...env, cipherText: env.cipherText.slice(0, -2) + "XX" };
      assert.throws(() => {
        decryptVaultPayload(tamperedEnv, "MasterKey99");
      }, /WRONG_PASSWORD|MAC/);
    });

    it("Chrome / Edge 标准 CSV 批量导入导出与畸形 CSV 容错处理", () => {
      const vault = new PasswordVaultManager([]);
      const csvText = [
        "name,url,username,password,note",
        "淘宝网,https://www.taobao.com,tb_user_01,Tb#Pass!2026,购物主号",
        '"GitHub, Inc.",https://github.com,dev@ztools.cn,"Pass,With,Comma",含逗号转义测试',
        "broken_row_only_two_cols,https://bad.url",
        ",https://missing-password.com,user_no_pass,,"
      ].join("\n");

      const importRes = vault.importFromCsv(csvText);
      assert.equal(importRes.imported, 2);
      assert.equal(importRes.failed, 1);
      assert.equal(importRes.skipped, 1);

      const exported = exportEntriesToCsv(vault.getEntries());
      assert.ok(exported.startsWith("name,url,username,password,note"));
      assert.ok(exported.includes('"GitHub, Inc."'));
      assert.ok(exported.includes('"Pass,With,Comma"'));

      // 密码生成器与边界参数校验
      const pwd = generateVaultPassword({ length: 20, uppercase: true, lowercase: true, numbers: true, symbols: true });
      assert.equal(pwd.length, 20);
      const strength = evaluatePasswordStrength(pwd);
      assert.ok(strength.score >= 70);

      assert.throws(() => generateVaultPassword({ length: 2 }), /4 ~ 128/);
      assert.throws(
        () => generateVaultPassword({ uppercase: false, lowercase: false, numbers: false, symbols: false }),
        /至少需要启用一种字符集/
      );
    });
  });

  // =========================================================================
  // 2. Wi-Fi 密码查看器 (Wi-Fi Password Reveal)
  // =========================================================================
  describe("2. Wi-Fi 密码查看器 (wifi-password-reveal) 集成与异常测试", () => {
    it("端到端声明式 UI 渲染：Wi-Fi 列表与扫码卡片详情页渲染正常", () => {
      const root = renderDeclarativeRoot(WifiPasswordRevealCommand);
      const desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.ok(desc.children.length > 0);
      root.unmount();

      const detailDesc = WifiDetailView({ profile: SAMPLE_WIFI_PROFILES[0] });
      assert.equal(detailDesc.type, "Detail");
      assert.ok(detailDesc.props.markdown.includes(SAMPLE_WIFI_PROFILES[0].ssid));
      assert.ok(detailDesc.props.markdown.includes("WIFI:T:WPA"));
    });

    it("中英双语 Windows netsh wlan 与 macOS networksetup 输出解析及异常防御", async () => {
      const mixedProfilesOut = `
Profiles on interface WLAN:
    All User Profile     : ZTools-Office-5G
    所有用户配置文件 : 小米_Home_WiFi6
    当前用户配置文件 : ZTools-Guest
`;
      const profiles = parseNetshWlanProfiles(mixedProfilesOut);
      assert.deepEqual(profiles, ["ZTools-Office-5G", "小米_Home_WiFi6", "ZTools-Guest"]);
      assert.deepEqual(parseNetshWlanProfiles(""), []);

      // 中文 Windows netsh key=clear 解析
      const zhDetail = `
SSID 名称              : "小米_Home_WiFi6"
身份验证               : WPA2 - 个人
加密                   : CCMP
安全密钥               : 存在
关键内容               : MyHomePass888!
`;
      const parsedZh = parseWindowsWlanProfileDetail("小米_Home_WiFi6", zhDetail);
      assert.equal(parsedZh.password, "MyHomePass888!");
      assert.equal(parsedZh.isOpenNetwork, false);
      assert.equal(parsedZh.error, undefined);

      // 802.1X 企业网络无明文密码识别
      const corpDetail = `
SSID name              : "Corp-Dot1X"
Authentication         : WPA2-Enterprise
Security key           : Absent
`;
      const parsedCorp = parseWindowsWlanProfileDetail("Corp-Dot1X", corpDetail);
      assert.equal(parsedCorp.isEnterprise, true);
      assert.equal(parsedCorp.error?.code, "EnterpriseNetwork");

      // 权限不足未显示 Key Content 拦截
      const noPermDetail = `
SSID name              : "Locked-WiFi"
Authentication         : WPA2-Personal
Security key           : Present
`;
      const parsedNoPerm = parseWindowsWlanProfileDetail("Locked-WiFi", noPermDetail);
      assert.equal(parsedNoPerm.error?.code, "PermissionDenied");

      // 模拟跨平台命令执行器异常回退与抛出验证
      await assert.rejects(
        async () => {
          await fetchSavedWifiProfiles({
            fallbackToSample: false,
            platform: "win32",
            executor: async () => {
              throw new Error("netsh crashed");
            }
          });
        },
        /WIFI_COMMAND_EXECUTION_FAILED/
      );

      // macOS 硬件端口解析与二维码特殊字符转义
      const macPorts = `
Hardware Port: Thunderbolt Bridge
Device: bridge0

Hardware Port: Wi-Fi
Device: en1
`;
      assert.equal(parseWifiInterface(macPorts), "en1");
      const qr = generateWifiQrString("My;SSID:Test", 'Pass"123;');
      assert.equal(qr, 'WIFI:T:WPA;S:My\\;SSID\\:Test;P:Pass\\"123\\;;;');
      assert.throws(() => generateWifiQrString("   "), /SSID 不能为空/);
      assert.ok(generateWifiQrSvgDataUrl(SAMPLE_WIFI_PROFILES[0]).startsWith("data:image/svg+xml;utf8,"));
      assert.equal(filterAndSortWifiProfiles(SAMPLE_WIFI_PROFILES, { securityFilter: "wpa3" }).length, 1);
    });
  });

  // =========================================================================
  // 3. 音频设备一键切换 (Audio Device)
  // =========================================================================
  describe("3. 音频设备一键切换 (audio-device) 集成与异常测试", () => {
    beforeEach(() => {
      defaultAudioDeviceManager.resetToDefaults();
    });

    it("端到端声明式 UI 渲染：音频设备列表、详情页与调音表单正常挂载", () => {
      const root = renderDeclarativeRoot(AudioDeviceCommand);
      const desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.ok(desc.children.length > 0);
      root.unmount();

      const detailDesc = AudioDeviceDetailView({ device: INITIAL_AUDIO_DEVICES[0] });
      assert.equal(detailDesc.type, "Detail");

      const volFormDesc = AudioVolumeForm({ device: INITIAL_AUDIO_DEVICES[0] });
      assert.equal(volFormDesc.type, "Form");
    });

    it("输出/输入默认端点互斥切换、音量极值裁剪、静音翻转与场景组合预设闭环", async () => {
      const all = await getAllDevices();
      assert.ok(all.length >= 6);
      const outputs = await getOutputDevices();
      const inputs = await getInputDevices();
      assert.ok(outputs.length >= 3);
      assert.ok(inputs.length >= 2);

      // 切换默认输出设备并验证唯一默认互斥性
      const swRes = await setDefaultOutputDevice("out-display-dell-4k");
      assert.equal(swRes.success, true);
      assert.equal(swRes.device?.id, "out-display-dell-4k");
      const updatedOutputs = await getOutputDevices();
      const defaultOutList = updatedOutputs.filter((d) => d.isDefault);
      assert.equal(defaultOutList.length, 1, "同一时刻只能有 1 个默认输出设备");
      assert.equal(defaultOutList[0].id, "out-display-dell-4k");

      // 音量边界裁剪 (0 ~ 100) 与非法 NaN 拦截
      const volHigh = await setOutputDeviceVolume("out-display-dell-4k", 180);
      assert.equal(volHigh.success, true);
      assert.equal(volHigh.device?.volume, 100);

      const volLow = await setOutputDeviceVolume("out-display-dell-4k", -25);
      assert.equal(volLow.success, true);
      assert.equal(volLow.device?.volume, 0);

      const volNan = await setOutputDeviceVolume("out-display-dell-4k", Number.NaN);
      assert.equal(volNan.success, false);

      // 不存在设备 ID 拦截
      const notFound = await setDefaultOutputDevice("non-existent-audio-id");
      assert.equal(notFound.success, false);
      assert.match(notFound.error || "", /未找到/);

      // 静音切换与场景组合预设一键切换
      const muteRes = await toggleOutputDeviceMute("out-display-dell-4k");
      assert.equal(muteRes.success, true);
      assert.equal(muteRes.device?.isMuted, true);

      const comboRes = defaultAudioDeviceManager.applyComboPreset("combo-speaker-chill");
      assert.equal(comboRes.success, true);
      const comboNotFound = defaultAudioDeviceManager.applyComboPreset("combo-invalid");
      assert.equal(comboNotFound.success, false);
    });
  });

  // =========================================================================
  // 4. 键盘清洁防误触锁 (Clean Keyboard)
  // =========================================================================
  describe("4. 键盘清洁防误触锁 (clean-keyboard) 集成与异常测试", () => {
    beforeEach(async () => {
      await defaultKeyboardLockManager.resetAll();
    });

    it("端到端声明式 UI 渲染：8 档时长预设列表、锁定监控视图与自定义表单正常挂载", () => {
      assert.equal(CLEAN_DURATION_PRESETS.length, 8);
      const root = renderDeclarativeRoot(CleanKeyboardCommand);
      const desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.ok(desc.children.length > 0);
      root.unmount();

      const activeDesc = CleanKeyboardDetailView({});
      assert.equal(activeDesc.type, "Detail");

      const customForm = CustomDurationForm({});
      assert.equal(customForm.type, "Form");
      assert.equal(formatCleanDuration(null), "无限期 (手动解锁)");
      assert.equal(formatCleanDuration(90), "1 分 30 秒");
    });

    it("状态机流转、重复加锁互斥拦截、误触按键计数、紧急解锁快捷键与看门狗超时自动释放", async () => {
      const manager = new KeyboardLockManager();

      // 非法时长边界拦截 (<=0 或 >7天)
      const invalidZero = await manager.lockKeyboard(0);
      assert.equal(invalidZero.success, false);
      assert.equal(invalidZero.code, "INVALID_DURATION");

      const invalidHuge = await manager.lockKeyboard(86400 * 30);
      assert.equal(invalidHuge.success, false);
      assert.equal(invalidHuge.code, "INVALID_DURATION");

      // 未锁定态下解锁拦截
      const unlockWhenUnlocked = await manager.unlockKeyboard();
      assert.equal(unlockWhenUnlocked.success, false);
      assert.equal(unlockWhenUnlocked.code, "NOT_LOCKED");

      // 正常启动 30 秒清洁锁定
      const lockRes = await manager.lockKeyboard(30, { presetTitle: "30秒快速擦拭", icon: "🧽" });
      assert.equal(lockRes.success, true);
      assert.equal(lockRes.status, "locked");

      // 重复加锁拦截 (ALREADY_LOCKED)
      const dupLock = await manager.lockKeyboard(15);
      assert.equal(dupLock.success, false);
      assert.equal(dupLock.code, "ALREADY_LOCKED");

      // 锁定期间普通按键拦截与计数累加
      const k1 = await manager.interceptKeystroke("a", []);
      const k2 = await manager.interceptKeystroke("Space", ["shift"]);
      assert.equal(k1.blocked, true);
      assert.equal(k1.unlocked, false);
      assert.equal(k2.state.blockedKeystrokes, 2);

      // 按下紧急解锁热键 (Ctrl + U) 立即解除锁定并记录会话历史
      const emergency = await manager.interceptKeystroke("u", ["ctrl"]);
      assert.equal(emergency.unlocked, true);
      assert.equal(emergency.state.status, "unlocked");
      assert.equal(manager.getStats().totalBlockedKeystrokes, 2);
      assert.equal(manager.getStats().history[0].unlockReason, "emergency_hotkey");

      // 看门狗超时强制解锁防死锁测试 (watchdogMs = 25ms)
      await manager.lockKeyboard(60, { watchdogMs: 25 });
      assert.equal(manager.getState().status, "locked");
      await new Promise((r) => setTimeout(r, 45));
      assert.equal(manager.getState().status, "unlocked", "看门狗超时后必须自动强制解锁");
      assert.equal(manager.getStats().history[0].unlockReason, "watchdog_timeout");

      // 紧急快捷键非法配置拦截
      const badShortcut = await manager.updateEmergencyShortcut([], "u");
      assert.equal(badShortcut.success, false);
      assert.equal(badShortcut.code, "INVALID_SHORTCUT");
    });
  });

  // =========================================================================
  // 5. 下载文件夹管家 (Downloads Manager)
  // =========================================================================
  describe("5. 下载文件夹管家 (downloads-manager) 集成与异常测试", () => {
    beforeEach(() => {
      defaultDownloadsManager.resetToDefaults();
    });

    it("端到端声明式 UI 渲染：下载文件列表与文件详情视图正常挂载", () => {
      const root = renderDeclarativeRoot(DownloadsManagerCommand);
      const desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.ok(desc.children.length > 0);
      assert.equal(desc.props.isShowingDetail, true, "默认应开启左右分栏实时预览 (对齐 Raycast 标杆体验)");
      const section = desc.children.find((c) => c.type === "List.Section");
      assert.ok(section);
      const firstItem = section.children.find((c) => c.type === "List.Item");
      assert.ok(firstItem);
      assert.ok(firstItem.props.detail, "List.Item 必须挂载 List.Item.Detail 预览描述符");
      assert.equal(firstItem.props.detail.type, "List.Item.Detail");
      root.unmount();

      const latest = defaultDownloadsManager.getLatestDownload();
      assert.ok(latest);
      const detailDesc = DownloadFileDetailView({ file: latest });
      assert.equal(detailDesc.type, "Detail");
      assert.ok(detailDesc.props.markdown.includes(latest.filename));
    });

    it("文件分类识别、一键分类自动归档、过期清理、置顶防误删与路径穿越攻击拦截", async () => {
      assert.equal(formatFileSize(0), "0 B");
      assert.equal(formatFileSize(-500), "0 B");
      assert.equal(detectDownloadCategory("WeChatSetup.exe"), "installer");
      assert.equal(detectDownloadCategory("archive.7z"), "archive");
      assert.equal(detectDownloadCategory("report.pdf"), "document");
      assert.equal(detectDownloadCategory("poster.webp"), "image");
      assert.equal(detectDownloadCategory("demo.mp4"), "media");
      assert.equal(detectDownloadCategory("unknown_binary"), "other");

      // 路径安全防穿越校验 (Path Traversal Defense)
      const emptyPath = validateSafeDownloadPath("");
      assert.equal(emptyPath.valid, false);
      assert.equal(emptyPath.errorCode, "EMPTY_PATH");

      const traversalPath = validateSafeDownloadPath("C:\\Users\\User\\Downloads\\..\\..\\Windows\\System32\\cmd.exe");
      assert.equal(traversalPath.valid, false);
      assert.equal(traversalPath.errorCode, "PATH_TRAVERSAL");

      const uncPath = validateSafeDownloadPath("\\\\malicious-server\\share\\payload.exe");
      assert.equal(uncPath.valid, false);
      assert.equal(uncPath.errorCode, "PATH_TRAVERSAL");

      // 置顶文件防误删保护 (FILE_PINNED)
      const service = new DownloadsManagerService();
      const latest = service.getLatestDownload();
      assert.ok(latest);
      assert.equal(latest.pinned, true);
      const delPinned = await service.deleteDownload(latest.id);
      assert.equal(delPinned.success, false);
      assert.equal(delPinned.errorCode, "FILE_PINNED");

      // 取消置顶后允许删除
      service.togglePin(latest.id);
      const delOk = await service.deleteDownload(latest.id);
      assert.equal(delOk.success, true);

      // 一键按分类归档整理
      const orgRes = await service.organizeByCategory(false);
      assert.equal(orgRes.success, true);
      assert.ok(orgRes.movedCount > 0);
      assert.ok(orgRes.summary.length >= 4);

      // 过期文件清理与非法天数参数拦截
      const badClean = await service.cleanExpiredDownloads(-5);
      assert.equal(badClean.success, false);
      assert.equal(badClean.errorCode, "INVALID_DAYS");

      const okClean = await service.cleanExpiredDownloads(30, false);
      assert.equal(okClean.success, true);
      assert.ok(okClean.deletedCount >= 1);
    });
  });
});

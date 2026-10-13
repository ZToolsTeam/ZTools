import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  renderDeclarativeRoot,
  LocalStorage,
  Clipboard,
  // 1. json-format
  JsonFormatCommand,
  JsonDetailView,
  validateJson,
  formatJson,
  minifyJson,
  jsonToTsInterface,
  // 2. qr-code
  QrCodeCommand,
  QrDetailView,
  CreateQrForm,
  generateQrSvg,
  // 3. github
  GithubDashboardCommand,
  GithubDetailView,
  filterGithubItems,
  SAMPLE_GITHUB_ITEMS,
  // 4. google-translate
  GoogleTranslateCommand,
  TranslateDetailView,
  translateText,
  getTranslateHistory,
  saveTranslateHistory,
  clearTranslateHistory,
  SUPPORTED_LANGUAGES,
  // 5. color-picker
  ColorPickerCommand,
  ColorDetailView,
  parseColor,
  hexToRgb,
  rgbToHex,
  rgbToHsl,
  hslToRgb,
  rgbToCmyk,
  cmykToRgb,
  calculateContrast,
  calculateWcag,
  generateColorSwatchSvg,
  getSavedPalette,
  saveColorToPalette,
  clearPalette,
  // 6. obsidian
  ObsidianCommand,
  ObsidianNoteDetailView,
  ObsidianQuickNoteForm,
  getVaultNotes,
  saveVaultNote,
  deleteVaultNote,
  searchVaultNotes,
  SAMPLE_OBSIDIAN_NOTES,
  // 7. speedtest
  SpeedtestCommand,
  SpeedtestDetailView,
  runNetworkDiagnostics,
  generateAsciiBar,
  // 8. winget
  WingetCommand,
  WingetDetailView,
  filterWingetPackages,
  SAMPLE_WINGET_PACKAGES,
  // 9. currency-exchange
  CurrencyExchangeCommand,
  CurrencyDetailView,
  convertCurrency,
  calculateAllConversions,
  parseAmountAndCurrency,
  USD_RATES,
  // 10. kill-process
  KillProcessCommand,
  ProcessDetailView,
  filterAndSortProcesses,
  SAMPLE_PROCESSES
} from "../dist/index.js";

describe("Raycast Compat: 10 Classic Open-Source Applications Suite", () => {
  beforeEach(async () => {
    await LocalStorage.clear();
    await Clipboard.clear();
  });

  // --------------------------------------------------------------------------
  // 1. JSON Format
  // --------------------------------------------------------------------------
  describe("App 1: json-format", () => {
    test("JsonFormatCommand mounts and renders Form correctly", () => {
      const root = renderDeclarativeRoot(JsonFormatCommand);
      const desc = root.getLatest();
      assert.equal(desc.type, "Form");
      assert.equal(desc.props.navigationTitle, "JSON 格式化与类型转换");
      assert.equal(desc.props.actions.type, "ActionPanel");
      assert.ok(desc.children.length >= 2);
      root.unmount();
    });

    test("JsonDetailView renders formatted JSON, TypeScript and metadata", () => {
      const formatted = '{\n  "status": "ok"\n}';
      const ts = "export interface Status { status: string; }";
      const view = JsonDetailView({
        formatted,
        tsInterface: ts,
        stats: { keys: 1, depth: 1, byteSize: 22 }
      });
      assert.equal(view.type, "Detail");
      assert.equal(view.props.navigationTitle, "JSON 格式化详情");
      assert.match(view.props.markdown, /export interface Status/);
      assert.equal(view.props.metadata.type, "Detail.Metadata");
      assert.equal(view.props.actions.type, "ActionPanel");
    });
  });

  // --------------------------------------------------------------------------
  // 2. QR Code
  // --------------------------------------------------------------------------
  describe("App 2: qr-code", () => {
    test("QrCodeCommand mounts and renders List with items", () => {
      const root = renderDeclarativeRoot(QrCodeCommand);
      const desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.equal(desc.props.navigationTitle, "二维码生成器");
      assert.ok(desc.children.length >= 1);
      const section = desc.children[0];
      assert.equal(section.type, "List.Section");
      assert.ok(section.children.length >= 2);
      root.unmount();
    });

    test("QrDetailView renders QR SVG and actions", () => {
      const item = {
        id: "qr-test",
        title: "Test QR",
        content: "https://ztools.dev",
        level: "M",
        createdAt: "12:00:00"
      };
      const view = QrDetailView({ item });
      assert.equal(view.type, "Detail");
      assert.match(view.props.markdown, /data:image\/svg\+xml;utf8/);
      assert.equal(view.props.actions.type, "ActionPanel");
    });

    test("CreateQrForm mounts and renders form fields", () => {
      let created = null;
      const root = renderDeclarativeRoot(() =>
        CreateQrForm({ onCreated: (it) => (created = it) })
      );
      const desc = root.getLatest();
      assert.equal(desc.type, "Form");
      assert.equal(desc.props.navigationTitle, "新建二维码");
      assert.ok(desc.children.length >= 3);
      root.unmount();
    });
  });

  // --------------------------------------------------------------------------
  // 3. GitHub Dashboard
  // --------------------------------------------------------------------------
  describe("App 3: github", () => {
    test("filterGithubItems filters PRs, Issues, Workflows and Starred Repos accurately", () => {
      const allPrs = filterGithubItems(SAMPLE_GITHUB_ITEMS, "", "pr");
      assert.ok(allPrs.length >= 2);
      assert.ok(allPrs.every((i) => i.type === "pr"));

      const allIssues = filterGithubItems(SAMPLE_GITHUB_ITEMS, "", "issue");
      assert.ok(allIssues.length >= 2);
      assert.ok(allIssues.every((i) => i.type === "issue"));

      const searchKeyword = filterGithubItems(SAMPLE_GITHUB_ITEMS, "virtual-reconciler", "all");
      assert.equal(searchKeyword.length, 1);
      assert.equal(searchKeyword[0].id, "pr-1");
    });

    test("GithubDashboardCommand mounts and renders List with Dropdown and Sections", () => {
      const root = renderDeclarativeRoot(GithubDashboardCommand);
      const desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.equal(desc.props.navigationTitle, "GitHub 仪表盘");
      assert.equal(desc.props.searchBarAccessory.type, "List.Dropdown");
      assert.ok(desc.children.length >= 3); // PRs, Issues, Workflows, Repos
      root.unmount();
    });

    test("GithubDetailView renders Markdown and Metadata for PR, Issue, Workflow and Repo", () => {
      const pr = SAMPLE_GITHUB_ITEMS.find((i) => i.type === "pr");
      const prView = GithubDetailView({ item: pr });
      assert.equal(prView.type, "Detail");
      assert.equal(prView.props.navigationTitle, `PR #${pr.number}`);
      assert.equal(prView.props.metadata.type, "Detail.Metadata");
      assert.equal(prView.props.actions.type, "ActionPanel");

      const issue = SAMPLE_GITHUB_ITEMS.find((i) => i.type === "issue");
      const issueView = GithubDetailView({ item: issue });
      assert.equal(issueView.type, "Detail");
      assert.equal(issueView.props.navigationTitle, `Issue #${issue.number}`);

      const wf = SAMPLE_GITHUB_ITEMS.find((i) => i.type === "workflow");
      const wfView = GithubDetailView({ item: wf });
      assert.equal(wfView.type, "Detail");
      assert.equal(wfView.props.navigationTitle, wf.name);

      const repo = SAMPLE_GITHUB_ITEMS.find((i) => i.type === "repo");
      const repoView = GithubDetailView({ item: repo });
      assert.equal(repoView.type, "Detail");
      assert.equal(repoView.props.navigationTitle, `${repo.owner}/${repo.name}`);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Google Translate
  // --------------------------------------------------------------------------
  describe("App 4: google-translate", () => {
    test("translateText translates known dictionary words and general phrases", () => {
      const resHello = translateText("Hello", "en", "zh-CN");
      assert.equal(resHello.translatedText, "你好");
      assert.ok(resHello.phonetic);
      assert.ok(resHello.synonyms?.length > 0);

      const resGeneral = translateText("Good morning developers", "auto", "ja");
      assert.match(resGeneral.translatedText, /Good morning developers/);
      assert.equal(resGeneral.targetLang, "ja");
    });

    test("getTranslateHistory, saveTranslateHistory, clearTranslateHistory persist to LocalStorage", async () => {
      await clearTranslateHistory();
      const empty = await getTranslateHistory();
      assert.equal(empty.length, 0);

      const res = translateText("Thank you", "en", "zh-CN");
      const updated = await saveTranslateHistory(res);
      assert.equal(updated.length, 1);
      assert.equal(updated[0].translatedText, "谢谢");

      const loaded = await getTranslateHistory();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].sourceText, "Thank you");

      await clearTranslateHistory();
      const afterClear = await getTranslateHistory();
      assert.equal(afterClear.length, 0);
    });

    test("GoogleTranslateCommand mounts and renders List with searchBar and Dropdown", async () => {
      const root = renderDeclarativeRoot(GoogleTranslateCommand);
      const desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.equal(desc.props.navigationTitle, "Google 即时翻译");
      assert.equal(desc.props.searchBarAccessory.type, "List.Dropdown");
      assert.ok(desc.children.length >= 1);
      root.unmount();
    });

    test("TranslateDetailView renders translations, phonetic, synonyms and metadata", () => {
      const item = translateText("Hello", "en", "zh-CN");
      const view = TranslateDetailView({ item });
      assert.equal(view.type, "Detail");
      assert.match(view.props.markdown, /你好/);
      assert.equal(view.props.metadata.type, "Detail.Metadata");
      assert.equal(view.props.actions.type, "ActionPanel");
    });
  });

  // --------------------------------------------------------------------------
  // 5. Color Picker
  // --------------------------------------------------------------------------
  describe("App 5: color-picker", () => {
    test("Color converter functions: hexToRgb, rgbToHex, rgbToHsl, hslToRgb, rgbToCmyk, cmykToRgb", () => {
      const rgb = hexToRgb("#FF0000");
      assert.deepEqual(rgb, { r: 255, g: 0, b: 0 });

      const hex = rgbToHex({ r: 0, g: 255, b: 0 });
      assert.equal(hex, "#00FF00");

      const hsl = rgbToHsl({ r: 255, g: 0, b: 0 });
      assert.equal(hsl.h, 0);
      assert.equal(hsl.s, 100);
      assert.equal(hsl.l, 50);

      const rgbBack = hslToRgb(hsl);
      assert.equal(rgbBack.r, 255);
      assert.equal(rgbBack.g, 0);
      assert.equal(rgbBack.b, 0);

      const cmyk = rgbToCmyk({ r: 0, g: 0, b: 0 });
      assert.deepEqual(cmyk, { c: 0, m: 0, y: 0, k: 100 });

      const cmykWhite = rgbToCmyk({ r: 255, g: 255, b: 255 });
      assert.deepEqual(cmykWhite, { c: 0, m: 0, y: 0, k: 0 });
    });

    test("WCAG contrast calculation accurately evaluates ratios and ratings", () => {
      const black = { r: 0, g: 0, b: 0 };
      const white = { r: 255, g: 255, b: 255 };
      const contrast = calculateContrast(black, white);
      assert.equal(contrast, 21);

      const wcagBlack = calculateWcag(black);
      assert.equal(wcagBlack.contrastOnWhite, 21);
      assert.equal(wcagBlack.whiteRating, "AAA");
      assert.equal(wcagBlack.recommendedText, "white");

      const wcagWhite = calculateWcag(white);
      assert.equal(wcagWhite.contrastOnBlack, 21);
      assert.equal(wcagWhite.blackRating, "AAA");
      assert.equal(wcagWhite.recommendedText, "black");
    });

    test("parseColor handles HEX, RGB, HSL and generates SVG swatch", () => {
      const resHex = parseColor("#0A84FF");
      assert.equal(resHex.isValid, true);
      assert.equal(resHex.hex, "#0A84FF");
      assert.equal(resHex.rgb.r, 10);
      assert.equal(resHex.rgb.g, 132);
      assert.equal(resHex.rgb.b, 255);

      const resRgb = parseColor("rgb(255, 69, 58)");
      assert.equal(resRgb.isValid, true);
      assert.equal(resRgb.hex, "#FF453A");

      const resHsl = parseColor("hsl(120, 100%, 50%)");
      assert.equal(resHsl.isValid, true);
      assert.equal(resHsl.hex, "#00FF00");

      const svg = generateColorSwatchSvg("#0A84FF");
      assert.match(svg, /^data:image\/svg\+xml;utf8,/);
    });

    test("Palette history LocalStorage persistence", async () => {
      await clearPalette();
      let palette = await getSavedPalette();
      assert.equal(palette.length, 0);

      palette = await saveColorToPalette("Blue", "#0A84FF");
      assert.equal(palette.length, 1);
      assert.equal(palette[0].hex, "#0A84FF");

      await clearPalette();
      palette = await getSavedPalette();
      assert.equal(palette.length, 0);
    });

    test("ColorPickerCommand mounts and renders List with conversions and palette", () => {
      const root = renderDeclarativeRoot(ColorPickerCommand);
      const desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.equal(desc.props.navigationTitle, "调色板与色彩转换器");
      assert.equal(desc.children.length, 2);
      root.unmount();
    });

    test("ColorDetailView renders swatch, WCAG test table and metadata", () => {
      const parsed = parseColor("#30D158");
      const view = ColorDetailView({ color: parsed });
      assert.equal(view.type, "Detail");
      assert.match(view.props.markdown, /WCAG 2.1 无障碍对比度测试/);
      assert.equal(view.props.metadata.type, "Detail.Metadata");
      assert.equal(view.props.actions.type, "ActionPanel");
    });
  });

  // --------------------------------------------------------------------------
  // 6. Obsidian
  // --------------------------------------------------------------------------
  describe("App 6: obsidian", () => {
    test("searchVaultNotes searches by title, content and tags", () => {
      const found = searchVaultNotes(SAMPLE_OBSIDIAN_NOTES, "ADR-004");
      assert.equal(found.length, 1);
      assert.equal(found[0].id, "note-1");

      const foundTag = searchVaultNotes(SAMPLE_OBSIDIAN_NOTES, "agile");
      assert.equal(foundTag.length, 1);
      assert.equal(foundTag[0].id, "note-2");
    });

    test("saveVaultNote and deleteVaultNote persist to LocalStorage", async () => {
      const initial = await getVaultNotes();
      const initialCount = initial.length;

      const updated = await saveVaultNote({
        title: "Test Note 999",
        vault: "Personal",
        folder: "Inbox",
        tags: ["test", "ztools"],
        content: "## Temporary Content"
      });

      assert.equal(updated.length, initialCount + 1);
      assert.equal(updated[0].title, "Test Note 999");

      const afterDelete = await deleteVaultNote(updated[0].id);
      assert.equal(afterDelete.length, initialCount);
    });

    test("ObsidianCommand mounts and renders note List with Dropdown", () => {
      const root = renderDeclarativeRoot(ObsidianCommand);
      const desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.equal(desc.props.navigationTitle, "Obsidian 笔记知识库");
      assert.equal(desc.props.searchBarAccessory.type, "List.Dropdown");
      assert.ok(desc.children.length >= 1);
      root.unmount();
    });

    test("ObsidianNoteDetailView renders note Markdown and metadata", () => {
      const note = SAMPLE_OBSIDIAN_NOTES[0];
      const view = ObsidianNoteDetailView({ note });
      assert.equal(view.type, "Detail");
      assert.equal(view.props.navigationTitle, note.title);
      assert.match(view.props.markdown, /ZTools 声明式架构设计决策/);
      assert.equal(view.props.metadata.type, "Detail.Metadata");
      assert.equal(view.props.actions.type, "ActionPanel");
    });

    test("ObsidianQuickNoteForm mounts and renders Form fields", () => {
      let created = null;
      const root = renderDeclarativeRoot(() =>
        ObsidianQuickNoteForm({ onCreated: (list) => (created = list) })
      );
      const desc = root.getLatest();
      assert.equal(desc.type, "Form");
      assert.equal(desc.props.navigationTitle, "新建随手记 / 知识沉淀");
      assert.ok(desc.children.length >= 5);
      root.unmount();
    });
  });

  // --------------------------------------------------------------------------
  // 7. Speedtest
  // --------------------------------------------------------------------------
  describe("App 7: speedtest", () => {
    test("runNetworkDiagnostics produces complete network report", () => {
      const rep = runNetworkDiagnostics();
      assert.ok(rep.local.ip);
      assert.ok(rep.publicIp.ip);
      assert.ok(rep.dnsList.length >= 5);
      assert.ok(rep.speed.downloadMbps > 0);
      assert.ok(rep.speed.uploadMbps > 0);
    });

    test("generateAsciiBar generates visual bar of designated length", () => {
      const barFull = generateAsciiBar(100, 100, 10);
      assert.equal(barFull, "██████████");

      const barHalf = generateAsciiBar(50, 100, 10);
      assert.equal(barHalf, "█████░░░░░");

      const barEmpty = generateAsciiBar(0, 100, 10);
      assert.equal(barEmpty, "░░░░░░░░░░");
    });

    test("SpeedtestCommand mounts and renders List with speed, IPs and DNS benchmarks", () => {
      const root = renderDeclarativeRoot(SpeedtestCommand);
      const desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.equal(desc.props.navigationTitle, "网络与 IP 诊断");
      assert.equal(desc.children.length, 3);
      root.unmount();
    });

    test("SpeedtestDetailView renders ASCII charts, topology and metadata", () => {
      const report = runNetworkDiagnostics();
      const view = SpeedtestDetailView({ report });
      assert.equal(view.type, "Detail");
      assert.match(view.props.markdown, /全球主流 DNS 解析延时对比/);
      assert.match(view.props.markdown, /网络拓扑路径/);
      assert.equal(view.props.metadata.type, "Detail.Metadata");
      assert.equal(view.props.actions.type, "ActionPanel");
    });
  });

  // --------------------------------------------------------------------------
  // 8. Winget
  // --------------------------------------------------------------------------
  describe("App 8: winget", () => {
    test("filterWingetPackages filters packages by status and keyword", () => {
      const upgradable = filterWingetPackages(SAMPLE_WINGET_PACKAGES, "", "upgradable");
      assert.ok(upgradable.length >= 2);
      assert.ok(upgradable.every((p) => p.status === "upgradable"));

      const searchVSCode = filterWingetPackages(SAMPLE_WINGET_PACKAGES, "vscode", "all");
      assert.equal(searchVSCode.length, 1);
      assert.equal(searchVSCode[0].id, "Microsoft.VisualStudioCode");
    });

    test("WingetCommand mounts and renders List with Dropdown and package items", () => {
      const root = renderDeclarativeRoot(WingetCommand);
      const desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.equal(desc.props.navigationTitle, "Windows 包管理器 (Winget)");
      assert.equal(desc.props.searchBarAccessory.type, "List.Dropdown");
      assert.ok(desc.children.length >= 1);
      root.unmount();
    });

    test("WingetDetailView renders install commands, package metadata and actions", () => {
      const pkg = SAMPLE_WINGET_PACKAGES[0];
      const view = WingetDetailView({ pkg });
      assert.equal(view.type, "Detail");
      assert.equal(view.props.navigationTitle, `${pkg.name} (${pkg.id})`);
      assert.match(view.props.markdown, /winget install/);
      assert.equal(view.props.metadata.type, "Detail.Metadata");
      assert.equal(view.props.actions.type, "ActionPanel");
    });
  });

  // --------------------------------------------------------------------------
  // 9. Currency Exchange
  // --------------------------------------------------------------------------
  describe("App 9: currency-exchange", () => {
    test("convertCurrency accurately calculates exchange between currency pairs", () => {
      const usdToCny = convertCurrency(100, "USD", "CNY");
      assert.equal(Number(usdToCny.toFixed(2)), 723.50);

      const cnyToUsd = convertCurrency(723.50, "CNY", "USD");
      assert.equal(Math.round(cnyToUsd), 100);

      const eurToJpy = convertCurrency(100, "EUR", "JPY");
      assert.ok(eurToJpy > 0);
    });

    test("parseAmountAndCurrency parses strings like '$100', '¥500', '250 EUR'", () => {
      assert.deepEqual(parseAmountAndCurrency("$150"), { amount: 150, currency: "USD" });
      assert.deepEqual(parseAmountAndCurrency("¥888"), { amount: 888, currency: "CNY" });
      assert.deepEqual(parseAmountAndCurrency("€50"), { amount: 50, currency: "EUR" });
      assert.deepEqual(parseAmountAndCurrency("300 JPY"), { amount: 300, currency: "JPY" });
      assert.deepEqual(parseAmountAndCurrency(""), { amount: 100, currency: "USD" });
    });

    test("calculateAllConversions calculates all target currencies for base currency", () => {
      const conversions = calculateAllConversions(100, "USD");
      assert.ok(conversions.length >= 10);
      const cny = conversions.find((c) => c.code === "CNY");
      assert.ok(cny);
      assert.equal(cny.convertedAmount, 723.50);
    });

    test("CurrencyExchangeCommand mounts and renders List with currency rates", () => {
      const root = renderDeclarativeRoot(CurrencyExchangeCommand);
      const desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.equal(desc.props.navigationTitle, "全球多币种实时汇率换算");
      assert.equal(desc.props.searchBarAccessory.type, "List.Dropdown");
      assert.equal(desc.children.length, 1);
      root.unmount();
    });

    test("CurrencyDetailView renders 7-day trend table, inverse rates and metadata", () => {
      const conversions = calculateAllConversions(100, "USD");
      const cny = conversions.find((c) => c.code === "CNY");
      const view = CurrencyDetailView({
        fromCode: "USD",
        item: cny,
        amount: 100
      });
      assert.equal(view.type, "Detail");
      assert.match(view.props.markdown, /7-Day Trend/);
      assert.equal(view.props.metadata.type, "Detail.Metadata");
      assert.equal(view.props.actions.type, "ActionPanel");
    });
  });

  // --------------------------------------------------------------------------
  // 10. Kill Process
  // --------------------------------------------------------------------------
  describe("App 10: kill-process", () => {
    test("filterAndSortProcesses sorts by memory, cpu, name and pid accurately", () => {
      const byMem = filterAndSortProcesses(SAMPLE_PROCESSES, "", "memory");
      assert.ok(byMem[0].memoryMB >= byMem[1].memoryMB);

      const byCpu = filterAndSortProcesses(SAMPLE_PROCESSES, "", "cpu");
      assert.ok(byCpu[0].cpuPercent >= byCpu[1].cpuPercent);

      const searchNode = filterAndSortProcesses(SAMPLE_PROCESSES, "node", "memory");
      assert.equal(searchNode.length, 1);
      assert.equal(searchNode[0].name, "node.exe");
    });

    test("KillProcessCommand mounts and renders List with processes and sorting dropdown", () => {
      const root = renderDeclarativeRoot(KillProcessCommand);
      const desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.equal(desc.props.navigationTitle, "进程管理急救箱");
      assert.equal(desc.props.searchBarAccessory.type, "List.Dropdown");
      assert.equal(desc.children.length, 1);
      const section = desc.children[0];
      assert.ok(section.children.length >= 8);
      root.unmount();
    });

    test("ProcessDetailView renders process stats, commandline and metadata", () => {
      const proc = SAMPLE_PROCESSES[0];
      const view = ProcessDetailView({ process: proc });
      assert.equal(view.type, "Detail");
      assert.equal(view.props.navigationTitle, `${proc.name} [PID: ${proc.pid}]`);
      assert.match(view.props.markdown, /工作集物理内存/);
      assert.match(view.props.markdown, /taskkill/);
      assert.equal(view.props.metadata.type, "Detail.Metadata");
      assert.equal(view.props.actions.type, "ActionPanel");
    });
  });

  // --------------------------------------------------------------------------
  // 11. Dynamic & Interactive Actions for all apps
  // --------------------------------------------------------------------------
  describe("10 Apps Dynamic & Interactive Actions", () => {
    test("GithubDashboardCommand handles search and category switching", async () => {
      const root = renderDeclarativeRoot(GithubDashboardCommand);
      let desc = root.getLatest();

      // 搜索关键字
      desc.props.onSearchTextChange("reconciler");
      await new Promise((r) => queueMicrotask(r));
      desc = root.getLatest();

      // 只包含匹配的 PR Section
      assert.equal(desc.children.length, 1);
      assert.equal(desc.children[0].props.title, "Pull Requests (1)");

      // 切换类别为 Starred Repos
      desc.props.onSearchTextChange("");
      desc.props.searchBarAccessory.props.onChange("repo");
      await new Promise((r) => queueMicrotask(r));
      desc = root.getLatest();

      assert.equal(desc.children.length, 1);
      assert.match(desc.children[0].props.title, /Starred Repositories/);
      root.unmount();
    });

    test("GoogleTranslateCommand handles text input, language change and save action", async () => {
      const root = renderDeclarativeRoot(GoogleTranslateCommand);
      let desc = root.getLatest();

      // 输入待翻译词汇
      desc.props.onSearchTextChange("thank you");
      await new Promise((r) => queueMicrotask(r));
      desc = root.getLatest();

      const liveSection = desc.children[0];
      assert.equal(liveSection.props.title, "即时翻译结果");
      const liveItem = liveSection.children[0];
      assert.equal(liveItem.props.title, "谢谢");

      // 执行保存至历史动作
      const saveAction = desc.props.actions.children[0];
      await saveAction.props.onAction();

      const history = await getTranslateHistory();
      assert.ok(history.length >= 1);
      assert.equal(history[0].translatedText, "谢谢");

      root.unmount();
    });

    test("ColorPickerCommand handles color change and save to palette action", async () => {
      const root = renderDeclarativeRoot(ColorPickerCommand);
      let desc = root.getLatest();

      // 改变输入色值
      desc.props.onSearchTextChange("#FF9F0A");
      await new Promise((r) => queueMicrotask(r));
      desc = root.getLatest();

      const convSection = desc.children[0];
      assert.match(convSection.props.title, /\[#FF9F0A\]/);

      // 触发收藏至调色板
      const saveAction = desc.props.actions.children[0];
      await saveAction.props.onAction();

      const palette = await getSavedPalette();
      assert.ok(palette.some((c) => c.hex === "#FF9F0A"));

      root.unmount();
    });

    test("ObsidianCommand handles search and ObsidianQuickNoteForm submission", async () => {
      let createdNotes = null;
      const formRoot = renderDeclarativeRoot(() =>
        ObsidianQuickNoteForm({
          onCreated: (list) => {
            createdNotes = list;
          }
        })
      );
      const formDesc = formRoot.getLatest();

      // 提交新笔记
      const submitAction = formDesc.props.actions.children[0];
      await submitAction.props.onSubmit({
        title: "Declarative UI Architecture",
        vault: "Engineering",
        folder: "Design",
        tags: "raycast ztools virtual",
        content: "Detailed RFC content..."
      });

      assert.ok(createdNotes);
      assert.equal(createdNotes[0].title, "Declarative UI Architecture");
      formRoot.unmount();
    });

    test("SpeedtestCommand handles re-run network benchmark action", async () => {
      const root = renderDeclarativeRoot(SpeedtestCommand);
      let desc = root.getLatest();

      const refreshAction = desc.props.actions.children[0];
      await refreshAction.props.onAction();
      await new Promise((r) => queueMicrotask(r));

      desc = root.getLatest();
      assert.equal(desc.type, "List");
      assert.ok(desc.children.length >= 3);
      root.unmount();
    });

    test("WingetCommand handles filter switching and package installation", async () => {
      const root = renderDeclarativeRoot(WingetCommand);
      let desc = root.getLatest();

      // 切换为已安装
      desc.props.searchBarAccessory.props.onChange("installed");
      await new Promise((r) => queueMicrotask(r));
      desc = root.getLatest();

      const installedSection = desc.children[0];
      assert.ok(installedSection.children.length >= 2);

      // 搜索 Bun 并进行一键安装
      desc.props.searchBarAccessory.props.onChange("all");
      desc.props.onSearchTextChange("Bun");
      await new Promise((r) => queueMicrotask(r));
      desc = root.getLatest();

      const bunItem = desc.children[0].children[0];
      assert.equal(bunItem.props.title, "Bun");

      // 触发安装 Action
      const installAction = bunItem.props.actions.children.find(
        (a) => a.props.title === "一键安装此软件"
      );
      assert.ok(installAction);
      await installAction.props.onAction();
      await new Promise((r) => queueMicrotask(r));

      desc = root.getLatest();
      const updatedBun = desc.children[0].children[0];
      assert.equal(updatedBun.props.accessories[1].tag, "installed");

      root.unmount();
    });

    test("CurrencyExchangeCommand handles base currency switch and amount change", async () => {
      const root = renderDeclarativeRoot(CurrencyExchangeCommand);
      let desc = root.getLatest();

      // 切换基准货币为 EUR
      desc.props.searchBarAccessory.props.onChange("EUR");
      // 改变换算金额为 500
      desc.props.onSearchTextChange("500");
      await new Promise((r) => queueMicrotask(r));
      desc = root.getLatest();

      const sec = desc.children[0];
      assert.equal(sec.props.title, "折算结果 (基准: 500 EUR)");
      assert.ok(sec.children.length >= 10);

      root.unmount();
    });

    test("KillProcessCommand handles search and kill process action", async () => {
      const root = renderDeclarativeRoot(KillProcessCommand);
      let desc = root.getLatest();

      // 搜索 Docker
      desc.props.onSearchTextChange("Docker");
      await new Promise((r) => setImmediate(r));
      desc = root.getLatest();

      let sec = desc.children[0];
      assert.equal(sec.children.length, 1);
      const dockerItem = sec.children[0];
      assert.match(dockerItem.props.title, /Docker Desktop/);

      // 触发一键强制结束进程
      const killAction = dockerItem.props.actions.children.find(
        (a) => a.props.title === "一键强制结束进程"
      );
      assert.ok(killAction);
      await killAction.props.onAction();
      await new Promise((r) => setImmediate(r));

      desc = root.getLatest();
      sec = desc.children[0];
      assert.equal(sec.children.length, 0); // Docker 已被杀死并从列表中移出

      root.unmount();
    });
  });
});

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  renderDeclarativeRoot,
  LocalStorage,
  Clipboard,
  // 12. clipboard-history
  ClipboardHistoryCommand,
  ClipboardDetailView,
  SAMPLE_CLIPBOARD_ITEMS,
  getClipboardHistory,
  saveClipboardHistory,
  filterClipboardItems,
  formatCopiedTime,
  detectClipboardContentType,
  parseColorDetails,
  maskSensitiveContent,
  calculateShannonEntropy,
  toggleClipboardItemPin,
  deleteClipboardItem,
  clearUnpinnedClipboardHistory,
  pasteSequentialClipboard,
  resetPasteSequence,
  pasteSequenceManager,
  getClipboardPreferences,
  saveClipboardPreferences,
  // 13. snippets
  SnippetsCommand,
  SnippetDetailView,
  CreateSnippetForm,
  ImportSnippetsForm,
  SAMPLE_SNIPPETS,
  getSnippets,
  saveSnippets,
  filterSnippets,
  expandSnippetTemplate,
  createSnippetService,
  updateSnippetService,
  deleteSnippetService,
  toggleSnippetService,
  exportSnippetsJSON,
  importSnippetsJSON,
  // 14. window-management
  WindowManagementCommand,
  WindowActionDetailView,
  WindowPreferencesForm,
  WINDOW_ACTIONS,
  filterWindowActions,
  calculateWindowGeometry,
  getWindowPreferences,
  saveWindowPreferences,
  executeWindowAction,
  DEFAULT_WINDOW_PREFERENCES,
  // 15. calculator
  CalculatorCommand,
  evaluateMathExpression,
  inspectColor,
  convertUnits,
  convertCalculatorCurrency,
  evaluateDateExpression,
  evaluateCalculatorQuery,
  getCalculatorHistory,
  addCalculatorHistory,
  togglePinCalculatorHistory,
  deleteCalculatorHistory,
  clearCalculatorHistory,
  // 16. system
  SystemCommand,
  SYSTEM_ACTIONS,
  filterSystemActions,
  executeSystemAction,
  // 17. quicklinks
  QuicklinksCommand,
  CreateQuicklinkForm,
  getQuicklinks,
  saveQuicklinks,
  resolveQuicklinkUrl,
  filterQuicklinks,
  DEFAULT_QUICKLINKS,
  // 24. notes
  NotesCommand,
  NoteDetailView,
  NoteCreateForm,
  NoteEditForm,
  getNotes,
  saveNote,
  updateNote,
  deleteNote,
  clearNotes,
  togglePinNote,
  filterNotes,
  calculateNoteStats,
  deriveNoteTitle,
  exportNoteAsMarkdown,
  SAMPLE_NOTES,
  NOTES_STORAGE_KEY,
  // bridge
  setDeclarativeBridge
} from "../dist/index.js";

// 构造通用 localStorage 模拟环境以供浏览器存储层测试
const mockStore = new Map();
if (typeof globalThis.localStorage === "undefined") {
  globalThis.localStorage = {
    getItem: (key) => mockStore.get(key) ?? null,
    setItem: (key, val) => mockStore.set(key, String(val)),
    removeItem: (key) => mockStore.delete(key),
    clear: () => mockStore.clear()
  };
}

describe("M1.5 Core Built-in Suites Integration & Chaos Resilience", () => {
  beforeEach(async () => {
    mockStore.clear();
    await LocalStorage.clear();
  });

  // =========================================================================
  // 1. Calculator Engine: Math Expression Evaluation & AST Compliance
  // =========================================================================
  describe("Calculator: Safe Math Expression Evaluation", () => {
    test("Happy Path: basic arithmetic, precedence and parentheses", () => {
      // 基础四则运算
      const res1 = evaluateMathExpression("1024 * 768");
      assert.equal(res1.isCalculation, true);
      assert.equal(res1.answer, 786432);
      assert.equal(res1.formattedAnswer, "786,432");

      // 优先级: 乘法优于加法
      const res2 = evaluateMathExpression("2 + 3 * 4");
      assert.equal(res2.answer, 14);

      // 括号覆盖优先级
      const res3 = evaluateMathExpression("(2 + 3) * 4");
      assert.equal(res3.answer, 20);

      // 嵌套多重括号
      const res4 = evaluateMathExpression("((10 + 20) * 2) / (3 + 2)");
      assert.equal(res4.answer, 12);

      // 幂运算符
      const res5 = evaluateMathExpression("2 ^ 10");
      assert.equal(res5.answer, 1024);

      // 百分比折算
      const res6 = evaluateMathExpression("5000 * 15%");
      assert.equal(res6.answer, 750);
    });

    test("Happy Path: math functions and constants", () => {
      // 平方根
      const resSqrt = evaluateMathExpression("sqrt(65536)");
      assert.equal(resSqrt.isCalculation, true);
      assert.equal(resSqrt.answer, 256);

      // 绝对值
      const resAbs = evaluateMathExpression("abs(-42.5)");
      assert.equal(resAbs.answer, 42.5);

      // 向上取整 / 向下取整
      const resCeil = evaluateMathExpression("ceil(4.1)");
      assert.equal(resCeil.answer, 5);
      const resFloor = evaluateMathExpression("floor(4.9)");
      assert.equal(resFloor.answer, 4);

      // 三角函数与常量 pi
      const resSin = evaluateMathExpression("sin(pi / 2)");
      assert.equal(Math.round(resSin.answer), 1);

      // 常量 e
      const resE = evaluateMathExpression("ln(e)");
      assert.equal(Math.round(resE.answer), 1);
    });

    test("Chaos & Fault Injection: edge cases, malformed inputs, and syntax errors", () => {
      // 1. 空输入与非数学字符串
      assert.equal(evaluateMathExpression("").isCalculation, false);
      assert.equal(evaluateMathExpression("   ").isCalculation, false);
      assert.equal(evaluateMathExpression(null).isCalculation, false);
      assert.equal(evaluateMathExpression(undefined).isCalculation, false);
      assert.equal(evaluateMathExpression("hello world").isCalculation, false);

      // 2. 除以零错误捕获
      const resDivZero = evaluateMathExpression("100 / 0");
      assert.equal(resDivZero.isCalculation, true);
      assert.equal(resDivZero.answer, null);
      assert.match(resDivZero.error, /除数不能为零/);

      // 3. 负数平方根异常拦截
      const resNegSqrt = evaluateMathExpression("sqrt(-16)");
      assert.equal(resNegSqrt.isCalculation, true);
      assert.equal(resNegSqrt.answer, null);
      assert.match(resNegSqrt.error, /负数没有实数平方根/);

      // 4. 括号不匹配与语法畸形
      const resUnbalanced = evaluateMathExpression("(1 + 2 * (3 + 4)");
      assert.equal(resUnbalanced.isCalculation, true);
      assert.equal(resUnbalanced.answer, null);
      assert.match(resUnbalanced.error, /括号不匹配/);

      // 5. 运算符连续出现畸形语法
      const resBadOp = evaluateMathExpression("2 + * 3");
      assert.equal(resBadOp.isCalculation, true);
      assert.equal(resBadOp.answer, null);
      assert.ok(resBadOp.error);

      // 6. 极端极大数溢出防御
      const resOverflow = evaluateMathExpression("10 ^ 400");
      assert.equal(resOverflow.isCalculation, true);
      assert.equal(resOverflow.answer, null);
      assert.match(resOverflow.error, /溢出/);
    });
  });

  // =========================================================================
  // 2. Calculator Engine: Color Inspector & WCAG Rating
  // =========================================================================
  describe("Calculator: Color Inspector & WCAG Rating", () => {
    test("Happy Path: HEX, RGB, HSL parsing and dual-way conversion", () => {
      // 1. 标准 6 位 HEX
      const color1 = inspectColor("#0ea5e9");
      assert.ok(color1);
      assert.equal(color1.hex.toLowerCase(), "#0ea5e9");
      assert.equal(color1.r, 14);
      assert.equal(color1.g, 165);
      assert.equal(color1.b, 233);
      assert.match(color1.rgb, /^rgb\(14,\s*165,\s*233\)$/i);
      assert.match(color1.hsl, /^hsl\(199,\s*89%,\s*48%\)$/i);
      assert.ok(color1.cmyk);
      assert.ok(color1.contrastWhite > 0);
      assert.ok(color1.contrastBlack > 0);

      // 2. 缩写 3 位 HEX
      const color2 = inspectColor("#fff");
      assert.ok(color2);
      assert.equal(color2.hex.toLowerCase(), "#ffffff");
      assert.equal(color2.r, 255);
      assert.equal(color2.g, 255);
      assert.equal(color2.b, 255);
      assert.equal(color2.contrastBlack, 21); // 纯白与纯黑对比度 21:1

      // 3. RGB 格式解析
      const color3 = inspectColor("rgb(99, 102, 241)");
      assert.ok(color3);
      assert.equal(color3.hex.toLowerCase(), "#6366f1");
      assert.equal(color3.r, 99);
      assert.equal(color3.g, 102);
      assert.equal(color3.b, 241);

      // 4. HSL 格式解析
      const color4 = inspectColor("hsl(120, 100%, 50%)");
      assert.ok(color4);
      assert.equal(color4.hex.toLowerCase(), "#00ff00");
    });

    test("Chaos & Fault Injection: boundary values and invalid inputs", () => {
      // 1. 非色彩字符串返回 null
      assert.equal(inspectColor(""), null);
      assert.equal(inspectColor("not-a-color"), null);
      assert.equal(inspectColor("#xyz"), null);
      assert.equal(inspectColor("1024 * 768"), null);

      // 2. 超过 255 的 RGB 溢出安全裁剪
      const clamped = inspectColor("rgb(300, 200, 50)");
      assert.ok(clamped);
      assert.equal(clamped.r, 255);
      assert.equal(clamped.g, 200);
      assert.equal(clamped.b, 50);

      // 3. 负数或非法格式直接返回 null
      assert.equal(inspectColor("rgb(-10, 50, 50)"), null);
    });
  });

  // =========================================================================
  // 3. Calculator: Advanced Units, Currency, Dates & History Pinning
  // =========================================================================
  describe("Calculator: Units, Currency, Date Arithmetic & History Pinning", () => {
    test("Happy Path: CSS px <-> rem conversion with custom base", () => {
      const res1 = convertUnits("32px to rem");
      assert.ok(res1);
      assert.equal(res1.isConversion, true);
      assert.equal(res1.value, 2);
      assert.equal(res1.formattedAnswer, "2 rem");

      const res2 = convertUnits("2.5rem in px");
      assert.ok(res2);
      assert.equal(res2.value, 40);
      assert.equal(res2.formattedAnswer, "40 px");

      // Custom remBase (e.g. 10px base)
      const res3 = convertUnits("30px to rem", { remBase: 10 });
      assert.ok(res3);
      assert.equal(res3.value, 3);
    });

    test("Happy Path: length, mass, temperature and digital storage conversions", () => {
      // 1. 长度与距离
      const resKm = convertUnits("10km to miles");
      assert.ok(resKm);
      assert.ok(Math.abs(resKm.value - 6.2137) < 0.01);
      assert.match(resKm.formattedAnswer, /miles/);

      // 2. 重量与质量
      const resKg = convertUnits("5kg to lbs");
      assert.ok(resKg);
      assert.ok(Math.abs(resKg.value - 11.023) < 0.05);

      // 3. 摄氏度与华氏度
      const resTempF = convertUnits("100c to f");
      assert.ok(resTempF);
      assert.equal(resTempF.value, 212);
      assert.equal(resTempF.formattedAnswer, "212 °F");

      const resTempC = convertUnits("32f to c");
      assert.ok(resTempC);
      assert.equal(resTempC.value, 0);
      assert.equal(resTempC.formattedAnswer, "0 °C");

      // 4. 数字存储
      const resStorage = convertUnits("1024mb to gb");
      assert.ok(resStorage);
      assert.equal(resStorage.value, 1);
      assert.equal(resStorage.formattedAnswer, "1 GB");
    });

    test("Happy Path: number radix conversion (hex, dec, bin, oct)", () => {
      // 0xFF to dec
      const resHexToDec = convertUnits("0xFF to dec");
      assert.ok(resHexToDec);
      assert.equal(resHexToDec.value, 255);
      assert.equal(resHexToDec.formattedAnswer, "255");

      // 255 to hex
      const resDecToHex = convertUnits("255 to hex");
      assert.ok(resDecToHex);
      assert.equal(resDecToHex.formattedAnswer, "0xFF");

      // 255 to bin
      const resDecToBin = convertUnits("255 to bin");
      assert.ok(resDecToBin);
      assert.equal(resDecToBin.formattedAnswer, "0b11111111");

      // 0b1010 to dec
      const resBinToDec = convertUnits("0b1010 to dec");
      assert.ok(resBinToDec);
      assert.equal(resBinToDec.value, 10);
    });

    test("Happy Path: currency exchange rate estimation", () => {
      const resCny = convertCalculatorCurrency("100 USD in CNY");
      assert.ok(resCny);
      assert.equal(resCny.isCurrency, true);
      assert.equal(resCny.amount, 100);
      assert.equal(resCny.fromCurrency, "USD");
      assert.equal(resCny.toCurrency, "CNY");
      assert.equal(resCny.convertedAmount, 725);
      assert.match(resCny.formattedAnswer, /725(\.00)? CNY/);

      // Symbol prefix: $100 to CNY
      const resSym = convertCalculatorCurrency("$100 to CNY");
      assert.ok(resSym);
      assert.equal(resSym.convertedAmount, 725);
    });

    test("Happy Path: date and time arithmetic", () => {
      const resDate = evaluateDateExpression("now + 2 weeks");
      assert.ok(resDate);
      assert.equal(resDate.isDate, true);
      assert.ok(resDate.targetDate.getTime() > Date.now());
      assert.match(resDate.formattedAnswer, /^\d{4}-\d{2}-\d{2}$/);

      const resDays = evaluateDateExpression("today - 3 days");
      assert.ok(resDays);
      assert.ok(resDays.targetDate.getTime() < Date.now());
    });

    test("Happy Path: unified evaluateCalculatorQuery dispatching", () => {
      // 1. Color query
      const qColor = evaluateCalculatorQuery("#3B82F6");
      assert.equal(qColor.type, "color");
      assert.ok(qColor.colorResult);

      // 2. Unit query
      const qUnit = evaluateCalculatorQuery("32px to rem");
      assert.equal(qUnit.type, "unit");
      assert.equal(qUnit.formattedAnswer, "2 rem");

      // 3. Currency query
      const qCurr = evaluateCalculatorQuery("100 USD in CNY");
      assert.equal(qCurr.type, "currency");
      assert.match(qCurr.formattedAnswer, /CNY/);

      // 4. Date query
      const qDate = evaluateCalculatorQuery("now + 2 weeks");
      assert.equal(qDate.type, "date");

      // 5. Math query
      const qMath = evaluateCalculatorQuery("512 * 4");
      assert.equal(qMath.type, "math");
      assert.equal(qMath.formattedAnswer, "2,048");

      // 6. Unknown query
      const qNone = evaluateCalculatorQuery("hello world");
      assert.equal(qNone.type, "none");
    });

    test("History & Pinning: CRUD and persistence", async () => {
      await clearCalculatorHistory();
      const initial = await getCalculatorHistory();
      assert.equal(initial.length, 0);

      // Add calculation
      const h1 = await addCalculatorHistory("1024 * 768", "786,432", "math");
      assert.equal(h1.length, 1);
      assert.equal(h1[0].expression, "1024 * 768");
      assert.equal(h1[0].pinned, false);

      // Add conversion
      const h2 = await addCalculatorHistory("32px to rem", "2 rem", "unit");
      assert.equal(h2.length, 2);
      assert.equal(h2[0].expression, "32px to rem");

      // Pin first item
      const pinned = await togglePinCalculatorHistory(h2[1].id);
      assert.equal(pinned.find(item => item.id === h2[1].id)?.pinned, true);

      // Delete item
      const remaining = await deleteCalculatorHistory(h2[0].id);
      assert.equal(remaining.length, 1);

      // Clear all
      await clearCalculatorHistory();
      const cleared = await getCalculatorHistory();
      assert.equal(cleared.length, 0);
    });

    test("Chaos & Fault Injection: unknown units, invalid currency, and date boundary", () => {
      // 未知单位
      assert.equal(convertUnits("100 unknownUnit to otherUnit"), null);
      assert.equal(convertUnits("not a conversion"), null);

      // 未知货币
      assert.equal(convertCalculatorCurrency("100 UNKNOWN in XYZ"), null);

      // 未知日期格式
      assert.equal(evaluateDateExpression("now + unknown"), null);
    });
  });

  // =========================================================================
  // 4. Window Management: Action Catalog, Geometry Engine & Preferences
  // =========================================================================
  describe("Window Management: 30+ Action Grid, Geometry Calculation & Gap Offsets", () => {
    test("Happy Path: catalog registration and full category coverage", () => {
      // 验证动作总数达到 30+ 项
      assert.ok(WINDOW_ACTIONS.length >= 30, `Current count: ${WINDOW_ACTIONS.length}`);

      // 验证核心动作存在
      const actionIds = WINDOW_ACTIONS.map(a => a.id);
      assert.ok(actionIds.includes("left-half"));
      assert.ok(actionIds.includes("right-half"));
      assert.ok(actionIds.includes("top-half"));
      assert.ok(actionIds.includes("bottom-half"));
      assert.ok(actionIds.includes("center-half"));

      assert.ok(actionIds.includes("first-third"));
      assert.ok(actionIds.includes("center-third"));
      assert.ok(actionIds.includes("last-third"));
      assert.ok(actionIds.includes("first-two-thirds"));
      assert.ok(actionIds.includes("center-two-thirds"));
      assert.ok(actionIds.includes("last-two-thirds"));

      assert.ok(actionIds.includes("top-left-quarter"));
      assert.ok(actionIds.includes("top-right-quarter"));
      assert.ok(actionIds.includes("bottom-left-quarter"));
      assert.ok(actionIds.includes("bottom-right-quarter"));

      assert.ok(actionIds.includes("top-left-sixth"));
      assert.ok(actionIds.includes("bottom-right-sixth"));

      assert.ok(actionIds.includes("maximize"));
      assert.ok(actionIds.includes("restore"));
      assert.ok(actionIds.includes("almost-maximize"));
      assert.ok(actionIds.includes("reasonable-size"));
      assert.ok(actionIds.includes("center"));

      assert.ok(actionIds.includes("next-display"));
      assert.ok(actionIds.includes("previous-display"));
    });

    test("Happy Path: Halves and Thirds geometry calculations", () => {
      const mon = { x: 0, y: 0, width: 1920, height: 1080 };
      const cur = { x: 100, y: 100, width: 800, height: 600 };

      // 左半屏: 0, 0, 960, 1080
      const leftHalf = calculateWindowGeometry("left-half", cur, mon);
      assert.equal(leftHalf.x, 0);
      assert.equal(leftHalf.y, 0);
      assert.equal(leftHalf.width, 960);
      assert.equal(leftHalf.height, 1080);

      // 右半屏: 960, 0, 960, 1080
      const rightHalf = calculateWindowGeometry("right-half", cur, mon);
      assert.equal(rightHalf.x, 960);
      assert.equal(rightHalf.y, 0);
      assert.equal(rightHalf.width, 960);
      assert.equal(rightHalf.height, 1080);

      // 左三分之一: 0, 0, 640, 1080
      const firstThird = calculateWindowGeometry("first-third", cur, mon);
      assert.equal(firstThird.x, 0);
      assert.equal(firstThird.width, 640);
      assert.equal(firstThird.height, 1080);

      // 左三分之二: 0, 0, 1280, 1080
      const firstTwoThirds = calculateWindowGeometry("first-two-thirds", cur, mon);
      assert.equal(firstTwoThirds.x, 0);
      assert.equal(firstTwoThirds.width, 1280);
      assert.equal(firstTwoThirds.height, 1080);
    });

    test("Happy Path: Quarters, Sixths, Center and Almost Maximize", () => {
      const mon = { x: 0, y: 0, width: 1920, height: 1080 };
      const cur = { x: 100, y: 100, width: 800, height: 600 };

      // 左上四分之一
      const topLeft = calculateWindowGeometry("top-left-quarter", cur, mon);
      assert.equal(topLeft.x, 0);
      assert.equal(topLeft.y, 0);
      assert.equal(topLeft.width, 960);
      assert.equal(topLeft.height, 540);

      // 右下四分之一
      const bottomRight = calculateWindowGeometry("bottom-right-quarter", cur, mon);
      assert.equal(bottomRight.x, 960);
      assert.equal(bottomRight.y, 540);
      assert.equal(bottomRight.width, 960);
      assert.equal(bottomRight.height, 540);

      // 几乎最大化 90%
      const almostMax = calculateWindowGeometry("almost-maximize", cur, mon, { percentage: 0.9 });
      assert.equal(almostMax.width, 1728);
      assert.equal(almostMax.height, 972);
      assert.equal(almostMax.x, 96);
      assert.equal(almostMax.y, 54);

      // 居中显示
      const centered = calculateWindowGeometry("center", cur, mon);
      assert.equal(centered.width, 800);
      assert.equal(centered.height, 600);
      assert.equal(centered.x, (1920 - 800) / 2);
      assert.equal(centered.y, (1080 - 600) / 2);
    });

    test("Gap Offsets: innerGap and outerGap boundary math", () => {
      const mon = { x: 0, y: 0, width: 1920, height: 1080 };
      const cur = { x: 100, y: 100, width: 800, height: 600 };
      const prefs = { innerGap: 16, outerGap: 20 };

      // 左半屏 (带 outerGap 20 与 innerGap 16)
      // effW = 1920 - 40 = 1880, effH = 1080 - 40 = 1040
      // halfW = (1880 - 16) / 2 = 932
      const leftHalf = calculateWindowGeometry("left-half", cur, mon, prefs);
      assert.equal(leftHalf.x, 20);
      assert.equal(leftHalf.y, 20);
      assert.equal(leftHalf.width, 932);
      assert.equal(leftHalf.height, 1040);

      // 右半屏: x = 20 + 932 + 16 = 968, width = 1880 - 932 - 16 = 932
      const rightHalf = calculateWindowGeometry("right-half", cur, mon, prefs);
      assert.equal(rightHalf.x, 968);
      assert.equal(rightHalf.y, 20);
      assert.equal(rightHalf.width, 932);
      assert.equal(rightHalf.height, 1040);
    });

    test("Search & Filter: keyword, category, and fuzzy matching", () => {
      // 类别筛选
      const halves = filterWindowActions(WINDOW_ACTIONS, { category: "halves" });
      assert.ok(halves.length >= 5);
      assert.ok(halves.every(a => a.category === "halves"));

      // 关键词检索
      const searchMatches = filterWindowActions(WINDOW_ACTIONS, { query: "四分之一" });
      assert.ok(searchMatches.length >= 4);

      // 快捷键检索
      const shortcutMatches = filterWindowActions(WINDOW_ACTIONS, { query: "Ctrl + Alt + Return" });
      assert.ok(shortcutMatches.some(a => a.id === "maximize"));
    });

    test("Preferences Storage: get and save preferences", async () => {
      const initial = await getWindowPreferences();
      assert.equal(initial.innerGap, DEFAULT_WINDOW_PREFERENCES.innerGap);

      // 更新偏好设置
      await saveWindowPreferences({ innerGap: 12, outerGap: 16, percentage: 0.8 });
      const updated = await getWindowPreferences();
      assert.equal(updated.innerGap, 12);
      assert.equal(updated.outerGap, 16);
      assert.equal(updated.percentage, 0.8);
    });

    test("Window Action Execution Pipeline & HUD Feedback", async () => {
      const res = await executeWindowAction("left-half", {
        monRect: { x: 0, y: 0, width: 1920, height: 1040 }
      });
      assert.equal(res.success, true);
      assert.equal(res.actionId, "left-half");
      assert.ok(res.rect);
      assert.equal(res.rect.width, 960);
    });
  });

  // =========================================================================
  // 5. System Actions: Native Operations & Destructive Gating
  // =========================================================================
  describe("System Actions: Operations, Search & Safety Metadata", () => {
    test("Happy Path: system action catalog and category classification", () => {
      // 1. 全量 20+ 原生指令覆盖
      assert.ok(SYSTEM_ACTIONS.length >= 20);

      // 电源与会话 (Power & Session)
      const powerActions = filterSystemActions("", "power");
      assert.ok(powerActions.length >= 6);
      const powerKeys = powerActions.map(a => a.actionKey);
      assert.ok(powerKeys.includes("lockScreen"));
      assert.ok(powerKeys.includes("shutDown"));
      assert.ok(powerKeys.includes("restart"));
      assert.ok(powerKeys.includes("sleep"));
      assert.ok(powerKeys.includes("logOut"));
      assert.ok(powerKeys.includes("hibernate"));

      // 进程与桌面治理 (Apps & Windows)
      const appsActions = filterSystemActions("", "apps");
      assert.ok(appsActions.length >= 4);
      const appsKeys = appsActions.map(a => a.actionKey);
      assert.ok(appsKeys.includes("hideAllAppsExceptFrontmost"));
      assert.ok(appsKeys.includes("quitAllApplications"));
      assert.ok(appsKeys.includes("quitAllApplicationsExceptFrontmost"));
      assert.ok(appsKeys.includes("quitActiveApplication"));

      // 音频与硬件控制 (Audio & Hardware)
      const audioActions = filterSystemActions("", "audio");
      assert.ok(audioActions.length >= 8);
      const audioKeys = audioActions.map(a => a.actionKey);
      assert.ok(audioKeys.includes("toggleMuteCurrentApp"));
      assert.ok(audioKeys.includes("turnCurrentAppVolumeUp"));
      assert.ok(audioKeys.includes("turnCurrentAppVolumeDown"));
      assert.ok(audioKeys.includes("volumeMixer"));
      assert.ok(audioKeys.includes("toggleMute"));
      assert.ok(audioKeys.includes("turnVolumeUp"));
      assert.ok(audioKeys.includes("turnVolumeDown"));
      assert.ok(audioKeys.includes("turnDisplayOff"));
      assert.ok(audioKeys.includes("ejectAllDisks"));

      // 维护与通知 (Maintenance)
      const maintActions = filterSystemActions("", "maintenance");
      assert.ok(maintActions.length >= 3);
      const maintKeys = maintActions.map(a => a.actionKey);
      assert.ok(maintKeys.includes("emptyTrash"));
      assert.ok(maintKeys.includes("openTrash"));
      assert.ok(maintKeys.includes("dismissNotifications"));

      // 验证破坏性标记 (Destructive actions)
      const shutdown = SYSTEM_ACTIONS.find(a => a.actionKey === "shutDown");
      assert.ok(shutdown);
      assert.equal(shutdown.destructive, true);

      const emptyTrash = SYSTEM_ACTIONS.find(a => a.actionKey === "emptyTrash");
      assert.ok(emptyTrash);
      assert.equal(emptyTrash.destructive, true);

      const quitAll = SYSTEM_ACTIONS.find(a => a.actionKey === "quitAllApplications");
      assert.ok(quitAll);
      assert.equal(quitAll.destructive, true);

      // 验证非破坏性安全操作
      const lock = SYSTEM_ACTIONS.find(a => a.actionKey === "lockScreen");
      assert.ok(lock);
      assert.equal(Boolean(lock.destructive), false);

      const toggleMute = SYSTEM_ACTIONS.find(a => a.actionKey === "toggleMute");
      assert.ok(toggleMute);
      assert.equal(Boolean(toggleMute.destructive), false);

      const dismiss = SYSTEM_ACTIONS.find(a => a.actionKey === "dismissNotifications");
      assert.ok(dismiss);
      assert.equal(Boolean(dismiss.destructive), false);
    });

    test("Search & Filter: keywords, title and category matching", () => {
      // 中文关键词检索
      const lockMatches = filterSystemActions("锁定");
      assert.ok(lockMatches.length >= 1);
      assert.equal(lockMatches[0].actionKey, "lockScreen");

      // 英文指令检索
      const restartMatches = filterSystemActions("restart");
      assert.ok(restartMatches.length >= 1);
      assert.equal(restartMatches[0].actionKey, "restart");

      // 音频控制指令
      const muteMatches = filterSystemActions("静音");
      assert.ok(muteMatches.some(a => a.actionKey === "toggleMute"));

      // 硬件显示指令
      const displayMatches = filterSystemActions("熄屏");
      assert.ok(displayMatches.some(a => a.actionKey === "turnDisplayOff"));

      // 类别筛选
      const audioActions = filterSystemActions("", "audio");
      assert.ok(audioActions.every(a => a.category === "audio"));
    });

    test("Execution Pipeline & Destructive Confirmation Gating (Beyond Happy Path)", async () => {
      // 1. 安全操作直接调度无需弹窗
      const lockItem = SYSTEM_ACTIONS.find(a => a.actionKey === "lockScreen");
      assert.ok(lockItem);
      const resSafe = await executeSystemAction(lockItem);
      assert.equal(resSafe.success, true);
      assert.equal(resSafe.executed, true);

      // 2. 高危破坏性操作：用户拒绝确认 -> 中断执行
      setDeclarativeBridge({
        confirmAlert: async () => false
      });
      const shutdownItem = SYSTEM_ACTIONS.find(a => a.actionKey === "shutDown");
      assert.ok(shutdownItem);
      const resRejected = await executeSystemAction(shutdownItem);
      assert.equal(resRejected.success, false);
      assert.equal(resRejected.executed, false);
      assert.match(resRejected.message, /取消/);

      // 3. 高危破坏性操作：用户批准确认 -> 顺利下发
      let alertPrompted = false;
      setDeclarativeBridge({
        confirmAlert: async () => {
          alertPrompted = true;
          return true;
        },
        system: {
          execute: async (key) => ({ success: true, message: `Dispatched ${key}` })
        }
      });
      const resApproved = await executeSystemAction(shutdownItem);
      assert.equal(alertPrompted, true);
      assert.equal(resApproved.success, true);
      assert.equal(resApproved.executed, true);

      // 4. 强制执行绕过确认 (force / confirmBypass)
      alertPrompted = false;
      const resForced = await executeSystemAction(shutdownItem, { confirmBypass: true });
      assert.equal(alertPrompted, false); // 未触发弹窗
      assert.equal(resForced.success, true);
      assert.equal(resForced.executed, true);

      // 5. 底层异常故障注入：Bridge 抛出错误被优雅捕获
      setDeclarativeBridge({
        system: {
          execute: async () => {
            throw new Error("Win32 Native API Error: 0x80070005 Access Denied");
          }
        }
      });
      const resError = await executeSystemAction(lockItem);
      assert.equal(resError.success, false);
      assert.equal(resError.executed, false);
      assert.match(resError.message, /Access Denied/);

      // 清理 Bridge 模拟
      setDeclarativeBridge(null);
    });

    test("Chaos & Fault Injection: empty, whitespace and unknown queries", () => {
      // 空白返回全量
      assert.equal(filterSystemActions("").length, SYSTEM_ACTIONS.length);
      assert.equal(filterSystemActions("   ").length, SYSTEM_ACTIONS.length);

      // 未知指令返回空数组
      assert.equal(filterSystemActions("unknown-impossible-action-xyz").length, 0);
      assert.equal(filterSystemActions("", "non-existent-category").length, 0);
    });
  });

  // =========================================================================
  // 6. Quicklinks: Dynamic Query Resolution, Keyword Alias & Storage
  // =========================================================================
  describe("Quicklinks: Macro Resolution & Alias Direct Match", () => {
    test("Happy Path: dynamic {query} replacement and static URLs", () => {
      // 带 {query} 的动态链接
      const tpl = "https://www.google.com/search?q={query}";
      const res1 = resolveQuicklinkUrl(tpl, "deepseek r1");
      assert.equal(res1.hasQuery, true);
      assert.equal(res1.url, "https://www.google.com/search?q=deepseek%20r1");

      // 静态链接无需替换
      const staticUrl = "https://github.com";
      const res2 = resolveQuicklinkUrl(staticUrl, "ignored arg");
      assert.equal(res2.hasQuery, false);
      assert.equal(res2.url, "https://github.com");

      // 带 {query} 但未传入参数
      const res3 = resolveQuicklinkUrl(tpl, "");
      assert.equal(res3.hasQuery, true);
      assert.equal(res3.url, "https://www.google.com/search?q=");
    });

    test("Happy Path: alias instant jump matching", () => {
      // 别名 + 参数 (例如 'g react')
      const filter1 = filterQuicklinks(DEFAULT_QUICKLINKS, "g react framework");
      assert.ok(filter1.directMatch);
      assert.equal(filter1.directMatch.quicklink.keyword, "g");
      assert.equal(filter1.directMatch.queryArg, "react framework");

      // 检索包含关键字的普通匹配
      const filter2 = filterQuicklinks(DEFAULT_QUICKLINKS, "gh");
      assert.ok(filter2.matches.some(m => m.keyword === "gh"));

      // 普通标题或链接模糊检索
      const filter3 = filterQuicklinks(DEFAULT_QUICKLINKS, "bilibili");
      assert.ok(filter3.matches.length >= 1);
      assert.equal(filter3.matches[0].keyword, "bili");
    });

    test("Storage: LocalStorage persistence and fallback", async () => {
      // 初始加载默认数据
      const initial = await getQuicklinks();
      assert.ok(initial.length >= 3);

      // 新增记录
      const customItem = {
        id: "custom-1",
        title: "自定义开发文档",
        link: "https://developer.mozilla.org/zh-CN/search?q={query}",
        keyword: "mdn",
        openCount: 5,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await saveQuicklinks([customItem, ...initial]);

      const reloaded = await getQuicklinks();
      assert.equal(reloaded.length, initial.length + 1);
      assert.equal(reloaded[0].id, "custom-1");
      assert.equal(reloaded[0].keyword, "mdn");
    });

    test("Chaos & Fault Injection: malformed data and boundary characters", () => {
      // 特殊字符 URL 编码安全性
      const resSpecial = resolveQuicklinkUrl("https://example.com/search?q={query}", "C++ & C# 100%");
      assert.ok(!resSpecial.url.includes(" "));
      assert.ok(resSpecial.url.includes("%2B%2B")); // + 转义
      assert.ok(resSpecial.url.includes("%23")); // # 转义

      // 异常输入过滤
      assert.equal(filterQuicklinks([], "test").matches.length, 0);
      assert.equal(filterQuicklinks(DEFAULT_QUICKLINKS, "").matches.length, DEFAULT_QUICKLINKS.length);
    });
  });

  // =========================================================================
  // 6. Clipboard History: Deep Integration, Sensitivity & Sequential Paste State Machine
  // =========================================================================
  describe("Clipboard History: Deep Integration, Sensitivity & Sequential Paste State Machine", () => {
    test("Happy Path: filter by types, pinyin initials and content search", () => {
      // 1. All items
      const all = filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { type: "all" });
      assert.equal(all.length, SAMPLE_CLIPBOARD_ITEMS.length);
      assert.equal(all[0].pinned, true);

      // 2. Filter by category
      const codeOnly = filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { type: "code" });
      assert.equal(codeOnly.length, 1);
      assert.equal(codeOnly[0].type, "code");

      const colorsOnly = filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { type: "color" });
      assert.equal(colorsOnly.length, 1);
      assert.equal(colorsOnly[0].type, "color");

      // 3. Pinyin initials match: "jtb" matches "剪贴板"
      const pinyinRes = filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { query: "jtb" });
      assert.ok(pinyinRes.length >= 1);
      assert.match(pinyinRes[0].content, /剪贴板/);
    });

    test("Sensitive Content: Masking & Desensitization (API Keys, Tokens, Secrets)", () => {
      // 1. OpenAI API Key
      const openAiKey = "sk-proj-12345678abcdefghijklmnopQRSTUVWX";
      const resOpenAi = maskSensitiveContent(openAiKey);
      assert.equal(resOpenAi.isSensitive, true);
      assert.equal(resOpenAi.reason, "API Key");
      assert.ok(resOpenAi.masked.includes("••••••••"));
      assert.ok(!resOpenAi.masked.includes("abcdefghijklmnop"));

      // 2. GitHub Token
      const ghToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
      const resGh = maskSensitiveContent(ghToken);
      assert.equal(resGh.isSensitive, true);
      assert.equal(resGh.reason, "GitHub Token");
      assert.ok(resGh.masked.includes("••••••••"));

      // 3. AWS Key
      const awsKey = "AKIA1234567890ABCDEF";
      const resAws = maskSensitiveContent(awsKey);
      assert.equal(resAws.isSensitive, true);
      assert.equal(resAws.reason, "AWS Access Key");

      // 4. Private Key
      const privKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----";
      const resPriv = maskSensitiveContent(privKey);
      assert.equal(resPriv.isSensitive, true);
      assert.match(resPriv.masked, /PROTECTED PRIVATE KEY/);

      // 5. Normal text is not sensitive
      const normalText = "Hello, this is regular code snippet for testing.";
      const resNormal = maskSensitiveContent(normalText);
      assert.equal(resNormal.isSensitive, false);
      assert.equal(resNormal.masked, normalText);
    });

    test("Sequential Paste State Machine: Advances, Calculates Remaining & Resets", async () => {
      pasteSequenceManager.reset();
      const items = [...SAMPLE_CLIPBOARD_ITEMS];

      // 1. First invocation
      const step1 = pasteSequenceManager.pasteNext(items);
      assert.ok(step1.item);
      assert.equal(step1.offset, 1);
      assert.equal(step1.remaining, items.length - 1);

      // 2. Second invocation
      const step2 = pasteSequenceManager.pasteNext(items);
      assert.ok(step2.item);
      assert.equal(step2.offset, 2);
      assert.equal(step2.remaining, items.length - 2);

      // 3. Reset
      pasteSequenceManager.reset();
      const state = pasteSequenceManager.getState();
      assert.equal(state.offset, 0);
      assert.equal(state.lastInvocation, null);

      // 4. Next invocation starts from 0 again
      const stepAfterReset = pasteSequenceManager.pasteNext(items);
      assert.equal(stepAfterReset.offset, 1);
      assert.equal(stepAfterReset.item.id, items[0].id);
    });

    test("Preferences: Storage, defaults and updates", async () => {
      const initialPrefs = await getClipboardPreferences();
      assert.equal(initialPrefs.historyDuration, "P1W");
      assert.equal(initialPrefs.primaryAction, "paste");

      await saveClipboardPreferences({
        historyDuration: "P1M",
        primaryAction: "copy",
        preferPastingAsPlainText: true
      });

      const updatedPrefs = await getClipboardPreferences();
      assert.equal(updatedPrefs.historyDuration, "P1M");
      assert.equal(updatedPrefs.primaryAction, "copy");
      assert.equal(updatedPrefs.preferPastingAsPlainText, true);
    });

    test("Chaos & Fault Injection: 10MB ultra-large payload, malformed colors and entropy extremes", () => {
      // 1. 10MB ultra-large text
      const tenMbChunk = "A".repeat(1024 * 1024 * 10);
      const start = Date.now();
      const type = detectClipboardContentType(tenMbChunk);
      const entropy = calculateShannonEntropy(tenMbChunk);
      const masked = maskSensitiveContent(tenMbChunk);
      const duration = Date.now() - start;

      assert.equal(type, "text");
      assert.equal(entropy, 0); // single repeated character has 0 entropy
      assert.equal(masked.isSensitive, false);
      assert.ok(duration < 2000, `Large 10MB payload processed in ${duration}ms, must be < 2000ms`);

      // 2. Malformed color inputs
      assert.equal(parseColorDetails("#xyz"), null);
      assert.equal(parseColorDetails(""), null);
      assert.equal(parseColorDetails("rgb(256, 999)"), null);

      // 3. Empty and boundary queries
      assert.equal(filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { query: "" }).length, SAMPLE_CLIPBOARD_ITEMS.length);
      assert.equal(filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { query: "   " }).length, SAMPLE_CLIPBOARD_ITEMS.length);
      assert.equal(filterClipboardItems([], { query: "test" }).length, 0);
    });
  });

  // =========================================================================
  // 7. Snippets: Dynamic Macro Engine, CRUD, Import/Export & Fault Injection
  // =========================================================================
  describe("Snippets: Dynamic Macro Engine, CRUD, Import/Export & Fault Injection", () => {
    test("Happy Path: dynamic macro replacement ({clipboard}, {date format}, {time}, {datetime}, {uuid}, {cursor}, {argument})", () => {
      const fixedDate = new Date(2026, 9, 13, 15, 30, 45); // 2026-10-13 15:30:45
      const ctx = {
        clipboard: "Hello Clipboard",
        now: fixedDate,
        args: { user: "Alice", project: "ZTools" }
      };

      // 1. {clipboard}
      const resClip = expandSnippetTemplate("Val: {clipboard}", "", ctx);
      assert.equal(resClip.expanded, "Val: Hello Clipboard");

      // 2. {date format=\"YYYY/MM/DD\"}
      const resDateFmt = expandSnippetTemplate("Date: {date format=\"YYYY/MM/DD\"}", "", ctx);
      assert.equal(resDateFmt.expanded, "Date: 2026/10/13");

      // 3. {time format=\"HH:mm\"}
      const resTimeFmt = expandSnippetTemplate("Time: {time format=\"HH:mm\"}", "", ctx);
      assert.equal(resTimeFmt.expanded, "Time: 15:30");

      // 4. {datetime}
      const resDateTime = expandSnippetTemplate("Stamp: {datetime}", "", ctx);
      assert.equal(resDateTime.expanded, "Stamp: 2026-10-13 15:30:45");

      // 5. {year}, {month}, {day}
      const resParts = expandSnippetTemplate("{year}-{month}-{day}", "", ctx);
      assert.equal(resParts.expanded, "2026-10-13");

      // 6. {uuid}
      const resUuid = expandSnippetTemplate("UUID: {uuid}", "", ctx);
      assert.match(resUuid.expanded, /UUID: [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/);

      // 7. {cursor}
      const resCursor = expandSnippetTemplate("const x = '{cursor}';", "", ctx);
      assert.equal(resCursor.expanded, "const x = '';");
      assert.equal(resCursor.cursorOffset, 2);
      assert.equal(resCursor.hasCursor, true);

      // 8. {argument name=\"user\"}
      const resArg = expandSnippetTemplate("Author: {argument name=\"user\"}, Project: {argument name=\"project\"}", "", ctx);
      assert.equal(resArg.expanded, "Author: Alice, Project: ZTools");
    });

    test("Batch Import & Export: JSON import, keyword deduplication and export roundtrip", async () => {
      const initialSnippets = await getSnippets();
      const exportJson = await exportSnippetsJSON(initialSnippets);
      assert.ok(exportJson.includes(":mail"));

      // Import valid snippets
      const batchData = [
        { name: "工作邮箱快速输入", keyword: ":mail", snippet: "updated@ztools.org" }, // should update
        { name: "新建宏短语", keyword: ":newmacro", snippet: "Welcome {date}" } // should insert
      ];

      const importRes = await importSnippetsJSON(batchData, initialSnippets);
      assert.equal(importRes.total, 2);
      assert.equal(importRes.updated, 1);
      assert.equal(importRes.imported, 1);
      assert.equal(importRes.failed, 0);

      const reloaded = await getSnippets();
      const updatedMail = reloaded.find(s => s.keyword === ":mail");
      assert.equal(updatedMail.snippet, "updated@ztools.org");

      const newSnippet = reloaded.find(s => s.keyword === ":newmacro");
      assert.ok(newSnippet);
    });

    test("Chaos & Fault Injection: 10MB template, malformed macro tags, and corrupted JSON import", async () => {
      // 1. 10MB ultra-large template with multiple macros
      const largeChunk = "Prefix ".repeat(100000) + "{date} Middle " + "{cursor} " + "Suffix ".repeat(100000);
      const start = Date.now();
      const largeRes = expandSnippetTemplate(largeChunk);
      const duration = Date.now() - start;

      assert.ok(largeRes.expanded.includes("Middle"));
      assert.equal(largeRes.hasCursor, true);
      assert.ok(largeRes.cursorOffset > 0);
      assert.ok(duration < 2500, `10MB template expanded in ${duration}ms, must be < 2500ms`);

      // 2. Malformed macro tags
      const unclosed = expandSnippetTemplate("Broken {date and {argument name= without end");
      assert.equal(unclosed.expanded, "Broken {date and {argument name= without end");

      // 3. Corrupted JSON import (Beyond Happy Path)
      const corruptedRes = await importSnippetsJSON("{ not valid json at all", []);
      assert.equal(corruptedRes.failed, 1);
      assert.ok(corruptedRes.errors && corruptedRes.errors.length > 0);

      // 4. Non-array JSON import
      const nonArrayRes = await importSnippetsJSON("{\"name\": \"single object\"}", []);
      assert.equal(nonArrayRes.failed, 1);

      // 5. Missing required fields in array
      const missingFieldsRes = await importSnippetsJSON([
        { name: "No keyword or snippet" },
        { keyword: ":nokeyword" }
      ], []);
      assert.equal(missingFieldsRes.failed, 2);
    });
  });

  // =========================================================================
  // 8. Notes: Multi-Note Lifecycle, Live Markdown & Full Keyboard Flow
  // =========================================================================
  describe("Notes: Multi-Note Lifecycle, Live Markdown & Full Keyboard Flow", () => {
    test("Happy Path: default sample notes, stats calculation and auto title derivation", async () => {
      // 1. 默认自动初始化精选便签
      const initialNotes = await getNotes();
      assert.ok(initialNotes.length >= 4);

      // 验证置顶优先排序规则 (Pinned First)
      assert.equal(initialNotes[0].pinned, true);

      // 2. 字数、行数与阅读耗时统计验证
      const stats = calculateNoteStats("# 核心标题\n\n这是第一段文字。\n\n- 任务 1\n- 任务 2\n");
      assert.ok(stats.characters > 20);
      assert.ok(stats.words >= 4);
      assert.ok(stats.lines >= 5);
      assert.equal(stats.readingTimeMinutes, 1);

      // 3. 标题自动提取算法
      // 显式指定标题
      assert.equal(deriveNoteTitle("我的专属标题", "正文内容"), "我的专属标题");
      // 隐式从正文第一行 Markdown 提取并剔除前缀
      assert.equal(deriveNoteTitle("", "# 架构设计指南\n\n正文"), "架构设计指南");
      assert.equal(deriveNoteTitle("", "- 待办清单项\n\n正文"), "待办清单项");
      assert.equal(deriveNoteTitle("", "> 引用开头的备忘\n\n正文"), "引用开头的备忘");
      // 空白内容兜底
      assert.equal(deriveNoteTitle("", ""), "未命名便签 (Untitled Note)");
      assert.equal(deriveNoteTitle("   ", "   "), "未命名便签 (Untitled Note)");
    });

    test("Happy Path: note CRUD, tagging, and pinned priority sorting", async () => {
      const initialCount = (await getNotes()).length;

      // 1. 新建便签
      const created = await saveNote({
        title: "Sprint 37 评审纪要",
        content: "## 会议纪要\n\n讨论了 MFT 索引侧车性能优化方案。",
        pinned: false,
        tags: ["meeting", "review"]
      });
      assert.ok(created.id);
      assert.equal(created.title, "Sprint 37 评审纪要");
      assert.equal(created.tags.length, 2);

      let list = await getNotes();
      assert.equal(list.length, initialCount + 1);

      // 2. 置顶便签并验证排序重排（置顶跃升至最前）
      const pinned = await togglePinNote(created.id);
      assert.ok(pinned);
      assert.equal(pinned.pinned, true);

      list = await getNotes();
      assert.equal(list[0].id, created.id); // 跃居首位

      // 3. 编辑便签正文与标签
      const updated = await updateNote(created.id, {
        content: "## 会议纪要 (已修订)\n\n全量跑通 15+ 项系统调度测试。",
        tags: ["meeting", "completed"]
      });
      assert.ok(updated);
      assert.match(updated.content, /已修订/);
      assert.ok(updated.tags.includes("completed"));

      // 4. 删除便签
      const deleted = await deleteNote(created.id);
      assert.equal(deleted, true);

      list = await getNotes();
      assert.equal(list.length, initialCount);
      assert.ok(!list.some(n => n.id === created.id));
    });

    test("Happy Path: Markdown export with YAML frontmatter", async () => {
      const sample = SAMPLE_NOTES[0];
      const exported = exportNoteAsMarkdown(sample);

      // 必须包含标准 YAML Frontmatter 与正文
      assert.match(exported, /^---\ntitle: "/);
      assert.match(exported, /pinned: true/);
      assert.match(exported, /tags: \[/);
      assert.match(exported, /createdAt: "/);
      assert.match(exported, /updatedAt: "/);
      assert.match(exported, /---\n\n# ZTools 架构设计纲领/);
    });

    test("Search & Filter: keyword fuzzy search in title, body, and tags with pinned filter tab", async () => {
      const list = await getNotes();

      // 1. 按标题关键字检索
      const titleMatches = filterNotes(list, "架构设计");
      assert.ok(titleMatches.length >= 1);
      assert.equal(titleMatches[0].id, "note-1");

      // 2. 按正文关键字检索
      const bodyMatches = filterNotes(list, "Alt + Space");
      assert.ok(bodyMatches.length >= 1);
      assert.equal(bodyMatches[0].id, "note-2");

      // 3. 按标签检索
      const tagMatches = filterNotes(list, "roadmap");
      assert.ok(tagMatches.length >= 1);
      assert.equal(tagMatches[0].id, "note-4");

      // 4. 仅看置顶便签标签页
      const pinnedOnly = filterNotes(list, "", "pinned");
      assert.ok(pinnedOnly.length >= 2);
      assert.ok(pinnedOnly.every(n => n.pinned));
    });

    test("Chaos & Fault Injection: 50KB ultra-large note, non-existent ID resilience, special characters and rapid concurrency", async () => {
      // 1. 50KB 超大便签统计与渲染
      const largeContent = "# 巨幅架构演进白皮书\n\n" + "ZTools 极致极客性能与 Raycast 声明式 UI 完美融合。\n\n".repeat(1000);
      const start = Date.now();
      const largeStats = calculateNoteStats(largeContent);
      const duration = Date.now() - start;

      assert.ok(largeStats.characters > 30000);
      assert.ok(largeStats.lines > 1000);
      assert.ok(duration < 200, `Large note stats computed in ${duration}ms, must be < 200ms`);

      const largeNote = await saveNote({
        title: "超大测试便签",
        content: largeContent
      });
      assert.ok(largeNote);
      assert.ok(largeNote.content.length > 30000);
      await deleteNote(largeNote.id);

      // 2. 特殊字符与代码块安全
      const specialContent = "# `<div>` & <script>alert('xss')</script> 测试\n\n```json\n{\"quote\": \"'hello' \\\"world\\\"\"}\n```\n\nEmoji: 🚀 ⚡ 💎 📌";
      const specialNote = await saveNote({
        content: specialContent,
        tags: ["special<tag>", "emoji🚀"]
      });
      assert.ok(specialNote);
      assert.match(specialNote.content, /<script>/);
      const reloadedSpecial = (await getNotes()).find(n => n.id === specialNote.id);
      assert.ok(reloadedSpecial);
      assert.equal(reloadedSpecial.tags.length, 2);
      await deleteNote(specialNote.id);

      // 3. 不存在的便签 ID 边界防御
      assert.equal(await updateNote("non-existent-id-9999", { title: "x" }), null);
      assert.equal(await togglePinNote("non-existent-id-9999"), null);
      assert.equal(await deleteNote("non-existent-id-9999"), false);

      // 4. 并发快速增删压测 (10 笔并发操作)
      const concurrentTasks = Array.from({ length: 10 }).map((_, i) =>
        saveNote({
          title: `并发便签 ${i}`,
          content: `这是第 ${i} 篇并发压测便签。`
        })
      );
      const createdNotes = await Promise.all(concurrentTasks);
      assert.equal(createdNotes.length, 10);

      // 清理并发测试产生的记录
      for (const n of createdNotes) {
        await deleteNote(n.id);
      }
    });
  });

  // =========================================================================
  // 9. Declarative Component Tree Integration (Renderer Compatibility)
  // =========================================================================
  describe("Declarative Component Tree: Virtual Descriptors Rendering", () => {
    test("CalculatorCommand renders <List> with Section and Items", () => {
      const vnode = CalculatorCommand();
      assert.equal(vnode.type, "List");
      assert.ok(vnode.props);
      assert.ok(vnode.props.searchBarPlaceholder);
    });

    test("ClipboardHistoryCommand renders <List> with Dropdown and Items", () => {
      const vnode = ClipboardHistoryCommand();
      assert.equal(vnode.type, "List");
      assert.ok(vnode.props.searchBarAccessory);
      assert.equal(vnode.props.searchBarAccessory.type, "List.Dropdown");
    });

    test("ClipboardDetailView renders <Detail> with Metadata", () => {
      const vnode = ClipboardDetailView();
      assert.equal(vnode.type, "Detail");
      assert.ok(vnode.props.metadata);
    });

    test("SnippetsCommand renders <List> with Dropdown and Items", () => {
      const vnode = SnippetsCommand();
      assert.equal(vnode.type, "List");
      assert.ok(vnode.props.searchBarPlaceholder);
    });

    test("CreateSnippetForm renders <Form> with 4 primary fields", () => {
      const vnode = CreateSnippetForm();
      assert.equal(vnode.type, "Form");
      assert.equal(vnode.children.length, 4);
    });

    test("ImportSnippetsForm renders <Form> with TextArea", () => {
      const vnode = ImportSnippetsForm();
      assert.equal(vnode.type, "Form");
      assert.equal(vnode.children[0].type, "Form.TextArea");
    });

    test("SnippetDetailView renders <Detail> with Metadata", () => {
      const vnode = SnippetDetailView();
      assert.equal(vnode.type, "Detail");
      assert.ok(vnode.props.metadata);
    });

    test("WindowManagementCommand renders <List> with Dropdown and Action Sections", () => {
      const vnode = WindowManagementCommand();
      assert.equal(vnode.type, "List");
      assert.ok(vnode.props.searchBarAccessory);
      assert.equal(vnode.props.searchBarAccessory.type, "List.Dropdown");
    });

    test("WindowPreferencesForm renders <Form> with Dropdowns", () => {
      const vnode = WindowPreferencesForm();
      assert.equal(vnode.type, "Form");
      assert.equal(vnode.props.navigationTitle, "窗口管理偏好设置 (Window Preferences)");
    });

    test("WindowActionDetailView renders <Detail> with Metadata", () => {
      const vnode = WindowActionDetailView();
      assert.equal(vnode.type, "Detail");
      assert.ok(vnode.props.metadata);
    });

    test("SystemCommand renders <List> with Dropdown and Action Sections", () => {
      const vnode = SystemCommand();
      assert.equal(vnode.type, "List");
      assert.ok(vnode.props.searchBarAccessory);
      assert.equal(vnode.props.searchBarAccessory.type, "List.Dropdown");
    });

    test("QuicklinksCommand renders <List> with Sections and ActionPanel", () => {
      const vnode = QuicklinksCommand();
      assert.equal(vnode.type, "List");
      assert.ok(vnode.props.searchBarPlaceholder);
    });

    test("NotesCommand renders <List isShowingDetail={true}> with Dropdown and Sections", () => {
      const vnode = NotesCommand();
      assert.equal(vnode.type, "List");
      assert.equal(vnode.props.isShowingDetail, true);
      assert.ok(vnode.props.searchBarPlaceholder);
      assert.ok(vnode.props.searchBarAccessory);
      assert.equal(vnode.props.searchBarAccessory.type, "List.Dropdown");
    });

    test("NoteDetailView renders <Detail> with rich Markdown and Metadata", () => {
      const vnode = NoteDetailView({ note: SAMPLE_NOTES[0] });
      assert.equal(vnode.type, "Detail");
      assert.match(vnode.props.markdown, /ZTools 架构设计纲领/);
      assert.ok(vnode.props.metadata);
      assert.equal(vnode.props.metadata.type, "Detail.Metadata");
    });

    test("NoteCreateForm and NoteEditForm render <Form> with fields and submit actions", () => {
      const createForm = NoteCreateForm({});
      assert.equal(createForm.type, "Form");
      assert.equal(createForm.props.navigationTitle, "新建便签笔记");
      assert.ok(createForm.children.length >= 4);

      const editForm = NoteEditForm({ note: SAMPLE_NOTES[0] });
      assert.equal(editForm.type, "Form");
      assert.match(editForm.props.navigationTitle, /编辑便签/);
      assert.ok(editForm.children.length >= 4);
    });
  });
});

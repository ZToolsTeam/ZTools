import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  renderDeclarativeRoot,
  LocalStorage,
  Clipboard,
  // 12. clipboard-history
  ClipboardHistoryCommand,
  ClipboardDetailView,
  getClipboardHistory,
  saveClipboardHistory,
  filterClipboardItems,
  formatCopiedTime,
  SAMPLE_CLIPBOARD_ITEMS,
  // 13. snippets
  SnippetsCommand,
  SnippetDetailView,
  CreateSnippetForm,
  getSnippets,
  saveSnippets,
  filterSnippets,
  expandSnippetTemplate,
  SAMPLE_SNIPPETS,
  // 14. window-management
  WindowManagementCommand,
  WindowActionDetailView,
  WINDOW_ACTIONS,
  filterWindowActions
} from "../dist/index.js";

describe("Raycast Compat: Official Built-in Core Applications Suite", () => {
  beforeEach(async () => {
    await LocalStorage.clear();
  });

  // ============================================================================
  // 1. 剪贴板历史 (Clipboard History) 深度测试
  // ============================================================================
  describe("App 1: Clipboard History (官方内置核心能力)", () => {
    test("filterClipboardItems filters by type, search query and pinned status", () => {
      // 1. All items
      const all = filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { type: "all" });
      assert.equal(all.length, SAMPLE_CLIPBOARD_ITEMS.length);
      // Pinned items should come first
      assert.equal(all[0].pinned, true);

      // 2. Filter by category
      const codeOnly = filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { type: "code" });
      assert.equal(codeOnly.length, 1);
      assert.equal(codeOnly[0].type, "code");

      const imagesOnly = filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { type: "image" });
      assert.equal(imagesOnly.length, 1);
      assert.equal(imagesOnly[0].type, "image");

      const pinnedOnly = filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { type: "pinned" });
      assert.ok(pinnedOnly.length >= 2);
      assert.ok(pinnedOnly.every(item => item.pinned));

      // 3. Search query matching
      const searchRes = filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { query: "现代化架构" });
      assert.equal(searchRes.length, 1);
      assert.match(searchRes[0].content, /现代化架构/);

      // 4. Search file path
      const fileRes = filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { query: "hosts" });
      assert.equal(fileRes.length, 1);
      assert.equal(fileRes[0].type, "files");

      // 5. Non-matching search query (Beyond Happy Path)
      const emptyRes = filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { query: "NonExistentString12345" });
      assert.equal(emptyRes.length, 0);

      // 6. Empty query handling
      const emptyQueryRes = filterClipboardItems(SAMPLE_CLIPBOARD_ITEMS, { query: "   " });
      assert.equal(emptyQueryRes.length, SAMPLE_CLIPBOARD_ITEMS.length);
    });

    test("formatCopiedTime handles boundaries from seconds to days", () => {
      const now = Date.now();
      assert.equal(formatCopiedTime(now - 1000 * 10), "刚刚");
      assert.equal(formatCopiedTime(now - 1000 * 60 * 5), "5 分钟前");
      assert.equal(formatCopiedTime(now - 1000 * 60 * 60 * 3), "3 小时前");
      assert.equal(formatCopiedTime(now - 1000 * 60 * 60 * 24 * 4), "4 天前");
    });

    test("ClipboardHistoryCommand mounts and renders List with Dropdown and Items", () => {
      const root = renderDeclarativeRoot(ClipboardHistoryCommand);
      const desc = root.getLatest();

      assert.equal(desc.type, "List");
      assert.match(desc.props.searchBarPlaceholder, /搜索剪贴板历史/);

      // Check Dropdown
      const dropdown = desc.props.searchBarAccessory;
      assert.equal(dropdown.type, "List.Dropdown");
      assert.ok(dropdown.children.length >= 6);

      // Check List.Section
      const sec = desc.children[0];
      assert.equal(sec.type, "List.Section");
      assert.ok(sec.children.length >= 5);

      const firstItem = sec.children[0];
      assert.equal(firstItem.type, "List.Item");
      assert.ok(firstItem.props.title);
      assert.ok(firstItem.props.actions);

      root.unmount();
    });

    test("ClipboardDetailView renders code, image, files and metadata", () => {
      // Code item detail
      const codeItem = SAMPLE_CLIPBOARD_ITEMS.find(i => i.type === "code");
      const root1 = renderDeclarativeRoot(() => ClipboardDetailView({ item: codeItem }));
      const desc1 = root1.getLatest();

      assert.equal(desc1.type, "Detail");
      assert.match(desc1.props.markdown, /```typescript/);
      assert.equal(desc1.props.metadata.type, "Detail.Metadata");
      root1.unmount();

      // Files item detail
      const filesItem = SAMPLE_CLIPBOARD_ITEMS.find(i => i.type === "files");
      const root2 = renderDeclarativeRoot(() => ClipboardDetailView({ item: filesItem }));
      const desc2 = root2.getLatest();
      assert.match(desc2.props.markdown, /包含的文件列表/);
      root2.unmount();
    });

    test("ClipboardHistoryCommand handles search, pin toggle, delete and clear unpinned", async () => {
      const root = renderDeclarativeRoot(ClipboardHistoryCommand);
      let desc = root.getLatest();

      // 1. Search text change
      desc.props.onSearchTextChange("现代化架构");
      await new Promise(r => queueMicrotask(r));
      desc = root.getLatest();

      let sec = desc.children[0];
      assert.equal(sec.children.length, 1);
      assert.match(sec.children[0].props.title, /现代化架构/);

      // Reset search
      desc.props.onSearchTextChange("");
      await new Promise(r => queueMicrotask(r));
      desc = root.getLatest();
      sec = desc.children[0];

      // 2. Dropdown switch to "code"
      desc.props.searchBarAccessory.props.onChange("code");
      await new Promise(r => queueMicrotask(r));
      desc = root.getLatest();
      sec = desc.children[0];
      assert.equal(sec.children.length, 1);
      assert.equal(sec.children[0].props.accessories.some(a => a.text === "CODE"), true);

      // Switch back to "all"
      desc.props.searchBarAccessory.props.onChange("all");
      await new Promise(r => queueMicrotask(r));
      desc = root.getLatest();
      sec = desc.children[0];

      // 3. Toggle pin on an item
      const itemToPin = sec.children.find(it => it.props.id === "clip-2");
      assert.ok(itemToPin);
      const pinAction = itemToPin.props.actions.children.find(a => a.props.title?.includes("置顶"));
      assert.ok(pinAction);
      await pinAction.props.onAction();
      await new Promise(r => queueMicrotask(r));

      desc = root.getLatest();
      sec = desc.children[0];
      const pinnedItem = sec.children.find(it => it.props.id === "clip-2");
      assert.ok(pinnedItem.props.accessories.some(a => a.tooltip === "已置顶"));

      // 4. Delete an item
      const itemToDelete = sec.children.find(it => it.props.id === "clip-4");
      assert.ok(itemToDelete);
      const deleteAction = itemToDelete.props.actions.children.find(a => a.props.title === "删除该记录");
      assert.ok(deleteAction);
      await deleteAction.props.onAction();
      await new Promise(r => queueMicrotask(r));

      desc = root.getLatest();
      sec = desc.children[0];
      assert.equal(sec.children.some(it => it.props.id === "clip-4"), false);

      // 5. Clear all unpinned
      const firstAvailable = sec.children[0];
      const clearAction = firstAvailable.props.actions.children.find(a => a.props.title === "清空所有未置顶记录");
      assert.ok(clearAction);
      await clearAction.props.onAction();
      await new Promise(r => queueMicrotask(r));

      desc = root.getLatest();
      sec = desc.children[0];
      // All remaining items must be pinned
      assert.ok(sec.children.every(it => it.props.accessories.some(a => a.tooltip === "已置顶")));

      root.unmount();
    });
  });

  // ============================================================================
  // 2. Snippets 文本扩展深度测试
  // ============================================================================
  describe("App 2: Snippets 文本扩展 (官方内置核心能力)", () => {
    test("expandSnippetTemplate parses dynamic placeholders and handles edge cases", () => {
      // 1. Basic text without variables
      const res1 = expandSnippetTemplate("Plain Hello World");
      assert.equal(res1.expanded, "Plain Hello World");
      assert.equal(res1.cursorOffset, 0);

      // 2. Clipboard placeholder
      const res2 = expandSnippetTemplate("Copied: {clipboard}", "Antigravity Agent");
      assert.equal(res2.expanded, "Copied: Antigravity Agent");
      assert.equal(res2.cursorOffset, 0);

      // 3. Date and Time placeholders
      const today = new Date().toISOString().slice(0, 10);
      const res3 = expandSnippetTemplate("Log [{date}] [{time}]");
      assert.ok(res3.expanded.includes(`[${today}]`));

      // 4. Cursor offset calculation
      const res4 = expandSnippetTemplate("console.log('{cursor}');");
      assert.equal(res4.expanded, "console.log('');");
      assert.equal(res4.cursorOffset, 3); // 向左 3 个字符到达单引号内部

      // 5. Fault Injection & Malformed Placeholders (Beyond Happy Path)
      // Unclosed brace
      const res5 = expandSnippetTemplate("Malformed {date without closing");
      assert.equal(res5.expanded, "Malformed {date without closing");

      // Empty template
      const res6 = expandSnippetTemplate("");
      assert.equal(res6.expanded, "");
      assert.equal(res6.cursorOffset, 0);

      // Multiple cursors (first one defines cursorOffset)
      const res7 = expandSnippetTemplate("A{cursor}B");
      assert.equal(res7.expanded, "AB");
      assert.equal(res7.cursorOffset, 1);
    });

    test("filterSnippets filters by query and enabled status", () => {
      // 1. All
      const all = filterSnippets(SAMPLE_SNIPPETS, {});
      assert.equal(all.length, SAMPLE_SNIPPETS.length);

      // 2. Enabled only
      const enabledOnly = filterSnippets(SAMPLE_SNIPPETS, { enabledOnly: true });
      assert.ok(enabledOnly.length < SAMPLE_SNIPPETS.length);
      assert.ok(enabledOnly.every(s => s.enabled));

      // 3. Search by keyword
      const keywordRes = filterSnippets(SAMPLE_SNIPPETS, { query: ":shrug" });
      assert.equal(keywordRes.length, 1);
      assert.equal(keywordRes[0].keyword, ":shrug");

      // 4. Search by name
      const nameRes = filterSnippets(SAMPLE_SNIPPETS, { query: "邮箱" });
      assert.equal(nameRes.length, 1);

      // 5. Non-matching query (Beyond Happy Path)
      const emptyRes = filterSnippets(SAMPLE_SNIPPETS, { query: "InvalidKeyword999" });
      assert.equal(emptyRes.length, 0);
    });

    test("SnippetsCommand mounts and renders List", () => {
      const root = renderDeclarativeRoot(SnippetsCommand);
      const desc = root.getLatest();

      assert.equal(desc.type, "List");
      assert.match(desc.props.searchBarPlaceholder, /搜索 Snippets/);

      const sec = desc.children[0];
      assert.equal(sec.type, "List.Section");
      assert.ok(sec.children.length >= 4);

      root.unmount();
    });

    test("SnippetDetailView and CreateSnippetForm mount and render correctly", () => {
      // Detail view
      const snippet = SAMPLE_SNIPPETS[0];
      const root1 = renderDeclarativeRoot(() => SnippetDetailView({ snippet }));
      const desc1 = root1.getLatest();

      assert.equal(desc1.type, "Detail");
      assert.match(desc1.props.markdown, /Snippet:/);
      assert.equal(desc1.props.metadata.type, "Detail.Metadata");
      root1.unmount();

      // Create form
      const root2 = renderDeclarativeRoot(() => CreateSnippetForm());
      const desc2 = root2.getLatest();
      assert.equal(desc2.type, "Form");
      assert.equal(desc2.children.length, 4);
      assert.equal(desc2.children[0].props.id, "name");
      assert.equal(desc2.children[1].props.id, "keyword");
      assert.equal(desc2.children[2].props.id, "snippet");
      assert.equal(desc2.children[3].props.id, "enabled");
      root2.unmount();
    });

    test("CreateSnippetForm handles submission and rejects invalid inputs (Beyond Happy Path)", async () => {
      let savedSnippet = null;
      const root = renderDeclarativeRoot(() => CreateSnippetForm({
        onSaved: (snip) => { savedSnippet = snip; }
      }));
      const desc = root.getLatest();
      const submitAction = desc.props.actions.children[0];
      assert.ok(submitAction);

      // 1. Reject empty form
      await submitAction.props.onSubmit({});
      assert.equal(savedSnippet, null, "Should reject empty form values");

      // 2. Reject missing keyword
      await submitAction.props.onSubmit({ name: "Test", snippet: "content" });
      assert.equal(savedSnippet, null, "Should reject missing keyword");

      // 3. Valid submission
      await submitAction.props.onSubmit({
        name: "My Custom Snippet",
        keyword: ":custom",
        snippet: "Expanded text for custom",
        enabled: true
      });
      assert.ok(savedSnippet);
      assert.equal(savedSnippet.name, "My Custom Snippet");
      assert.equal(savedSnippet.keyword, ":custom");
      assert.equal(savedSnippet.snippet, "Expanded text for custom");
      assert.equal(savedSnippet.enabled, true);

      root.unmount();
    });

    test("SnippetsCommand handles search, filter, toggle and deletion", async () => {
      const root = renderDeclarativeRoot(SnippetsCommand);
      let desc = root.getLatest();

      // 1. Search text change
      desc.props.onSearchTextChange(":journal");
      await new Promise(r => queueMicrotask(r));
      desc = root.getLatest();
      let sec = desc.children[0];
      assert.equal(sec.children.length, 1);
      assert.equal(sec.children[0].props.subtitle, ":journal");

      // Reset search
      desc.props.onSearchTextChange("");
      await new Promise(r => queueMicrotask(r));
      desc = root.getLatest();
      sec = desc.children[0];

      // 2. Filter enabled only
      desc.props.searchBarAccessory.props.onChange("enabled");
      await new Promise(r => queueMicrotask(r));
      desc = root.getLatest();
      sec = desc.children[0];
      assert.ok(sec.children.every(it => it.props.accessories.some(a => a.tooltip === "已激活")));

      // Reset filter
      desc.props.searchBarAccessory.props.onChange("all");
      await new Promise(r => queueMicrotask(r));
      desc = root.getLatest();
      sec = desc.children[0];

      // 3. Toggle enabled status of a snippet
      const targetSnippet = sec.children.find(it => it.props.id === "snip-2");
      assert.ok(targetSnippet);
      const toggleAction = targetSnippet.props.actions.children.find(a => a.props.title?.includes("该指令"));
      assert.ok(toggleAction);
      await toggleAction.props.onAction();
      await new Promise(r => queueMicrotask(r));

      desc = root.getLatest();
      sec = desc.children[0];
      const toggledItem = sec.children.find(it => it.props.id === "snip-2");
      assert.ok(toggledItem.props.accessories.some(a => a.tooltip === "已停用"));

      // 4. Delete snippet
      const deleteAction = toggledItem.props.actions.children.find(a => a.props.title === "删除 Snippet");
      assert.ok(deleteAction);
      await deleteAction.props.onAction();
      await new Promise(r => queueMicrotask(r));

      desc = root.getLatest();
      sec = desc.children[0];
      assert.equal(sec.children.some(it => it.props.id === "snip-2"), false);

      root.unmount();
    });
  });

  // ============================================================================
  // 3. Window Management (窗口管理) 深度测试
  // ============================================================================
  describe("App 3: Window Management 窗口管理器 (官方内置核心能力)", () => {
    test("WINDOW_ACTIONS catalogue completeness and attributes integrity", () => {
      assert.ok(WINDOW_ACTIONS.length >= 15, "Must contain all 15 core window actions");

      const requiredActions = [
        "left-half", "right-half", "top-half", "bottom-half",
        "maximize", "restore", "center",
        "first-third", "center-third", "last-third",
        "first-two-thirds", "last-two-thirds",
        "make-larger", "make-smaller",
        "next-display", "previous-display"
      ];

      for (const req of requiredActions) {
        const found = WINDOW_ACTIONS.find(a => a.id === req);
        assert.ok(found, `Action ${req} must exist`);
        assert.ok(found.name.length > 0);
        assert.ok(found.description.length > 0);
        assert.ok(found.shortcut?.length > 0);
      }
    });

    test("filterWindowActions filters by category and search query", () => {
      // 1. All
      const all = filterWindowActions(WINDOW_ACTIONS, { category: "all" });
      assert.equal(all.length, WINDOW_ACTIONS.length);

      // 2. Category halves
      const halves = filterWindowActions(WINDOW_ACTIONS, { category: "halves" });
      assert.equal(halves.length, WINDOW_ACTIONS.filter(a => a.category === "halves").length);
      assert.ok(halves.every(a => a.category === "halves"));

      // 3. Category thirds
      const thirds = filterWindowActions(WINDOW_ACTIONS, { category: "thirds" });
      assert.equal(thirds.length, WINDOW_ACTIONS.filter(a => a.category === "thirds").length);

      // 4. Search by action name
      const searchRes = filterWindowActions(WINDOW_ACTIONS, { query: "左半屏" });
      assert.equal(searchRes.length, 1);
      assert.equal(searchRes[0].id, "left-half");

      // 5. Search by shortcut
      const shortcutRes = filterWindowActions(WINDOW_ACTIONS, { query: "Ctrl + Alt + Return" });
      assert.equal(shortcutRes.length, 1);
      assert.equal(shortcutRes[0].id, "maximize");

      // 6. Beyond Happy Path: Empty query and non-matching query
      const emptyQuery = filterWindowActions(WINDOW_ACTIONS, { query: "   " });
      assert.equal(emptyQuery.length, WINDOW_ACTIONS.length);

      const noMatch = filterWindowActions(WINDOW_ACTIONS, { query: "UnknownNonExistentWindowOperation" });
      assert.equal(noMatch.length, 0);
    });

    test("WindowManagementCommand mounts and renders List with all sections", () => {
      const root = renderDeclarativeRoot(WindowManagementCommand);
      const desc = root.getLatest();

      assert.equal(desc.type, "List");
      assert.match(desc.props.searchBarPlaceholder, /搜索窗口管理动作/);

      // Check Dropdown
      const dropdown = desc.props.searchBarAccessory;
      assert.equal(dropdown.type, "List.Dropdown");
      assert.ok(dropdown.children.length >= 6);

      // Check Sections (halves, thirds, center-max, displays, resize)
      assert.ok(desc.children.length >= 4);
      assert.match(desc.children[0].props.title, /半屏对齐/);

      root.unmount();
    });

    test("WindowActionDetailView renders markdown and technical UIAccess metadata", () => {
      const action = WINDOW_ACTIONS.find(a => a.id === "left-half");
      const root = renderDeclarativeRoot(() => WindowActionDetailView({ action }));
      const desc = root.getLatest();

      assert.equal(desc.type, "Detail");
      assert.match(desc.props.markdown, /窗口管理动作: 左半屏/);
      assert.match(desc.props.markdown, /ztools-uiaccess/);
      assert.match(desc.props.markdown, /GetForegroundWindow/);
      assert.equal(desc.props.metadata.type, "Detail.Metadata");

      root.unmount();
    });

    test("WindowManagementCommand handles category filtering and search", async () => {
      const root = renderDeclarativeRoot(WindowManagementCommand);
      let desc = root.getLatest();

      // 1. Search action
      desc.props.onSearchTextChange("最大化");
      await new Promise(r => queueMicrotask(r));
      desc = root.getLatest();

      // Only center & maximize section should be present
      assert.equal(desc.children.length, 1);
      assert.match(desc.children[0].props.title, /居中与/);
      assert.equal(desc.children[0].children[0].props.id, "maximize");

      // 2. Trigger action execution
      const maxAction = desc.children[0].children[0].props.actions.children[0];
      assert.ok(maxAction);
      await maxAction.props.onAction();

      // 3. Category switch via dropdown
      desc.props.onSearchTextChange("");
      desc.props.searchBarAccessory.props.onChange("displays");
      await new Promise(r => queueMicrotask(r));
      desc = root.getLatest();

      assert.equal(desc.children.length, 1);
      assert.match(desc.children[0].props.title, /跨显示器调度/);
      assert.equal(desc.children[0].children.length, WINDOW_ACTIONS.filter(a => a.category === "displays").length);

      root.unmount();
    });

    test("WindowManagementCommand renders semantic icons and double-column detail with Bridge integration", async () => {
      let executedAction = null;
      // Inject bridge mock to verify genuine Win32 dispatch
      globalThis.__ZTOOLS_RAYCAST_BRIDGE__ = {
        manageWindow: async (act) => { executedAction = act; return true; }
      };

      const root = renderDeclarativeRoot(WindowManagementCommand);
      const desc = root.getLatest();

      // Check double-column detail prop
      assert.equal(desc.props.isShowingDetail, true);

      const firstSec = desc.children[0];
      const firstItem = firstSec.children[0];

      // Check semantic icon is NOT the generic circle
      assert.ok(firstItem.props.icon);
      assert.notEqual(firstItem.props.icon.name, "circle");

      // Check item detail component
      assert.ok(firstItem.props.detail);
      assert.equal(firstItem.props.detail.type, "List.Item.Detail");
      assert.match(firstItem.props.detail.props.markdown, /左半屏/);

      // Trigger execution via Primary Action
      const primaryAction = firstItem.props.actions.children[0];
      assert.ok(primaryAction);
      await primaryAction.props.onAction();
      assert.equal(executedAction, "left-half", "Bridge manageWindow should be invoked with left-half");

      root.unmount();
      delete globalThis.__ZTOOLS_RAYCAST_BRIDGE__;
    });
  });

  // ============================================================================
  // 4. Raycast UI & Functional Full Alignment Verification Suite
  // ============================================================================
  describe("App Full Alignment: Raycast Primary Action & Double-Column Detail", () => {
    test("Clipboard History: Primary action is Action.Paste and detail view is active", async () => {
      let pastedContent = null;
      globalThis.__ZTOOLS_RAYCAST_BRIDGE__ = {
        pasteToActive: async (text) => { pastedContent = text; }
      };

      const root = renderDeclarativeRoot(ClipboardHistoryCommand);
      const desc = root.getLatest();

      assert.equal(desc.props.isShowingDetail, true, "isShowingDetail should be enabled by default");

      const sec = desc.children[0];
      const item = sec.children[0];

      // Verify List.Item.Detail
      assert.ok(item.props.detail);
      assert.equal(item.props.detail.type, "List.Item.Detail");
      assert.ok(item.props.detail.props.metadata);

      // Verify Primary Action is Action.Paste
      const primaryAction = item.props.actions.children[0];
      assert.equal(primaryAction.type, "Action.Paste");
      assert.match(primaryAction.props.title, /Paste to Active/);
      assert.ok(primaryAction.props.content.includes("calculateFrecency"), "Should paste full original code content");

      // Execute primary paste action
      await Clipboard.paste(primaryAction.props.content);
      assert.equal(pastedContent, primaryAction.props.content);

      root.unmount();
      delete globalThis.__ZTOOLS_RAYCAST_BRIDGE__;
    });

    test("Snippets: Supports {datetime} and {uuid} macros and Action.Paste primary action", async () => {
      // 1. New macros test
      const resDatetime = expandSnippetTemplate("Time: {datetime}");
      assert.match(resDatetime.expanded, /Time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);

      const resUuid = expandSnippetTemplate("ID: {uuid}");
      assert.match(resUuid.expanded, /ID: [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/);

      // 2. Component structure
      const root = renderDeclarativeRoot(SnippetsCommand);
      const desc = root.getLatest();

      assert.equal(desc.props.isShowingDetail, true);

      const sec = desc.children[0];
      const item = sec.children[0];

      assert.ok(item.props.detail);
      assert.equal(item.props.detail.type, "List.Item.Detail");

      // Verify Primary Action is Action.Paste with expanded text
      const primaryAction = item.props.actions.children[0];
      assert.equal(primaryAction.type, "Action.Paste");
      assert.match(primaryAction.props.title, /Paste to Active/);

      root.unmount();
    });
  });
});

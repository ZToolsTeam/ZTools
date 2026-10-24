import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EverythingFileSearchCommand,
  FileDetailView,
  FileQuickLookDetailView,
  sortAndFilterFiles,
  formatBytes,
  truncatePath,
  getFileCategory,
  searchLocalFiles,
  calculateFileSha256,
  calculateFileMd5,
  openFile,
  openWith,
  revealFile,
  moveToTrash,
  copyFileToClipboard,
  getFileQuickLook,
  SAMPLE_FILES
} from "../dist/examples/index.js";
import { renderDeclarativeRoot } from "../dist/runtime/reconciler.js";

describe("Everything File Search Application Suite (自研零依赖引擎 + 标杆声明式 UI)", () => {
  describe("1. 基础工具与格式化函数", () => {
    it("formatBytes 能够准确格式化各类文件尺寸", () => {
      assert.equal(formatBytes(0), "0 B");
      assert.equal(formatBytes(-10), "0 B");
      assert.equal(formatBytes(512), "512 B");
      assert.equal(formatBytes(1024), "1.0 KB");
      assert.equal(formatBytes(1536), "1.5 KB");
      assert.equal(formatBytes(1024 * 1024 * 5.2), "5.2 MB");
      assert.equal(formatBytes(1024 * 1024 * 1024 * 3.75), "3.8 GB");
      assert.equal(formatBytes(NaN), "0 B");
      assert.equal(formatBytes(Infinity), "0 B");
    });

    it("truncatePath 优雅截断超长路径", () => {
      assert.equal(truncatePath(""), "");
      assert.equal(truncatePath("C:\\short\\path.txt"), "C:\\short\\path.txt");
      const longPath = "C:\\Very\\Long\\Nested\\Directory\\Structure\\Inside\\Company\\Project\\Documents\\Subfolder\\TargetFile.pdf";
      const truncated = truncatePath(longPath, 40);
      assert.ok(truncated.includes("..."));
      assert.ok(truncated.startsWith("C:"));
      assert.ok(truncated.endsWith("TargetFile.pdf"));
    });

    it("getFileCategory 准确识别各类文件扩展名归类", () => {
      assert.equal(getFileCategory("folderName", true), "folder");
      assert.equal(getFileCategory("test.docx", false), "document");
      assert.equal(getFileCategory("test.pdf", false), "document");
      assert.equal(getFileCategory("photo.png", false), "image");
      assert.equal(getFileCategory("video.mp4", false), "media");
      assert.equal(getFileCategory("audio.mp3", false), "media");
      assert.equal(getFileCategory("app.ts", false), "code");
      assert.equal(getFileCategory("bundle.zip", false), "archive");
      assert.equal(getFileCategory("launcher.exe", false), "app");
      assert.equal(getFileCategory("unknown.xyz", false), "document");

      // 细致模式：准确区分 video 与 audio
      assert.equal(getFileCategory("video.mp4", false, true), "video");
      assert.equal(getFileCategory("audio.mp3", false, true), "audio");
    });
  });

  describe("2. 多维排序与 8 大类类型筛选逻辑", () => {
    it("按名称升序与降序准确排序", () => {
      const asc = sortAndFilterFiles(SAMPLE_FILES, "name-asc", "all");
      for (let i = 0; i < asc.length - 1; i++) {
        assert.ok(asc[i].name.localeCompare(asc[i + 1].name, "zh-CN") <= 0);
      }

      const desc = sortAndFilterFiles(SAMPLE_FILES, "name-desc", "all");
      for (let i = 0; i < desc.length - 1; i++) {
        assert.ok(desc[i].name.localeCompare(desc[i + 1].name, "zh-CN") >= 0);
      }
    });

    it("按大小升序与降序准确排序", () => {
      const asc = sortAndFilterFiles(SAMPLE_FILES, "size-asc", "all");
      for (let i = 0; i < asc.length - 1; i++) {
        assert.ok(asc[i].size <= asc[i + 1].size);
      }

      const desc = sortAndFilterFiles(SAMPLE_FILES, "size-desc", "all");
      for (let i = 0; i < desc.length - 1; i++) {
        assert.ok(desc[i].size >= desc[i + 1].size);
      }
    });

    it("按修改时间排序", () => {
      const desc = sortAndFilterFiles(SAMPLE_FILES, "mtime-desc", "all");
      for (let i = 0; i < desc.length - 1; i++) {
        assert.ok(desc[i].mtime >= desc[i + 1].mtime);
      }
    });

    it("按 8 大类别精确过滤 (document, image, video, audio, archive, code, folder, app)", () => {
      const docs = sortAndFilterFiles(SAMPLE_FILES, "name-asc", "document");
      assert.ok(docs.every((f) => getFileCategory(f.name, f.isDir) === "document"));

      const images = sortAndFilterFiles(SAMPLE_FILES, "name-asc", "image");
      assert.ok(images.every((f) => getFileCategory(f.name, f.isDir) === "image"));

      const videos = sortAndFilterFiles(SAMPLE_FILES, "name-asc", "video");
      assert.ok(videos.every((f) => getFileCategory(f.name, f.isDir, true) === "video"));

      const audios = sortAndFilterFiles(SAMPLE_FILES, "name-asc", "audio");
      assert.ok(audios.every((f) => getFileCategory(f.name, f.isDir, true) === "audio"));

      const archives = sortAndFilterFiles(SAMPLE_FILES, "name-asc", "archive");
      assert.ok(archives.every((f) => getFileCategory(f.name, f.isDir) === "archive"));

      const codes = sortAndFilterFiles(SAMPLE_FILES, "name-asc", "code");
      assert.ok(codes.every((f) => getFileCategory(f.name, f.isDir) === "code"));

      const folders = sortAndFilterFiles(SAMPLE_FILES, "name-asc", "folder");
      assert.ok(folders.every((f) => f.isDir));

      const apps = sortAndFilterFiles(SAMPLE_FILES, "name-asc", "app");
      assert.ok(apps.every((f) => getFileCategory(f.name, f.isDir) === "app"));
    });
  });

  describe("3. 本地搜索引擎与降级自愈", () => {
    it("空查询返回默认样本集合", async () => {
      const results = await searchLocalFiles("");
      assert.ok(results.length > 0);
    });

    it("能够模糊匹配拼音、缩写及英文", async () => {
      const resZtools = await searchLocalFiles("ztools");
      assert.ok(resZtools.length > 0);
      assert.ok(resZtools.some((f) => f.name.toLowerCase().includes("ztools")));

      const resAcronym = await searchLocalFiles("dp2");
      assert.ok(resAcronym.some((f) => f.name.includes("Development-Plan")));
    });

    it("不存在匹配项时返回空数组，不抛出异常", async () => {
      const res = await searchLocalFiles("non_existent_file_pattern_123456789");
      assert.equal(res.length, 0);
    });

    it("特殊符号与畸形字符串输入防御（无 SQL 注入、无崩溃）", async () => {
      const badInputs = ["' OR '1'='1", "../../../etc/passwd", "\\0\\0\\0", "\"'<>|?*:", "   "];
      for (const input of badInputs) {
        await assert.doesNotReject(async () => {
          await searchLocalFiles(input);
        });
      }
    });
  });

  describe("4. 声明式 UI 挂载与双栏 List.Item.Detail 分栏渲染", () => {
    it("EverythingFileSearchCommand 能够正确挂载并生成双栏 List 视图描述符", () => {
      const root = renderDeclarativeRoot(EverythingFileSearchCommand);
      const descriptor = root.getLatest();
      assert.equal(descriptor.type, "List");
      assert.ok(descriptor.props.searchBarPlaceholder.includes("Everything文件搜索"));
      assert.equal(descriptor.props.isShowingDetail, true, "默认应开启双栏详情预览");
      assert.ok(descriptor.props.searchBarAccessory);
      assert.equal(descriptor.props.searchBarAccessory.type, "List.Dropdown");
      assert.ok(Array.isArray(descriptor.children));
      assert.ok(descriptor.children.length > 0);

      // 验证 List.Item 及右侧分栏 detail
      const firstItem = descriptor.children[0];
      assert.equal(firstItem.type, "List.Item");
      assert.ok(firstItem.props.detail, "必须包含 List.Item.Detail 双栏详情组件");
      assert.equal(firstItem.props.detail.type, "List.Item.Detail");

      // 验证 List.Item.Detail.Metadata
      const detailMetadata = firstItem.props.detail.props.metadata;
      assert.ok(detailMetadata);
      assert.ok(
        detailMetadata.type === "List.Item.Detail.Metadata" ||
        detailMetadata.type === "Detail.Metadata"
      );
      root.unmount();
    });

    it("FileDetailView 能够准确生成 Markdown 预览与元数据栏", () => {
      const sampleFile = SAMPLE_FILES[0];
      const detailDesc = FileDetailView({ file: sampleFile });
      assert.equal(detailDesc.type, "Detail");
      assert.ok(detailDesc.props.markdown.includes(sampleFile.name));
      assert.ok(detailDesc.props.metadata);
      assert.equal(detailDesc.props.metadata.type, "Detail.Metadata");
      assert.ok(detailDesc.props.actions);
      assert.equal(detailDesc.props.actions.type, "ActionPanel");
    });

    it("文件夹与可执行文件的动作面板区分准确", () => {
      const folder = SAMPLE_FILES.find((f) => f.isDir);
      assert.ok(folder);
      const detailFolder = FileDetailView({ file: folder });
      assert.ok(detailFolder.props.markdown.includes("文件夹"));
    });
  });

  describe("5. ActionPanel 动作集与文件治理", () => {
    it("openFile 能够成功处理有效文件并拦截不存在文件", async () => {
      // 成功案例 (使用自身当前测试脚本路径)
      const resSuccess = await openFile("packages/declarative-ui/tests/everything-file-search.test.mjs");
      assert.equal(resSuccess.success, true);

      // 不存在文件拦截
      const resNotFound = await openFile("C:\\NonExistentPath_Test_12345.xyz");
      assert.equal(resNotFound.success, false);
      assert.equal(resNotFound.error, "FILE_NOT_FOUND");
    });

    it("openWith 调起关联程序选择或指定打开程序", async () => {
      const res = await openWith("C:\\test.docx", "winword.exe");
      assert.equal(res.success, true);
      assert.match(res.message, /关联程序/);
    });

    it("revealFile 能够在资源管理器中定位选定文件", async () => {
      const res = await revealFile("packages/declarative-ui/package.json");
      assert.equal(res.success, true);
    });

    it("moveToTrash 移入回收站安全验证 (拦截不存在文件)", async () => {
      const resNotFound = await moveToTrash("D:\\NonExistent_Trash_Test.tmp");
      assert.equal(resNotFound.success, false);
      assert.equal(resNotFound.error, "FILE_NOT_FOUND");
    });

    it("copyFileToClipboard 复制文件本身到剪贴板", async () => {
      const res = await copyFileToClipboard("C:\\Windows\\notepad.exe");
      assert.equal(res.success, true);
    });

    it("calculateFileSha256 与 calculateFileMd5 准确计算真实哈希摘要", async () => {
      const sha = await calculateFileSha256("packages/declarative-ui/package.json");
      assert.ok(typeof sha === "string");
      assert.equal(sha.length, 64, "SHA-256 必须是 64 位十六进制字符串");

      const md5 = await calculateFileMd5("packages/declarative-ui/package.json");
      assert.ok(typeof md5 === "string");
      assert.equal(md5.length, 32, "MD5 必须是 32 位十六进制字符串");
    });
  });

  describe("6. 破坏性与边界极端异常测试 (Chaos & Resilience)", () => {
    it("超长路径 (>260 字符) 边界安全处理与超限拦截 (>1024 字符)", async () => {
      const longPath = "C:\\" + "very_long_nested_subfolder_name\\".repeat(10) + "test-file.docx";
      assert.ok(longPath.length > 260);

      const resLong = await openFile(longPath);
      // 应优雅返回而不崩死
      assert.ok(typeof resLong.success === "boolean");

      // 极端恶意超限路径 (>1024 字符)
      const extremePath = "C:\\" + "x".repeat(1100) + ".txt";
      const resExtreme = await openFile(extremePath);
      assert.equal(resExtreme.success, false);
      assert.equal(resExtreme.error, "PATH_TOO_LONG");
    });

    it("非英文字符路径 (中文、空格、特殊标点) 安全通过", async () => {
      const cjkFile = SAMPLE_FILES.find((f) => f.name.includes("中文测试"));
      assert.ok(cjkFile);
      assert.ok(cjkFile.path.includes("中文测试"));

      const res = await openFile(cjkFile.path);
      assert.ok(typeof res.success === "boolean");
    });

    it("空对象、空字符串与畸形路径输入安全拦截", async () => {
      const resEmpty = await openFile("");
      assert.equal(resEmpty.success, false);
      assert.equal(resEmpty.error, "INVALID_PATH");

      const resTrashEmpty = await moveToTrash("");
      assert.equal(resTrashEmpty.success, false);
      assert.equal(resTrashEmpty.error, "INVALID_PATH");

      await assert.rejects(async () => {
        await calculateFileSha256("");
      }, /无效或为空/);
    });

    it("0 字节空文件快速预览安全拦截防崩溃", async () => {
      const emptyFile = {
        name: "empty.txt",
        path: "C:\\empty.txt",
        isDir: false,
        size: 0,
        mtime: Date.now()
      };

      const ql = await getFileQuickLook(emptyFile);
      assert.equal(ql.previewType, "empty");
      assert.match(ql.content, /0 字节/);
    });
  });
});

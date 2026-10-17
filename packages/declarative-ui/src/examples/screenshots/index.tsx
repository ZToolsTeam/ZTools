/**
 * Windows Screenshots (截图历史与文字识别 OCR 中枢)
 * 
 * 深度对齐 Raycast Windows 截图管理与 OCR 识别规范：
 * - 自动检测与列出系统默认截图目录 (Pictures/Screenshots) 中的最近截图
 * - 双栏详情分栏 (<List.Item.Detail>)：展示截图缩略图、分辨率、拍摄时间、文件大小与 OCR 识别结果
 * - OCR 文本提取：支持从选中的截图中自动提取文字并在详情中展示
 * - ActionPanel 动作集：
 *   - Paste Image to Active Window (直接粘贴截图至前台)
 *   - Copy Image to Clipboard (复制图片本身)
 *   - Copy Image Path (复制图片本地路径)
 *   - Copy Recognized Text (OCR) (复制提取的文字)
 *   - Show in Explorer (在资源管理器中定位)
 *   - Open with Default App (用默认图片查看器打开)
 *   - Delete Screenshot (删除截图文件)
 */

import React from "../../index.js";
import {
  List,
  Detail,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Clipboard
} from "../../index.js";
import { useState, useMemo, useEffect } from "../../runtime/hooks.js";
import { isRealElectronHost } from "../shared/native-ipc.js";
import {
  ScreenshotItem,
  ScreenshotCategory
} from "./types.js";
import {
  defaultScreenshotsManager,
  generateScreenshotThumbnailSvg,
  INITIAL_SCREENSHOTS
} from "./screenshots-service.js";

export * from "./types.js";
export * from "./screenshots-service.js";

/**
 * 独立单项详情查看页 (供导航栈或独立路由调用)
 */
export function ScreenshotDetailView({ item }: { item: ScreenshotItem }) {
  const markdown = `![${item.filename}](${item.thumbnailSvg})

---

### 📝 识别提取文字 (OCR Result)

\`\`\`text
${item.ocrText}
\`\`\`

- **存储路径**: \`${item.path}\`
- **分辨率**: **${item.dimensions}** (${item.width} × ${item.height})
- **文件大小**: ${item.formattedSize} (${item.sizeBytes.toLocaleString()} bytes)
- **拍摄时间**: ${item.formattedDate}`;

  return (
    <Detail
      markdown={markdown}
      navigationTitle={`截图详情: ${item.filename}`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="文件名称" text={item.filename} icon={Icon.Image} />
          <Detail.Metadata.Label title="分辨率" text={item.dimensions} icon={Icon.Monitor} />
          <Detail.Metadata.Label title="文件大小" text={item.formattedSize} icon={Icon.HardDrive} />
          <Detail.Metadata.Label title="拍摄时间" text={item.formattedDate} icon={Icon.Calendar} />
          <Detail.Metadata.TagList title="状态">
            <Detail.Metadata.TagList.Item
              text={item.pinned ? "PINNED (已置顶)" : "NORMAL"}
              color={item.pinned ? Color.Yellow : Color.Blue}
            />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label title="存储路径" text={item.path} icon={Icon.Folder} />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel title={`截图: ${item.filename}`}>
          <Action
            title="粘贴到活动窗口 (Paste to Active Window)"
            icon={Icon.Window}
            onAction={async () => {
              const res = await defaultScreenshotsManager.pasteToActiveWindow(item);
              await showToast(Toast.Style.Success, res.message);
            }}
          />
          <Action
            title="复制图片本身 (Copy Image to Clipboard)"
            icon={Icon.Clipboard}
            onAction={async () => {
              const res = await defaultScreenshotsManager.copyImageToClipboard(item);
              await showToast(Toast.Style.Success, res.message);
            }}
          />
          <Action
            title="复制图片本地路径 (Copy Image Path)"
            icon={Icon.Document}
            onAction={async () => {
              await Clipboard.copy(item.path);
              await showToast(Toast.Style.Success, `已复制路径: ${item.path}`);
            }}
          />
          <Action
            title="复制提取的文字 (Copy OCR Text)"
            icon={Icon.Text}
            onAction={async () => {
              const res = await defaultScreenshotsManager.copyOcrText(item);
              await Clipboard.copy(res.ocrText || "");
              await showToast(Toast.Style.Success, res.message);
            }}
          />
        </ActionPanel>
      }
    />
  );
}

export default function ScreenshotsCommand() {
  const [items, setItems] = useState<ScreenshotItem[]>(() =>
    isRealElectronHost() ? [] : [...INITIAL_SCREENSHOTS]
  );
  const [searchText, setSearchText] = useState("");
  const [category, setCategory] = useState<ScreenshotCategory>("all");
  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    let active = true;
    defaultScreenshotsManager.loadScreenshots().then((list) => {
      if (active) setItems(list);
    });
    return () => {
      active = false;
    };
  }, [refreshCount]);

  const reloadScreenshots = (force = false) => {
    defaultScreenshotsManager.loadScreenshots(force).then((list) => {
      setItems(list);
    });
  };

  const handleCaptureScreenNow = async () => {
    const res = await defaultScreenshotsManager.captureScreenNow();
    reloadScreenshots(true);
    await showToast(
      res.success ? Toast.Style.Success : Toast.Style.Failure,
      res.message
    );
  };

  const filtered = useMemo(() => {
    return defaultScreenshotsManager.filterScreenshots(items, searchText, category);
  }, [items, searchText, category]);

  // 快捷动作处理
  const handlePasteToActive = async (item: ScreenshotItem) => {
    try {
      const res = await defaultScreenshotsManager.pasteToActiveWindow(item);
      await showToast(Toast.Style.Success, res.message);
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "粘贴失败", err.message || String(err));
    }
  };

  const handlePasteLatest = async () => {
    try {
      const res = await defaultScreenshotsManager.pasteLatestScreenshot();
      if (res.success) {
        await showToast(Toast.Style.Success, res.message);
      } else {
        await showToast(Toast.Style.Failure, "未找到截图", res.message);
      }
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "回贴最新截图失败", err.message || String(err));
    }
  };

  const handleCopyImage = async (item: ScreenshotItem) => {
    try {
      const res = await defaultScreenshotsManager.copyImageToClipboard(item);
      await showToast(Toast.Style.Success, res.message);
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "复制图片失败", err.message || String(err));
    }
  };

  const handleCopyPath = async (item: ScreenshotItem) => {
    await Clipboard.copy(item.path);
    await showToast(Toast.Style.Success, `已复制路径: ${item.path}`);
  };

  const handleCopyOcr = async (item: ScreenshotItem) => {
    try {
      const text = await defaultScreenshotsManager.extractOcr(item);
      await Clipboard.copy(text);
      await showToast(Toast.Style.Success, `已复制 OCR 文字 (${text.length} 字符)`);
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "提取 OCR 文字失败", err.message || String(err));
    }
  };

  const handleShowInExplorer = async (item: ScreenshotItem) => {
    try {
      const res = await defaultScreenshotsManager.showInExplorer(item);
      await showToast(Toast.Style.Success, res.message);
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "定位失败", err.message || String(err));
    }
  };

  const handleOpenWithDefault = async (item: ScreenshotItem) => {
    try {
      const res = await defaultScreenshotsManager.openWithDefaultApp(item);
      await showToast(Toast.Style.Success, res.message);
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "打开失败", err.message || String(err));
    }
  };

  const handleDelete = async (item: ScreenshotItem) => {
    try {
      const res = await defaultScreenshotsManager.deleteScreenshot(item);
      setItems((prev) => prev.filter((s) => s.id !== item.id));
      await showToast(Toast.Style.Success, res.message);
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "删除截图失败", err.message || String(err));
    }
  };

  const handleTogglePin = async (item: ScreenshotItem) => {
    try {
      const res = await defaultScreenshotsManager.togglePinScreenshot(item);
      reloadScreenshots();
      await showToast(Toast.Style.Success, res.message);
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "置顶操作失败", err.message || String(err));
    }
  };

  const renderActionPanel = (item: ScreenshotItem) => (
    <ActionPanel title={`截图: ${item.filename}`}>
      {/* 1. Paste Image to Active Window */}
      <Action
        title="粘贴到活动窗口 (Paste Image to Active Window)"
        icon={Icon.Window}
        shortcut={{ modifiers: ["cmd"], key: "enter" }}
        onAction={() => handlePasteToActive(item)}
      />

      {/* 2. Copy Image to Clipboard */}
      <Action
        title="复制图片本身 (Copy Image to Clipboard)"
        icon={Icon.Clipboard}
        shortcut={{ modifiers: ["cmd"], key: "c" }}
        onAction={() => handleCopyImage(item)}
      />

      {/* 3. Copy Image Path */}
      <Action
        title="复制图片本地路径 (Copy Image Path)"
        icon={Icon.Document}
        shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
        onAction={() => handleCopyPath(item)}
      />

      {/* 4. Copy Recognized Text (OCR) */}
      <Action
        title="复制提取的文字 (Copy Recognized Text)"
        icon={Icon.Text}
        shortcut={{ modifiers: ["cmd", "alt"], key: "c" }}
        onAction={() => handleCopyOcr(item)}
      />

      {/* 5. Show in Explorer */}
      <Action
        title="在资源管理器中定位 (Show in Explorer)"
        icon={Icon.Folder}
        shortcut={{ modifiers: ["cmd"], key: "o" }}
        onAction={() => handleShowInExplorer(item)}
      />

      {/* 6. Open with Default App */}
      <Action
        title="用默认图片查看器打开 (Open with Default App)"
        icon={Icon.ArrowRight}
        shortcut={{ modifiers: ["cmd", "shift"], key: "o" }}
        onAction={() => handleOpenWithDefault(item)}
      />

      {/* 立即截取当前屏幕 */}
      <Action
        title="立即截取当前屏幕 (Capture Screen Now)"
        icon={Icon.Camera}
        shortcut={{ modifiers: ["ctrl", "shift"], key: "s" }}
        onAction={handleCaptureScreenNow}
      />

      {/* 置顶切换 */}
      <Action
        title={item.pinned ? "取消置顶 (Unpin Screenshot)" : "置顶此截图 (Pin Screenshot)"}
        icon={Icon.Pin}
        shortcut={{ modifiers: ["cmd"], key: "p" }}
        onAction={() => handleTogglePin(item)}
      />

      {/* 回贴最新截图 */}
      <Action
        title="回贴最新一张截图 (Paste Latest)"
        icon={Icon.Clock}
        shortcut={{ modifiers: ["cmd", "shift"], key: "v" }}
        onAction={handlePasteLatest}
      />

      {/* 7. Delete Screenshot */}
      <Action
        title="删除此截图 (Delete Screenshot)"
        icon={Icon.Trash}
        shortcut={{ modifiers: ["ctrl"], key: "x" }}
        onAction={() => handleDelete(item)}
      />
    </ActionPanel>
  );

  return (
    <List
      isShowingDetail={true}
      searchBarPlaceholder="搜索系统截图文件名、OCR 提取文字或分辨率 (如 2560x1440, error)..."
      onSearchTextChange={setSearchText}
      actions={
        <ActionPanel title="屏幕截图全局操作">
          <Action
            title="立即截取当前屏幕 (Capture Screen Now)"
            icon={Icon.Camera}
            onAction={handleCaptureScreenNow}
          />
          <Action
            title="重新扫描截图目录 (Refresh Screenshots)"
            icon={Icon.Repeat}
            onAction={() => reloadScreenshots(true)}
          />
        </ActionPanel>
      }
      searchBarAccessory={
        <List.Dropdown
          tooltip="按分类筛选截图"
          onChange={(val) => setCategory(val as ScreenshotCategory)}
        >
          <List.Dropdown.Item title="全部截图 (All Screenshots)" value="all" />
          <List.Dropdown.Item title="已置顶截图 (Pinned)" value="pinned" />
          <List.Dropdown.Item title="1小时内拍摄 (Recent)" value="recent" />
          <List.Dropdown.Item title="包含提取文字 (With OCR Text)" value="ocr" />
        </List.Dropdown>
      }
    >
      {/* 截图列表 */}
      <List.Section title={`系统截图库 (${filtered.length})`}>
        {filtered.map((item) => (
          <List.Item
            key={item.id}
            title={item.filename}
            subtitle={item.dimensions}
            accessories={[
              ...(item.pinned ? [{ text: "PINNED" }] : []),
              { text: item.formattedSize },
              { text: item.formattedDate }
            ]}
            detail={
              <List.Item.Detail
                markdown={`![${item.filename}](${item.thumbnailSvg})

---

### 📝 OCR 文字提取识别 (Text Recognition)

\`\`\`text
${item.ocrText}
\`\`\`
`}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label
                      title="文件名称"
                      text={item.filename}
                      icon={Icon.Image}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="分辨率"
                      text={item.dimensions}
                      icon={Icon.Monitor}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="文件大小"
                      text={item.formattedSize}
                      icon={Icon.HardDrive}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="拍摄时间"
                      text={item.formattedDate}
                      icon={Icon.Calendar}
                    />
                    <List.Item.Detail.Metadata.TagList title="状态">
                      <List.Item.Detail.Metadata.TagList.Item
                        text={item.pinned ? "PINNED (已置顶)" : "NORMAL"}
                        color={item.pinned ? Color.Yellow : Color.Blue}
                      />
                    </List.Item.Detail.Metadata.TagList>
                    <List.Item.Detail.Metadata.Separator />
                    <List.Item.Detail.Metadata.Label
                      title="存储路径"
                      text={item.path}
                      icon={Icon.Folder}
                    />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={renderActionPanel(item)}
          />
        ))}
      </List.Section>
    </List>
  );
}

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
import { isRealElectronHost, readRealClipboardText } from "../shared/native-ipc.js";
import {
  buildQrMatrix,
  generateQrSvg,
  decodeQrCode,
  detectQrContentType,
  getQrHistory,
  saveQrItem,
  toggleFavoriteQrItem,
  deleteQrItem,
  clearQrHistory,
  QrErrorCorrectionLevel,
  QrItem,
  QR_COLOR_SCHEMES
} from "./qr-generator.js";

export * from "./qr-generator.js";

const INITIAL_ITEMS: QrItem[] = [
  {
    id: "qr-1",
    title: "ZTools 官方主页",
    content: "https://ztools.dev",
    level: "M",
    createdAt: new Date().toLocaleTimeString(),
    favorite: true,
    colorScheme: "dark"
  },
  {
    id: "qr-2",
    title: "ZTools 扩展开发指南",
    content: "https://github.com/codingmuse/ZTools-extensions",
    level: "H",
    createdAt: new Date().toLocaleTimeString(),
    favorite: false,
    colorScheme: "cyber"
  }
];

const ECC_RATE_DESC: Record<QrErrorCorrectionLevel, string> = {
  L: "Level L (~7% 容错恢复能力 · 10 字节 GF(256) Reed-Solomon 纠错码字)",
  M: "Level M (~15% 容错恢复能力 · 16 字节 GF(256) Reed-Solomon 纠错码字)",
  Q: "Level Q (~25% 容错恢复能力 · 22 字节 GF(256) Reed-Solomon 纠错码字)",
  H: "Level H (~30% 容错恢复能力 · 28 字节 GF(256) Reed-Solomon 纠错码字)"
};

/**
 * 将二维码布尔矩阵渲染为紧凑的半块字符 ASCII 矩阵预览
 */
export function renderQrAsciiPreview(content: string, level: QrErrorCorrectionLevel = "M"): string {
  const matrix = buildQrMatrix(content || " ", level);
  const size = matrix.length;
  const lines: string[] = [];
  for (let r = 0; r < size; r += 2) {
    let rowStr = "";
    for (let c = 0; c < size; c++) {
      const top = matrix[r]?.[c] ?? false;
      const bottom = matrix[r + 1]?.[c] ?? false;
      if (top && bottom) rowStr += "█";
      else if (top && !bottom) rowStr += "▀";
      else if (!top && bottom) rowStr += "▄";
      else rowStr += " ";
    }
    lines.push(rowStr);
  }
  return lines.join("\n");
}

function buildQrDetailMarkdown(item: QrItem, dataUrl: string, matrixSize: number): string {
  const ascii = renderQrAsciiPreview(item.content, item.level);
  const eccDesc = ECC_RATE_DESC[item.level] || ECC_RATE_DESC.M;
  const detected = detectQrContentType(item.content);
  return [
    `# ${item.title}`,
    `![二维码](${dataUrl})`,
    `---`,
    `### 内容文本 (${detected.label})`,
    `\`\`\`text\n${item.content}\n\`\`\``,
    `### 容错率与编码分析 (ECC & Matrix Analysis)`,
    `- **容错等级**: \`${eccDesc}\``,
    `- **矩阵规格**: \`${matrixSize} × ${matrixSize} modules\` (含 3 个 Finder Pattern + Alignment Pattern + BCH(15,5) Format Info)`,
    `- **UTF-8 字节长度**: \`${new TextEncoder().encode(item.content).length} Bytes\``,
    `### ASCII 矩阵拓扑预览`,
    `\`\`\`text\n${ascii}\n\`\`\``
  ].join("\n\n");
}

/**
 * 二维码详情视图 (现代纯正 TSX 模式)
 */
export function QrDetailView({ item }: { item: QrItem }) {
  const { svg, dataUrl, matrixSize } = generateQrSvg(item.content, {
    size: 320,
    errorCorrectionLevel: item.level,
    colorScheme: item.colorScheme || "dark",
    foregroundColor: item.foregroundColor,
    backgroundColor: item.backgroundColor
  });

  const detected = detectQrContentType(item.content);
  const isUrl = detected.type === "url";
  const markdown = buildQrDetailMarkdown(item, dataUrl, matrixSize);

  return (
    <Detail
      markdown={markdown}
      navigationTitle={item.title}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="字符长度" text={`${item.content.length} 字符`} icon={Icon.Text} />
          <Detail.Metadata.Label title="纠错级别" text={`Level ${item.level}`} icon={Icon.Key} />
          <Detail.Metadata.Label title="内容类型" text={detected.label} icon={detected.icon} />
          <Detail.Metadata.Label title="矩阵尺寸" text={`${matrixSize} × ${matrixSize}`} icon={Icon.Grid} />
          <Detail.Metadata.Label title="生成时间" text={item.createdAt} icon={Icon.Clock} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.TagList title="收藏状态">
            <Detail.Metadata.TagList.Item
              text={item.favorite ? "已收藏" : "未收藏"}
              color={item.favorite ? Color.Yellow : Color.SecondaryText}
              icon={item.favorite ? Icon.Star : Icon.Dot}
            />
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
      actions={
        <ActionPanel title="二维码操作">
          <Action.CopyToClipboard title="复制二维码 SVG" content={svg} icon={Icon.CopyClipboard} />
          <Action.CopyToClipboard title="复制 Data URL" content={dataUrl} icon={Icon.CopyClipboard} />
          <Action.CopyToClipboard title="复制文本内容" content={item.content} icon={Icon.Clipboard} />
          <Action
            title="直接粘贴文本到前台应用"
            icon={Icon.Pencil}
            onAction={async () => {
              await Clipboard.paste(item.content);
              await showToast(Toast.Style.Success, "已粘贴到活动应用");
            }}
          />
          {isUrl && (
            <Action.OpenInBrowser title="在浏览器中打开" url={item.content} icon={Icon.Globe} />
          )}
        </ActionPanel>
      }
    />
  );
}

/**
 * 新建/定制二维码表单视图（支持普通文本/URL 与 Wi-Fi 凭据自动拼接 `WIFI:T:WPA;S:...;P:...;;`）
 */
export function CreateQrCodeForm({ onCreated }: { onCreated: (newItem: QrItem) => void }) {
  const { pop } = useNavigation();
  const [qrMode, setQrMode] = useState<"text" | "wifi">("text");
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [wifiEncryption, setWifiEncryption] = useState<"WPA" | "WEP" | "nopass">("WPA");
  const [level, setLevel] = useState<QrErrorCorrectionLevel>("M");
  const [colorScheme, setColorScheme] = useState<string>("dark");

  const handleSubmit = async (values?: Record<string, any>) => {
    const mode = (values?.qrMode as "text" | "wifi") || qrMode;
    const ssid = (values?.wifiSsid ?? wifiSsid ?? "").trim();
    const pwd = values?.wifiPassword ?? wifiPassword ?? "";
    const enc = (values?.wifiEncryption ?? wifiEncryption ?? "WPA") as "WPA" | "WEP" | "nopass";

    let finalContent = (values?.qrText ?? content ?? "").trim();
    let defaultTitle = "";

    if (mode === "wifi" || ssid.length > 0) {
      if (!ssid) {
        await showToast(Toast.Style.Failure, "请输入 Wi-Fi 名称 (SSID)");
        return;
      }
      finalContent = `WIFI:T:${enc};S:${ssid};P:${pwd};;`;
      defaultTitle = `Wi-Fi: ${ssid}`;
    }

    if (!finalContent) {
      await showToast(Toast.Style.Failure, "请输入二维码文本内容或 Wi-Fi SSID");
      return;
    }

    const itemTitle =
      (values?.qrTitle ?? title ?? "").trim() ||
      defaultTitle ||
      (finalContent.length > 24 ? `${finalContent.slice(0, 24)}...` : finalContent);
    const selectedLevel = ((values?.level as QrErrorCorrectionLevel) || level) as QrErrorCorrectionLevel;
    const selectedScheme = values?.colorScheme || colorScheme;

    const newItem: QrItem = {
      id: "qr-" + Date.now(),
      title: itemTitle,
      content: finalContent,
      level: selectedLevel,
      colorScheme: selectedScheme,
      createdAt: new Date().toLocaleTimeString(),
      favorite: false
    };

    await saveQrItem(newItem);
    onCreated(newItem);
    await showToast(Toast.Style.Success, "二维码创建成功并已持久化", itemTitle);
    pop();
  };

  return (
    <Form
      navigationTitle="新建二维码"
      actions={
        <ActionPanel title="创建操作">
          <Action.SubmitForm
            title="立即生成并保存二维码"
            icon={Icon.QrCode}
            onSubmit={handleSubmit}
          />
          <Action title="立即生成并保存二维码" icon={Icon.Check} onAction={() => handleSubmit()} />
        </ActionPanel>
      }
    >
      <Form.Dropdown
        id="qrMode"
        title="二维码模板类型"
        value={qrMode}
        onChange={(v) => setQrMode(v as "text" | "wifi")}
      >
        <Form.Dropdown.Item title="普通文本 / 网址链接 (Text / URL)" value="text" />
        <Form.Dropdown.Item title="无线网络一键连凭据 (Wi-Fi QR: WIFI:T:WPA;S:...)" value="wifi" />
      </Form.Dropdown>

      <Form.TextField
        id="qrTitle"
        title="标题备注"
        placeholder="输入二维码标题（选填）..."
        value={title}
        onChange={(v) => setTitle(v)}
      />

      {qrMode === "wifi" ? (
        <>
          <Form.TextField
            id="wifiSsid"
            title="Wi-Fi 名称 (SSID)"
            placeholder="输入无线网络 SSID..."
            value={wifiSsid}
            onChange={setWifiSsid}
          />
          <Form.PasswordField
            id="wifiPassword"
            title="Wi-Fi 密码 (Password)"
            placeholder="输入无线网络密码..."
            value={wifiPassword}
            onChange={setWifiPassword}
          />
          <Form.Dropdown
            id="wifiEncryption"
            title="Wi-Fi 加密方式"
            value={wifiEncryption}
            onChange={(v) => setWifiEncryption(v as "WPA" | "WEP" | "nopass")}
          >
            <Form.Dropdown.Item title="WPA / WPA2 / WPA3 (推荐)" value="WPA" />
            <Form.Dropdown.Item title="WEP" value="WEP" />
            <Form.Dropdown.Item title="无密码开放网络 (nopass)" value="nopass" />
          </Form.Dropdown>
        </>
      ) : (
        <Form.TextArea
          id="qrText"
          title="文本 / URL"
          placeholder="输入或粘贴待生成二维码的文本、URL 或 Wi-Fi 凭据..."
          value={content}
          onChange={(v) => setContent(v)}
        />
      )}

      <Form.Dropdown
        id="level"
        title="纠错级别 (ECC Level)"
        value={level}
        onChange={(v) => setLevel(v as QrErrorCorrectionLevel)}
      >
        <Form.Dropdown.Item title="Low (7% 容错)" value="L" />
        <Form.Dropdown.Item title="Medium (15% 容错 - 推荐)" value="M" />
        <Form.Dropdown.Item title="Quartile (25% 容错)" value="Q" />
        <Form.Dropdown.Item title="High (30% 容错)" value="H" />
      </Form.Dropdown>

      <Form.Dropdown
        id="colorScheme"
        title="配色风格"
        value={colorScheme}
        onChange={(v) => setColorScheme(v)}
      >
        <Form.Dropdown.Item title="极客暗黑 (Dark: #FFFFFF / #1A1B26)" value="dark" />
        <Form.Dropdown.Item title="经典黑白 (Light: #000000 / #FFFFFF)" value="light" />
        <Form.Dropdown.Item title="赛博深蓝 (Cyber: #38BDF8 / #0F172A)" value="cyber" />
        <Form.Dropdown.Item title="霓虹电光绿 (Neon: #10B981 / #064E3B)" value="neon" />
        <Form.Dropdown.Item title="极光暗紫 (Violet: #C084FC / #1E1B4B)" value="violet" />
      </Form.Dropdown>
    </Form>
  );
}

export const CreateQrForm = CreateQrCodeForm;

/**
 * 扫码与解码视图 (Scan / Decode)
 */
export function DecodeQrView(props: { onDecoded?: (text: string) => void } = {}) {
  const { onDecoded } = props || {};
  const [rawInput, setRawInput] = useState("");
  const [decodedResult, setDecodedResult] = useState<string | null>(null);

  const handleDecode = async (values: Record<string, any>) => {
    const input = values.qrRawInput || rawInput;
    const res = decodeQrCode(input);
    if (res.success && res.text) {
      setDecodedResult(res.text);
      onDecoded?.(res.text);
      await showToast(Toast.Style.Success, "成功解码", res.contentTypeLabel);
    } else {
      await showToast(Toast.Style.Failure, "无法解码内容", res.error);
    }
  };

  const handlePasteClipboard = async () => {
    const text = (await readRealClipboardText()) || (await Clipboard.readText());
    if (text) {
      setRawInput(text);
      const res = decodeQrCode(text);
      if (res.success && res.text) {
        setDecodedResult(res.text);
        onDecoded?.(res.text);
        await showToast(Toast.Style.Success, "从剪贴板读取并成功解码");
      }
    } else {
      await showToast(Toast.Style.Failure, "剪贴板为空");
    }
  };

  return (
    <Form
      navigationTitle="扫码与二维码解码"
      actions={
        <ActionPanel title="解码动作">
          <Action.SubmitForm
            title="开始解码分析"
            icon={Icon.Binoculars}
            onSubmit={handleDecode}
          />
          <Action
            title="从剪贴板粘贴并解码"
            icon={Icon.Clipboard}
            onAction={handlePasteClipboard}
          />
          {decodedResult && (
            <Action.CopyToClipboard
              title="复制解码出的文本"
              content={decodedResult}
              icon={Icon.CopyClipboard}
            />
          )}
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="qrRawInput"
        title="输入数据"
        placeholder="在此粘贴二维码 SVG 源码、Data URL、Base64 或带解码内容..."
        value={rawInput}
        onChange={(v) => setRawInput(v)}
      />
      {decodedResult && (
        <Form.TextArea
          id="decodedOutput"
          title="解码结果"
          value={decodedResult}
        />
      )}
    </Form>
  );
}

/**
 * 二维码管理主命令组件 (支持搜索框实时动态生成二维码、读取真实系统剪贴板、双栏详情分栏与表单定制)
 */
export default function QrCodeCommand() {
  const realHost = isRealElectronHost();
  const [items, setItems] = useState<QrItem[]>(() => (realHost ? [] : INITIAL_ITEMS));
  const [clipboardText, setClipboardText] = useState<string>("");
  const [searchText, setSearchText] = useState("");
  const { push } = useNavigation();

  useEffect(() => {
    let active = true;
    getQrHistory().then((saved) => {
      if (!active) return;
      if (saved && saved.length > 0) {
        setItems(saved);
      }
    });
    // 挂载时自动读取系统真实剪贴板 (clipboard_read_text IPC)
    readRealClipboardText()
      .then(async (clip) => {
        const txt = (clip || (await Clipboard.readText()) || "").trim();
        if (active && txt) {
          setClipboardText(txt);
        }
      })
      .catch(() => {
        // ignore
      });
    return () => {
      active = false;
    };
  }, []);

  const trimmedSearch = searchText.trim();

  // 1. 搜索框实时动态生成二维码项
  const liveSearchQrItem: QrItem | null = useMemo(() => {
    if (!trimmedSearch) return null;
    return {
      id: "qr-live-search",
      title: `⚡ 实时生成二维码: "${trimmedSearch}"`,
      content: trimmedSearch,
      level: "M",
      createdAt: "实时生成 (Live)",
      favorite: false,
      colorScheme: "cyber"
    };
  }, [trimmedSearch]);

  // 2. 系统真实剪贴板二维码项
  const clipboardQrItem: QrItem | null = useMemo(() => {
    if (!clipboardText) return null;
    return {
      id: "qr-current-clipboard",
      title: "📋 当前剪贴板内容二维码 (Current Clipboard QR)",
      content: clipboardText,
      level: "M",
      createdAt: "系统剪贴板",
      favorite: false,
      colorScheme: "dark"
    };
  }, [clipboardText]);

  const filteredItems = useMemo(() => {
    if (!trimmedSearch) return items;
    const q = trimmedSearch.toLowerCase();
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.content.toLowerCase().includes(q)
    );
  }, [items, trimmedSearch]);

  const handlePasteClipboard = async () => {
    const text = (await readRealClipboardText()) || (await Clipboard.readText());
    if (!text || !text.trim()) {
      await showToast(Toast.Style.Failure, "剪贴板为空");
      return;
    }
    setClipboardText(text.trim());
    const newItem: QrItem = {
      id: "qr-" + Date.now(),
      title: "剪贴板二维码",
      content: text.trim(),
      level: "M",
      createdAt: new Date().toLocaleTimeString(),
      favorite: false,
      colorScheme: "dark"
    };
    const updated = await saveQrItem(newItem);
    setItems(updated);
    await showToast(Toast.Style.Success, "已根据剪贴板快速生成并保存二维码");
  };

  const handleSaveLiveItem = async (item: QrItem) => {
    const persisted: QrItem = {
      ...item,
      id: "qr-" + Date.now(),
      title:
        item.id === "qr-live-search"
          ? `二维码: ${item.content.slice(0, 24)}`
          : item.title,
      createdAt: new Date().toLocaleTimeString()
    };
    const updated = await saveQrItem(persisted);
    setItems(updated);
    await showToast(Toast.Style.Success, "已保存到二维码历史列表", persisted.title);
  };

  const handleToggleFavorite = async (id: string) => {
    const updated = await toggleFavoriteQrItem(id);
    setItems(updated);
    await showToast(Toast.Style.Success, "已更新收藏状态");
  };

  const handleDelete = async (id: string) => {
    const updated = await deleteQrItem(id);
    setItems(updated);
    await showToast(Toast.Style.Success, "已从历史记录移除");
  };

  const handleClear = async () => {
    await clearQrHistory();
    setItems([]);
    await showToast(Toast.Style.Success, "已清空所有二维码历史");
  };

  const handleOpenCreate = () => {
    push(() => (
      <CreateQrCodeForm
        onCreated={(item) => {
          setItems((prev) => [item, ...prev]);
        }}
      />
    ));
  };

  const handleOpenDecode = () => {
    push(() => (
      <DecodeQrView
        onDecoded={(text) => {
          const newItem: QrItem = {
            id: "qr-" + Date.now(),
            title: `解码: ${text.slice(0, 16)}...`,
            content: text,
            level: "M",
            createdAt: new Date().toLocaleTimeString(),
            favorite: false,
            colorScheme: "cyber"
          };
          saveQrItem(newItem).then((updated) => setItems(updated));
        }}
      />
    ));
  };

  const renderQrListItem = (item: QrItem, isEphemeral = false) => {
    const { svg, dataUrl, matrixSize } = generateQrSvg(item.content, {
      size: 260,
      errorCorrectionLevel: item.level,
      colorScheme: item.colorScheme || "dark",
      foregroundColor: item.foregroundColor,
      backgroundColor: item.backgroundColor
    });
    const detected = detectQrContentType(item.content);
    const isUrl = detected.type === "url";

    return (
      <List.Item
        key={item.id}
        id={item.id}
        title={item.title}
        subtitle={item.content}
        keywords={trimmedSearch ? [trimmedSearch, item.title, item.content] : undefined}
        icon={
          item.id === "qr-live-search"
            ? Icon.Bolt
            : item.id === "qr-current-clipboard"
              ? Icon.Clipboard
              : item.favorite
                ? Icon.Star
                : Icon.QrCode
        }
        accessories={[
          ...(item.favorite ? [{ icon: Icon.Star, tooltip: "已收藏" }] : []),
          { text: `Level ${item.level}` },
          { text: item.createdAt }
        ]}
        detail={
          <List.Item.Detail
            markdown={buildQrDetailMarkdown(item, dataUrl, matrixSize)}
            metadata={
              <List.Item.Detail.Metadata>
                <List.Item.Detail.Metadata.Label
                  title="字符长度"
                  text={`${item.content.length} 字符`}
                  icon={Icon.Text}
                />
                <List.Item.Detail.Metadata.Label
                  title="内容格式"
                  text={detected.label}
                  icon={detected.icon}
                />
                <List.Item.Detail.Metadata.Label
                  title="纠错级别"
                  text={`Level ${item.level}`}
                  icon={Icon.Key}
                />
                <List.Item.Detail.Metadata.Label
                  title="矩阵规格"
                  text={`${matrixSize} × ${matrixSize}`}
                  icon={Icon.Grid}
                />
                <List.Item.Detail.Metadata.Label
                  title="创建时间"
                  text={item.createdAt}
                  icon={Icon.Clock}
                />
                <List.Item.Detail.Metadata.Separator />
                <List.Item.Detail.Metadata.TagList title="状态">
                  <List.Item.Detail.Metadata.TagList.Item
                    text={
                      item.id === "qr-live-search"
                        ? "LIVE PREVIEW"
                        : item.id === "qr-current-clipboard"
                          ? "CLIPBOARD"
                          : item.favorite
                            ? "FAVORITE (已收藏)"
                            : "HISTORY"
                    }
                    color={
                      item.id === "qr-live-search"
                        ? Color.Green
                        : item.favorite
                          ? Color.Yellow
                          : Color.Blue
                    }
                    icon={item.favorite ? Icon.Star : Icon.Dot}
                  />
                </List.Item.Detail.Metadata.TagList>
              </List.Item.Detail.Metadata>
            }
          />
        }
        actions={
          <ActionPanel title={item.title}>
            <Action.Push
              title="查看二维码大图详情"
              icon={Icon.Eye}
              target={() => <QrDetailView item={item} />}
            />
            {isEphemeral && (
              <Action
                title="保存此二维码到历史列表"
                icon={Icon.Download}
                onAction={() => handleSaveLiveItem(item)}
              />
            )}
            <Action.CopyToClipboard
              title="复制二维码 SVG"
              content={svg}
              icon={Icon.CopyClipboard}
            />
            <Action.CopyToClipboard
              title="复制 Data URL"
              content={dataUrl}
              icon={Icon.CopyClipboard}
            />
            <Action.CopyToClipboard
              title="复制原始文本"
              content={item.content}
              icon={Icon.Clipboard}
            />
            <Action
              title="直接粘贴文本到前台应用"
              icon={Icon.Pencil}
              onAction={async () => {
                await Clipboard.paste(item.content);
                await showToast(Toast.Style.Success, "已粘贴到活动应用");
              }}
            />
            {isUrl && (
              <Action.OpenInBrowser
                title="在浏览器中打开"
                url={item.content}
                icon={Icon.Globe}
              />
            )}
            <Action.Push
              title="通过表单定制二维码 (Create Custom QR Code / Wi-Fi QR)"
              icon={Icon.Plus}
              shortcut={{ modifiers: ["ctrl"], key: "n" }}
              target={
                <CreateQrCodeForm
                  onCreated={(created) => setItems((prev) => [created, ...prev])}
                />
              }
            />
            {!isEphemeral && (
              <Action
                title={item.favorite ? "取消收藏" : "加入收藏"}
                icon={Icon.Star}
                onAction={() => handleToggleFavorite(item.id)}
              />
            )}
            <Action
              title="扫码与解码"
              icon={Icon.Binoculars}
              onAction={handleOpenDecode}
            />
            {!isEphemeral && (
              <Action
                title="删除历史记录"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                onAction={() => handleDelete(item.id)}
              />
            )}
          </ActionPanel>
        }
      />
    );
  };

  return (
    <List
      navigationTitle="二维码生成器"
      searchBarPlaceholder="输入任意文本或 URL 实时生成二维码，或搜索历史记录..."
      searchText={searchText}
      onSearchTextChange={(txt) => setSearchText(txt)}
      isShowingDetail={true}
      actions={
        <ActionPanel title="全局操作">
          <Action.Push
            title="通过表单定制二维码 (Create Custom QR Code / Wi-Fi QR)"
            icon={Icon.Plus}
            target={
              <CreateQrCodeForm
                onCreated={(item) => setItems((prev) => [item, ...prev])}
              />
            }
          />
          <Action title="从剪贴板创建" icon={Icon.Clipboard} onAction={handlePasteClipboard} />
          <Action title="扫码与解码 (Scan / Decode)" icon={Icon.Binoculars} onAction={handleOpenDecode} />
          <Action title="清空全部历史" icon={Icon.Trash} onAction={handleClear} />
        </ActionPanel>
      }
    >
      {(liveSearchQrItem || clipboardQrItem) && (
        <List.Section title="实时动态二维码与系统剪贴板 (Live & Clipboard QR)">
          {liveSearchQrItem && renderQrListItem(liveSearchQrItem, true)}
          {clipboardQrItem && renderQrListItem(clipboardQrItem, true)}
        </List.Section>
      )}

      <List.Section title={`二维码历史 (${filteredItems.length})`}>
        {filteredItems.map((item) => renderQrListItem(item, false))}
      </List.Section>
    </List>
  );
}

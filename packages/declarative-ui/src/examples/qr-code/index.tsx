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
import { useState, useEffect } from "../../runtime/hooks.js";
import {
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

  const markdown = `
# ${item.title}

![二维码](${dataUrl})

---

### 内容文本
\`\`\`
${item.content}
\`\`\`
  `;

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
 * 新建二维码表单视图
 */
export function CreateQrForm({ onCreated }: { onCreated: (newItem: QrItem) => void }) {
  const { pop } = useNavigation();
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [level, setLevel] = useState<QrErrorCorrectionLevel>("M");
  const [colorScheme, setColorScheme] = useState<string>("dark");

  const handleSubmit = async (values: Record<string, any>) => {
    const text = values.qrText || content;
    const itemTitle = values.qrTitle || title || (text.slice(0, 16) + "...");
    const selectedLevel = (values.level as QrErrorCorrectionLevel) || level;
    const selectedScheme = values.colorScheme || colorScheme;

    if (!text || !text.trim()) {
      await showToast(Toast.Style.Failure, "请输入内容");
      return;
    }

    const newItem: QrItem = {
      id: "qr-" + Date.now(),
      title: itemTitle,
      content: text.trim(),
      level: selectedLevel,
      colorScheme: selectedScheme,
      createdAt: new Date().toLocaleTimeString(),
      favorite: false
    };

    await saveQrItem(newItem);
    onCreated(newItem);
    await showToast(Toast.Style.Success, "二维码创建成功并已持久化");
    pop();
  };

  return (
    <Form
      navigationTitle="新建二维码"
      actions={
        <ActionPanel title="创建操作">
          <Action.SubmitForm
            title="立即生成二维码"
            icon={Icon.QrCode}
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="qrTitle"
        title="标题"
        placeholder="输入二维码标题（选填）..."
        value={title}
        onChange={(v) => setTitle(v)}
      />
      <Form.TextArea
        id="qrText"
        title="文本 / URL"
        placeholder="输入或粘贴待生成二维码的文本、URL 或 Wi-Fi 凭据..."
        value={content}
        onChange={(v) => setContent(v)}
      />
      <Form.Dropdown
        id="level"
        title="纠错级别"
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
    const text = await Clipboard.readText();
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
 * 二维码管理主命令组件 (支持双栏详情分栏、历史持久化与全键盘流)
 */
export default function QrCodeCommand() {
  const [items, setItems] = useState<QrItem[]>(INITIAL_ITEMS);
  const [searchText, setSearchText] = useState("");
  const { push } = useNavigation();

  useEffect(() => {
    getQrHistory().then((saved) => {
      if (saved && saved.length > 0) {
        setItems(saved);
      }
    });
  }, []);

  const filteredItems = items.filter(
    (item) =>
      item.title.toLowerCase().includes(searchText.toLowerCase()) ||
      item.content.toLowerCase().includes(searchText.toLowerCase())
  );

  const handlePasteClipboard = async () => {
    const text = await Clipboard.readText();
    if (!text || !text.trim()) {
      await showToast(Toast.Style.Failure, "剪贴板为空");
      return;
    }
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
      <CreateQrForm
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

  return (
    <List
      navigationTitle="二维码生成器"
      searchBarPlaceholder="搜索二维码历史、链接或文本..."
      searchText={searchText}
      onSearchTextChange={(txt) => setSearchText(txt)}
      isShowingDetail={true}
      actions={
        <ActionPanel title="全局操作">
          <Action title="新建二维码" icon={Icon.Plus} onAction={handleOpenCreate} />
          <Action title="从剪贴板创建" icon={Icon.Clipboard} onAction={handlePasteClipboard} />
          <Action title="扫码与解码 (Scan / Decode)" icon={Icon.Binoculars} onAction={handleOpenDecode} />
          <Action title="清空全部历史" icon={Icon.Trash} onAction={handleClear} />
        </ActionPanel>
      }
    >
      <List.Section title={`二维码历史 (${filteredItems.length})`}>
        {filteredItems.map((item) => {
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
              icon={item.favorite ? Icon.Star : Icon.QrCode}
              accessories={[
                ...(item.favorite ? [{ icon: Icon.Star, tooltip: "已收藏" }] : []),
                { text: `Level ${item.level}` },
                { text: item.createdAt }
              ]}
              detail={
                <List.Item.Detail
                  markdown={`# ${item.title}\n\n![二维码](${dataUrl})\n\n**内容文本：**\n\`\`\`\n${item.content}\n\`\`\``}
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
                      <List.Item.Detail.Metadata.TagList title="收藏状态">
                        <List.Item.Detail.Metadata.TagList.Item
                          text={item.favorite ? "FAVORITE (已收藏)" : "HISTORY"}
                          color={item.favorite ? Color.Yellow : Color.Blue}
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
                  <Action
                    title={item.favorite ? "取消收藏" : "加入收藏"}
                    icon={Icon.Star}
                    onAction={() => handleToggleFavorite(item.id)}
                  />
                  <Action
                    title="新建二维码"
                    icon={Icon.Plus}
                    onAction={handleOpenCreate}
                  />
                  <Action
                    title="扫码与解码"
                    icon={Icon.Binoculars}
                    onAction={handleOpenDecode}
                  />
                  <Action
                    title="删除历史记录"
                    icon={Icon.Trash}
                    onAction={() => handleDelete(item.id)}
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

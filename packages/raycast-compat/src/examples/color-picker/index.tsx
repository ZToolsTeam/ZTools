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
  Clipboard,
  useNavigation
} from "../../index.js";
import { useState, useEffect } from "../../runtime/hooks.js";
import {
  parseColor,
  generateColorSwatchSvg,
  pickScreenColor,
  getSavedPalette,
  saveColorToPalette,
  clearPalette,
  removeFromPalette,
  getColorHistory,
  saveColorHistory,
  clearColorHistory,
  ColorConversionResult,
  SavedColorItem,
  PickedColorResult
} from "./converter.js";

export * from "./converter.js";

/**
 * 颜色可视化与全能合规详情视图
 */
export function ColorDetailView({ color }: { color: ColorConversionResult }) {
  const swatchUrl = generateColorSwatchSvg(color.hex);
  const comp = color.harmonies.complementary;
  const compSwatch = generateColorSwatchSvg(comp, 200, 50);

  const markdown = `
# 色彩全景与合规检查

![Color Swatch](${swatchUrl})

---

### 色彩格式换算
| 格式 | 值 | 说明 |
| :--- | :--- | :--- |
| **HEX** | \`${color.hex}\` | 6 位十六进制色值 |
| **HEX8** | \`${color.hex8}\` | 带 Alpha 通道的 8 位色值 |
| **RGB** | \`${color.cssRgb}\` | 红绿蓝标准色彩 |
| **RGBA** | \`${color.cssRgba}\` | 带透明度色彩 |
| **HSL** | \`${color.cssHsl}\` | 色相/饱和度/明度 |
| **HSV** | \`${color.cssHsv}\` | 色相/饱和度/明度 (色度学) |
| **CMYK** | \`${color.cssCmyk}\` | 四色印刷色彩 |
| **CSS 变量** | \`${color.cssVar}\` | Web 变量定义 |

---

### WCAG 2.1 无障碍对比度测试
- **与白色文字对比度**: \`${color.wcag.contrastOnWhite}:1\` (评级: **${color.wcag.whiteRating}**)
- **与黑色文字对比度**: \`${color.wcag.contrastOnBlack}:1\` (评级: **${color.wcag.blackRating}**)
- **推荐前景色**: 使用 **${color.wcag.recommendedText.toUpperCase()}** 字体可获得最高可读性

---

### 衍生专业配色方案
- **互补色**: \`${comp}\`
- **类似色**: \`${color.harmonies.analogous[0]}\`, \`${color.harmonies.analogous[1]}\`
- **三色平衡**: \`${color.harmonies.triadic[0]}\`, \`${color.harmonies.triadic[1]}\`
- **分裂互补**: \`${color.harmonies.splitComplementary[0]}\`, \`${color.harmonies.splitComplementary[1]}\`
- **四色矩阵**: \`${color.harmonies.tetradic.join(", ")}\`
- **单色渐变**: \`${color.harmonies.monochromatic.join(" -> ")}\`
  `;

  return (
    <Detail
      markdown={markdown}
      navigationTitle={`颜色详情: ${color.hex}`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="HEX" text={color.hex} icon={Icon.Eye} />
          <Detail.Metadata.Label title="RGB" text={color.cssRgb} icon={Icon.Brush} />
          <Detail.Metadata.Label title="HSL" text={color.cssHsl} icon={Icon.Circle} />
          <Detail.Metadata.Label title="HSV" text={color.cssHsv} icon={Icon.Dot} />
          <Detail.Metadata.Label title="CMYK" text={color.cssCmyk} icon={Icon.Document} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.TagList title="WCAG 对比度评级">
            <Detail.Metadata.TagList.Item
              text={`White: ${color.wcag.whiteRating}`}
              color={color.wcag.whiteRating === "AAA" || color.wcag.whiteRating === "AA" ? Color.Green : Color.Red}
            />
            <Detail.Metadata.TagList.Item
              text={`Black: ${color.wcag.blackRating}`}
              color={color.wcag.blackRating === "AAA" || color.wcag.blackRating === "AA" ? Color.Green : Color.Red}
            />
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
      actions={
        <ActionPanel title="色彩操作">
          <Action.CopyToClipboard title="复制 HEX 色值" content={color.hex} icon={Icon.CopyClipboard} />
          <Action.CopyToClipboard title="复制 RGB 代码" content={color.cssRgb} icon={Icon.Code} />
          <Action.CopyToClipboard title="复制 HSL 代码" content={color.cssHsl} icon={Icon.Code} />
          <Action.CopyToClipboard title="复制 HSV 代码" content={color.cssHsv} icon={Icon.Code} />
          <Action.CopyToClipboard title="复制 CMYK 代码" content={color.cssCmyk} icon={Icon.Code} />
          <Action.CopyToClipboard title="复制 CSS 变量" content={color.cssVar} icon={Icon.Terminal} />
          <Action
            title="直接粘贴 HEX 到前台应用"
            icon={Icon.Pencil}
            onAction={async () => {
              await Clipboard.paste(color.hex);
              await showToast(Toast.Style.Success, `已将 ${color.hex} 粘贴到活动应用`);
            }}
          />
          <Action
            title="收藏到本地调色板"
            icon={Icon.Star}
            onAction={async () => {
              await saveColorToPalette(`颜色 ${color.hex}`, color.hex);
              await showToast(Toast.Style.Success, "已保存到调色板");
            }}
          />
        </ActionPanel>
      }
    />
  );
}

/**
 * 调色板与屏幕取色主命令
 */
export default function ColorPickerCommand() {
  const [inputColor, setInputColor] = useState("#0A84FF");
  const [palette, setPalette] = useState<SavedColorItem[]>([]);
  const [history, setHistory] = useState<PickedColorResult[]>([]);
  const { push } = useNavigation();

  useEffect(() => {
    getSavedPalette().then((items) => {
      if (items && items.length > 0) {
        setPalette(items);
      } else {
        setPalette([
          { id: "col_1", name: "Apple System Blue", hex: "#0A84FF", savedAt: "预设" },
          { id: "col_2", name: "Emerald Green", hex: "#30D158", savedAt: "预设" },
          { id: "col_3", name: "Sunset Orange", hex: "#FF9F0A", savedAt: "预设" },
          { id: "col_4", name: "Cyber Purple", hex: "#BF5AF2", savedAt: "预设" }
        ]);
      }
    });

    getColorHistory().then((hist) => {
      if (hist && hist.length > 0) {
        setHistory(hist);
      }
    });
  }, []);

  const parsed = parseColor(inputColor);

  const handlePickScreenColor = async () => {
    try {
      await showToast(Toast.Style.Animated, "正在启动屏幕拾色器...");
      const picked = await pickScreenColor();
      setInputColor(picked.hex);
      const updatedHist = await saveColorHistory(picked);
      setHistory(updatedHist);
      await Clipboard.copy(picked.hex);
      await showToast(
        Toast.Style.Success,
        `取色成功: ${picked.hex}`,
        picked.source === "native" ? "已穿透 Win32/UIAccess 拾取" : "高精度放大镜模拟取色"
      );
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "屏幕拾色失败", err?.message);
    }
  };

  const handlePasteToActive = async () => {
    await Clipboard.paste(parsed.hex);
    await showToast(Toast.Style.Success, `已将 ${parsed.hex} 回贴到当前前台应用`);
  };

  const handleSaveToPalette = async () => {
    const updated = await saveColorToPalette(`Color ${parsed.hex}`, parsed.hex);
    setPalette(updated);
    await showToast(Toast.Style.Success, "已持久化收藏到调色板");
  };

  const handleClearPalette = async () => {
    await clearPalette();
    setPalette([]);
    await showToast(Toast.Style.Success, "已清空调色板历史");
  };

  const handleClearHistory = async () => {
    await clearColorHistory();
    setHistory([]);
    await showToast(Toast.Style.Success, "已清空拾色历史");
  };

  const handleRemoveColor = async (id: string) => {
    const updated = await removeFromPalette(id);
    setPalette(updated);
    await showToast(Toast.Style.Success, "已从调色板移除");
  };

  return (
    <List
      navigationTitle="调色板与色彩转换器"
      searchBarPlaceholder="输入 Hex (#0A84FF)、RGB (rgb(10, 132, 255))、HSL (hsl(210, 100%, 52%)) 或拾色..."
      searchText={inputColor}
      onSearchTextChange={(val) => setInputColor(val)}
      actions={
        <ActionPanel title="全局色彩操作">
          <Action title="收藏当前色彩到调色板" icon={Icon.Star} onAction={handleSaveToPalette} />
          <Action.CopyToClipboard title="复制 HEX 色值" content={parsed.hex} icon={Icon.CopyClipboard} />
          <Action title="屏幕吸色 (Screen Eyedropper)" icon={Icon.Brush} onAction={handlePickScreenColor} />
          <Action title="粘贴当前色到前台应用" icon={Icon.Pencil} onAction={handlePasteToActive} />
          <Action.CopyToClipboard title="复制 RGB 代码" content={parsed.cssRgb} icon={Icon.Code} />
          <Action.CopyToClipboard title="复制 HSL 代码" content={parsed.cssHsl} icon={Icon.Code} />
          <Action.CopyToClipboard title="复制 HSV 代码" content={parsed.cssHsv} icon={Icon.Code} />
          <Action.CopyToClipboard title="复制 CMYK 代码" content={parsed.cssCmyk} icon={Icon.Code} />
          <Action.CopyToClipboard title="复制 CSS 变量" content={parsed.cssVar} icon={Icon.Terminal} />
          <Action title="清空调色板历史" icon={Icon.Trash} onAction={handleClearPalette} />
        </ActionPanel>
      }
    >
      <List.Section title={`当前颜色换算 [${parsed.hex}]`}>
        <List.Item
          id="fmt_hex"
          title={parsed.hex}
          subtitle="十六进制 HEX 格式"
          icon={Icon.Eye}
          accessories={[{ text: "HEX" }]}
          actions={
            <ActionPanel title={parsed.hex}>
              <Action.Push
                title="查看颜色视觉与对比度详情"
                icon={Icon.Eye}
                target={() => <ColorDetailView color={parsed} />}
              />
              <Action.CopyToClipboard title="复制 HEX" content={parsed.hex} icon={Icon.CopyClipboard} />
              <Action title="粘贴到前台活动应用" icon={Icon.Pencil} onAction={handlePasteToActive} />
              <Action title="屏幕吸色 (Eyedropper)" icon={Icon.Brush} onAction={handlePickScreenColor} />
              <Action title="收藏到调色板" icon={Icon.Star} onAction={handleSaveToPalette} />
            </ActionPanel>
          }
        />
        <List.Item
          id="fmt_rgb"
          title={parsed.cssRgb}
          subtitle="红绿蓝 RGB 格式"
          icon={Icon.Brush}
          accessories={[{ text: "RGB" }]}
          actions={
            <ActionPanel title={parsed.cssRgb}>
              <Action.CopyToClipboard title="复制 RGB 代码" content={parsed.cssRgb} icon={Icon.CopyClipboard} />
              <Action title="粘贴到前台活动应用" icon={Icon.Pencil} onAction={() => Clipboard.paste(parsed.cssRgb)} />
            </ActionPanel>
          }
        />
        <List.Item
          id="fmt_hsl"
          title={parsed.cssHsl}
          subtitle="色相/饱和度/明度 HSL 格式"
          icon={Icon.Circle}
          accessories={[{ text: "HSL" }]}
          actions={
            <ActionPanel title={parsed.cssHsl}>
              <Action.CopyToClipboard title="复制 HSL 代码" content={parsed.cssHsl} icon={Icon.CopyClipboard} />
              <Action title="粘贴到前台活动应用" icon={Icon.Pencil} onAction={() => Clipboard.paste(parsed.cssHsl)} />
            </ActionPanel>
          }
        />
        <List.Item
          id="fmt_hsv"
          title={parsed.cssHsv}
          subtitle="色度学明度 HSV 格式"
          icon={Icon.Dot}
          accessories={[{ text: "HSV" }]}
          actions={
            <ActionPanel title={parsed.cssHsv}>
              <Action.CopyToClipboard title="复制 HSV 代码" content={parsed.cssHsv} icon={Icon.CopyClipboard} />
            </ActionPanel>
          }
        />
        <List.Item
          id="fmt_cmyk"
          title={parsed.cssCmyk}
          subtitle="印刷色彩 CMYK 格式"
          icon={Icon.Document}
          accessories={[{ text: "CMYK" }]}
          actions={
            <ActionPanel title={parsed.cssCmyk}>
              <Action.CopyToClipboard title="复制 CMYK 代码" content={parsed.cssCmyk} icon={Icon.CopyClipboard} />
            </ActionPanel>
          }
        />
        <List.Item
          id="fmt_css_var"
          title={parsed.cssVar}
          subtitle="CSS 变量定义"
          icon={Icon.Terminal}
          accessories={[{ text: "CSS Var" }]}
          actions={
            <ActionPanel title={parsed.cssVar}>
              <Action.CopyToClipboard title="复制 CSS 变量" content={parsed.cssVar} icon={Icon.CopyClipboard} />
            </ActionPanel>
          }
        />
        <List.Item
          id="fmt_wcag"
          title={`WCAG: White (${parsed.wcag.whiteRating}) / Black (${parsed.wcag.blackRating})`}
          subtitle={`推荐前景色: ${parsed.wcag.recommendedText.toUpperCase()}`}
          icon={Icon.Checkmark}
          accessories={[{ text: `${parsed.wcag.contrastOnWhite}:1 / ${parsed.wcag.contrastOnBlack}:1` }]}
          actions={
            <ActionPanel title="无障碍对比度">
              <Action.Push
                title="查看色彩合规详情"
                icon={Icon.Eye}
                target={() => <ColorDetailView color={parsed} />}
              />
            </ActionPanel>
          }
        />
        <List.Item
          id="harm_comp"
          title={`互补色: ${parsed.harmonies.complementary}`}
          subtitle="环形色轮 180° 对称色"
          icon={Icon.Brush}
          accessories={[{ text: parsed.harmonies.complementary }]}
          actions={
            <ActionPanel title={parsed.harmonies.complementary}>
              <Action title="应用此颜色" icon={Icon.Checkmark} onAction={() => setInputColor(parsed.harmonies.complementary)} />
              <Action.CopyToClipboard title="复制色值" content={parsed.harmonies.complementary} icon={Icon.CopyClipboard} />
            </ActionPanel>
          }
        />
        <List.Item
          id="harm_analog"
          title={`类似色: ${parsed.harmonies.analogous[0]} · ${parsed.harmonies.analogous[1]}`}
          subtitle="环形色轮 ±30° 邻近和谐色"
          icon={Icon.Circle}
          actions={
            <ActionPanel title="类似色">
              <Action title="应用左邻色" icon={Icon.ArrowLeft} onAction={() => setInputColor(parsed.harmonies.analogous[0])} />
              <Action title="应用右邻色" icon={Icon.ArrowRight} onAction={() => setInputColor(parsed.harmonies.analogous[1])} />
            </ActionPanel>
          }
        />
        <List.Item
          id="harm_triad"
          title={`三色调和: ${parsed.harmonies.triadic[0]} · ${parsed.harmonies.triadic[1]}`}
          subtitle="环形色轮 +120° / +240° 等边三角形色彩"
          icon={Icon.Grid}
          actions={
            <ActionPanel title="三色调和">
              <Action title="应用三色其一" icon={Icon.Checkmark} onAction={() => setInputColor(parsed.harmonies.triadic[0])} />
              <Action title="应用三色其二" icon={Icon.Checkmark} onAction={() => setInputColor(parsed.harmonies.triadic[1])} />
            </ActionPanel>
          }
        />
      </List.Section>

      <List.Section title={`已收藏调色板 (${palette.length})`}>
        {palette.map((item) => (
          <List.Item
            key={item.id}
            id={item.id}
            title={item.name}
            subtitle={item.hex}
            icon={Icon.Star}
            accessories={[{ text: item.savedAt }]}
            actions={
              <ActionPanel title={item.name}>
                <Action
                  title="填入当前输入"
                  icon={Icon.Pencil}
                  onAction={() => setInputColor(item.hex)}
                />
                <Action.CopyToClipboard title="复制色值" content={item.hex} icon={Icon.CopyClipboard} />
                <Action.Push
                  title="查看色彩详情"
                  icon={Icon.Eye}
                  target={() => <ColorDetailView color={parseColor(item.hex)} />}
                />
                <Action
                  title="从调色板移除"
                  icon={Icon.Trash}
                  onAction={() => handleRemoveColor(item.id)}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}

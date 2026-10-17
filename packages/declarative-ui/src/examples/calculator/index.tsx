import React from "../../index.js";
import { confirmAlert } from "../../api/alert.js";
import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Clipboard
} from "../../index.js";
import { useState, useEffect, useMemo } from "../../runtime/hooks.js";
import {
  evaluateCalculatorQuery,
  evaluateMathExpression,
  inspectColor,
  convertUnits,
  convertCalculatorCurrency,
  evaluateDateExpression,
  getCalculatorHistory,
  addCalculatorHistory,
  togglePinCalculatorHistory,
  deleteCalculatorHistory,
  clearCalculatorHistory,
  CalculatorQueryResult,
  CalculatorHistoryItem,
  CalculatorColorResult,
  CalculationResult
} from "./calculator-engine.js";

export * from "./calculator-engine.js";

const DEFAULT_CALC_EXAMPLES = [
  { expr: "1024 * 768", desc: "分辨率像素点四则运算", category: "数学" },
  { expr: "sqrt(65536)", desc: "平方根函数计算", category: "数学" },
  { expr: "2 ^ 16", desc: "指数幂运算", category: "数学" },
  { expr: "sin(pi / 2)", desc: "三角函数与常数", category: "数学" },
  { expr: "32px to rem", desc: "前端 CSS px 与 rem 极客换算", category: "换算" },
  { expr: "2.5rem to px", desc: "CSS rem 转像素 (基于 16px)", category: "换算" },
  { expr: "10km to miles", desc: "公制与英制度量衡换算", category: "换算" },
  { expr: "5kg to lbs", desc: "重量单位千克转磅", category: "换算" },
  { expr: "100c to f", desc: "摄氏度与华氏度互转", category: "换算" },
  { expr: "1024mb to gb", desc: "计算机存储容量二进制换算", category: "换算" },
  { expr: "0xFF to dec", desc: "十六进制转十进制", category: "进制" },
  { expr: "255 to hex", desc: "十进制转十六进制 (0xFF)", category: "进制" },
  { expr: "255 to bin", desc: "十进制转二进制 (0b11111111)", category: "进制" },
  { expr: "100 USD in CNY", desc: "全球货币实时汇率估算", category: "汇率" },
  { expr: "50 EUR to USD", desc: "欧元兑换美元", category: "汇率" },
  { expr: "now + 2 weeks", desc: "未来相对日期与时间推算", category: "日期" },
  { expr: "#3B82F6", desc: "HEX 颜色预览、互转与 WCAG 对比度", category: "色彩" },
  { expr: "rgb(59, 130, 246)", desc: "RGB 格式色彩即时检测", category: "色彩" }
];

export default function CalculatorCommand() {
  const [searchText, setSearchText] = useState("");
  const [history, setHistory] = useState<CalculatorHistoryItem[]>([]);

  useEffect(() => {
    void getCalculatorHistory().then(setHistory);
  }, []);

  const queryResult: CalculatorQueryResult = useMemo(() => {
    return evaluateCalculatorQuery(searchText);
  }, [searchText]);

  const handleCopy = async (text: string, label: string) => {
    await Clipboard.copy(text);
    await showToast(Toast.Style.Success, `已复制 ${label}`, text);
    if (queryResult.type !== "none" && !queryResult.error) {
      const updated = await addCalculatorHistory(
        queryResult.expression,
        queryResult.formattedAnswer,
        queryResult.type
      );
      setHistory(updated);
    }
  };

  const handlePaste = async (text: string) => {
    await Clipboard.paste(text);
    await showToast(Toast.Style.Success, "已粘贴到前台应用", text);
    if (queryResult.type !== "none" && !queryResult.error) {
      const updated = await addCalculatorHistory(
        queryResult.expression,
        queryResult.formattedAnswer,
        queryResult.type
      );
      setHistory(updated);
    }
  };

  const handleTogglePin = async (id: string) => {
    const updated = await togglePinCalculatorHistory(id);
    setHistory(updated);
  };

  const handleDeleteHistory = async (id: string) => {
    const updated = await deleteCalculatorHistory(id);
    setHistory(updated);
    await showToast(Toast.Style.Success, "已删除历史记录");
  };

  const handleClearHistory = async () => {
    const confirmed = await confirmAlert({
      title: "清空全部计算历史？",
      message: `将删除全部 ${history.length} 条记录（含已固定的），且无法恢复。`,
      primaryAction: { title: "清空", style: "destructive" },
      dismissAction: { title: "取消" }
    });
    if (!confirmed) return;
    await clearCalculatorHistory();
    setHistory([]);
    await showToast(Toast.Style.Success, "已清空所有历史计算记录");
  };

  const pinnedItems = history.filter(item => item.pinned);
  const recentItems = history.filter(item => !item.pinned);

  return (
    <List
      searchBarPlaceholder="输入算式 (如 128*1024, 32px to rem, 0xFF to dec, 100 USD in CNY, now+2w, #3B82F6)..."
      onSearchTextChange={setSearchText}
    >
      {/* 1. 色彩速查与双向转换 */}
      {queryResult.type === "color" && queryResult.colorResult && (
        <List.Section title="色彩识别与即时转换">
          <List.Item
            id="color-hex"
            title={queryResult.colorResult.hex}
            subtitle={`HEX 色彩代码 | 对比度 白:${queryResult.colorResult.contrastWhite}:1 黑:${queryResult.colorResult.contrastBlack}:1`}
            icon={Icon.Eye}
            accessories={[{ text: "HEX" }]}
            actions={
              <ActionPanel title="色彩动作">
                <Action
                  title="复制 HEX"
                  icon={Icon.CopyClipboard}
                  onAction={() => handleCopy(queryResult.colorResult!.hex, "HEX")}
                />
                <Action
                  title="复制 RGB"
                  icon={Icon.CopyClipboard}
                  onAction={() => handleCopy(queryResult.colorResult!.rgb, "RGB")}
                />
                <Action
                  title="复制 HSL"
                  icon={Icon.CopyClipboard}
                  onAction={() => handleCopy(queryResult.colorResult!.hsl, "HSL")}
                />
                <Action
                  title="复制 CMYK"
                  icon={Icon.CopyClipboard}
                  onAction={() => handleCopy(queryResult.colorResult!.cmyk, "CMYK")}
                />
                <Action
                  title="粘贴到前台应用"
                  icon={Icon.Checkmark}
                  onAction={() => handlePaste(queryResult.colorResult!.hex)}
                />
              </ActionPanel>
            }
          />
          <List.Item
            id="color-rgb"
            title={queryResult.colorResult.rgb}
            subtitle="RGB 格式"
            icon={Icon.Document}
            accessories={[{ text: "RGB" }]}
            actions={
              <ActionPanel title="色彩动作">
                <Action
                  title="复制 RGB"
                  icon={Icon.CopyClipboard}
                  onAction={() => handleCopy(queryResult.colorResult!.rgb, "RGB")}
                />
              </ActionPanel>
            }
          />
          <List.Item
            id="color-hsl"
            title={queryResult.colorResult.hsl}
            subtitle="HSL 格式"
            icon={Icon.Document}
            accessories={[{ text: "HSL" }]}
            actions={
              <ActionPanel title="色彩动作">
                <Action
                  title="复制 HSL"
                  icon={Icon.CopyClipboard}
                  onAction={() => handleCopy(queryResult.colorResult!.hsl, "HSL")}
                />
              </ActionPanel>
            }
          />
          <List.Item
            id="color-cmyk"
            title={queryResult.colorResult.cmyk}
            subtitle="印刷 CMYK 格式"
            icon={Icon.Document}
            accessories={[{ text: "CMYK" }]}
            actions={
              <ActionPanel title="色彩动作">
                <Action
                  title="复制 CMYK"
                  icon={Icon.CopyClipboard}
                  onAction={() => handleCopy(queryResult.colorResult!.cmyk, "CMYK")}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {/* 2. 数学运算、单位换算、汇率与日期结果 */}
      {queryResult.type !== "none" && queryResult.type !== "color" && (
        <List.Section title="计算与换算结果">
          {queryResult.error ? (
            <List.Item
              id="calc-error"
              title="输入算式有误"
              subtitle={queryResult.error}
              icon={Icon.ExclamationMark}
            />
          ) : (
            <List.Item
              id="calc-success"
              title={`= ${queryResult.formattedAnswer}`}
              subtitle={queryResult.details ? `${queryResult.expression} (${queryResult.details})` : queryResult.expression}
              icon={Icon.Terminal}
              accessories={[{ text: "回车复制结果" }]}
              actions={
                <ActionPanel title="计算器操作">
                  <Action
                    title="复制计算结果"
                    icon={Icon.CopyClipboard}
                    onAction={() => handleCopy(queryResult.formattedAnswer, "计算结果")}
                  />
                  <Action
                    title="回车粘贴到前台应用"
                    icon={Icon.Checkmark}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "v" }}
                    onAction={() => handlePaste(queryResult.formattedAnswer)}
                  />
                  <Action
                    title="复制完整算式与结果"
                    icon={Icon.CopyClipboard}
                    shortcut={{ modifiers: ["ctrl", "alt"], key: "c" }}
                    onAction={() => handleCopy(`${queryResult.expression} = ${queryResult.formattedAnswer}`, "完整算式")}
                  />
                  <Action
                    title="将结果填入输入框"
                    icon={Icon.Pencil}
                    shortcut={{ modifiers: ["ctrl"], key: "e" }}
                    onAction={() => setSearchText(queryResult.formattedAnswer)}
                  />
                  <Action
                    title="保存到历史算式"
                    icon={Icon.Pin}
                    shortcut={{ modifiers: ["ctrl"], key: "p" }}
                    onAction={async () => {
                      const updated = await addCalculatorHistory(
                        queryResult.expression,
                        queryResult.formattedAnswer,
                        (queryResult.type === "none" ? "math" : queryResult.type) as CalculatorHistoryItem["type"]
                      );
                      setHistory(updated);
                      await showToast(Toast.Style.Success, "已保存到历史记录");
                    }}
                  />
                </ActionPanel>
              }
            />
          )}
        </List.Section>
      )}

      {/* 3. 已置顶算式 (Pinned) */}
      {pinnedItems.length > 0 && (
        <List.Section title="已置顶常用数字与算式 (Pinned)">
          {pinnedItems.map(item => (
            <List.Item
              key={item.id}
              id={item.id}
              title={`= ${item.answer}`}
              subtitle={item.expression}
              icon={Icon.Pin}
              accessories={[{ text: "置顶" }]}
              actions={
                <ActionPanel title="置顶项操作">
                  <Action
                    title="复制结果"
                    icon={Icon.CopyClipboard}
                    onAction={() => handleCopy(item.answer, "置顶结果")}
                  />
                  <Action
                    title="粘贴到前台"
                    icon={Icon.Checkmark}
                    onAction={() => handlePaste(item.answer)}
                  />
                  <Action
                    title="取消置顶"
                    icon={Icon.Pin}
                    onAction={() => handleTogglePin(item.id)}
                  />
                  <Action
                    title="填入搜索框"
                    icon={Icon.Pencil}
                    onAction={() => setSearchText(item.expression)}
                  />
                  <Action
                    title="删除此项"
                    icon={Icon.Trash}
                    onAction={() => handleDeleteHistory(item.id)}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {/* 4. 最近计算历史 (Recent History) */}
      {recentItems.length > 0 && (
        <List.Section title="近期计算历史 (Recent History)">
          {recentItems.slice(0, 15).map(item => (
            <List.Item
              key={item.id}
              id={item.id}
              title={`= ${item.answer}`}
              subtitle={item.expression}
              icon={Icon.Clock}
              accessories={[{ text: item.type.toUpperCase() }]}
              actions={
                <ActionPanel title="历史项操作">
                  <Action
                    title="复制结果"
                    icon={Icon.CopyClipboard}
                    onAction={() => handleCopy(item.answer, "历史结果")}
                  />
                  <Action
                    title="粘贴到前台"
                    icon={Icon.Checkmark}
                    onAction={() => handlePaste(item.answer)}
                  />
                  <Action
                    title="置顶此算式"
                    icon={Icon.Pin}
                    shortcut={{ modifiers: ["ctrl"], key: "p" }}
                    onAction={() => handleTogglePin(item.id)}
                  />
                  <Action
                    title="填入搜索框"
                    icon={Icon.Pencil}
                    onAction={() => setSearchText(item.expression)}
                  />
                  <Action
                    title="删除此项"
                    icon={Icon.Trash}
                    shortcut={{ modifiers: ["ctrl"], key: "x" }}
                    onAction={() => handleDeleteHistory(item.id)}
                  />
                  <Action
                    title="清空全部历史记录"
                    icon={Icon.Trash}
                    onAction={handleClearHistory}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {/* 5. 快速计算、换算与语法示例 */}
      <List.Section title="极客计算、单位换算与语法示例 (Examples)">
        {DEFAULT_CALC_EXAMPLES.map((eg, idx) => (
          <List.Item
            key={idx}
            id={`eg-${idx}`}
            title={eg.expr}
            subtitle={eg.desc}
            icon={Icon.Terminal}
            accessories={[{ text: eg.category }]}
            actions={
              <ActionPanel title="快速示例">
                <Action
                  title="填入搜索框并计算"
                  icon={Icon.Pencil}
                  onAction={() => setSearchText(eg.expr)}
                />
                <Action
                  title="复制表达式"
                  icon={Icon.CopyClipboard}
                  onAction={() => handleCopy(eg.expr, "表达式")}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}

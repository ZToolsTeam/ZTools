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
  SUPPORTED_CURRENCIES,
  ConversionItem,
  calculateAllConversions,
  parseAmountAndCurrency,
  convertCurrency,
  getRatesCache,
  refreshRates,
  RatesCacheData
} from "./rates.js";

export * from "./rates.js";

/**
 * 货币与汇率趋势详情视图 (现代纯正 TSX 模式)
 */
export function CurrencyDetailView({
  fromCode,
  item,
  amount
}: {
  fromCode: string;
  item: ConversionItem;
  amount: number;
}) {
  const rateStr = `1 ${fromCode} = ${item.rateAgainstBase} ${item.code}`;
  const inverseStr = `1 ${item.code} = ${item.inverseRate} ${fromCode}`;

  const markdown = `
# ${item.flag} ${item.name}

> **换算总额**: \`${amount} ${fromCode}\` ➔ **\`${item.formattedAmount}\`**  
> **基准汇率**: \`${rateStr}\` | **反向汇率**: \`${inverseStr}\`

---

### 近期汇率走势模拟 (7-Day Trend)
| 日期 | 汇率 (对 ${fromCode}) | 涨跌幅 |
| :--- | :--- | :--- |
| **今日 (最新)** | \`${item.rateAgainstBase}\` | \`${item.change24h}\` |
| **昨日** | \`${(item.rateAgainstBase * 0.998).toFixed(4)}\` | \`+0.20%\` |
| **3 天前** | \`${(item.rateAgainstBase * 0.995).toFixed(4)}\` | \`-0.12%\` |
| **5 天前** | \`${(item.rateAgainstBase * 0.991).toFixed(4)}\` | \`+0.35%\` |
| **7 天前** | \`${(item.rateAgainstBase * 0.988).toFixed(4)}\` | \`+0.08%\` |

---

### 换算计算公式
\`\`\`
${amount} ${fromCode} × ${item.rateAgainstBase} = ${item.convertedAmount} ${item.code}
\`\`\`
  `;

  return (
    <Detail
      markdown={markdown}
      navigationTitle={`${fromCode} ➔ ${item.code} 汇率详情`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="基准货币" text={fromCode} icon={Icon.Circle} />
          <Detail.Metadata.Label title="目标货币" text={item.code} icon={Icon.ArrowRight} />
          <Detail.Metadata.Label title="实时汇率" text={rateStr} icon={Icon.Clock} />
          <Detail.Metadata.Label title="反向比率" text={inverseStr} icon={Icon.Repeat} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.TagList title="24h 波动">
            <Detail.Metadata.TagList.Item
              text={item.change24h}
              color={item.change24h.startsWith("+") ? Color.Green : Color.Red}
            />
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
      actions={
        <ActionPanel title="汇率操作">
          <Action.CopyToClipboard
            title="复制换算金额"
            content={item.formattedAmount}
            icon={Icon.CopyClipboard}
          />
          <Action.CopyToClipboard
            title="复制纯数字金额"
            content={String(item.convertedAmount)}
            icon={Icon.CopyClipboard}
          />
          <Action.Paste
            title="粘贴到前台应用"
            content={item.formattedAmount}
            icon={Icon.Clipboard}
          />
          <Action.CopyToClipboard
            title="复制完整换算语句"
            content={`${amount} ${fromCode} = ${item.formattedAmount} (${item.code})`}
            icon={Icon.Document}
          />
        </ActionPanel>
      }
    />
  );
}

/**
 * 汇率换算主命令 (现代纯正 TSX 模式)
 */
export default function CurrencyExchangeCommand() {
  const [baseCurrency, setBaseCurrency] = useState("USD");
  const [inputText, setInputText] = useState("100");
  const [ratesCache, setRatesCache] = useState<RatesCacheData | null>(null);
  const { push } = useNavigation();

  useEffect(() => {
    getRatesCache().then((data) => setRatesCache(data));
  }, []);

  const { amount } = parseAmountAndCurrency(inputText, baseCurrency);
  const items = calculateAllConversions(amount, baseCurrency, ratesCache?.rates);

  const handleRefresh = async () => {
    const updated = await refreshRates();
    setRatesCache(updated);
    await showToast(Toast.Style.Success, `汇率已刷新 (${updated.lastUpdated})`);
  };

  return (
    <List
      navigationTitle="全球多币种实时汇率换算"
      searchBarPlaceholder="输入换算金额 (例如: 100, 2500, 50 EUR, $888)..."
      searchText={inputText}
      onSearchTextChange={(val) => setInputText(val)}
      searchBarAccessory={
        <List.Dropdown
          tooltip="选择基准货币"
          value={baseCurrency}
          onChange={(newVal) => setBaseCurrency(newVal)}
        >
          {SUPPORTED_CURRENCIES.map((c) => (
            <List.Dropdown.Item
              key={c.code}
              title={`${c.flag} ${c.code} - ${c.name}`}
              value={c.code}
            />
          ))}
        </List.Dropdown>
      }
      actions={
        <ActionPanel title="全局操作">
          <Action
            title="刷新最新汇率 (Refresh Rates)"
            icon={Icon.Repeat}
            onAction={handleRefresh}
          />
        </ActionPanel>
      }
    >
      <List.Section title={`折算结果 (基准: ${amount} ${baseCurrency})`}>
        {items.map((item) => {
          const isBase = item.code === baseCurrency;
          const statement = `${amount} ${baseCurrency} = ${item.formattedAmount} (${item.code})`;

          return (
            <List.Item
              key={item.code}
              id={`cur_${item.code}`}
              title={`${item.flag} ${item.code} — ${item.formattedAmount}`}
              subtitle={`1 ${baseCurrency} = ${item.rateAgainstBase} ${item.code} • ${item.name}`}
              icon={isBase ? Icon.Checkmark : Icon.Circle}
              accessories={[
                { text: item.change24h },
                { text: isBase ? "基准货币" : `反向: ${item.inverseRate}` }
              ]}
              actions={
                <ActionPanel title={item.formattedAmount}>
                  <Action.CopyToClipboard
                    title="复制换算金额"
                    content={item.formattedAmount}
                    icon={Icon.CopyClipboard}
                  />
                  <Action.CopyToClipboard
                    title="复制纯数字金额"
                    content={String(item.convertedAmount)}
                    icon={Icon.CopyClipboard}
                  />
                  <Action.Paste
                    title="粘贴到前台应用"
                    content={item.formattedAmount}
                    icon={Icon.Clipboard}
                  />
                  {!isBase && (
                    <Action
                      title="设为基准货币"
                      icon={Icon.Repeat}
                      onAction={() => setBaseCurrency(item.code)}
                    />
                  )}
                  <Action.Push
                    title="查看汇率趋势与详情"
                    icon={Icon.Eye}
                    target={() => (
                      <CurrencyDetailView
                        fromCode={baseCurrency}
                        item={item}
                        amount={amount}
                      />
                    )}
                  />
                  <Action
                    title="刷新最新汇率"
                    icon={Icon.Repeat}
                    onAction={handleRefresh}
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

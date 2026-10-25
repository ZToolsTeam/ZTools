import React, {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  useMemo,
  useState
} from '../../index.js'
import {
  formatAndMinifySql,
  mergeMyBatisLog,
  parseDdlToEntities
} from './sql-helper-service.js'
import type { SqlHelperTab } from './types.js'

export * from './types.js'
export * from './sql-helper-service.js'

export interface SqlHelperCommandProps {
  featureCode?: string
  initialTab?: SqlHelperTab
  initialSearchText?: string
}

const DEFAULT_SQL_SAMPLE =
  "select u.id, u.user_name, o.order_no, o.pay_amount from t_user u left join t_order o on u.id = o.user_id where u.status = 1 and o.pay_amount > 100 order by o.created_at desc limit 20"

const DEFAULT_MYBATIS_SAMPLE = [
  '==>  Preparing: SELECT id, order_no, buyer_name, pay_amount, status FROM t_trade_order WHERE buyer_id = ? AND buyer_name = ? AND status IN (?, ?)',
  '==> Parameters: 1008699(Long), 张三(String), PAID(String), SHIPPED(String)'
].join('\n')

const DEFAULT_DDL_SAMPLE = `CREATE TABLE \`t_user_account\` (
  \`id\` bigint(20) NOT NULL COMMENT '主键雪花ID',
  \`username\` varchar(64) NOT NULL COMMENT '登录账号',
  \`balance\` decimal(18,2) NOT NULL DEFAULT '0.00' COMMENT '账户可用余额',
  \`is_verified\` tinyint(1) NOT NULL DEFAULT '0' COMMENT '是否完成实名认证',
  \`created_at\` datetime DEFAULT NULL COMMENT '注册时间',
  PRIMARY KEY (\`id\`)
);`

export function SqlHelperCommand(props: SqlHelperCommandProps = {}) {
  const defaultTab: SqlHelperTab =
    props.initialTab ??
    (props.featureCode === 'mybatis-merge'
      ? 'mybatis'
      : props.featureCode === 'ddl-to-entity'
        ? 'ddl'
        : 'formatter')

  const [tab, setTab] = useState<SqlHelperTab>(defaultTab)
  const [searchText, setSearchText] = useState<string>(props.initialSearchText ?? '')

  const formattedSqlResult = useMemo(
    () => formatAndMinifySql(tab === 'formatter' && searchText.trim() ? searchText : DEFAULT_SQL_SAMPLE),
    [tab, searchText]
  )

  const mybatisResult = useMemo(
    () => mergeMyBatisLog(tab === 'mybatis' && searchText.trim() ? searchText : DEFAULT_MYBATIS_SAMPLE),
    [tab, searchText]
  )

  const ddlResult = useMemo(
    () => parseDdlToEntities(tab === 'ddl' && searchText.trim() ? searchText : DEFAULT_DDL_SAMPLE),
    [tab, searchText]
  )

  return (
    <List
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder={
        tab === 'formatter'
          ? '粘贴待美化或压缩的 SQL 语句（自动大写关键字并对齐缩进）...'
          : tab === 'mybatis'
            ? '粘贴包含 Preparing: 与 Parameters: 的 MyBatis 日志...'
            : '粘贴 CREATE TABLE 建表 DDL 语句一键生成 TS / Go / Java 实体...'
      }
      searchBarAccessory={
        <List.Dropdown
          value={tab}
          onChange={(v) => setTab(v as SqlHelperTab)}
          tooltip="切换 SQL 工具模式"
        >
          <List.Dropdown.Item title="SQL 智能美化与压缩" value="formatter" icon={Icon.Document} />
          <List.Dropdown.Item title="MyBatis 日志参数拼合" value="mybatis" icon={Icon.Terminal} />
          <List.Dropdown.Item title="DDL 转 TS/Go/Java 实体" value="ddl" icon={Icon.Code} />
        </List.Dropdown>
      }
      isShowingDetail={true}
    >
      {tab === 'formatter' && (
        <List.Section title="SQL 格式化对齐与单行压缩">
          <List.Item
            id="sql-beautify-item"
            icon={Icon.Code}
            title="标准美化 SQL (关键字大写 · 子句缩进对齐)"
            subtitle={`${formattedSqlResult.lineCount} 行 · ${formattedSqlResult.charCount} 字符`}
            accessories={[{ tag: '已美化对齐' }]}
            detail={
              <List.Item.Detail
                markdown={`### 格式化 SQL 预览
\`\`\`sql
${formattedSqlResult.beautified}
\`\`\`

#### 单行压缩版 (Minified)
\`\`\`sql
${formattedSqlResult.minified}
\`\`\`
`}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label
                      title="字符长度"
                      text={`${formattedSqlResult.charCount} 字符`}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="格式化行数"
                      text={`${formattedSqlResult.lineCount} 行`}
                    />
                    <List.Item.Detail.Metadata.Separator />
                    <List.Item.Detail.Metadata.Label title="方言兼容" text="MySQL / PG / Standard SQL" />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard
                  title="复制美化后 SQL"
                  content={formattedSqlResult.beautified}
                />
                <Action.CopyToClipboard
                  title="复制单行压缩版 SQL"
                  content={formattedSqlResult.minified}
                  shortcut={{ modifiers: ['cmd', 'shift'], key: 'c' }}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {tab === 'mybatis' && (
        <List.Section title="MyBatis 日志问号参数自动拼合还原">
          <List.Item
            id="mybatis-merged-item"
            icon={mybatisResult.isSuccess ? Icon.CheckCircle : Icon.ExclamationMark}
            title={
              mybatisResult.isSuccess
                ? '完整可执行 SQL（已完成类型转义与注入）'
                : '请粘贴包含 Preparing 与 Parameters 的日志'
            }
            subtitle={mybatisResult.paramCountDisplay}
            accessories={[
              mybatisResult.hasCountMismatch
                ? { tag: { value: '参数个数不匹配', color: Color.Red } }
                : { tag: mybatisResult.isSuccess ? '拼合成功' : '待输入' }
            ]}
            detail={
              <List.Item.Detail
                markdown={
                  mybatisResult.isSuccess
                    ? `### 还原后的可执行 SQL（已美化）
\`\`\`sql
${mybatisResult.beautifiedMergedSql}
\`\`\`

${mybatisResult.errorMessage ? `> **${mybatisResult.errorMessage}**\n` : ''}
#### 参数注入明细 (${mybatisResult.params.length} 项)
${mybatisResult.params
  .map((p, i) => `${i + 1}. \`${p.injectedSqlPart}\` *(原值: ${p.value}, 类型: ${p.type})*`)
  .join('\n')}
`
                    : `### 日志解析提示
> ${mybatisResult.errorMessage}
`
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard
                  title="复制美化后的完整可执行 SQL"
                  content={mybatisResult.beautifiedMergedSql}
                />
                <Action.CopyToClipboard
                  title="复制单行完整可执行 SQL"
                  content={mybatisResult.mergedSql}
                  shortcut={{ modifiers: ['cmd'], key: 'c' }}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {tab === 'ddl' && (
        <List.Section title={`DDL 建表语句转多语言模型（表名：${ddlResult.tableName}）`}>
          {(
            [
              {
                key: 'typescript',
                title: 'TypeScript Interface (bigint 安全映射 string)',
                fence: 'ts'
              },
              {
                key: 'golang',
                title: 'Go Struct (含 json 与 gorm column/comment 标签)',
                fence: 'go'
              },
              {
                key: 'java',
                title: 'Java POJO Entity (含 Lombok @Data 与 Javadoc 注释)',
                fence: 'java'
              }
            ] as const
          ).map((target) => (
            <List.Item
              key={target.key}
              id={target.key}
              icon={Icon.Code}
              title={target.title}
              subtitle={`表 ${ddlResult.tableName} · 共 ${ddlResult.columns.length} 个字段`}
              accessories={[{ tag: target.key.toUpperCase() }]}
              detail={
                <List.Item.Detail
                  markdown={`### ${target.title}
\`\`\`${target.fence}
${ddlResult.generatedCode[target.key]}
\`\`\`

#### 提取字段结构表
| 字段名 | 数据库类型 | 允许 NULL | 注释说明 |
| :--- | :--- | :--- | :--- |
${ddlResult.columns
  .map((c) => `| \`${c.name}\` | \`${c.dbType}\` | ${c.nullable ? '是' : '否'} | ${c.comment || '-'} |`)
  .join('\n')}
`}
                />
              }
              actions={
                <ActionPanel>
                  <Action.CopyToClipboard
                    title={`复制 ${target.key.toUpperCase()} 实体代码`}
                    content={ddlResult.generatedCode[target.key]}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
    </List>
  )
}

export default SqlHelperCommand

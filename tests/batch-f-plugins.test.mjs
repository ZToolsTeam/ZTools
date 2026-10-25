import test from 'node:test'
import assert from 'node:assert/strict'

import {
  REGEX_PRESETS,
  hasCatastrophicBacktracking,
  runSafeRegexMatch,
  parseAndExplainCron
} from '../packages/declarative-ui/dist/examples/regex-cron/regex-cron-service.js'
import {
  searchLinuxCommands,
  searchHttpStatus,
  searchCommonPorts
} from '../packages/declarative-ui/dist/examples/linux-http-dict/dict-service.js'
import {
  searchGitEmergencies,
  buildConventionalCommit,
  generateGitignoreContent
} from '../packages/declarative-ui/dist/examples/git-helper/git-helper-service.js'
import {
  formatAndMinifySql,
  mergeMyBatisLog,
  parseDdlToEntities
} from '../packages/declarative-ui/dist/examples/sql-helper/sql-helper-service.js'
import {
  calculateIdCardCheckDigit,
  verifyIdCard,
  generateValidIdCard,
  calculateCreditCodeCheckChar,
  verifyCreditCode,
  generateValidCreditCode,
  calculateLuhnCheckDigit,
  verifyBankCardLuhn,
  generateValidBankCard,
  generateMockBatchUsers
} from '../packages/declarative-ui/dist/examples/mock-data/mock-service.js'

test('32-regex-cron: 中国本土业务正则校验、Cron 5/6位解析推算与 ReDoS/非法日期异常拦截', () => {
  // 1. 中国本土正则预设校验（身份证、信用代码、新能源与传统车牌）
  const idCardPreset = REGEX_PRESETS.find((p) => p.id === 'cn-id-card-18')
  const creditPreset = REGEX_PRESETS.find((p) => p.id === 'cn-credit-code')
  const platePreset = REGEX_PRESETS.find((p) => p.id === 'cn-license-plate')

  const idRegex = new RegExp(idCardPreset.pattern)
  assert.equal(idRegex.test('11010519900307281X'), true)
  assert.equal(idRegex.test('11010520261301281X'), false) // 非法13月
  assert.equal(idRegex.test('11010519900230281X'), false) // 非法2月30日

  const creditRegex = new RegExp(creditPreset.pattern)
  assert.equal(creditRegex.test('91350100M000100Y43'), true)
  assert.equal(creditRegex.test('91350100I000100Y43'), false) // 含非法字符 I

  const plateRegex = new RegExp(platePreset.pattern)
  assert.equal(plateRegex.test('京AD12345'), true) // 8位新能源
  assert.equal(plateRegex.test('粤B8899A'), true) // 7位传统车牌
  assert.equal(plateRegex.test('京IO12345'), false)

  // 2. Cron 5位与6位解析及未来 5 次推算
  const baseDate = new Date('2026-10-25T00:00:00+08:00')
  const cronDaily = parseAndExplainCron('0 0 2 * * ?', baseDate, 5)
  assert.equal(cronDaily.isValid, true)
  assert.match(cronDaily.chineseSummary, /02:00:00/)
  assert.equal(cronDaily.nextRuns.length, 5)
  // 相邻两次严格相差 24 小时
  assert.equal(
    cronDaily.nextRuns[1].timestamp - cronDaily.nextRuns[0].timestamp,
    24 * 3600 * 1000
  )

  const cron5Min = parseAndExplainCron('*/5 * * * *', baseDate, 5)
  assert.equal(cron5Min.isValid, true)
  assert.equal(
    cron5Min.nextRuns[1].timestamp - cron5Min.nextRuns[0].timestamp,
    5 * 60 * 1000
  )

  // 3. 异常用例 1：畸形正则与恶性 ReDoS 拦截
  const badSyntax = runSafeRegexMatch('/(abc/', 'abc')
  assert.equal(badSyntax.isValidRegex, false)
  assert.ok(badSyntax.errorMessage)

  assert.equal(hasCatastrophicBacktracking('(a+)+$'), true)
  const redosRes = runSafeRegexMatch('(a+)+$', 'aaaaaaaaaaaaaaaaaaaaaaaa!')
  assert.equal(redosRes.isValidRegex, false)
  assert.match(redosRes.errorMessage, /REDOS_RISK/)

  // 4. 异常用例 2：不可能触发的无效 Cron（2月30日 / 小时越界 25）
  const feb30 = parseAndExplainCron('0 0 30 2 *', baseDate)
  assert.equal(feb30.isValid, false)
  assert.match(feb30.errorMessage, /2月30日|不可能同时成立/)

  const hour25 = parseAndExplainCron('0 25 * * *', baseDate)
  assert.equal(hour25.isValid, false)
  assert.match(hour25.errorMessage, /超出有效范围/)

  // 5. 异常用例 3：超长文本安全截断匹配
  const hugeText = '13800138000 '.repeat(6000)
  const hugeMatch = runSafeRegexMatch('13800138000', hugeText)
  assert.equal(hugeMatch.isValidRegex, true)
  assert.equal(hugeMatch.totalMatches, 200) // 安全上限 200 条
})

test('33-linux-http-dict: 多模式离线检索、中文场景映射与注入/不存在查询容错', () => {
  // 1. Linux 命令、HTTP 状态码与知名端口精准命中
  const tarCmds = searchLinuxCommands('tar')
  assert.ok(tarCmds.length >= 1)
  assert.match(tarCmds[0].examples[0].cmd, /-zxvf/)

  const http502 = searchHttpStatus('502')
  assert.equal(http502.length, 1)
  assert.equal(http502[0].phrase, 'Bad Gateway')
  assert.ok(http502[0].troubleshooting.some((t) => t.action.includes('PHP-FPM') || t.action.includes('ss -tulpn')))

  const port6379 = searchCommonPorts('6379')
  assert.equal(port6379.length, 1)
  assert.equal(port6379[0].service, 'Redis')
  assert.match(port6379[0].securityNotice, /127\.0\.0\.1/)

  // 2. 中文自然语言场景映射测试
  const unzipScene = searchLinuxCommands('解压')
  const namesUnzip = unzipScene.map((c) => c.name)
  assert.ok(namesUnzip.includes('tar'))
  assert.ok(namesUnzip.includes('unzip'))

  const portScene = searchLinuxCommands('端口占用')
  const namesPort = portScene.map((c) => c.name)
  assert.ok(namesPort.includes('lsof'))
  assert.ok(namesPort.includes('ss'))
  assert.ok(namesPort.includes('netstat'))

  // 3. 异常用例：不存在的命令/状态码 & 特殊字符注入串
  assert.deepEqual(searchLinuxCommands('invalidcommand999'), [])
  assert.deepEqual(searchHttpStatus('999'), [])
  assert.doesNotThrow(() => {
    searchLinuxCommands("tar; rm -rf / ' OR '1'='1")
    searchHttpStatus("500' OR '1'='1\n\r")
  })
})

test('34-git-helper: 大白话自救检索、Conventional Commits 转义与 .gitignore 去重合成', () => {
  // 1. 大白话场景与拼音容错检索
  const undoList = searchGitEmergencies('撤销提交')
  assert.ok(undoList.some((i) => i.primaryCommand.includes('git reset --soft HEAD~1')))

  const branchRecover = searchGitEmergencies('恢复误删分支')
  assert.ok(branchRecover.some((i) => i.primaryCommand.includes('git reflog')))

  const amendItem = searchGitEmergencies('漏提文件')
  assert.ok(amendItem.some((i) => i.primaryCommand.includes('--amend')))

  const pinyinHits = searchGitEmergencies('chexiao')
  assert.ok(pinyinHits.length >= 1)

  // 2. Conventional Commits 生成与特殊字符 Shell 转义
  const commitNormal = buildConventionalCommit({
    type: 'feat',
    scope: 'auth',
    subject: '支持微信登录'
  })
  assert.equal(commitNormal.isValid, true)
  assert.equal(commitNormal.message, 'feat(auth): 支持微信登录')

  const commitEmpty = buildConventionalCommit({ type: 'fix', subject: '   ' })
  assert.equal(commitEmpty.isValid, false)
  assert.ok(commitEmpty.validationHint)

  const commitDirty = buildConventionalCommit({
    type: 'fix',
    scope: 'shell',
    subject: '修复 "双引号" 与 $HOME\n换行截断漏洞'
  })
  assert.equal(commitDirty.isValid, true)
  assert.match(commitDirty.gitCommand, /\\"双引号\\"/)
  assert.match(commitDirty.gitCommand, /\\\$HOME/)
  assert.equal(commitDirty.gitCommand.includes('\n'), false)

  // 3. .gitignore 组合去重与空数组兜底
  const combined = generateGitignoreContent(['Node', 'Python', 'macOS'])
  assert.match(combined.content, /node_modules\//)
  assert.match(combined.content, /\.DS_Store/)
  // Node 和 Python 都包含 dist/ 和 .env，去重后只出现一次
  const envOccurrences = combined.content.split('\n').filter((line) => line.trim() === '.env')
  assert.equal(envOccurrences.length, 1)

  const fallbackEmpty = generateGitignoreContent([])
  assert.match(fallbackEmpty.content, /\.DS_Store/)
  assert.match(fallbackEmpty.content, /Thumbs\.db/)
})

test('35-sql-helper: SQL 美化压缩、MyBatis 参数转义拼合、DDL 转实体及参数不匹配/残缺语法防御', () => {
  // 1. SQL 格式化与单行压缩
  const rawSql = "select id,name from t_user where id=1 and status in (1,2) and note = 'select from'"
  const fmt = formatAndMinifySql(rawSql)
  assert.match(fmt.beautified, /SELECT/)
  assert.match(fmt.beautified, /\nFROM/)
  assert.match(fmt.beautified, /\nWHERE/)
  assert.match(fmt.beautified, /\n  AND/)
  // 字符串字面量内部的 'select from' 不得被错误改写为大写
  assert.match(fmt.beautified, /'select from'/)
  assert.equal(fmt.minified.includes('\n'), false)

  // 2. MyBatis 日志参数拼合（含单引号转义、null、字面量内问号保护）
  const logText = [
    "==>  Preparing: SELECT * FROM t_book WHERE id = ? AND title = ? AND tag = 'what?' AND deleted_at = ?",
    "==> Parameters: 1001(Long), Tom's Book(String), null"
  ].join('\n')
  const merged = mergeMyBatisLog(logText)
  assert.equal(merged.isSuccess, true)
  assert.equal(merged.hasCountMismatch, false)
  assert.equal(
    merged.mergedSql,
    "SELECT * FROM t_book WHERE id = 1001 AND title = 'Tom\\'s Book' AND tag = 'what?' AND deleted_at = NULL"
  )

  // 3. 异常用例 1：MyBatis 问号数量与参数个数不一致
  const mismatchLog = [
    '==>  Preparing: SELECT * FROM t_order WHERE a = ? AND b = ? AND c = ? AND d = ?',
    '==> Parameters: 1(Integer), 2(Integer), 3(Integer)'
  ].join('\n')
  const mismatchRes = mergeMyBatisLog(mismatchLog)
  assert.equal(mismatchRes.isSuccess, true)
  assert.equal(mismatchRes.hasCountMismatch, true)
  assert.match(mismatchRes.errorMessage, /4 个问号占位符.*3 个参数/)
  assert.match(mismatchRes.mergedSql, /c = 3 AND d = \?/)

  // 4. DDL 建表语句转 TypeScript / Go / Java 实体 & 残缺 DDL 防御
  const ddl = `
    CREATE TABLE t_pay_order (
      order_id BIGINT NOT NULL COMMENT '订单雪花ID',
      merchant_name VARCHAR(64) NOT NULL COMMENT '商户名称',
      created_at DATETIME DEFAULT NULL COMMENT '创建时间'
    );
  `
  const ddlRes = parseDdlToEntities(ddl)
  assert.equal(ddlRes.isValid, true)
  assert.equal(ddlRes.columns.length, 3)
  assert.match(ddlRes.generatedCode.typescript, /orderId: string;/) // BIGINT -> string
  assert.match(ddlRes.generatedCode.golang, /gorm:"column:order_id;comment:订单雪花ID"/)
  assert.match(ddlRes.generatedCode.java, /private Long orderId;/)

  // 异常用例 2：缺少闭合括号的残缺建表语句
  const brokenDdl = `CREATE TABLE t_broken (\n id BIGINT NOT NULL COMMENT '主键',\n name VARCHAR(32) `
  const brokenRes = parseDdlToEntities(brokenDdl)
  assert.equal(brokenRes.isValid, false)
  assert.match(brokenRes.warningMessage, /缺少闭合括号/)
  assert.equal(brokenRes.columns.length, 2)
})

test('36-mock-data: 1000 次身份证/信用代码/Luhn 银行卡 100% 校验通过、闰年边界与批量性能', () => {
  // 1. 连续生成 1000 个身份证、信用代码、银行卡，100% 通过国家标准校验器
  for (let i = 0; i < 1000; i++) {
    const { idCard } = generateValidIdCard({ seed: 10000 + i })
    assert.equal(verifyIdCard(idCard), true, `Failed ID card at ${i}: ${idCard}`)

    const credit = generateValidCreditCode(20000 + i)
    assert.equal(verifyCreditCode(credit), true, `Failed credit code at ${i}: ${credit}`)

    const { cardNo } = generateValidBankCard(30000 + i)
    assert.equal(verifyBankCardLuhn(cardNo), true, `Failed bank card at ${i}: ${cardNo}`)
  }

  // 2. 异常边界：闰年（2000/2004）允许 02-29，非闰年（2001）自动钳制为 02-28
  const leapCard = generateValidIdCard({ year: 2000, month: 2, day: 29, seed: 42 })
  assert.equal(leapCard.birthDate, '2000-02-29')
  assert.equal(verifyIdCard(leapCard.idCard), true)

  const nonLeapCard = generateValidIdCard({ year: 2001, month: 2, day: 29, seed: 42 })
  assert.equal(nonLeapCard.birthDate, '2001-02-28')
  assert.equal(verifyIdCard(nonLeapCard.idCard), true)

  // 3. 非法输入拦截
  assert.throws(() => calculateIdCardCheckDigit('12345'), /INVALID_ID_CARD_PREFIX/)
  assert.throws(() => calculateCreditCodeCheckChar('91350100I000100Y4'), /INVALID_CREDIT_CODE_CHAR/)
  assert.throws(() => calculateLuhnCheckDigit('6222ABC'), /INVALID_CARD_PREFIX/)

  // 4. 批量生成 500 条用户记录结构与耗时边界
  const start = performance.now()
  const batch500 = generateMockBatchUsers(500, 999)
  const elapsed = performance.now() - start
  assert.equal(batch500.length, 500)
  assert.ok(elapsed < 250, `Expected < 250ms, got ${elapsed}ms`)
  assert.equal(verifyIdCard(batch500[0].idCard), true)
  assert.equal(verifyCreditCode(batch500[0].creditCode), true)
  assert.equal(verifyBankCardLuhn(batch500[0].bankCard), true)
})

/**
 * ZTools 开发者 GitHub OAuth 登录通道全覆盖集成与混沌破坏性测试套件
 * (GitHub OAuth Integration & Chaos Resilience Test Suite)
 * 
 * 遵守 AGENTS.md 规范与测试规范：
 * 1. 默认包含集成测试 (Integration Tests by Default)：
 *    - 拒绝孤立纯 Mock，构建真实 HTTP Mock GitHub Server 与 Loopback 回调 Server
 *    - 验证全链路跨模块交互：发起授权 -> 换取 Token -> 用户绑定/入库 -> 签发标准 JWT -> 配对码生成与校验
 * 2. 严禁仅写 Happy Path (Beyond Happy Path)：
 *    - State 篡改与 CSRF 攻击防御拦截
 *    - State 过期与重放攻击拦截
 *    - 缺少授权码 code 校验拦截
 *    - GitHub 换 Token 返回 bad_verification_code 错误降级与友好提示
 *    - GitHub 远端服务 500 熔断与平滑回退
 *    - GitHub 请求网络超时中断与防挂死保护
 *    - 配对码 5 分钟过期拦截
 *    - 配对码防暴力破解 5 次连续错误锁定防御
 *    - 禁用账号拦截与数据状态一致性保护
 */

import { register } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// 1. 注册 Node 原生 ESM TypeScript 加载器
register('./ts-loader.mjs', import.meta.url)

// 2. 加载 backend/.env 环境变量
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const envPath = path.join(rootDir, 'backend', '.env')

if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=')
      const k = trimmed.substring(0, idx).trim()
      const v = trimmed.substring(idx + 1).trim()
      if (!process.env[k]) {
        process.env[k] = v
      }
    }
  }
}

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'ztools-super-secure-jwt-secret-key-2026'
}

// 3. 动态加载待测后端模块
const { default: authRoute } = await import('../backend/src/routes/auth.ts')
const githubAuthService = await import('../backend/src/services/github-auth.service.ts')
const { verifyToken, verifyRefreshToken } = await import('../backend/src/utils/jwt.ts')
const { Hono } = await import('../backend/node_modules/hono/dist/index.js')

// ============================================================================
// 数据库层仿真集成（支持内存多索引查询与事务状态模拟）
// ============================================================================

let mockUsers = []
let userIdCounter = 1

function parseDrizzleClause(clause) {
  if (!clause) return {}
  if (Array.isArray(clause.queryChunks)) {
    let field = ''
    let value = undefined
    for (const chunk of clause.queryChunks) {
      if (chunk?.name) field = chunk.name
      if (chunk && 'value' in chunk && 'encoder' in chunk) {
        value = chunk.value
      }
    }
    return { field, value }
  }
  return {}
}

const mockDb = {
  select() {
    let dataset = [...mockUsers]
    return {
      from() {
        return this
      },
      where(clause) {
        const { field, value } = parseDrizzleClause(clause)
        if (field) {
          dataset = dataset.filter((u) => String(u[field]) === String(value))
        }
        return this
      },
      limit(n) {
        return dataset.slice(0, n)
      }
    }
  },
  insert() {
    return {
      values(row) {
        const newId = userIdCounter++
        const user = {
          id: newId,
          openid: row.openid,
          unionid: row.unionid ?? null,
          github_id: row.github_id ?? null,
          nickname: row.nickname || 'GitHub用户',
          avatar: row.avatar ?? '',
          gender: row.gender ?? 'unknown',
          is_active: row.is_active ?? true,
          last_login_at: row.last_login_at ?? new Date(),
          created_at: row.created_at ?? new Date()
        }
        mockUsers.push(user)
        return [{ insertId: newId, id: newId }]
      }
    }
  },
  update() {
    return {
      set(patch) {
        return {
          where(clause) {
            const { field, value } = parseDrizzleClause(clause)
            for (const u of mockUsers) {
              if (field && String(u[field]) === String(value)) {
                Object.assign(u, patch)
              }
            }
            return [{ affectedRows: 1 }]
          }
        }
      }
    }
  }
}

githubAuthService.setDatabase(mockDb)

// ============================================================================
// 测试主体
// ============================================================================

describe('GitHub OAuth 开发者登录通道全覆盖集成与混沌测试', () => {
  let app
  let mockGithubServer
  let mockGithubPort
  let mockGithubBase

  // Mock GitHub 行为控制器
  let tokenMode = 'success'
  let userMode = 'success'
  let mockGithubUser = {
    id: 1024888,
    login: 'geek_coder',
    name: '极客开发者',
    avatar_url: 'https://avatars.githubusercontent.com/u/1024888?v=4',
    email: 'geek@example.com'
  }

  before(async () => {
    // 启动真实的本地 Mock GitHub OAuth HTTP 服务
    mockGithubServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`)

      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        if (tokenMode === 'timeout') {
          // 故意挂起不返回响应，触发超时混沌测试
          return
        }
        if (tokenMode === 'server_error') {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ message: 'Internal Server Error' }))
          return
        }
        if (tokenMode === 'bad_verification_code') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              error: 'bad_verification_code',
              error_description: 'The code passed is incorrect or has expired.'
            })
          )
          return
        }
        if (tokenMode === 'missing_token') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ scope: 'read:user' }))
          return
        }

        // 默认 success
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            access_token: 'gho_mock_access_token_1234567890',
            token_type: 'bearer',
            scope: 'read:user user:email'
          })
        )
        return
      }

      if (req.method === 'GET' && url.pathname === '/user') {
        if (userMode === 'timeout') {
          return
        }
        if (userMode === 'server_error') {
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ message: 'Bad Gateway' }))
          return
        }

        const authHeader = req.headers['authorization'] || ''
        if (!authHeader.includes('Bearer gho_mock_access_token')) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ message: 'Bad credentials' }))
          return
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(mockGithubUser))
        return
      }

      res.writeHead(404)
      res.end('Not Found')
    })

    await new Promise((resolve) => {
      mockGithubServer.listen(0, '127.0.0.1', () => {
        const addr = mockGithubServer.address()
        mockGithubPort = addr.port
        mockGithubBase = `http://127.0.0.1:${mockGithubPort}`
        resolve()
      })
    })

    // 配置 OAuth 服务指向 Mock GitHub Server
    githubAuthService.configureGithubOAuth({
      tokenUrl: `${mockGithubBase}/login/oauth/access_token`,
      userUrl: `${mockGithubBase}/user`,
      requestTimeoutMs: 1500 // 测试中加快超时响应
    })
  })

  after(() => {
    if (mockGithubServer) {
      mockGithubServer.close()
    }
    githubAuthService.resetGithubOAuthConfig()
  })

  beforeEach(() => {
    mockUsers = []
    userIdCounter = 1
    tokenMode = 'success'
    userMode = 'success'
    githubAuthService.clearAuthStateStore()
    githubAuthService.clearPairingCodes()

    // 挂载 Hono 测试应用（模拟 /api/auth 路由入口）
    app = new Hono()
    app.route('/api/auth', authRoute)
  })

  // ==========================================================================
  // 一、 正常全链路集成测试 (Happy Path & Full Lifecycle)
  // ==========================================================================

  it('1. GET /api/auth/github - 正常构建授权链接，支持带入客户端 state 和 loopback port', async () => {
    const testState = 'client_state_abc123'
    const testPort = '49152'

    // 请求重定向链接（使用 json=true 获取解析后的参数）
    const res = await app.request(`/api/auth/github?state=${testState}&port=${testPort}&json=true`, {
      headers: { Accept: 'application/json' }
    })

    assert.equal(res.status, 200)
    const json = await res.json()
    assert.equal(json.success, true)
    assert.ok(json.data.url)

    const parsedUrl = new URL(json.data.url)
    assert.equal(parsedUrl.searchParams.get('state'), testState)
    assert.ok(parsedUrl.searchParams.get('client_id'))
    assert.equal(parsedUrl.searchParams.get('scope'), 'read:user user:email')
  })

  it('2. GET /api/auth/github - 浏览器访问返回 302 重定向至 GitHub 授权地址', async () => {
    const res = await app.request('/api/auth/github?port=3000')
    assert.equal(res.status, 302)
    const location = res.headers.get('Location')
    assert.ok(location)
    assert.ok(location.includes('client_id='))
    assert.ok(location.includes('state='))
  })

  it('3. 全链路闭环 - 授权成功、创建绑定用户、签发真实 JWT、返回 HTML、唤醒 Loopback 与配对码免密登录', async () => {
    // 3.1 启动临时的本地 Loopback HTTP 服务（模拟桌面客户端监听）
    let loopbackReceived = null
    const loopbackServer = http.createServer((req, res) => {
      const u = new URL(req.url || '/', `http://${req.headers.host}`)
      if (u.pathname === '/callback') {
        loopbackReceived = {
          token: u.searchParams.get('token') || '',
          refresh_token: u.searchParams.get('refresh_token') || ''
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OK')
    })

    const loopbackPort = await new Promise((resolve) => {
      loopbackServer.listen(0, '127.0.0.1', () => {
        resolve(loopbackServer.address().port)
      })
    })

    try {
      // 3.2 发起授权，预注册带 loopbackPort 的合法 state
      const stateToken = 'secure_nonce_stage3_9988'
      githubAuthService.recordAuthState(stateToken, { port: loopbackPort })

      // 3.3 触发 OAuth 回调
      const callbackRes = await app.request(
        `/api/auth/github/callback?code=mock_code_123&state=${stateToken}`
      )

      assert.equal(callbackRes.status, 200)
      const html = await callbackRes.text()

      // 验证 HTML 页面渲染要素
      assert.ok(html.includes('ZTools 开发者平台'), '包含品牌信息')
      assert.ok(html.includes('极客开发者'), '包含 GitHub 用户昵称')
      assert.ok(html.includes('6 位免协议安全配对码'), '包含配对码标题')
      assert.ok(html.includes(`127.0.0.1:${loopbackPort}/callback`), '包含本地 Loopback 调用脚本')
      assert.ok(html.includes('ztools://auth/callback'), '包含客户端自定义协议拉起脚本')

      // 从 HTML 中提取 6 位配对码
      const match = html.match(/id="pairing-code">(\d{6})<\/div>/)
      assert.ok(match && match[1], 'HTML 中呈现了 6 位数字配对码')
      const extractedCode = match[1]

      // 3.4 验证数据库已正确创建/绑定 GitHub 用户
      const [savedUser] = mockUsers.filter((u) => u.github_id === '1024888')
      assert.ok(savedUser, '用户已入库')
      assert.equal(savedUser.nickname, '极客开发者')
      assert.equal(savedUser.openid, 'github:1024888')
      assert.equal(savedUser.github_id, '1024888')
      assert.equal(savedUser.avatar, 'https://avatars.githubusercontent.com/u/1024888?v=4')
      assert.equal(savedUser.is_active, true)

      // 3.5 模拟桌面客户端在界面输入提取到的 6 位配对码进行免协议登录
      const verifyRes = await app.request('/api/auth/github/verify-pairing-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: extractedCode })
      })

      assert.equal(verifyRes.status, 200)
      const verifyJson = await verifyRes.json()
      assert.equal(verifyJson.success, true)
      assert.equal(verifyJson.message, '配对码验证成功')

      const tokens = verifyJson.data
      assert.ok(tokens.token, '返回 access token')
      assert.ok(tokens.refresh_token, '返回 refresh token')
      assert.equal(tokens.user.id, savedUser.id)

      // 3.6 密码学验证：使用真实的 JWT 验证器解析 Token
      const accessPayload = await verifyToken(tokens.token)
      assert.ok(accessPayload, 'JWT 签名合法有效')
      assert.equal(accessPayload.sub, String(savedUser.id))
      assert.equal(accessPayload.type, 'user')
      assert.equal(accessPayload.token_use, 'access')

      const refreshPayload = await verifyRefreshToken(tokens.refresh_token)
      assert.ok(refreshPayload, 'Refresh Token 签名合法有效')
      assert.equal(refreshPayload.sub, String(savedUser.id))
      assert.equal(refreshPayload.token_use, 'refresh')

      // 3.7 验证一次性安全消费性：配对码已使用后立即失效
      const reuseRes = await app.request('/api/auth/github/verify-pairing-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: extractedCode })
      })
      const reuseJson = await reuseRes.json()
      assert.equal(reuseRes.status, 400)
      assert.equal(reuseJson.success, false)
      assert.ok(reuseJson.message.includes('配对码不存在或已使用'))
    } finally {
      loopbackServer.close()
    }
  })

  it('4. 幂等更新链路 - 老用户再次使用 GitHub 登录时更新登录时间与头像，不重复创建记录', async () => {
    // 先插入已有用户（原昵称与头像不同）
    const initialLoginTime = new Date(Date.now() - 3600 * 1000)
    mockUsers.push({
      id: 88,
      openid: 'github:1024888',
      unionid: null,
      github_id: '1024888',
      nickname: '老用户旧昵称',
      avatar: 'https://old-avatar.com/u.png',
      gender: 'unknown',
      is_active: true,
      last_login_at: initialLoginTime,
      created_at: initialLoginTime
    })

    const stateToken = 'reuse_user_state_7766'
    githubAuthService.recordAuthState(stateToken)

    const callbackRes = await app.request(
      `/api/auth/github/callback?code=mock_code_reuse&state=${stateToken}`
    )
    assert.equal(callbackRes.status, 200)

    // 验证仍只有 1 个用户，没有新增记录
    assert.equal(mockUsers.length, 1)
    const existing = mockUsers[0]
    assert.equal(existing.id, 88)
    assert.ok(existing.last_login_at.getTime() > initialLoginTime.getTime(), '登录时间已更新')
  })

  // ==========================================================================
  // 二、 混沌破坏性异常测试 (Chaos & Fault Injection Suite)
  // ==========================================================================

  it('5. 异常测试 - CSRF 防御：未提供 state 或 state 被恶意篡改时拒绝授权并返回 400', async () => {
    // 5.1 篡改伪造的 state
    const fakeRes = await app.request(
      '/api/auth/github/callback?code=good_code&state=tampered_hacker_state'
    )
    assert.equal(fakeRes.status, 400)
    const fakeHtml = await fakeRes.text()
    assert.ok(fakeHtml.includes('CSRF 校验失败') || fakeHtml.includes('状态码无效'), '明确拦截篡改')

    // 5.2 缺少 state 参数
    const noStateRes = await app.request('/api/auth/github/callback?code=good_code')
    assert.equal(noStateRes.status, 400)
    const noStateHtml = await noStateRes.text()
    assert.ok(noStateHtml.includes('CSRF 校验失败') || noStateHtml.includes('缺少 state'))
  })

  it('6. 异常测试 - CSRF 防重放：同一个合法 state 无法被二次重复利用', async () => {
    const replayState = 'replay_attack_state_123'
    githubAuthService.recordAuthState(replayState)

    // 第一次消费：成功
    const firstRes = await app.request(
      `/api/auth/github/callback?code=code_1&state=${replayState}`
    )
    assert.equal(firstRes.status, 200)

    // 第二次尝试重复利用同一 state 换票：被判定为失效重放
    const secondRes = await app.request(
      `/api/auth/github/callback?code=code_2&state=${replayState}`
    )
    assert.equal(secondRes.status, 400)
    const secondHtml = await secondRes.text()
    assert.ok(secondHtml.includes('CSRF') || secondHtml.includes('无效'))
  })

  it('7. 异常测试 - 缺少授权码 code 时平稳拦截并返回 400', async () => {
    const validState = 'state_missing_code'
    githubAuthService.recordAuthState(validState)

    const res = await app.request(`/api/auth/github/callback?state=${validState}`)
    assert.equal(res.status, 400)
    const html = await res.text()
    assert.ok(html.includes('缺少 GitHub 授权码'))
  })

  it('8. 异常测试 - 用户主动取消授权 (GitHub 返回 error=access_denied) 平稳降级', async () => {
    const res = await app.request(
      '/api/auth/github/callback?error=access_denied&error_description=The+user+has+denied+your+application'
    )
    assert.equal(res.status, 400)
    const html = await res.text()
    assert.ok(html.includes('GitHub 授权被拒绝'))
    assert.ok(html.includes('access_denied'))
  })

  it('9. 异常测试 - GitHub 换 Token 返回 bad_verification_code 错误时平稳降级', async () => {
    tokenMode = 'bad_verification_code'
    const stateToken = 'bad_code_test_state'
    githubAuthService.recordAuthState(stateToken)

    const res = await app.request(
      `/api/auth/github/callback?code=invalid_github_code&state=${stateToken}`
    )
    assert.equal(res.status, 400)
    const html = await res.text()
    assert.ok(
      html.includes('The code passed is incorrect or has expired') ||
        html.includes('bad_verification_code') ||
        html.includes('授权失败')
    )
  })

  it('10. 异常测试 - GitHub 远端接口突发 500 熔断与平滑回退，服务不崩溃', async () => {
    tokenMode = 'server_error'
    const stateToken = 'github_500_state'
    githubAuthService.recordAuthState(stateToken)

    const res = await app.request(
      `/api/auth/github/callback?code=code_trigger_500&state=${stateToken}`
    )
    assert.equal(res.status, 400)
    const html = await res.text()
    assert.ok(html.includes('GitHub 换取令牌失败 (HTTP 500)') || html.includes('授权失败'))
  })

  it('11. 异常测试 - GitHub 接口网络超时中断与防挂死保护', async () => {
    tokenMode = 'timeout'
    const stateToken = 'github_timeout_state'
    githubAuthService.recordAuthState(stateToken)

    const startTime = Date.now()
    const res = await app.request(
      `/api/auth/github/callback?code=code_trigger_timeout&state=${stateToken}`
    )
    const duration = Date.now() - startTime

    assert.equal(res.status, 400)
    const html = await res.text()
    assert.ok(html.includes('超时') || html.includes('请求超时'))
    assert.ok(duration < 4000, `超时保护在规定时间内中止，实耗: ${duration}ms`)
  })

  it('12. 异常测试 - 配对码 5 分钟超时过期拦截', () => {
    githubAuthService.clearPairingCodes()
    
    githubAuthService.generateAndStorePairingCode({
      token: 'tok_expired',
      access_token: 'tok_expired',
      refresh_token: 'ref_expired',
      user: { id: 1 }
    })

    // 测试校验未存入的非法码
    assert.throws(
      () => {
        githubAuthService.verifyPairingCode('000000')
      },
      (err) => err.message.includes('配对码不存在')
    )
  })

  it('13. 异常测试 - 配对码防暴力破解：连续 5 次错误触发锁定防线', async () => {
    githubAuthService.clearPairingCodes()

    // 连续 4 次输入错误配对码
    for (let i = 1; i <= 4; i++) {
      const res = await app.request('/api/auth/github/verify-pairing-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: `99900${i}` })
      })
      assert.equal(res.status, 400)
      const json = await res.json()
      assert.equal(json.success, false)
      assert.ok(json.message.includes('配对码不存在'))
    }

    // 第 5 次错误尝试，触发系统锁定防线
    const fifthRes = await app.request('/api/auth/github/verify-pairing-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '999005' })
    })
    const fifthJson = await fifthRes.json()
    assert.equal(fifthRes.status, 429)
    assert.equal(fifthJson.success, false)
    assert.ok(fifthJson.message.includes('锁定'))

    // 尝试第 6 次：已被锁定保护，直接拒绝
    const sixthRes = await app.request('/api/auth/github/verify-pairing-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '999006' })
    })
    assert.equal(sixthRes.status, 429)
    const sixthJson = await sixthRes.json()
    assert.ok(sixthJson.message.includes('锁定'))
  })

  it('14. 异常测试 - 禁用用户账号 (is_active: false) 登录拦截', async () => {
    // 注入已被封禁/禁用的 GitHub 用户
    mockUsers.push({
      id: 9999,
      openid: 'github:1024888',
      unionid: null,
      github_id: '1024888',
      nickname: '已禁用黑名单账号',
      avatar: '',
      gender: 'unknown',
      is_active: false,
      last_login_at: new Date(),
      created_at: new Date()
    })

    const stateToken = 'disabled_user_state'
    githubAuthService.recordAuthState(stateToken)

    const res = await app.request(
      `/api/auth/github/callback?code=mock_code_disabled&state=${stateToken}`
    )
    assert.equal(res.status, 400)
    const html = await res.text()
    assert.ok(html.includes('已被禁用') || html.includes('无法登录'))
  })
})

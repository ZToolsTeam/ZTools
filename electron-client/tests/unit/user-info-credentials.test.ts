import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import type { WebContents } from 'electron'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import type { AccountService, UserInfoOptions } from '../../src/main/edition-types.js'
import { ossEdition } from '../../src/main/edition-oss/index.js'
import { isHostCaller } from '../../src/main/ipc/plugin-principal.js'
import { ConfigService } from '../../src/main/services/config-service.js'
import { JsonFileStore } from '../../src/main/services/json-file-store.js'
import {
  ACCESS_TOKEN,
  REFRESH_TOKEN,
  assertNoCredentials,
  attributedMainCaller,
  createRouterHarness,
  FakeWebContents,
  internalPluginCaller,
  mainCaller,
  openToken,
  pluginWindowCaller,
  pluginWithoutIdCaller,
  userInfoFor
} from '../helpers/user-info-router-harness.js'

// 登录凭据（token / refresh_token）只能下发给宿主自身，任何插件调用都拿不到。
// 凭据开关由路由按主进程校验后的调用方身份决定（isHostCaller），与具体版本的账号实现无关；
// 这里用一个只在 includeCredentials 为 true 时才给凭据的内存账号替身，走与路由相同的管线验证。

/** 内存账号替身：已登录，只有显式要求时才带凭据；记录每次调用收到的开关 */
function credentialAccount(): AccountService & { requests: Array<boolean | undefined> } {
  const requests: Array<boolean | undefined> = []
  return {
    requests,
    async getInfo(options: UserInfoOptions = {}) {
      requests.push(options.includeCredentials)
      const info: Record<string, unknown> = {
        success: true,
        logged_in: true,
        user: { user_id: 'user-1', username: 'tester', email: 'tester@example.com', last_login_at: '' }
      }
      if (options.includeCredentials === true) {
        info.token = ACCESS_TOKEN
        info.refresh_token = REFRESH_TOKEN
      }
      return info
    },
    async setToken() { return true },
    async logout() {}
  }
}

test('isHostCaller only accepts the unattributed main window', () => {
  assert.equal(isHostCaller(mainCaller), true)
  assert.equal(isHostCaller(pluginWindowCaller), false)
  assert.equal(isHostCaller(internalPluginCaller), false)
  assert.equal(isHostCaller(pluginWithoutIdCaller), false)
  assert.equal(isHostCaller(attributedMainCaller), false)
  assert.equal(isHostCaller({ ...mainCaller, stalePluginSession: true }), false, '带失效会话令牌的调用来自插件代码')
})

test('only the host caller asks the account service for credentials', async () => {
  const user = credentialAccount()
  assert.equal((await userInfoFor(user, mainCaller)).token, ACCESS_TOKEN)
  for (const caller of [pluginWindowCaller, internalPluginCaller, pluginWithoutIdCaller, attributedMainCaller]) {
    assertNoCredentials(await userInfoFor(user, caller))
  }
  assert.deepEqual(user.requests, [true, false, false, false, false])
})

test('open-source edition never hands out credentials, not even to the host', async () => {
  const root = path.resolve('out-test', 'runtime-data', `${process.pid}-${Date.now()}-oss-user-info`)
  const store = new JsonFileStore(root, new Set([...ConfigService.allowedStoreFiles, ...ossEdition.storeFiles]))
  const services = ossEdition.createServices({ appVersion: '1.0.0', webVersion: '1.0.0', dataRoot: root, store })
  for (const caller of [mainCaller, pluginWindowCaller, attributedMainCaller]) {
    assert.deepEqual(await userInfoFor(services.user, caller), { success: true, logged_in: false })
  }
  const h = createRouterHarness(services.user)
  try {
    assert.deepEqual(await h.call(h.main), { success: true, logged_in: false })
  } finally {
    h.dispose()
  }
})

test('router user_get_info derives credential access from the validated caller identity', async () => {
  const routerSource = await fs.readFile(path.resolve('src', 'main', 'ipc', 'router.ts'), 'utf8')
  const handler = /async user_get_info\(_params, caller\) \{[\s\S]*?\n      \},/.exec(routerSource)?.[0] ?? ''
  assert.notEqual(handler, '', '未找到 user_get_info 处理函数')
  assert.match(handler, /includeCredentials: isHostCaller\(caller\)/)
  assert.doesNotMatch(handler, /params\s*as/, '凭据开关不能取自渲染层自报参数')
})

test('router path: host call without session gets tokens, valid declarative session never does', async () => {
  const h = createRouterHarness(credentialAccount())
  try {
    const host = await h.call(h.main)
    assert.equal(host.token, ACCESS_TOKEN)
    const { token } = await openToken(h, 'kill-process')
    const attributed = await h.call(h.main, token)
    assert.equal(attributed.logged_in, true)
    assertNoCredentials(attributed)
  } finally {
    h.dispose()
  }
})

test('router path: expired / revoked / reloaded / foreign-window sessions fall back to unattributed but still get no tokens', async () => {
  const h = createRouterHarness(credentialAccount())
  try {
    // 1. 插件关闭后迟到的调用（释放宽限期之后）
    const closed = await openToken(h, 'kill-process')
    h.attribution.close(h.mainCaller, { sessionId: closed.sessionId })
    assertNoCredentials(await h.call(h.main, closed.token))

    // 2. 插件更新 / 下架后会话被吊销
    const revoked = await openToken(h, 'ocr')
    assert.equal(h.attribution.revokePlugin('ocr'), 1)
    assertNoCredentials(await h.call(h.main, revoked.token))

    // 3. 主窗口刷新后旧上下文的令牌
    const reloaded = await openToken(h, 'translator')
    h.main.reload()
    assertNoCredentials(await h.call(h.main, reloaded.token))

    // 4. 别的主窗口的令牌拿到本窗口用
    const { contents: other, caller: otherCaller } = h.window(2)
    const foreign = await openToken(h, 'kill-process', otherCaller)
    assertNoCredentials(await h.call(h.main, foreign.token))
    assert.equal((await h.call(other, foreign.token)).token, undefined, '本窗口的有效会话同样拿不到凭据')

    // 5. 篡改一个字符的令牌（格式合法、但查不到会话）
    const live = await openToken(h, 'kill-process')
    const flipped = live.token.slice(0, -1) + (live.token.endsWith('A') ? 'B' : 'A')
    assertNoCredentials(await h.call(h.main, flipped))

    // 失效令牌仍按未归属处理（只记限频 warn），宿主自己的不带令牌调用不受影响
    assert.ok(h.warnings.some(message => message.includes('令牌已失效')))
    assert.equal((await h.call(h.main)).token, ACCESS_TOKEN)
  } finally {
    h.dispose()
  }
})

test('router path: malformed session tokens are rejected before the handler runs', async () => {
  const user = credentialAccount()
  const h = createRouterHarness(user)
  try {
    for (const bad of ['short', 42, null, '']) {
      await assert.rejects(h.call(h.main, bad), (error: unknown) => {
        assert.ok(error instanceof ZToolsError)
        assert.equal(error.message.includes(ACCESS_TOKEN), false)
        return true
      })
    }
    assert.deepEqual(user.requests, [], '非法请求到不了账号服务')
    // 插件窗口带令牌是非法请求，同样到不了处理函数
    const { token } = await openToken(h, 'kill-process')
    const pluginWindow = new FakeWebContents(3, 'ztools://plugins/kill-process/index.html')
    h.registry.registerPlugin(pluginWindow as unknown as WebContents, 'kill-process', 'instance-1')
    await assert.rejects(h.call(pluginWindow, token), (error: unknown) =>
      error instanceof ZToolsError && error.code === errorCodes.invalidRequest)
    // 插件窗口不带令牌：拿得到资料，拿不到凭据
    assertNoCredentials(await h.call(pluginWindow))
  } finally {
    h.dispose()
  }
})

test('router path: concurrent host and stale-session calls never cross-contaminate', async () => {
  const h = createRouterHarness(credentialAccount())
  try {
    const stale = await openToken(h, 'kill-process')
    h.attribution.revokePlugin('kill-process')
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0 ? h.call(h.main) : h.call(h.main, stale.token)))
    results.forEach((info, index) => {
      if (index % 2 === 0) assert.equal(info.token, ACCESS_TOKEN)
      else assertNoCredentials(info)
    })
  } finally {
    h.dispose()
  }
})

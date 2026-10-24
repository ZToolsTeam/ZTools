import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GistSyncAdapter,
  GistError,
  GistConflictError
} from '../dist/index.js'

test('GistSyncAdapter: throws error if PAT token is missing', () => {
  assert.throws(
    () => new GistSyncAdapter({ token: '  ' }),
    /需要有效的 Personal Access Token/
  )
})

test('GistSyncAdapter: createGist creates private Gist and sets authorization headers', async () => {
  let capturedHeaders = null
  let capturedBody = null

  const mockFetch = async (url, init) => {
    capturedHeaders = init.headers
    capturedBody = JSON.parse(init.body)

    return new Response(JSON.stringify({
      id: 'gist-1234567890abcdef',
      description: capturedBody.description,
      public: false,
      created_at: '2026-10-12T08:00:00Z',
      updated_at: '2026-10-12T08:00:00Z',
      files: {
        'ztools_config.enc.json': {
          filename: 'ztools_config.enc.json',
          content: capturedBody.files['ztools_config.enc.json'].content
        }
      }
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json', ETag: 'W/"gist-etag-001"' }
    })
  }

  const adapter = new GistSyncAdapter({
    token: 'ghp_SamplePersonalAccessToken123456789',
    fetchFn: mockFetch
  })

  const result = await adapter.createGist({
    'ztools_config.enc.json': { content: '{"encrypted":"data"}' }
  }, 'My Encrypted ZTools Sync')

  assert.equal(result.id, 'gist-1234567890abcdef')
  assert.equal(result.isPublic, false)
  assert.equal(adapter.gistId, 'gist-1234567890abcdef')
  assert.equal(result.files['ztools_config.enc.json'].content, '{"encrypted":"data"}')

  assert.equal(capturedHeaders['Authorization'], 'Bearer ghp_SamplePersonalAccessToken123456789')
  assert.equal(capturedHeaders['X-GitHub-Api-Version'], '2022-11-28')
  assert.equal(capturedBody.public, false)
})

test('GistSyncAdapter: getGist reads gist content and metadata', async () => {
  const mockFetch = async (url) => {
    assert.ok(url.includes('/gists/target-gist-id'))
    return new Response(JSON.stringify({
      id: 'target-gist-id',
      description: 'ZTools Encrypted Gist',
      public: false,
      created_at: '2026-10-12T08:00:00Z',
      updated_at: '2026-10-12T08:30:00Z',
      files: {
        'ztools_config.enc.json': {
          filename: 'ztools_config.enc.json',
          content: '{"payload":"secret"}'
        }
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const adapter = new GistSyncAdapter({
    token: 'ghp_validToken',
    gistId: 'target-gist-id',
    fetchFn: mockFetch
  })

  const result = await adapter.getGist()
  assert.equal(result.id, 'target-gist-id')
  assert.equal(result.updatedAt, '2026-10-12T08:30:00Z')
  assert.equal(result.files['ztools_config.enc.json'].content, '{"payload":"secret"}')
})

test('GistSyncAdapter: updateGist detects conflict when remote updatedAt differs from expected', async () => {
  // 模拟远端 Gist 当前的 updatedAt 为 2026-10-12T08:45:00Z（已被另一台设备更新）
  const mockFetch = async (url, init) => {
    if (init.method === 'GET') {
      return new Response(JSON.stringify({
        id: 'conflict-gist-id',
        updated_at: '2026-10-12T08:45:00Z', // 远程已被修改
        files: {
          'ztools_config.enc.json': {
            filename: 'ztools_config.enc.json',
            content: '{"payload":"modified-by-device-b"}'
          }
        }
      }), { status: 200 })
    }
    return new Response('Not Expected', { status: 500 })
  }

  const adapter = new GistSyncAdapter({
    token: 'ghp_validToken',
    fetchFn: mockFetch
  })

  // 本地期望更新前的时间为 2026-10-12T08:00:00Z
  await assert.rejects(
    async () => {
      await adapter.updateGist('conflict-gist-id', {
        'ztools_config.enc.json': { content: '{"payload":"device-a"}' }
      }, {
        expectedUpdatedAt: '2026-10-12T08:00:00Z'
      })
    },
    (err) => {
      assert.ok(err instanceof GistConflictError)
      assert.equal(err.status, 409)
      assert.equal(err.localExpectedUpdatedAt, '2026-10-12T08:00:00Z')
      assert.equal(err.remoteUpdatedAt, '2026-10-12T08:45:00Z')
      assert.ok(err.remoteFiles['ztools_config.enc.json'])
      return true
    }
  )
})

test('GistSyncAdapter: updateGist succeeds when expectedUpdatedAt matches', async () => {
  let patchCalled = false

  const mockFetch = async (url, init) => {
    if (init.method === 'GET') {
      return new Response(JSON.stringify({
        id: 'sync-gist-id',
        updated_at: '2026-10-12T08:00:00Z',
        files: {}
      }), { status: 200 })
    }
    if (init.method === 'PATCH') {
      patchCalled = true
      return new Response(JSON.stringify({
        id: 'sync-gist-id',
        updated_at: '2026-10-12T08:50:00Z',
        files: {
          'ztools_config.enc.json': {
            filename: 'ztools_config.enc.json',
            content: '{"payload":"device-a-updated"}'
          }
        }
      }), { status: 200 })
    }
    return new Response('', { status: 404 })
  }

  const adapter = new GistSyncAdapter({
    token: 'ghp_validToken',
    fetchFn: mockFetch
  })

  const result = await adapter.updateGist('sync-gist-id', {
    'ztools_config.enc.json': { content: '{"payload":"device-a-updated"}' }
  }, {
    expectedUpdatedAt: '2026-10-12T08:00:00Z'
  })

  assert.equal(patchCalled, true)
  assert.equal(result.updatedAt, '2026-10-12T08:50:00Z')
})

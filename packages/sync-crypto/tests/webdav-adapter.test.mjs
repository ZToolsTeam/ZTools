import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WebDavSyncAdapter,
  WebDavError,
  parseMultiStatusXml
} from '../dist/index.js'

test('parseMultiStatusXml: accurately parses WebDAV multi-status XML response', () => {
  const sampleXml = `<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/ztools-sync/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:getcontentlength>0</D:getcontentlength>
        <D:getetag>"dir-etag-001"</D:getetag>
        <D:getlastmodified>Mon, 12 Oct 2026 08:00:00 GMT</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/ztools-sync/config.enc</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:getcontentlength>1542</D:getcontentlength>
        <D:getetag>"file-etag-12345"</D:getetag>
        <D:getlastmodified>Mon, 12 Oct 2026 08:05:00 GMT</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`

  const resources = parseMultiStatusXml(sampleXml)
  assert.equal(resources.length, 2)

  // 验证目录项
  assert.equal(resources[0].name, 'ztools-sync')
  assert.equal(resources[0].isCollection, true)
  assert.equal(resources[0].etag, 'dir-etag-001')

  // 验证文件项
  assert.equal(resources[1].name, 'config.enc')
  assert.equal(resources[1].isCollection, false)
  assert.equal(resources[1].contentLength, 1542)
  assert.equal(resources[1].etag, 'file-etag-12345')
  assert.equal(resources[1].lastModified, 'Mon, 12 Oct 2026 08:05:00 GMT')
})

test('WebDavSyncAdapter: Basic Auth and custom User-Agent headers', async () => {
  let capturedHeaders = null

  const mockFetch = async (_url, init) => {
    capturedHeaders = init.headers
    return new Response(
      `<?xml version="1.0" encoding="utf-8" ?>
      <D:multistatus xmlns:D="DAV:">
        <D:response><D:href>/dav/</D:href><D:status>HTTP/1.1 200 OK</D:status></D:response>
      </D:multistatus>`,
      { status: 207, headers: { 'Content-Type': 'application/xml' } }
    )
  }

  const adapter = new WebDavSyncAdapter({
    endpoint: 'https://dav.jianguoyun.com/dav/',
    username: 'user@example.com',
    password: 'AppSpecificPassword123',
    preset: 'jianguoyun',
    fetchFn: mockFetch
  })

  await adapter.propfind('', 0)

  assert.ok(capturedHeaders)
  assert.equal(capturedHeaders['User-Agent'], 'ZTools-E2EE-Sync/1.0')
  const expectedAuth = 'Basic ' + Buffer.from('user@example.com:AppSpecificPassword123').toString('base64')
  assert.equal(capturedHeaders['Authorization'], expectedAuth)
})

test('WebDavSyncAdapter: MKCOL creates collection and tolerates 405 (already exists)', async () => {
  const createdUrls = []

  const mockFetch = async (url, init) => {
    createdUrls.push(url.toString())
    if (init.method === 'MKCOL') {
      // 首次创建返回 201，后续返回 405
      if (url.toString().includes('exist')) {
        return new Response('', { status: 405, statusText: 'Method Not Allowed' })
      }
      return new Response('', { status: 201, statusText: 'Created' })
    }
    return new Response('', { status: 404 })
  }

  const adapter = new WebDavSyncAdapter({
    endpoint: 'https://nas.local:5006/dav/',
    basePath: '/ztools/',
    fetchFn: mockFetch
  })

  // 正常新建
  await adapter.mkcol('backup')
  // 已存在目录（405）自动幂等通过
  await adapter.mkcol('exist_dir')

  assert.equal(createdUrls.length, 2)
})

test('WebDavSyncAdapter: PUT uploads content with ETag and handles 412 precondition conflict', async () => {
  let uploadedBody = ''
  let ifMatchHeader = null

  const mockFetch = async (_url, init) => {
    if (init.method === 'PUT') {
      ifMatchHeader = init.headers['If-Match']
      if (ifMatchHeader === '"stale-etag"') {
        return new Response('Conflict', { status: 412, statusText: 'Precondition Failed' })
      }
      uploadedBody = init.body.toString()
      return new Response('', {
        status: 201,
        headers: { ETag: '"new-etag-999"' }
      })
    }
    return new Response('', { status: 404 })
  }

  const adapter = new WebDavSyncAdapter({
    endpoint: 'https://nextcloud.example.com/remote.php/dav/files/user/',
    fetchFn: mockFetch
  })

  // 1. 成功上传
  const result = await adapter.put('config.enc', 'encrypted-payload-data', {
    ifMatch: '"valid-etag"'
  })
  assert.equal(result.etag, '"new-etag-999"')
  assert.equal(uploadedBody, 'encrypted-payload-data')
  assert.equal(ifMatchHeader, '"valid-etag"')

  // 2. 发生版本冲突 (412 Precondition Failed)
  await assert.rejects(
    async () => {
      await adapter.put('config.enc', 'payload', { ifMatch: '"stale-etag"' })
    },
    (err) => err instanceof WebDavError && err.status === 412
  )
})

test('WebDavSyncAdapter: GET downloads buffer and retrieves etag and lastModified', async () => {
  const mockFetch = async (_url, init) => {
    if (init.method === 'GET') {
      return new Response(Buffer.from('Hello WebDAV World!'), {
        status: 200,
        headers: {
          ETag: '"etag-content-123"',
          'Last-Modified': 'Mon, 12 Oct 2026 09:00:00 GMT'
        }
      })
    }
    return new Response('', { status: 404 })
  }

  const adapter = new WebDavSyncAdapter({
    endpoint: 'https://dav.jianguoyun.com/dav/',
    fetchFn: mockFetch
  })

  const { data, etag, lastModified } = await adapter.get('hello.txt')
  assert.equal(data.toString('utf8'), 'Hello WebDAV World!')
  assert.equal(etag, '"etag-content-123"')
  assert.equal(lastModified, 'Mon, 12 Oct 2026 09:00:00 GMT')
})

test('WebDavSyncAdapter: testConnection validates reachable WebDAV server', async () => {
  const successFetch = async () => {
    return new Response(
      `<?xml version="1.0" encoding="utf-8" ?>
      <D:multistatus xmlns:D="DAV:">
        <D:response><D:href>/dav/</D:href><D:status>HTTP/1.1 200 OK</D:status></D:response>
      </D:multistatus>`,
      { status: 207 }
    )
  }

  const adapter1 = new WebDavSyncAdapter({
    endpoint: 'https://dav.jianguoyun.com/dav/',
    fetchFn: successFetch
  })
  const conn1 = await adapter1.testConnection()
  assert.equal(conn1.ok, true)
  assert.equal(conn1.status, 200)

  // 模拟未授权 401
  const failFetch = async () => {
    return new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' })
  }
  const adapter2 = new WebDavSyncAdapter({
    endpoint: 'https://dav.jianguoyun.com/dav/',
    fetchFn: failFetch
  })
  const conn2 = await adapter2.testConnection()
  assert.equal(conn2.ok, false)
  assert.equal(conn2.status, 401)
})

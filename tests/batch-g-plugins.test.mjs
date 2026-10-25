import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  decodeBase64UrlToUtf8,
  encodeUtf8ToBase64Url,
  decodeJwtToken,
  verifyJwtHmacSha256,
  signJwtHmacSha256,
  parseAndInspectUrl,
} from '../plugins/jwt-url-codec/dist/jwt-url-service.js'

import {
  tokenizeShellCommand,
  parseCurlCommand,
  generateCodeFromCurl,
  executeCurlRequest,
} from '../plugins/curl-http/dist/curl-service.js'

import {
  normalizeDomainInput,
  evaluateSslCertInfo,
  resolveDomainDoh,
} from '../plugins/ssl-domain-check/dist/ssl-dns-service.js'

import { optimizeSvgSource } from '../plugins/svg-icon-studio/dist/svg-service.js'

import {
  calculateIpv4Cidr,
  convertChmod,
} from '../plugins/chmod-cidr-calc/dist/chmod-cidr-service.js'

describe('Batch G Plugins (37 ~ 41) Integration & Exception Suite', () => {
  it('37-jwt-url-codec: decodes UTF-8 JWT, verifies/signs HS256, parses URLs, and rejects malformed inputs', async () => {
    const secret = 'ztools-super-secret-2026'
    const nowSec = Math.floor(Date.now() / 1000)
    const token = await signJwtHmacSha256(
      {
        sub: 'u_9527',
        name: '极客开发者',
        iat: nowSec - 120,
        exp: nowSec + 3600,
      },
      secret,
    )

    const decoded = decodeJwtToken(`Bearer ${token}`)
    assert.equal(decoded.algorithm, 'HS256')
    assert.equal(decoded.payload.sub, 'u_9527')
    assert.equal(decoded.payload.name, '极客开发者')
    assert.equal(decoded.isExpired, false)

    const verifiedOk = await verifyJwtHmacSha256(token, secret)
    assert.equal(verifiedOk.verified, true)

    const verifiedBad = await verifyJwtHmacSha256(token, 'wrong-secret')
    assert.equal(verifiedBad.verified, false)

    // Expired JWT detection
    const expiredToken = await signJwtHmacSha256(
      { sub: 'u_old', exp: nowSec - 7200 },
      secret,
    )
    const decodedExpired = decodeJwtToken(expiredToken)
    assert.equal(decodedExpired.isExpired, true)
    assert.match(decodedExpired.expiryCountdownText, /已过期/)

    // URL inspection with nested URL and JSON query param
    const urlInfo = parseAndInspectUrl(
      'https://auth.ztools.cn:8443/oauth/callback?redirect_uri=https%3A%2F%2Fapp.ztools.cn%2Fhome&meta=%7B%22env%22%3A%22prod%22%7D#done',
    )
    assert.equal(urlInfo.protocol, 'https')
    assert.equal(urlInfo.hostname, 'auth.ztools.cn')
    assert.equal(urlInfo.port, '8443')
    assert.equal(urlInfo.queryParams.length, 2)
    assert.equal(urlInfo.queryParams[0].isNestedUrl, true)
    assert.equal(urlInfo.queryParams[1].isJsonLike, true)

    // Exception assertions
    assert.throws(() => decodeJwtToken(''), /EMPTY_JWT_TOKEN/)
    assert.throws(() => decodeJwtToken('only.two'), /INVALID_JWT_STRUCTURE/)
    assert.throws(() => decodeJwtToken('not_json.eyJmb28iOiJiYXIifQ.sig'), /INVALID_JWT_HEADER/)
    assert.throws(() => decodeBase64UrlToUtf8('***invalid***'), /INVALID_BASE64URL_CHARS/)
    await assert.rejects(() => verifyJwtHmacSha256(token, ''), /EMPTY_JWT_SECRET/)
    assert.throws(() => parseAndInspectUrl('   '), /EMPTY_URL_INPUT/)
    assert.equal(encodeUtf8ToBase64Url('中文测试'), decodeBase64UrlToUtf8(encodeUtf8ToBase64Url('中文测试')) ? encodeUtf8ToBase64Url('中文测试') : '')
  })

  it('38-curl-http: parses multi-line bash/cmd/PowerShell cURL, generates 4 languages, and handles HTTP timeout/5MB truncation', async () => {
    const rawCurl = `curl -X PUT ^\r\n  "https://api.ztools.cn/v1/items/42" \\\n  -H "Authorization: Bearer tok_123" \`\n  -H "Content-Type: application/json" -b "sid=abc" -d '{"enabled":true}'`
    const parsed = parseCurlCommand(rawCurl)
    assert.equal(parsed.method, 'PUT')
    assert.equal(parsed.url, 'https://api.ztools.cn/v1/items/42')
    assert.equal(parsed.headers['Authorization'], 'Bearer tok_123')
    assert.equal(parsed.headers['Cookie'], 'sid=abc')
    assert.equal(parsed.body, '{"enabled":true}')

    for (const lang of ['fetch', 'axios', 'python', 'go']) {
      const code = generateCodeFromCurl(parsed, lang)
      assert.ok(code.includes('https://api.ztools.cn/v1/items/42'))
    }

    // Execute HTTP request with custom fetch mock + large payload truncation check
    const normalRes = await executeCurlRequest(parsed, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: 0, msg: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    })
    assert.equal(normalRes.ok, true)
    assert.equal(normalRes.status, 200)
    assert.equal(normalRes.truncated, false)

    const hugeString = 'x'.repeat(5 * 1024 * 1024 + 128)
    const truncatedRes = await executeCurlRequest(parsed, {
      fetchImpl: async () => new Response(hugeString, { status: 200 }),
    })
    assert.equal(truncatedRes.truncated, true)
    assert.match(truncatedRes.bodyText, /已安全截断/)

    // Exception assertions: unclosed quote, missing URL, timeout
    assert.throws(() => tokenizeShellCommand('curl "https://example.com'), /UNCLOSED_QUOTE_IN_CURL/)
    assert.throws(() => parseCurlCommand(''), /EMPTY_CURL_INPUT/)
    assert.throws(() => parseCurlCommand('curl -H "Accept: */*"'), /MISSING_TARGET_URL/)
    await assert.rejects(
      () =>
        executeCurlRequest(parsed, {
          timeoutMs: 20,
          fetchImpl: (_url, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                const abortErr = new Error('Aborted')
                abortErr.name = 'AbortError'
                reject(abortErr)
              })
            }),
        }),
      /HTTP_TIMEOUT/,
    )
  })

  it('39-ssl-domain-check: evaluates SSL expiry/warning states, resolves DoH records, and handles NXDOMAIN/abort', async () => {
    assert.equal(normalizeDomainInput('https://Sub.GitHub.com:8443/path?a=1'), 'sub.github.com')

    const fixedNow = new Date('2026-10-25T00:00:00Z').getTime()
    const healthyCert = evaluateSslCertInfo(
      {
        domain: 'ztools.cn',
        subjectCN: 'ztools.cn',
        issuerName: 'DigiCert',
        validFrom: '2026-01-01T00:00:00Z',
        validTo: '2027-01-01T00:00:00Z',
      },
      fixedNow,
    )
    assert.equal(healthyCert.isExpired, false)
    assert.equal(healthyCert.isExpiringSoon, false)
    assert.equal(healthyCert.daysRemaining, 68)

    const expiringSoonCert = evaluateSslCertInfo(
      {
        domain: 'soon.ztools.cn',
        subjectCN: 'soon.ztools.cn',
        issuerName: 'Let\'s Encrypt',
        validFrom: '2026-08-01T00:00:00Z',
        validTo: '2026-11-02T00:00:00Z',
      },
      fixedNow,
    )
    assert.equal(expiringSoonCert.isExpired, false)
    assert.equal(expiringSoonCert.isExpiringSoon, true)
    assert.equal(expiringSoonCert.daysRemaining, 8)

    const expiredCert = evaluateSslCertInfo(
      {
        domain: 'old.ztools.cn',
        subjectCN: 'old.ztools.cn',
        issuerName: 'Let\'s Encrypt',
        validFrom: '2025-01-01T00:00:00Z',
        validTo: '2026-10-01T00:00:00Z',
      },
      fixedNow,
    )
    assert.equal(expiredCert.isExpired, true)

    const records = await resolveDomainDoh('ztools.cn', ['A', 'TXT'], {
      fetchImpl: async (url) => {
        const u = String(url)
        if (u.includes('type=A')) {
          return new Response(
            JSON.stringify({
              Status: 0,
              Answer: [{ name: 'ztools.cn.', type: 1, TTL: 300, data: '198.51.100.12' }],
            }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({
            Status: 0,
            Answer: [{ name: 'ztools.cn.', type: 16, TTL: 600, data: '"v=spf1 include:spf.ztools.cn ~all"' }],
          }),
          { status: 200 },
        )
      },
    })
    assert.equal(records.length, 2)
    assert.equal(records[0].data, '198.51.100.12')
    assert.equal(records[1].data, 'v=spf1 include:spf.ztools.cn ~all')

    // Exception assertions
    assert.throws(() => normalizeDomainInput(''), /EMPTY_DOMAIN_INPUT/)
    assert.throws(() => normalizeDomainInput('not a domain'), /INVALID_DOMAIN_NAME/)
    await assert.rejects(
      () =>
        resolveDomainDoh('nonexistent.ztools.invalid', ['A'], {
          fetchImpl: async () =>
            new Response(JSON.stringify({ Status: 3 }), { status: 200 }),
        }),
      /DNS_NXDOMAIN/,
    )
  })

  it('40-svg-icon-studio: strips metadata & XSS scripts, rounds decimals, and generates React TSX / Vue SFC / Data URI', () => {
    const dirtySvg = `<?xml version="1.0"?>
      <!-- comment -->
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:sketch="http://www.bohemiancoding.com/sketch/ns" viewBox="0 0 24 24" fill-rule="evenodd" stroke-width="1.876543" onload="alert(1)">
        <metadata>Sketch meta</metadata>
        <script>alert("xss")</script>
        <path d="M 10.123456 20.987654 L 30.00001 40.55555" onclick="evil()" />
      </svg>`

    const res = optimizeSvgSource(dirtySvg, 2)
    assert.ok(!res.optimizedSvg.includes('<script'))
    assert.ok(!res.optimizedSvg.includes('onload='))
    assert.ok(!res.optimizedSvg.includes('onclick='))
    assert.ok(!res.optimizedSvg.includes('<metadata'))
    assert.ok(res.metrics.removedDangerousNodes >= 3)
    assert.ok(res.metrics.savedBytes > 0)
    assert.ok(res.reactTsxCode.includes('fillRule="evenodd"'))
    assert.ok(res.reactTsxCode.includes('strokeWidth="1.88"'))
    assert.ok(res.vueSfcCode.includes('<template>'))
    assert.ok(res.base64DataUri.startsWith('data:image/svg+xml;base64,'))

    // Exception assertions
    assert.throws(() => optimizeSvgSource(''), /EMPTY_SVG_INPUT/)
    assert.throws(() => optimizeSvgSource('<div>not svg</div>'), /INVALID_SVG_DOCUMENT/)
  })

  it('41-chmod-cidr-calc: computes IPv4 CIDR (/24, /31, /32) & bidirectional chmod (octal <-> symbolic + 777 warning)', () => {
    const cidr24 = calculateIpv4Cidr('192.168.1.45/24')
    assert.equal(cidr24.networkAddress, '192.168.1.0')
    assert.equal(cidr24.broadcastAddress, '192.168.1.255')
    assert.equal(cidr24.netmask, '255.255.255.0')
    assert.equal(cidr24.wildcardMask, '0.0.0.255')
    assert.equal(cidr24.firstUsableIp, '192.168.1.1')
    assert.equal(cidr24.lastUsableIp, '192.168.1.254')
    assert.equal(cidr24.usableHosts, 254)

    const cidr31 = calculateIpv4Cidr('10.0.0.4/31')
    assert.equal(cidr31.usableHosts, 2)
    assert.equal(cidr31.firstUsableIp, '10.0.0.4')
    assert.equal(cidr31.lastUsableIp, '10.0.0.5')

    const cidr32 = calculateIpv4Cidr('203.0.113.9/32')
    assert.equal(cidr32.usableHosts, 1)
    assert.equal(cidr32.firstUsableIp, '203.0.113.9')

    const chmod755 = convertChmod('755')
    assert.equal(chmod755.symbolic, 'rwxr-xr-x')
    assert.equal(chmod755.lsSymbolic, '-rwxr-xr-x')
    assert.equal(chmod755.isWorldWritable, false)

    const chmodFromSym = convertChmod('-rw-r--r--')
    assert.equal(chmodFromSym.octal, '644')

    const chmod777 = convertChmod('777')
    assert.equal(chmod777.isWorldWritable, true)
    assert.ok(chmod777.securityWarning && chmod777.securityWarning.includes('高危权限告警'))

    // Exception assertions
    assert.throws(() => calculateIpv4Cidr(''), /EMPTY_CIDR_INPUT/)
    assert.throws(() => calculateIpv4Cidr('999.168.1.1/24'), /IPV4_OCTET_OUT_OF_RANGE/)
    assert.throws(() => calculateIpv4Cidr('192.168.1.1/33'), /CIDR_PREFIX_OUT_OF_RANGE/)
    assert.throws(() => convertChmod(''), /EMPTY_CHMOD_INPUT/)
    assert.throws(() => convertChmod('888'), /INVALID_CHMOD_INPUT/)
    assert.throws(() => convertChmod('rwxinvalid'), /INVALID_CHMOD_INPUT/)
  })
})

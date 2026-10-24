import { describe, expect, it, vi } from 'vitest'
import SystemAPI from '../../../public/js/cef-ipc/src/api/sys.js'

describe('SystemAPI.getDiagnostics', () => {
  it('requests only supplied SDK message IDs and strips unrecognized response fields', async () => {
    const transport = {
      call: vi.fn(async (method, params) => {
        expect(method).toBe('diagnostics_get')
        expect(params).toEqual({ requestIds: ['js_1_1_network_http_request'] })
        return {
          schemaVersion: 1,
          requestFailures: [{
            schemaVersion: 1, layer: 'main', requestId: 'js_1_1_network_http_request',
            method: 'network_http_request', failureStage: 'validation', errorCode: 'INVALID_REQUEST',
            occurredAt: '2026-10-09T00:00:00.000Z', password: 'private'
          }],
          nativeHost: { pid: 123, stderr: 'private' }
        }
      })
    }
    const result = await new SystemAPI(transport).getDiagnostics({ requestIds: ['js_1_1_network_http_request'] })
    expect(result).toEqual({
      schemaVersion: 1,
      requestFailures: [{
        schemaVersion: 1, layer: 'main', requestId: 'js_1_1_network_http_request',
        method: 'network_http_request', failureStage: 'validation', errorCode: 'INVALID_REQUEST',
        occurredAt: '2026-10-09T00:00:00.000Z'
      }]
    })
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('rejects malformed requests and corrupted host output', async () => {
    const transport = { call: vi.fn(async () => ({ schemaVersion: 1, requestFailures: [{}] })) }
    const api = new SystemAPI(transport)
    await expect(api.getDiagnostics({ requestIds: ['bad/id'] })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(transport.call).not.toHaveBeenCalled()
    await expect(api.getDiagnostics({ requestIds: ['req-1'] })).rejects.toMatchObject({ code: 'DIAGNOSTICS_INVALID' })
  })
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const apiRoot = resolve(process.cwd(), 'public/js/cef-ipc/src/api')
const source = readFileSync(resolve(apiRoot, 'fs-reference.js'), 'utf8').replace(/^export default .+$/m, '')
const legacy = readFileSync(resolve(apiRoot, 'fs.js'), 'utf8').replace(/^export default .+$/m, '')
const ReferenceFileSystemAPI = new Function(legacy + '\n' + source + '\nreturn ReferenceFileSystemAPI')()
const save = { grantId: 'b'.repeat(43), displayName: 'output.txt', kind: 'save', operations: ['write'] }
const artifact = { grantId: 'a'.repeat(43), displayName: 'output.txt', kind: 'file', operations: ['read'],
  fileUrl: 'ztools://file/' + 'a'.repeat(43) + '/output.txt' }

function fixture() {
  const calls = []
  let response = { success: true, status: 'committed', size: 4, reference: artifact }
  const transport = { call: async (method, params) => { calls.push({ method, params }); return response } }
  window.__ztoolsElectron = { contractVersion: 2, transport: { methods: { filesystem_write_file() {} } } }
  return { api: new ReferenceFileSystemAPI(transport), calls, respond(value) { response = value } }
}

afterEach(() => { delete window.__ztoolsElectron })

describe('SDK2 file write receipts', () => {
  it('returns committed only with exact byte count and a read-only file artifact reference', async () => {
    const f = fixture()
    const receipt = await f.api.writeFile(save, new Uint8Array([0, 255, 7, 13]))
    expect(receipt).toEqual({ success: true, status: 'committed', size: 4, reference: artifact })
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(Object.isFrozen(receipt.reference)).toBe(true)
    expect(f.calls).toEqual([{ method: 'filesystem_write_file', params: {
      saveGrantId: save.grantId, content: 'AP8HDQ==', encoding: 'base64', replace: false
    } }])
  })

  it('preserves explicit result-unknown and rejects malformed receipts', async () => {
    const f = fixture()
    f.respond({ success: false, status: 'result-unknown', code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
    await expect(f.api.writeFile(save, 'data')).resolves.toEqual({ success: false, status: 'result-unknown', code: 'FILE_WRITE_OUTCOME_UNKNOWN' })

    for (const response of [
      { success: true, status: 'committed', size: 3, reference: artifact },
      { success: true, status: 'committed', size: 4, reference: { grantId: artifact.grantId, displayName: artifact.displayName, kind: 'file', operations: ['read'] } },
      { success: true, status: 'committed', size: 4, reference: { ...artifact, fileUrl: undefined } },
      { success: true, status: 'committed', size: 4, reference: { ...artifact, operations: ['read', 'write'] } },
      { success: true, status: 'committed', size: 4, reference: { ...artifact, kind: 'save' } },
      { success: true, status: 'committed', size: 4, reference: { ...artifact, fileUrl: 'file:///private/output.txt' } },
      { success: false, status: 'result-unknown', code: 'FILE_WRITE_OUTCOME_UNKNOWN', path: '/private/output.txt' }
    ]) {
      f.respond(response)
      await expect(f.api.writeFile(save, 'data')).rejects.toMatchObject({ code: 'FILE_ERROR' })
    }
  })

  it('accepts only exact bounded immutable no-reference commit facts matching actual bytes', async () => {
    const f = fixture()
    const receipt = { success: true, status: 'committed-reference-unavailable', size: 4,
      issues: [{ stage: 'reference', code: 'PERMISSION_DENIED' }, { stage: 'release', code: 'FILE_ERROR' }] }
    f.respond(receipt)
    const result = await f.api.writeFile(save, 'data')
    expect(result).toEqual(receipt)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.issues)).toBe(true)
    expect(Object.isFrozen(result.issues[0])).toBe(true)
    expect(result).not.toHaveProperty('reference')
    for (const value of [
      { ...receipt, size: 3 }, { ...receipt, size: -1 }, { ...receipt, size: 16 * 1024 * 1024 + 1 },
      { ...receipt, size: Number.MAX_SAFE_INTEGER + 1 }, { ...receipt, issues: [] },
      { ...receipt, issues: [...receipt.issues, receipt.issues[0]] },
      { ...receipt, issues: [...receipt.issues].reverse() },
      { ...receipt, issues: [receipt.issues[0], receipt.issues[0]] },
      { ...receipt, issues: [{ stage: 'release', code: 'PERMISSION_DENIED' }] },
      { ...receipt, issues: [{ stage: 'reference', code: 'OTHER' }] },
      { ...receipt, issues: [{ stage: 'reference', code: 'FILE_ERROR', message: '/private' }] },
      ...['reference', 'grantId', 'path', 'fileUrl'].map(key => ({ ...receipt, [key]: 'private' })),
      Object.assign(Object.create({ inherited: true }), receipt),
      Object.defineProperty({ ...receipt }, 'private', { value: '/private' }),
      { ...receipt, [Symbol('private')]: '/private' }
    ]) {
      f.respond(value)
      await expect(f.api.writeFile(save, 'data')).rejects.toMatchObject({ code: 'FILE_ERROR' })
    }
    f.respond({ ...receipt, size: 0, issues: [{ stage: 'release', code: 'FILE_ERROR' }] })
    await expect(f.api.writeFile(save, '')).resolves.toEqual({ ...receipt, size: 0, issues: [{ stage: 'release', code: 'FILE_ERROR' }] })
    let reads = 0
    f.respond(Object.defineProperty({ ...receipt }, 'size', { enumerable: true, get() { reads++; return 4 } }))
    await expect(f.api.writeFile(save, 'data')).rejects.toMatchObject({ code: 'FILE_ERROR' })
    expect(reads).toBe(0)
  })

  it('rejects hidden, accessor, inherited, sparse and extra operations/issue indices', async () => {
    const f = fixture()
    const hiddenIssues = [{ stage: 'reference', code: 'FILE_ERROR' }]
    Object.defineProperty(hiddenIssues, '0', { enumerable: false })
    const accessorIssues = [hiddenIssues[0]]
    Object.defineProperty(accessorIssues, '0', { get() { throw new Error('must not read accessor') } })
    const inheritedIssues = new Array(1)
    Object.setPrototypeOf(inheritedIssues, { 0: hiddenIssues[0] })
    const hiddenOperations = ['read']
    Object.defineProperty(hiddenOperations, '0', { enumerable: false })
    const accessorOperations = ['read']
    Object.defineProperty(accessorOperations, '0', { get() { throw new Error('must not read accessor') } })
    const inheritedOperations = new Array(1)
    Object.setPrototypeOf(inheritedOperations, { 0: 'read' })
    for (const result of [
      ...[hiddenIssues, accessorIssues, inheritedIssues, new Array(1), Object.assign([hiddenIssues[0]], { extra: 'private' })]
        .map(issues => ({ success: true, status: 'committed-reference-unavailable', size: 4, issues })),
      ...[hiddenOperations, accessorOperations, inheritedOperations, new Array(1), Object.assign(['read'], { extra: 'private' }), undefined]
        .map(operations => ({ success: true, status: 'committed', size: 4, reference: { ...artifact, operations } }))
    ]) {
      f.respond(result)
      await expect(f.api.writeFile(save, 'data')).rejects.toMatchObject({ code: 'FILE_ERROR' })
    }
  })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  classifyClipboardAccessEvidence,
  readClipboardOsProbeReport,
  validateClipboardOsProbeReport
} from './windows-clipboard-metadata.mjs'

function makeReport(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: '7dee7f59-671a-4b0c-be2b-213797581e8e',
    platform: 'win32',
    arch: 'x64',
    createdAt: new Date().toISOString(),
    scope: 'read-only-win32-clipboard-lock-metadata',
    exitCode: 0,
    status: 'OBSERVED',
    metadata: {
      status: 'OBSERVED', canOpen: false, openErrorCode: 5, holderPresent: false, holderPid: 0,
      ownerPresent: false, ownerPid: 0, sessionId: 1, contentRead: false, contentWritten: false
    },
    ...overrides
  }
}

function makeDeniedProbe(overrides = {}) {
  return {
    status: 'OBSERVED', canOpen: false, openErrorCode: 5, holderPresent: false, holderPid: 0,
    ownerPresent: false, ownerPid: 0, sessionId: 1, contentRead: false, contentWritten: false,
    ...overrides
  }
}

test('recent read-only OS report plus matching current session confirms clipboard access denial', () => {
  const report = makeReport()
  const validation = validateClipboardOsProbeReport(report)
  assert.equal(validation.status, 'PASS')
  assert.equal(validation.sessionId, 1)
  assert.equal(classifyClipboardAccessEvidence(report, makeDeniedProbe()).status, 'OS_ACCESS_DENIED_CONFIRMED')
})

test('future, stale, wrong-platform, wrong-scope, or content-access reports cannot authorize a skip', () => {
  const recent = makeReport()
  const invalidReports = [
    { ...recent, createdAt: new Date(Date.now() + 30_000).toISOString() },
    { ...recent, createdAt: new Date(Date.now() - 31 * 60_000).toISOString() },
    { ...recent, platform: 'darwin' },
    { ...recent, scope: 'other-scope' },
    { ...recent, metadata: { ...recent.metadata, contentRead: true } },
    { ...recent, metadata: { ...recent.metadata, contentWritten: true } }
  ]
  for (const report of invalidReports) {
    assert.equal(validateClipboardOsProbeReport(report).status, 'FAIL')
    assert.equal(classifyClipboardAccessEvidence(report, makeDeniedProbe()).status, 'FAIL')
  }
})

test('unknown errors, clipboard owners, missing prior reports, or session mismatch cannot authorize a skip', () => {
  const report = makeReport()
  assert.equal(classifyClipboardAccessEvidence(null, makeDeniedProbe()).status, 'FAIL')
  assert.equal(classifyClipboardAccessEvidence(report, makeDeniedProbe({ openErrorCode: 87 })).status, 'FAIL')
  assert.equal(classifyClipboardAccessEvidence(report, makeDeniedProbe({ ownerPresent: true, ownerPid: 22 })).status, 'FAIL')
  assert.equal(classifyClipboardAccessEvidence(report, makeDeniedProbe({ sessionId: 2 })).status, 'FAIL')
})

test('a current accessible probe permits ordinary guarded clipboard verification', () => {
  const current = makeDeniedProbe({ canOpen: true, openErrorCode: 0 })
  assert.equal(classifyClipboardAccessEvidence(null, current).status, 'ACCESSIBLE')
})

test('OS report reader accepts bounded files and rejects oversized evidence', { skip: process.platform !== 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-clipboard-metadata-'))
  const validPath = path.join(directory, 'valid.json')
  const oversizedPath = path.join(directory, 'oversized.json')
  const growingPath = path.join(directory, 'growing.json')
  try {
    fs.writeFileSync(validPath, JSON.stringify(makeReport()), { flag: 'wx' })
    assert.equal(readClipboardOsProbeReport(validPath).report.scope, 'read-only-win32-clipboard-lock-metadata')
    fs.writeFileSync(oversizedPath, `${JSON.stringify(makeReport())}${' '.repeat(64 * 1024)}`, { flag: 'wx' })
    assert.throws(() => readClipboardOsProbeReport(oversizedPath), /CLIPBOARD_OS_PROBE_REPORT_PATH_INVALID|CLIPBOARD_OS_PROBE_REPORT_SIZE_INVALID/)

    fs.writeFileSync(growingPath, JSON.stringify(makeReport()), { flag: 'wx' })
    const originalReadSync = fs.readSync
    let grewDuringRead = false
    fs.readSync = function (fd, buffer, offset, length, position) {
      if (!grewDuringRead) {
        grewDuringRead = true
        fs.appendFileSync(growingPath, ' '.repeat(64 * 1024))
      }
      return originalReadSync.call(fs, fd, buffer, offset, length, position)
    }
    try {
      assert.throws(() => readClipboardOsProbeReport(growingPath), /CLIPBOARD_OS_PROBE_REPORT_SIZE_INVALID/)
      assert.equal(grewDuringRead, true)
    } finally {
      fs.readSync = originalReadSync
    }
  } finally {
    for (const filePath of [validPath, oversizedPath, growingPath]) if (fs.existsSync(filePath)) fs.rmSync(filePath)
    fs.rmdirSync(directory)
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { errorCodes, toPublicError, ZToolsError } from '../../src/contracts/errors.js'
import {
  normalizeOpenDialogProperties,
  parseDialogFilters
} from '../../src/main/services/window-service.js'

test('dialog filters convert Delphi pairs to Electron extensions', () => {
  assert.deepEqual(parseDialogFilters('文本文件 (*.txt)|*.txt;TXT|所有文件 (*.*)|*.*'), [
    { name: '文本文件 (*.txt)', extensions: ['txt', 'TXT'] },
    { name: '所有文件 (*.*)', extensions: ['*'] }
  ])
})

test('dialog filters reject malformed and path-like patterns', () => {
  for (const value of ['文本文件', '文本文件|../*.txt']) {
    assert.throws(
      () => parseDialogFilters(value),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
  }
})

test('dialog filter errors do not echo attacker-controlled extensions', () => {
  const untrusted = 'Bearer secret-token\r\nforged.log'
  assert.throws(
    () => parseDialogFilters(`文件|${untrusted}`),
    (error) => {
      if (!(error instanceof ZToolsError) || error.code !== errorCodes.invalidRequest) return false
      const publicError = toPublicError(error)
      return publicError.message === '文件筛选扩展名无效' &&
        !publicError.message.includes('secret-token') &&
        !publicError.message.includes('forged.log')
    }
  )
})

test('multi-selection keeps the Delphi implicit open-file behavior', () => {
  assert.deepEqual(normalizeOpenDialogProperties(['multiSelections']), [
    'openFile',
    'multiSelections'
  ])
  assert.deepEqual(normalizeOpenDialogProperties(['openDirectory']), ['openDirectory'])
})

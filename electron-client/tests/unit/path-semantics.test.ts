import assert from 'node:assert/strict'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import {
  createPathSemanticsAdapter,
  PosixPathSemanticsAdapter,
  WindowsPathSemanticsAdapter
} from '../../src/main/platform/path-semantics.js'

test('Windows semantics reject device namespaces, ADS, reserved devices, and drive-relative paths', () => {
  const adapter = new WindowsPathSemanticsAdapter()
  const invalidPaths = [
    String.raw`\\?\C:\private.txt`,
    String.raw`\\.\PhysicalDrive0`,
    String.raw`C:`,
    String.raw`C:relative\file.txt`,
    String.raw`C:\folder\file.txt:secret`,
    'report:secret',
    'CON',
    'CON.txt',
    'CON .txt',
    'NUL.log',
    'COM1',
    'LPT9.txt'
  ]

  for (const value of invalidPaths) {
    assert.throws(
      () => adapter.validatePathInput(value),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest,
      value
    )
  }

  assert.doesNotThrow(() => adapter.validatePathInput(String.raw`C:\Users\Public\report.txt`))
  assert.doesNotThrow(() => adapter.validatePathInput(String.raw`\\server\share\report.txt`))
  assert.doesNotThrow(() => adapter.validatePathInput(String.raw`folder\.\child\..\report.txt`))
})

test('POSIX semantics preserve legal colon and backslash filename characters', () => {
  const adapter = new PosixPathSemanticsAdapter()

  assert.doesNotThrow(() => adapter.validatePathInput('report:final.txt'))
  assert.doesNotThrow(() => adapter.validatePathInput(String.raw`\\?\literal-name`))
  assert.doesNotThrow(() => adapter.validatePathInput('C:relative-name'))
  assert.throws(
    () => adapter.validatePathInput(`invalid\0name`),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
})

test('path semantics fail closed on platforms without an adapter', () => {
  assert.throws(
    () => createPathSemanticsAdapter('freebsd' as NodeJS.Platform),
    (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
})

test('path semantics factory selects the host-specific filename rules', () => {
  const macos = createPathSemanticsAdapter('darwin')
  const windows = createPathSemanticsAdapter('win32')

  assert.doesNotThrow(() => macos.validatePathInput('report:final.txt'))
  assert.throws(
    () => windows.validatePathInput('report:final.txt'),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
})

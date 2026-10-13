import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SDK_HOST_MAXIMUM_CONTRACT_VERSION,
  SDK_LEGACY_CONTRACT_VERSION
} from '../../src/contracts/protocol-versions.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { requireSdkApiLane, selectSdkApiLane } from '../../src/contracts/sdk-api-lane.js'

function rejectsCode(work: () => unknown, code: string): boolean {
  try { work(); return false }
  catch (error) { return error instanceof ZToolsError && error.code === code }
}

test('host maximum and selected target lane stay independent; omitted and v1 targets remain lane 1', () => {
  assert.equal(SDK_HOST_MAXIMUM_CONTRACT_VERSION, 2)
  assert.equal(SDK_LEGACY_CONTRACT_VERSION, 1)
  assert.equal(selectSdkApiLane(undefined), 1)
  assert.equal(selectSdkApiLane(1), 1)
  assert.equal(selectSdkApiLane(2), 2)
  assert.equal(selectSdkApiLane(undefined, 2), 1)
  assert.equal(selectSdkApiLane(1, 2), 1)
  assert.equal(selectSdkApiLane(2, 2), 2)
})

test('a v2 target is rejected by a v1 host and unknown lanes fail closed', () => {
  assert.ok(rejectsCode(() => selectSdkApiLane(2, 1), errorCodes.notSupported))
  assert.ok(rejectsCode(() => selectSdkApiLane(3, 2), errorCodes.notSupported))
  assert.ok(rejectsCode(() => selectSdkApiLane(4, 4), errorCodes.notSupported))
  assert.ok(rejectsCode(() => selectSdkApiLane(2, 3), errorCodes.notSupported))
})

test('malformed target minimums and unknown host maxima are rejected', () => {
  for (const value of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2']) {
    assert.ok(rejectsCode(() => selectSdkApiLane(value, 2), errorCodes.pluginPackageInvalid))
  }
  for (const value of [0, 3, Number.MAX_SAFE_INTEGER + 1, '2']) {
    assert.ok(rejectsCode(() => selectSdkApiLane(1, value), errorCodes.notSupported))
  }
})

test('a Mac file-reference consumer must explicitly opt into lane 2 while stable shared APIs retain lane 1', () => {
  // clipboard_read_text and screen display metadata retain their stable SDK1 shapes.
  assert.equal(requireSdkApiLane(1, 'stable', 2), 1)
  assert.equal(requireSdkApiLane(2, 'stable', 2), 2)
  const macTargetLaneWithoutOptIn = selectSdkApiLane(undefined, 2)
  assert.equal(macTargetLaneWithoutOptIn, 1)
  assert.ok(rejectsCode(() => requireSdkApiLane(macTargetLaneWithoutOptIn, 'file-reference', 2), errorCodes.notSupported))
  assert.ok(rejectsCode(() => requireSdkApiLane(1, 'native-reference', 2), errorCodes.notSupported))
  assert.equal(requireSdkApiLane(selectSdkApiLane(2, 2), 'file-reference', 2), 2)
  assert.equal(requireSdkApiLane(2, 'file-reference', 2), 2)
  assert.equal(requireSdkApiLane(2, 'native-reference', 2), 2)
  assert.equal(requireSdkApiLane(2, 'file-reference'), 2)
  assert.ok(rejectsCode(() => requireSdkApiLane(2, 'file-reference', 1), errorCodes.notSupported))
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSdkLaneHandshake } from '../../src/contracts/sdk-lane-handshake.js'

test('a supporting host does not silently upgrade the selected window lane', () => {
  const selected = parseSdkLaneHandshake({ hostMaximumSdkContractVersion: 2, windowSdkApiLane: 1 })
  assert.deepEqual(selected, { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 1 })
  assert.ok(Object.isFrozen(selected))
  assert.equal(parseSdkLaneHandshake({ hostMaximumSdkContractVersion: 2, windowSdkApiLane: 2 })?.windowSdkApiLane, 2)
})

test('unknown, malformed, inherited or mismatched metadata never enables a reference lane', () => {
  for (const value of [null, undefined, [], {}, { windowSdkApiLane: 2 },
    { hostMaximumSdkContractVersion: 1, windowSdkApiLane: 2 },
    { hostMaximumSdkContractVersion: 3, windowSdkApiLane: 2 },
    { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 0 },
    { hostMaximumSdkContractVersion: '2', windowSdkApiLane: 2 },
    { hostMaximumSdkContractVersion: 2, windowSdkApiLane: Number.NaN },
    { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 2, requestedLane: 2 },
    Object.create({ hostMaximumSdkContractVersion: 2, windowSdkApiLane: 2 }),
    { get hostMaximumSdkContractVersion() { throw new Error('PRIVATE_PORT_FAILURE') }, windowSdkApiLane: 2 }]) {
    assert.equal(parseSdkLaneHandshake(value), undefined)
  }
})

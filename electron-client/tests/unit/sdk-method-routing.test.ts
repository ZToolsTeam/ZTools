import assert from 'node:assert/strict'
import test from 'node:test'
import { isAllowedMethod, methodCapabilities } from '../../src/contracts/capabilities.js'
import { REFERENCE_METHODS, REFERENCE_MUTATING_METHODS } from '../../src/contracts/reference-transport.js'
import {
  REFERENCE_METHOD_CLASSIFICATIONS,
  selectSdkMethodRoute,
  STABLE_LEGACY_ONLY_METHODS
} from '../../src/contracts/sdk-method-routing.js'

const stableOverlappingMethods = [
  'clipboard_read_text',
  'screen_get_cursor_pos',
  'screen_get_primary_display',
  'screen_get_all_displays',
  'screen_get_display_nearest',
  'screen_get_display_matching'
] as const

test('stable overlapping APIs preserve lane 1 schemas and use reference routing only on lane 2', () => {
  for (const method of stableOverlappingMethods) {
    assert.equal(REFERENCE_METHOD_CLASSIFICATIONS[method], 'protocol-stable')
    assert.deepEqual(selectSdkMethodRoute(method, 1, 2), {
      route: 'legacy', lane: 1, classification: 'protocol-stable'
    })
    assert.deepEqual(selectSdkMethodRoute(method, 2, 2), {
      route: 'reference', lane: 2, classification: 'protocol-stable'
    })
  }
})

test('clipboard_clear is schema-stable despite appearing in the mutating reference list', () => {
  assert.ok(REFERENCE_MUTATING_METHODS.includes('clipboard_clear'))
  assert.equal(REFERENCE_METHOD_CLASSIFICATIONS.clipboard_clear, 'protocol-stable')
  assert.deepEqual(selectSdkMethodRoute('clipboard_clear', 1, 2), {
    route: 'legacy', lane: 1, classification: 'protocol-stable'
  })
  assert.deepEqual(selectSdkMethodRoute('clipboard_clear', 2, 2), {
    route: 'reference', lane: 2, classification: 'protocol-stable'
  })
})

test('same-name versioned protocols select legacy only for lane 1', () => {
  for (const method of ['clipboard_copy_text', 'clipboard_copy_image', 'clipboard_read_image', 'screen_capture'] as const) {
    assert.equal(REFERENCE_METHOD_CLASSIFICATIONS[method], 'protocol-versioned')
    assert.equal(selectSdkMethodRoute(method, 1, 2).route, 'legacy')
    assert.equal(selectSdkMethodRoute(method, 2, 2).route, 'reference')
  }
})

test('every reference method has an explicit and consistent classification', () => {
  assert.deepEqual(
    Object.keys(REFERENCE_METHOD_CLASSIFICATIONS).sort(),
    [...REFERENCE_METHODS].sort()
  )

  for (const method of REFERENCE_METHODS) {
    const classification = REFERENCE_METHOD_CLASSIFICATIONS[method]
    const isLegacyMethod = isAllowedMethod(method)
    assert.equal(classification === 'reference-only', !isLegacyMethod, `${method} classification must match the legacy allowlist`)
    assert.equal(selectSdkMethodRoute(method, 2, 2).route, 'reference')
    assert.equal(selectSdkMethodRoute(method, 1, 2).route, isLegacyMethod ? 'legacy' : 'reject')
  }
})

test('only the explicit stable legacy-only whitelist remains on lane 2', () => {
  const referenceSet = new Set<string>(REFERENCE_METHODS)
  const stableSet = new Set<string>(STABLE_LEGACY_ONLY_METHODS)
  for (const method of STABLE_LEGACY_ONLY_METHODS) {
    assert.equal(isAllowedMethod(method), true)
    assert.equal(referenceSet.has(method), false)
    assert.equal(selectSdkMethodRoute(method, 1, 2).route, 'legacy')
    assert.deepEqual(selectSdkMethodRoute(method, 2, 2), {
      route: 'legacy', lane: 2, classification: 'legacy-stable'
    })
  }

  for (const method of Object.keys(methodCapabilities)) {
    assert.equal(selectSdkMethodRoute(method, 1, 2).route, 'legacy', `${method} remains available on lane 1`)
    if (!referenceSet.has(method)) {
      assert.equal(
        selectSdkMethodRoute(method, 2, 2).route,
        stableSet.has(method) ? 'legacy' : 'reject',
        `${method} must be explicitly stable or rejected on lane 2`
      )
    }
  }
})

test('plugin window close remains on the stable Main handler for both supported lanes', () => {
  assert.deepEqual(methodCapabilities.plugin_window_close, ['main', 'plugin'])
  assert.deepEqual(selectSdkMethodRoute('plugin_window_close', 1, 2), {
    route: 'legacy', lane: 1, classification: 'legacy-only'
  })
  assert.deepEqual(selectSdkMethodRoute('plugin_window_close', 2, 2), {
    route: 'legacy', lane: 2, classification: 'legacy-stable'
  })
})

test('versioned credential APIs remain on the existing host transport on both SDK lanes', () => {
  for (const method of ['credential_v1_status', 'credential_v1_set', 'credential_v1_get', 'credential_v1_delete'] as const) {
    assert.ok(STABLE_LEGACY_ONLY_METHODS.includes(method))
    assert.deepEqual(selectSdkMethodRoute(method, 1, 2), {
      route: 'legacy', lane: 1, classification: 'legacy-only'
    })
    assert.deepEqual(selectSdkMethodRoute(method, 2, 2), {
      route: 'legacy', lane: 2, classification: 'legacy-stable'
    })
  }
})

test('screen capability request and Main grant controls remain stable on both SDK lanes', () => {
  for (const method of [
    'runtime_capability_get',
    'runtime_capability_request',
    'runtime_capability_revoke',
    'runtime_capability_grants_list',
    'runtime_capability_grant_revoke'
  ]) {
    assert.equal(isAllowedMethod(method), true)
    assert.equal(selectSdkMethodRoute(method, 1, 2).route, 'legacy')
    assert.equal(selectSdkMethodRoute(method, 2, 2).route, 'legacy')
  }
  assert.deepEqual(methodCapabilities.runtime_capability_request, ['plugin'])
  assert.deepEqual(methodCapabilities.runtime_capability_revoke, ['plugin'])
  assert.deepEqual(methodCapabilities.runtime_capability_grants_list, ['main'])
  assert.deepEqual(methodCapabilities.runtime_capability_grant_revoke, ['main'])
})

test('unmigrated path, native, process, DLL, and media methods are not lane 2 legacy fallbacks', () => {
  const lane2Rejected = [
    'filesystem_get_full_path',
    'filesystem_combine_path',
    'system_get_file_icon',
    'shell_open_path',
    'shell_show_item_in_folder',
    'process_start',
    'process_run_ffmpeg',
    'dllplugin_call',
    'clipboard_hide_and_paste_file',
    'clipboard_hide_and_paste_image'
  ] as const

  for (const method of lane2Rejected) {
    assert.equal(isAllowedMethod(method), true)
    assert.deepEqual(selectSdkMethodRoute(method, 1, 2), {
      route: 'legacy', lane: 1, classification: 'legacy-only'
    })
    assert.deepEqual(selectSdkMethodRoute(method, 2, 2), {
      route: 'reject', reason: 'lane-2-adapter-required'
    })
  }
})

test('unknown methods, unknown lanes, and lanes above host maximum fail closed', () => {
  assert.deepEqual(selectSdkMethodRoute('unrecognized_method', 1, 2), {
    route: 'reject', reason: 'unknown-method'
  })
  assert.deepEqual(selectSdkMethodRoute(null, 1, 2), {
    route: 'reject', reason: 'unknown-method'
  })
  assert.deepEqual(selectSdkMethodRoute('clipboard_read_text', 3, 3), {
    route: 'reject', reason: 'unsupported-lane'
  })
  assert.deepEqual(selectSdkMethodRoute('clipboard_read_text', 2, 1), {
    route: 'reject', reason: 'unsupported-lane'
  })
  assert.deepEqual(selectSdkMethodRoute('clipboard_read_text', 1, 3), {
    route: 'reject', reason: 'unsupported-lane'
  })
})

test('request-supplied lane fields cannot override the trusted per-window lane', () => {
  const forgedUpgrade = { method: 'filesystem_derive_read', params: {}, sdkApiLane: 2, contractVersion: 2 }
  assert.deepEqual(selectSdkMethodRoute(forgedUpgrade.method, 1, 2), {
    route: 'reject', reason: 'lane-2-required'
  })

  const forgedDowngrade = { method: 'clipboard_copy_text', params: {}, sdkApiLane: 1 }
  assert.equal(selectSdkMethodRoute(forgedDowngrade.method, 2, 2).route, 'reference')

  const forgedLegacyFallback = { method: 'process_start', params: { path: 'C:/tool.exe' }, sdkApiLane: 2 }
  assert.equal(selectSdkMethodRoute(forgedLegacyFallback.method, 2, 2).route, 'reject')
})

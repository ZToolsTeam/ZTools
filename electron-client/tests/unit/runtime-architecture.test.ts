import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveRuntimeArchitecture } from '../../src/main/platform/runtime-architecture.js'

test('Windows reports x86 native architecture without WOW64', () => {
  assert.deepEqual(resolveRuntimeArchitecture({
    platform: 'win32',
    processArch: 'ia32',
    runningUnderARM64Translation: false,
    processorArchitecture: 'x86'
  }), { nativeOsArch: 'x86', wow64: false })
})

test('Windows distinguishes an ia32 process running under x64 WOW64', () => {
  assert.deepEqual(resolveRuntimeArchitecture({
    platform: 'win32',
    processArch: 'ia32',
    runningUnderARM64Translation: false,
    processorArchitecture: 'x86',
    processorArchitew6432: 'AMD64'
  }), { nativeOsArch: 'x64', wow64: true })
})

test('Windows reports x64 native process without WOW64', () => {
  assert.deepEqual(resolveRuntimeArchitecture({
    platform: 'win32',
    processArch: 'x64',
    runningUnderARM64Translation: false,
    processorArchitecture: 'AMD64'
  }), { nativeOsArch: 'x64', wow64: false })
})

test('Windows reports ARM64 native host when running under ARM64 translation', () => {
  assert.deepEqual(resolveRuntimeArchitecture({
    platform: 'win32',
    processArch: 'x64',
    runningUnderARM64Translation: true,
    processorArchitecture: 'AMD64'
  }), { nativeOsArch: 'arm64', wow64: true })
})

test('Windows does not label a native ARM64 process as WOW64 when Electron flags translation', () => {
  assert.deepEqual(resolveRuntimeArchitecture({
    platform: 'win32',
    processArch: 'arm64',
    runningUnderARM64Translation: true,
    processorArchitecture: 'ARM64'
  }), { nativeOsArch: 'arm64', wow64: false })
})

test('Windows detects x64 emulation even when PROCESSOR_ARCHITECTURE describes the emulated process', () => {
  assert.deepEqual(resolveRuntimeArchitecture({
    platform: 'win32',
    processArch: 'x64',
    runningUnderARM64Translation: true,
    processorArchitecture: 'AMD64'
  }), { nativeOsArch: 'arm64', wow64: true })
})

test('Windows uses the native architecture exposed to an ia32 process on ARM64', () => {
  assert.deepEqual(resolveRuntimeArchitecture({
    platform: 'win32',
    processArch: 'ia32',
    runningUnderARM64Translation: false,
    processorArchitecture: 'x86',
    processorArchitew6432: 'ARM64'
  }), { nativeOsArch: 'arm64', wow64: true })
})

test('macOS distinguishes native ARM64 from an x64 process under Rosetta', () => {
  assert.deepEqual(resolveRuntimeArchitecture({
    platform: 'darwin',
    processArch: 'arm64',
    runningUnderARM64Translation: false
  }), { nativeOsArch: 'arm64', wow64: null })
  assert.deepEqual(resolveRuntimeArchitecture({
    platform: 'darwin',
    processArch: 'x64',
    runningUnderARM64Translation: true
  }), { nativeOsArch: 'arm64', wow64: null })
})

test('macOS distinguishes a native x64 host and fails closed when translation is unknown', () => {
  assert.deepEqual(resolveRuntimeArchitecture({
    platform: 'darwin',
    processArch: 'x64',
    runningUnderARM64Translation: false
  }), { nativeOsArch: 'x64', wow64: null })
  assert.deepEqual(resolveRuntimeArchitecture({
    platform: 'darwin',
    processArch: 'x64',
    runningUnderARM64Translation: null
  }), { nativeOsArch: 'unknown', wow64: null })
})

test('unsupported host platforms leave architecture and WOW64 unknown', () => {
  assert.deepEqual(resolveRuntimeArchitecture({
    platform: 'linux',
    processArch: 'x64',
    runningUnderARM64Translation: false
  }), { nativeOsArch: 'unknown', wow64: null })
})

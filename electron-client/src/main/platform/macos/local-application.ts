import { execFile as execFileCallback } from 'node:child_process'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const MAX_APPLICATION_PATH_LENGTH = 32 * 1024
const MAX_INFO_PLIST_BYTES = 1024 * 1024
const PLUTIL_TIMEOUT_MS = 3000

export interface MacApplicationBundle {
  appPath: string
  bundleIdentifier: string
  executableName: string
}

export interface MacApplicationStat {
  size: number
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface MacApplicationInspectorDependencies {
  lstat(filePath: string): Promise<MacApplicationStat>
  realpath(filePath: string): Promise<string>
  access(filePath: string, mode: number): Promise<void>
  readInfoPlist(filePath: string, signal?: AbortSignal): Promise<unknown>
}

const execFileAsync = promisify(execFileCallback)

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('macOS 应用校验已取消')
}

async function readInfoPlistWithPlutil(filePath: string, signal?: AbortSignal): Promise<unknown> {
  throwIfAborted(signal)
  const result = await execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', filePath], {
    encoding: 'utf8',
    maxBuffer: MAX_INFO_PLIST_BYTES,
    shell: false,
    signal,
    timeout: PLUTIL_TIMEOUT_MS,
    windowsHide: true
  })
  throwIfAborted(signal)
  return JSON.parse(String(result.stdout)) as unknown
}

const defaultDependencies: MacApplicationInspectorDependencies = {
  lstat: (filePath) => fs.lstat(filePath),
  realpath: (filePath) => fs.realpath(filePath),
  access: (filePath, mode) => fs.access(filePath, mode),
  readInfoPlist: readInfoPlistWithPlutil
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBundleIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value)
}

function isExecutableName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 &&
    !value.includes('\0') && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..'
}

async function requireEntry(
  filePath: string,
  expected: 'directory' | 'file',
  dependencies: MacApplicationInspectorDependencies,
  maximumSize = Number.MAX_SAFE_INTEGER,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal)
  const stat = await dependencies.lstat(filePath)
  throwIfAborted(signal)
  if (
    stat.isSymbolicLink() ||
    (expected === 'directory' ? !stat.isDirectory() : !stat.isFile()) ||
    (expected === 'file' && (!Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > maximumSize))
  ) {
    throw new Error('macOS 应用包结构无效')
  }
  const realPath = await dependencies.realpath(filePath)
  throwIfAborted(signal)
  if (realPath !== filePath) throw new Error('macOS 应用包不允许符号链接')
}

export function createMacApplicationInspector(
  dependencies: MacApplicationInspectorDependencies = defaultDependencies
): (selectedPath: string, signal?: AbortSignal) => Promise<MacApplicationBundle> {
  return async (selectedPath: string, signal?: AbortSignal): Promise<MacApplicationBundle> => {
    throwIfAborted(signal)
    if (
      typeof selectedPath !== 'string' ||
      selectedPath.length === 0 ||
      selectedPath.length > MAX_APPLICATION_PATH_LENGTH ||
      selectedPath.includes('\0') ||
      !path.posix.isAbsolute(selectedPath)
    ) {
      throw new Error('macOS 应用路径无效')
    }

    const appPath = await dependencies.realpath(selectedPath)
    throwIfAborted(signal)
    if (
      appPath.length > MAX_APPLICATION_PATH_LENGTH ||
      !path.posix.isAbsolute(appPath) ||
      appPath !== path.posix.resolve(selectedPath) ||
      path.posix.extname(appPath).toLowerCase() !== '.app'
    ) {
      throw new Error('macOS 应用路径无效或包含符号链接')
    }

    await requireEntry(appPath, 'directory', dependencies, Number.MAX_SAFE_INTEGER, signal)
    const contentsPath = path.posix.join(appPath, 'Contents')
    const macOSPath = path.posix.join(contentsPath, 'MacOS')
    const infoPlistPath = path.posix.join(contentsPath, 'Info.plist')
    await requireEntry(contentsPath, 'directory', dependencies, Number.MAX_SAFE_INTEGER, signal)
    await requireEntry(macOSPath, 'directory', dependencies, Number.MAX_SAFE_INTEGER, signal)
    await requireEntry(infoPlistPath, 'file', dependencies, MAX_INFO_PLIST_BYTES, signal)

    throwIfAborted(signal)
    const metadata = await dependencies.readInfoPlist(infoPlistPath, signal)
    throwIfAborted(signal)
    if (
      !isRecord(metadata) ||
      metadata.CFBundlePackageType !== 'APPL' ||
      !isBundleIdentifier(metadata.CFBundleIdentifier) ||
      !isExecutableName(metadata.CFBundleExecutable)
    ) {
      throw new Error('Info.plist 缺少有效的应用身份')
    }

    const executablePath = path.posix.join(macOSPath, metadata.CFBundleExecutable)
    if (executablePath.length > MAX_APPLICATION_PATH_LENGTH) throw new Error('macOS 应用可执行文件路径过长')
    await requireEntry(executablePath, 'file', dependencies, Number.MAX_SAFE_INTEGER, signal)
    throwIfAborted(signal)
    await dependencies.access(executablePath, fsConstants.X_OK)
    throwIfAborted(signal)

    return {
      appPath,
      bundleIdentifier: metadata.CFBundleIdentifier,
      executableName: metadata.CFBundleExecutable
    }
  }
}

export const inspectMacApplicationBundle = createMacApplicationInspector()

#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_STRING_FIELDS = [
  'id',
  'name',
  'version',
  'description',
  'author',
  'entry',
  'icon'
]

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const TARGET_SCHEMA_PATH = [
  resolve(SCRIPT_DIR, '../contracts/platform-target.schema.json'),
  resolve(SCRIPT_DIR, '../sdk/contracts/platform-target.schema.json')
].find(existsSync) ?? resolve(SCRIPT_DIR, '../contracts/platform-target.schema.json')
const PLUGIN_MANIFEST_SCHEMA_PATH = [
  resolve(SCRIPT_DIR, '../schema/plugin.schema.json'),
  resolve(SCRIPT_DIR, '../sdk/js/plugin.schema.json')
].find(existsSync) ?? resolve(SCRIPT_DIR, '../schema/plugin.schema.json')
let cachedTargetSchema
let cachedTargetManifestKeys

const SUPPORTED_TARGET_SCHEMA_KEYS = new Set([
  '$schema', '$id', 'title', 'description', 'type', 'additionalProperties',
  'required', 'properties', 'allOf', 'if', 'then', 'else'
])
const SUPPORTED_TARGET_FIELD_KEYS = new Set([
  'type', 'const', 'enum', 'minLength', 'pattern', 'minimum', 'additionalProperties',
  'required', 'properties', 'allOf', 'if', 'then', 'else'
])
const NATIVE_COMPONENT_KINDS = new Set(['dll', 'shared-library', 'worker'])
const NATIVE_HOST32_DLL_ABI = 'ztools-native-host/v1'
const WINDOWS_PE_DEPENDENCY_ABI = 'windows-pe/v1'
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function isNativePayloadPath(entry) {
  if (!isSafeRelativePath(entry) || !/^lib\/(?:[^\\/]+\/)*[^\\/]+$/.test(entry)) return false
  return !entry.split('/').some((segment) => segment === '.' || segment === '..' || /[<>"|?*]|[. ]$/.test(segment))
}

function validateNativePayloads(manifest, pluginDir, targetIndexesById, errors, warnings) {
  const targetPaths = new Set()
  const sharedPaths = new Map()
  const hasPayloadContract = manifest.nativeComponents.some((component) =>
    component && typeof component === 'object' && Object.hasOwn(component, 'payloadFiles'))
  const registerPath = (component, file, prefix, format) => {
    if (typeof file.entry !== 'string' || typeof component.targetId !== 'string') return
    const normalized = file.entry.replaceAll('\\', '/').toLowerCase()
    const targetKey = `${component.targetId}:${normalized}`
    if (targetPaths.has(targetKey)) errors.push(`${prefix}.entry 与同一 target 的原生文件路径重复（忽略大小写）`)
    targetPaths.add(targetKey)
    const metadata = JSON.stringify({ format, arch: file.arch ?? null, sha256: file.sha256 ?? null })
    const existing = sharedPaths.get(normalized)
    if (hasPayloadContract && existing && existing.targetId !== component.targetId && existing.metadata !== metadata) {
      errors.push(`${prefix}.entry 跨 target 复用的 format、arch、sha256 必须一致`)
    }
    sharedPaths.set(normalized, { targetId: component.targetId, metadata })
  }
  manifest.nativeComponents.forEach((component, index) => {
    if (!component || typeof component !== 'object' || Array.isArray(component)) return
    const prefix = `nativeComponents[${index}]`
    if (component.sha256 !== undefined && (typeof component.sha256 !== 'string' || !SHA256_PATTERN.test(component.sha256))) {
      errors.push(`${prefix}.sha256 必须是64位小写十六进制SHA-256`)
    }
    registerPath(component, component, prefix, /\.(dll|exe)$/i.test(component.entry ?? '') ? 'pe' : 'component')
    const hasPayload = Object.hasOwn(component, 'payloadFiles')
    if (hasPayload) {
      const indexes = targetIndexesById.get(component.targetId) ?? []
      const target = indexes.length === 1 ? manifest.targets[indexes[0]] : undefined
      if (component.kind !== 'dll' || component.arch !== 'ia32' || component.abi !== NATIVE_HOST32_DLL_ABI ||
          component.protocolVersion !== 1 || target?.platform !== 'windows' || target?.runtime !== 'electron') {
        errors.push(`${prefix}.payloadFiles 仅适用于 Windows Electron ia32 NativeHost DLL（protocolVersion=1）`)
      }
      if (typeof component.sha256 !== 'string' || !SHA256_PATTERN.test(component.sha256)) {
        errors.push(`${prefix}.sha256 在声明 payloadFiles 时必填`)
      }
      if (!Array.isArray(component.payloadFiles)) {
        errors.push(`${prefix}.payloadFiles 必须是数组`)
      } else {
        component.payloadFiles.forEach((file, fileIndex) => {
          const filePrefix = `${prefix}.payloadFiles[${fileIndex}]`
          if (!file || typeof file !== 'object' || Array.isArray(file)) {
            errors.push(`${filePrefix} 必须是对象`)
            return
          }
          for (const field of ['entry', 'format', 'sha256']) {
            if (!Object.hasOwn(file, field)) errors.push(`${filePrefix}.${field} 为必填字段`)
          }
          for (const field of Object.keys(file)) {
            if (!['entry', 'format', 'sha256', 'arch'].includes(field)) errors.push(`${filePrefix}.${field} 不是支持的 payload 字段`)
          }
          if (!isNativePayloadPath(file.entry)) errors.push(`${filePrefix}.entry 必须是 lib/ 下的规范安全文件路径`)
          if (typeof file.sha256 !== 'string' || !SHA256_PATTERN.test(file.sha256)) {
            errors.push(`${filePrefix}.sha256 必须是64位小写十六进制SHA-256`)
          }
          if (file.format === 'pe') {
            if (!['ia32', 'x64'].includes(file.arch)) errors.push(`${filePrefix}.arch 在 format=pe 时必须是 ia32 或 x64`)
            if (typeof file.entry !== 'string' || !/\.(dll|exe)$/i.test(file.entry)) {
              errors.push(`${filePrefix}.entry 在 format=pe 时必须是 .dll 或 .exe`)
            }
          } else if (file.format === 'data') {
            if (Object.hasOwn(file, 'arch')) errors.push(`${filePrefix}.arch 在 format=data 时禁止声明`)
            if (typeof file.entry === 'string' && /\.(dll|exe)$/i.test(file.entry)) {
              errors.push(`${filePrefix}.entry 在 format=data 时不能是 .dll 或 .exe`)
            }
          } else {
            errors.push(`${filePrefix}.format 必须是 pe 或 data`)
          }
          registerPath(component, file, filePrefix, file.format)
          if (isNativePayloadPath(file.entry)) {
            const filePath = resolveSafePluginPath(pluginDir, file.entry)
            if (!filePath) errors.push(`${filePrefix}.entry 必须在插件目录内`)
            else if (!existsSync(filePath)) warnings.push(`${filePrefix}.entry 文件尚未生成：${file.entry}`)
            else if (!statSync(filePath).isFile()) errors.push(`${filePrefix}.entry 必须指向普通文件`)
          }
        })
      }
    }
    const owner = manifest.nativeComponents.find((item) => item && typeof item === 'object' &&
      item.id === component.hostComponentId && Object.hasOwn(item, 'payloadFiles'))
    if (owner && (typeof component.sha256 !== 'string' || !SHA256_PATTERN.test(component.sha256))) {
      errors.push(`${prefix}.sha256 绑定含 payloadFiles 的 Host 时必填`)
    }
  })
}

function assertTargetSchemaSupported(schema, path = '$', allowedKeys = SUPPORTED_TARGET_SCHEMA_KEYS) {
  const unsupportedKeys = Object.keys(schema).filter((key) => !allowedKeys.has(key))
  if (unsupportedKeys.length > 0) {
    throw new Error(`validator 不支持 ${path} 的 schema 约束：${unsupportedKeys.join(', ')}`)
  }
  for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
    assertTargetSchemaSupported(fieldSchema, `${path}.properties.${field}`, SUPPORTED_TARGET_FIELD_KEYS)
  }
  for (const [index, childSchema] of (schema.allOf ?? []).entries()) {
    assertTargetSchemaSupported(childSchema, `${path}.allOf[${index}]`)
  }
  for (const key of ['if', 'then', 'else']) {
    if (schema[key]) assertTargetSchemaSupported(schema[key], `${path}.${key}`)
  }
}

function loadTargetSchema() {
  if (cachedTargetSchema) return cachedTargetSchema
  const schema = JSON.parse(readFileSync(TARGET_SCHEMA_PATH, 'utf8'))
  assertTargetSchemaSupported(schema)
  if (schema.additionalProperties !== false) throw new Error('validator 要求平台目标 schema 禁止未知字段')
  cachedTargetSchema = schema
  return cachedTargetSchema
}

function schemaTypeMatches(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'integer': return Number.isInteger(value)
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    default: return true
  }
}

function validateSchemaNode(value, schema, path, errors) {
  let valid = true
  if (schema.type && !schemaTypeMatches(value, schema.type)) {
    errors.push(`${path} 类型不正确`)
    return false
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    errors.push(`${path} 值必须是 ${schema.const}`)
    valid = false
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} 值不受支持`)
    valid = false
  }
  if (schema.required) {
    for (const field of schema.required) {
      if (!Object.hasOwn(value, field)) {
        errors.push(`${path}.${field} 为必填字段`)
        valid = false
      }
    }
  }
  if (schema.additionalProperties === false) {
    const properties = schema.properties ?? {}
    for (const field of Object.keys(value)) {
      if (!Object.hasOwn(properties, field)) {
        errors.push(`${path}.${field} 不是支持的目标字段`)
        valid = false
      }
    }
  }
  for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(value, field)) continue
    valid = validateSchemaNode(value[field], fieldSchema, `${path}.${field}`, errors) && valid
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${path} 不能为空`)
    valid = false
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path} 格式不正确`)
    valid = false
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path} 不能小于 ${schema.minimum}`)
    valid = false
  }
  for (const childSchema of schema.allOf ?? []) {
    valid = validateSchemaNode(value, childSchema, path, errors) && valid
  }
  if (schema.if) {
    const conditionErrors = []
    const conditionMatches = validateSchemaNode(value, schema.if, path, conditionErrors)
    const branch = conditionMatches ? schema.then : schema.else
    if (branch) valid = validateSchemaNode(value, branch, path, errors) && valid
  }
  return valid
}

function validateTargetAgainstContract(target, index, errors, schema) {
  const prefix = `targets[${index}]`
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    errors.push(`${prefix} 必须是对象`)
    return false
  }
  const targetErrors = []
  validateSchemaNode(target, schema, prefix, targetErrors)
  errors.push(...targetErrors)
  return targetErrors.length === 0
}

function validateManifestTarget(target, index, errors, schema) {
  const valid = validateTargetAgainstContract(target, index, errors, schema)
  if (!target || typeof target !== 'object' || Array.isArray(target)) return false
  if (!Object.hasOwn(target, 'id')) {
    errors.push(`targets[${index}].id 为插件目标必填字段`)
    return false
  }
  return valid
}

function validateNativeComponents(manifest, pluginDir, schema, targetIndexesById, validTargetIndexes, errors, warnings) {
  if (!Array.isArray(manifest.nativeComponents)) {
    errors.push('显式声明 targets 时 nativeComponents 必须是数组；纯 JS 插件使用 []')
    return []
  }

  const componentIds = new Set()
  const validComponents = []
  const componentsById = new Map()
  for (const component of manifest.nativeComponents) {
    if (component && typeof component === 'object' && !Array.isArray(component) && typeof component.id === 'string') {
      componentsById.set(component.id, component)
    }
  }
  const allowedFields = new Set([
    'id', 'kind', 'targetId', 'arch', 'abi', 'entry', 'protocolVersion', 'hostComponentId', 'sha256', 'payloadFiles'
  ])
  const requiredFields = ['id', 'kind', 'targetId', 'arch', 'abi', 'entry']

  manifest.nativeComponents.forEach((component, index) => {
    const prefix = `nativeComponents[${index}]`
    const initialErrorCount = errors.length
    let targetIndex
    if (!component || typeof component !== 'object' || Array.isArray(component)) {
      errors.push(`${prefix} 必须是对象`)
      return
    }

    for (const field of requiredFields) {
      if (!Object.hasOwn(component, field)) errors.push(`${prefix}.${field} 为必填字段`)
    }
    for (const field of Object.keys(component)) {
      if (!allowedFields.has(field)) errors.push(`${prefix}.${field} 不是支持的组件字段`)
    }

    if (typeof component.id === 'string') {
      if (componentIds.has(component.id)) errors.push(`${prefix}.id 重复：${component.id}`)
      componentIds.add(component.id)
    }
    for (const field of ['id', 'targetId']) {
      if (!Object.hasOwn(component, field)) continue
      const fieldErrors = []
      validateSchemaNode(component[field], schema.properties.id, `${prefix}.${field}`, fieldErrors)
      errors.push(...fieldErrors)
    }
    if (!NATIVE_COMPONENT_KINDS.has(component.kind)) {
      errors.push(`${prefix}.kind 必须是 dll、shared-library 或 worker`)
    }

    if (Object.hasOwn(component, 'arch')) {
      const archErrors = []
      validateSchemaNode(component.arch, schema.properties.arch, `${prefix}.arch`, archErrors)
      errors.push(...archErrors)
      if (component.arch === 'any') errors.push(`${prefix}.arch 不能是 any；原生组件必须声明实际架构`)
    }
    if (Object.hasOwn(component, 'abi')) {
      const abiErrors = []
      validateSchemaNode(component.abi, schema.properties.abi, `${prefix}.abi`, abiErrors)
      errors.push(...abiErrors)
    }
    if (component.protocolVersion !== undefined &&
        (!Number.isInteger(component.protocolVersion) || component.protocolVersion < 1)) {
      errors.push(`${prefix}.protocolVersion 必须是大于等于 1 的整数`)
    }
    if (component.hostComponentId !== undefined) {
      const hostIdErrors = []
      validateSchemaNode(component.hostComponentId, schema.properties.id, `${prefix}.hostComponentId`, hostIdErrors)
      errors.push(...hostIdErrors)
    }

    let linkedHostComponent
    if (typeof component.targetId === 'string') {
      const matchingIndexes = targetIndexesById.get(component.targetId) ?? []
      if (matchingIndexes.length !== 1) {
        errors.push(`${prefix}.targetId 必须唯一引用一个 targets 项：${component.targetId}`)
      } else {
        targetIndex = matchingIndexes[0]
        const target = manifest.targets[targetIndex]

        if (component.abi === NATIVE_HOST32_DLL_ABI) {
          if (component.kind !== 'dll' || target.platform !== 'windows' || target.runtime !== 'electron') {
            errors.push(`${prefix}.abi=${NATIVE_HOST32_DLL_ABI} 仅支持 Windows Electron kind=dll`)
          }
          if (component.arch !== 'ia32') {
            errors.push(`${prefix}.arch 使用 ${NATIVE_HOST32_DLL_ABI} 时必须声明真实 ia32 架构`)
          }
          if (component.protocolVersion !== 1) {
            errors.push(`${prefix}.protocolVersion 使用 ${NATIVE_HOST32_DLL_ABI} 时必须显式等于 1`)
          }
        }

        if (component.abi === WINDOWS_PE_DEPENDENCY_ABI) {
          if (component.kind !== 'shared-library' || target.platform !== 'windows' || target.runtime !== 'electron') {
            errors.push(`${prefix}.abi=${WINDOWS_PE_DEPENDENCY_ABI} 仅支持 Windows Electron kind=shared-library`)
          }
          if (component.arch !== 'ia32') {
            errors.push(`${prefix}.arch 使用 ${WINDOWS_PE_DEPENDENCY_ABI} 时必须声明 ia32 架构`)
          }
          if (typeof component.entry === 'string' && !component.entry.toLowerCase().endsWith('.dll')) {
            errors.push(`${prefix}.entry 使用 ${WINDOWS_PE_DEPENDENCY_ABI} 时必须是 .dll`)
          }
        }

        if (component.hostComponentId !== undefined) {
          if (component.kind !== 'shared-library' || component.abi !== WINDOWS_PE_DEPENDENCY_ABI) {
            errors.push(`${prefix}.hostComponentId 仅适用于 windows-pe/v1 shared-library`)
          }
          if (typeof component.hostComponentId === 'string') {
            linkedHostComponent = componentsById.get(component.hostComponentId)
            if (!linkedHostComponent) {
              errors.push(`${prefix}.hostComponentId 引用了未知组件：${component.hostComponentId}`)
            } else if (linkedHostComponent.targetId !== component.targetId) {
              errors.push(`${prefix}.hostComponentId 必须引用同一 target 的 DLL`)
            } else if (
              linkedHostComponent.kind !== 'dll' || linkedHostComponent.arch !== 'ia32' ||
              linkedHostComponent.abi !== NATIVE_HOST32_DLL_ABI || linkedHostComponent.protocolVersion !== 1
            ) {
              errors.push(`${prefix}.hostComponentId 必须引用 ia32 ${NATIVE_HOST32_DLL_ABI} DLL，protocolVersion=1`)
            }
          }
        }

        const allowedNativeHost32DllBinding =
          target.platform === 'windows' && target.runtime === 'electron' && target.arch === 'x64' &&
          component.kind === 'dll' && component.arch === 'ia32' &&
          component.abi === NATIVE_HOST32_DLL_ABI && component.protocolVersion === 1
        const allowedNativeHost32DependencyBinding =
          target.platform === 'windows' && target.runtime === 'electron' && target.arch === 'x64' &&
          component.kind === 'shared-library' && component.arch === 'ia32' &&
          component.abi === WINDOWS_PE_DEPENDENCY_ABI && component.hostComponentId !== undefined &&
          linkedHostComponent !== undefined && linkedHostComponent.targetId === target.id &&
          linkedHostComponent.kind === 'dll' && linkedHostComponent.arch === 'ia32' &&
          linkedHostComponent.abi === NATIVE_HOST32_DLL_ABI && linkedHostComponent.protocolVersion === 1
        if (typeof component.arch === 'string' && component.arch !== target.arch &&
            !allowedNativeHost32DllBinding && !allowedNativeHost32DependencyBinding) {
          errors.push(
            `${prefix}.arch 必须与 targets[${targetIndex}].arch 精确相等；Windows Electron x64 的 ia32 例外要求 ` +
            `${NATIVE_HOST32_DLL_ABI} DLL 或绑定该 DLL 的 ${WINDOWS_PE_DEPENDENCY_ABI} shared-library`
          )
        }
        if (!validTargetIndexes.has(targetIndex)) {
          errors.push(`${prefix}.targetId 指向的 target 自身无效：${component.targetId}`)
        }
      }
    }

    if (component.kind === 'dll') {
      if (targetIndex !== undefined && manifest.targets[targetIndex].platform !== 'windows') {
        errors.push(`${prefix}.kind=dll 只能绑定 Windows target`)
      }
      if (typeof component.entry === 'string' && !component.entry.toLowerCase().endsWith('.dll')) {
        errors.push(`${prefix}.entry 的 DLL 路径必须以 .dll 结尾`)
      }
    }

    const componentEntry = resolveSafePluginPath(pluginDir, component.entry)
    if (!componentEntry) {
      errors.push(`${prefix}.entry 必须是插件目录内的安全相对路径`)
    } else if (!existsSync(componentEntry)) {
      warnings.push(`${prefix}.entry 文件尚未生成：${component.entry}`)
    } else if (!statSync(componentEntry).isFile()) {
      errors.push(`${prefix}.entry 必须指向普通文件`)
    }

    if (errors.length === initialErrorCount && targetIndex !== undefined) {
      validComponents.push({ component, targetIndex })
    }
  })
  validateNativePayloads(manifest, pluginDir, targetIndexesById, errors, warnings)
  return validComponents
}

function architectureSelectorsOverlap(left, right) {
  if (left === right || left === 'any' || right === 'any' ||
      left === 'universal' || right === 'universal') return true
  return false
}

function targetsOverlap(left, right) {
  if (left.platform !== right.platform || left.runtime !== right.runtime) return false
  if (!architectureSelectorsOverlap(left.arch, right.arch)) return false

  // ABI is an exact host constraint when declared; an omitted ABI is a wildcard.
  // minSdkContractVersion is a lower bound, so two such ranges can still overlap.
  return left.abi === undefined || right.abi === undefined || left.abi === right.abi
}

function validateTargets(manifest, pluginDir, errors, warnings) {
  if (!Object.hasOwn(manifest, 'targets')) {
    if (Object.hasOwn(manifest, 'nativeComponents')) {
      errors.push('nativeComponents 必须通过显式 targets 声明目标绑定')
    }
    warnings.push('未声明 targets：仅按旧版 Windows 兼容规则处理，不推断 macOS 支持')
    return
  }

  let allowedManifestKeys
  try {
    if (!cachedTargetManifestKeys) {
      const manifestSchema = JSON.parse(readFileSync(PLUGIN_MANIFEST_SCHEMA_PATH, 'utf8'))
      const strictTargetRule = manifestSchema.allOf?.find((rule) =>
        rule.if?.required?.includes('targets') && Array.isArray(rule.then?.propertyNames?.enum)
      )
      const schemaPropertyKeys = Object.keys(manifestSchema.properties ?? {})
      const allowedKeys = strictTargetRule?.then?.propertyNames?.enum
      if (
        !Array.isArray(allowedKeys) ||
        schemaPropertyKeys.length !== allowedKeys.length ||
        schemaPropertyKeys.some((key) => !allowedKeys.includes(key))
      ) {
        throw new Error('目标manifest顶层字段白名单与properties不一致')
      }
      cachedTargetManifestKeys = new Set(allowedKeys)
    }
    allowedManifestKeys = cachedTargetManifestKeys
  } catch (error) {
    errors.push(`无法读取平台目标manifest契约 ${PLUGIN_MANIFEST_SCHEMA_PATH}：${error.message}`)
    return
  }
  for (const key of Object.keys(manifest)) {
    if (!allowedManifestKeys.has(key)) errors.push(`plugin.json.${key} 不是支持的顶层字段`)
  }

  if (!Array.isArray(manifest.targets)) {
    errors.push('targets 必须是目标对象数组')
    return
  }
  if (manifest.targets.length === 0) errors.push('targets 至少要声明一个目标')

  let schema
  try {
    schema = loadTargetSchema()
  } catch (error) {
    errors.push(`无法读取平台目标契约 ${TARGET_SCHEMA_PATH}：${error.message}`)
    return
  }

  const validTargets = []
  const validTargetIndexes = new Set()
  const targetIndexesById = new Map()
  manifest.targets.forEach((target, index) => {
    if (validateManifestTarget(target, index, errors, schema)) {
      validTargets.push(target)
      validTargetIndexes.add(index)
    }
    if (target && typeof target === 'object' && !Array.isArray(target) && typeof target.id === 'string') {
      const indexes = targetIndexesById.get(target.id) ?? []
      indexes.push(index)
      targetIndexesById.set(target.id, indexes)
    }
  })

  for (const [targetId, indexes] of targetIndexesById) {
    if (indexes.length > 1) errors.push(`targets.id 必须唯一：${targetId} 出现在 ${indexes.join(', ')}`)
  }

  const validComponents = validateNativeComponents(
    manifest, pluginDir, schema, targetIndexesById, validTargetIndexes, errors, warnings
  )

  for (let leftIndex = 0; leftIndex < validTargets.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < validTargets.length; rightIndex += 1) {
      if (targetsOverlap(validTargets[leftIndex], validTargets[rightIndex])) {
        errors.push(`targets[${leftIndex}] 与 targets[${rightIndex}] 匹配范围重叠，目标选择存在歧义`)
      }
    }
  }

  if (manifest.dllloader !== undefined || manifest.requireAdmin === true) {
    if (validTargets.some((target) => target.platform === 'macos')) {
      errors.push('旧版 dllloader/requireAdmin 仅适用于 Windows，不能与 macOS 目标同时声明')
    }
  }

  const validWindowsDllComponents = validComponents.filter(({ component, targetIndex }) =>
    component.kind === 'dll' && manifest.targets[targetIndex].platform === 'windows'
  )
  if (manifest.dllloader !== undefined && !validWindowsDllComponents.some(({ component }) =>
    component.entry === manifest.dllloader
  )) {
    errors.push('声明 dllloader 时必须有 Windows kind=dll 组件，且 entry 与 dllloader 完全一致')
  }
  if (manifest.requireAdmin === true && validWindowsDllComponents.length === 0) {
    errors.push('requireAdmin=true 时必须声明绑定到 Windows target 的 kind=dll 组件')
  }
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) return false
  const normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return false
  const segments = normalized.split('/')
  return !segments.includes('..') && !segments.some((segment) => segment.includes(':'))
}

function pathIsWithin(rootPath, candidatePath) {
  const relativePath = relative(rootPath, candidatePath)
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}

function resolveSafePluginPath(pluginDir, value) {
  if (!isSafeRelativePath(value)) return null

  let candidatePath
  let realPluginDir
  try {
    candidatePath = resolve(pluginDir, value.replaceAll('\\', sep))
    realPluginDir = realpathSync(pluginDir)
  } catch {
    return null
  }

  // Resolve the nearest existing ancestor too, so an in-plugin symlink cannot
  // redirect a not-yet-built DLL or asset outside the plugin directory.
  let existingPath = candidatePath
  while (true) {
    try {
      lstatSync(existingPath)
      break
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null
      const parentPath = dirname(existingPath)
      if (parentPath === existingPath) return null
      existingPath = parentPath
    }
  }

  try {
    const realExistingPath = realpathSync(existingPath)
    if (!pathIsWithin(realPluginDir, realExistingPath)) return null
    if (existsSync(candidatePath) && !pathIsWithin(realPluginDir, realpathSync(candidatePath))) return null
  } catch {
    return null
  }

  return candidatePath
}

function validateDirectory(input) {
  const pluginDir = resolve(input)
  const manifestPath = resolve(pluginDir, 'plugin.json')
  const errors = []
  const warnings = []

  if (!existsSync(manifestPath)) {
    return { input, errors: [`缺少 ${manifestPath}`], warnings }
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { input, errors: [`plugin.json 不是有效 JSON：${error.message}`], warnings }
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { input, errors: ['plugin.json 根节点必须是对象'], warnings }
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      errors.push(`${field} 必须是非空字符串`)
    }
  }

  if (manifest.id && !/^[a-z][a-z0-9-]*$/.test(manifest.id)) {
    errors.push('id 必须以小写字母开头，且只能包含小写字母、数字和连字符')
  }
  if (manifest.version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    errors.push('version 必须使用语义化版本，例如 1.0.0 或 1.0.0-beta.1')
  }
  const hasKeyword = typeof manifest.keyword === 'string' && manifest.keyword.trim() !== ''
  const hasKeywords = Array.isArray(manifest.keywords) &&
    manifest.keywords.length > 0 && manifest.keywords.every((item) => typeof item === 'string' && item.trim() !== '')
  if (!hasKeyword && !hasKeywords) {
    warnings.push('未配置 keyword 或 keywords，插件仍可加载，但不利于在主面板中搜索')
  }

  for (const field of ['entry', 'icon']) {
    const value = manifest[field]
    const target = resolveSafePluginPath(pluginDir, value)
    if (!target) {
      errors.push(`${field} 必须是插件目录内的安全相对路径`)
      continue
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      errors.push(`${field} 指向的文件不存在：${value}`)
    }
  }

  if (!manifest.window || typeof manifest.window !== 'object' || Array.isArray(manifest.window)) {
    errors.push('window 必须是对象')
  } else {
    const window = manifest.window
    for (const field of ['width', 'height']) {
      if (!Number.isInteger(window[field]) || window[field] <= 0) {
        errors.push(`window.${field} 必须是正整数`)
      }
    }
    for (const field of ['minWidth', 'minHeight']) {
      if (window[field] !== undefined && (!Number.isInteger(window[field]) || window[field] < 0)) {
        errors.push(`window.${field} 必须是非负整数`)
      }
    }
    if (window.minWidth > window.width) errors.push('window.minWidth 不能大于 window.width')
    if (window.minHeight > window.height) errors.push('window.minHeight 不能大于 window.height')
    if (typeof window.resizable !== 'boolean') errors.push('window.resizable 必须是布尔值')
    if (typeof window.singleInstance !== 'boolean') errors.push('window.singleInstance 必须是布尔值')
    if (window.controls !== undefined) {
      if (!window.controls || typeof window.controls !== 'object' || Array.isArray(window.controls)) {
        errors.push('window.controls 必须是对象')
      } else {
        for (const field of ['minimize', 'maximize']) {
          if (typeof window.controls[field] !== 'boolean') {
            errors.push(`window.controls.${field} 必须是布尔值`)
          }
        }
      }
    }
  }

  if (manifest.requireAdmin !== undefined && typeof manifest.requireAdmin !== 'boolean') {
    errors.push('requireAdmin 必须是布尔值')
  }
  validateTargets(manifest, pluginDir, errors, warnings)
  if (manifest.commonLibs !== undefined &&
      (!Array.isArray(manifest.commonLibs) || manifest.commonLibs.some((item) => typeof item !== 'string' || !item))) {
    errors.push('commonLibs 必须是非空字符串数组')
  }
  if (manifest.dllloader !== undefined) {
    const dllPath = resolveSafePluginPath(pluginDir, manifest.dllloader)
    if (!dllPath || typeof manifest.dllloader !== 'string' || !manifest.dllloader.toLowerCase().endsWith('.dll')) {
      errors.push('dllloader 必须是插件目录内的 .dll 相对路径')
    } else if (!existsSync(dllPath)) {
      warnings.push(`尚未生成 DLL：${manifest.dllloader}（打包和真实加载前必须存在）`)
    } else if (!statSync(dllPath).isFile()) {
      errors.push('dllloader 必须指向插件目录内的普通文件')
    }
  }

  const entryPath = resolveSafePluginPath(pluginDir, manifest.entry)
  if (entryPath && existsSync(entryPath) && statSync(entryPath).isFile()) {
    const html = readFileSync(entryPath, 'utf8')
    if (!html.includes('ztools://web/sdk/ztools-api.js')) {
      errors.push('入口 HTML 必须引入 ztools://web/sdk/ztools-api.js')
    }
    if (!html.includes('ztools://web/sdk/plugin-sdk.js')) {
      warnings.push('未引入 plugin-sdk.js；生命周期、主题和拖拽等高层能力不可用')
    }
  }

  return { input, errors, warnings }
}

function validateDirectoryTargets(input) {
  const pluginDir = resolve(input)
  const manifestPath = resolve(pluginDir, 'plugin.json')
  const errors = []
  const warnings = []

  if (!existsSync(manifestPath)) {
    return { input, errors: [`缺少 ${manifestPath}`], warnings }
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { input, errors: [`plugin.json 不是有效 JSON：${error.message}`], warnings }
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { input, errors: ['plugin.json 根节点必须是对象'], warnings }
  }

  validateTargets(manifest, pluginDir, errors, warnings)
  return { input, errors, warnings }
}

const args = process.argv.slice(2)
const targetsOnly = args[0] === '--targets-only'
const inputs = targetsOnly ? args.slice(1) : args
if (inputs.length === 0) {
  console.error('用法：node scripts/validate-plugin.mjs [--targets-only] <插件目录> [...]')
  process.exit(2)
}

let failed = false
for (const input of inputs) {
  const result = targetsOnly ? validateDirectoryTargets(input) : validateDirectory(input)
  for (const warning of result.warnings) console.warn(`WARN ${input}: ${warning}`)
  for (const error of result.errors) console.error(`ERROR ${input}: ${error}`)
  if (result.errors.length === 0) console.log(`OK ${input}`)
  failed ||= result.errors.length > 0
}

process.exitCode = failed ? 1 : 0

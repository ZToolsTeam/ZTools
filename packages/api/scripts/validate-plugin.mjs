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
    if (targetPaths.has(targetKey)) errors.push(`${prefix}.entry duplicates a native file path within the same target (case-insensitive)`)
    targetPaths.add(targetKey)
    const metadata = JSON.stringify({ format, arch: file.arch ?? null, sha256: file.sha256 ?? null })
    const existing = sharedPaths.get(normalized)
    if (hasPayloadContract && existing && existing.targetId !== component.targetId && existing.metadata !== metadata) {
      errors.push(`${prefix}.entry reused across targets must have identical format, arch, and sha256`)
    }
    sharedPaths.set(normalized, { targetId: component.targetId, metadata })
  }
  manifest.nativeComponents.forEach((component, index) => {
    if (!component || typeof component !== 'object' || Array.isArray(component)) return
    const prefix = `nativeComponents[${index}]`
    if (component.sha256 !== undefined && (typeof component.sha256 !== 'string' || !SHA256_PATTERN.test(component.sha256))) {
      errors.push(`${prefix}.sha256 must be a 64-character lowercase hexadecimal SHA-256 hash`)
    }
    registerPath(component, component, prefix, /\.(dll|exe)$/i.test(component.entry ?? '') ? 'pe' : 'component')
    const hasPayload = Object.hasOwn(component, 'payloadFiles')
    if (hasPayload) {
      const indexes = targetIndexesById.get(component.targetId) ?? []
      const target = indexes.length === 1 ? manifest.targets[indexes[0]] : undefined
      if (component.kind !== 'dll' || component.arch !== 'ia32' || component.abi !== NATIVE_HOST32_DLL_ABI ||
          component.protocolVersion !== 1 || target?.platform !== 'windows' || target?.runtime !== 'electron') {
        errors.push(`${prefix}.payloadFiles is only supported for Windows Electron ia32 NativeHost DLLs (protocolVersion=1)`)
      }
      if (typeof component.sha256 !== 'string' || !SHA256_PATTERN.test(component.sha256)) {
        errors.push(`${prefix}.sha256 is required when payloadFiles is declared`)
      }
      if (!Array.isArray(component.payloadFiles)) {
        errors.push(`${prefix}.payloadFiles must be an array`)
      } else {
        component.payloadFiles.forEach((file, fileIndex) => {
          const filePrefix = `${prefix}.payloadFiles[${fileIndex}]`
          if (!file || typeof file !== 'object' || Array.isArray(file)) {
            errors.push(`${filePrefix} must be an object`)
            return
          }
          for (const field of ['entry', 'format', 'sha256']) {
            if (!Object.hasOwn(file, field)) errors.push(`${filePrefix}.${field} is required`)
          }
          for (const field of Object.keys(file)) {
            if (!['entry', 'format', 'sha256', 'arch'].includes(field)) errors.push(`${filePrefix}.${field} is not a supported payload field`)
          }
          if (!isNativePayloadPath(file.entry)) errors.push(`${filePrefix}.entry must be a safe canonical relative path under lib/`)
          if (typeof file.sha256 !== 'string' || !SHA256_PATTERN.test(file.sha256)) {
            errors.push(`${filePrefix}.sha256 must be a 64-character lowercase hexadecimal SHA-256 hash`)
          }
          if (file.format === 'pe') {
            if (!['ia32', 'x64'].includes(file.arch)) errors.push(`${filePrefix}.arch must be ia32 or x64 when format=pe`)
            if (typeof file.entry !== 'string' || !/\.(dll|exe)$/i.test(file.entry)) {
              errors.push(`${filePrefix}.entry must end with .dll or .exe when format=pe`)
            }
          } else if (file.format === 'data') {
            if (Object.hasOwn(file, 'arch')) errors.push(`${filePrefix}.arch is disallowed when format=data`)
            if (typeof file.entry === 'string' && /\.(dll|exe)$/i.test(file.entry)) {
              errors.push(`${filePrefix}.entry must not end with .dll or .exe when format=data`)
            }
          } else {
            errors.push(`${filePrefix}.format must be pe or data`)
          }
          registerPath(component, file, filePrefix, file.format)
          if (isNativePayloadPath(file.entry)) {
            const filePath = resolveSafePluginPath(pluginDir, file.entry)
            if (!filePath) errors.push(`${filePrefix}.entry must stay within the plugin directory`)
            else if (!existsSync(filePath)) warnings.push(`${filePrefix}.entry file has not been built yet: ${file.entry}`)
            else if (!statSync(filePath).isFile()) errors.push(`${filePrefix}.entry must point to a regular file`)
          }
        })
      }
    }
    const owner = manifest.nativeComponents.find((item) => item && typeof item === 'object' &&
      item.id === component.hostComponentId && Object.hasOwn(item, 'payloadFiles'))
    if (owner && (typeof component.sha256 !== 'string' || !SHA256_PATTERN.test(component.sha256))) {
      errors.push(`${prefix}.sha256 is required when bound to a Host component declaring payloadFiles`)
    }
  })
}

function assertTargetSchemaSupported(schema, path = '$', allowedKeys = SUPPORTED_TARGET_SCHEMA_KEYS) {
  const unsupportedKeys = Object.keys(schema).filter((key) => !allowedKeys.has(key))
  if (unsupportedKeys.length > 0) {
    throw new Error(`Validator does not support schema constraints at ${path}: ${unsupportedKeys.join(', ')}`)
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
  if (schema.additionalProperties !== false) throw new Error('Validator requires platform target schema to disallow unknown properties')
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
    errors.push(`${path} has invalid type`)
    return false
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    errors.push(`${path} must equal ${schema.const}`)
    valid = false
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} has unsupported value`)
    valid = false
  }
  if (schema.required) {
    for (const field of schema.required) {
      if (!Object.hasOwn(value, field)) {
        errors.push(`${path}.${field} is required`)
        valid = false
      }
    }
  }
  if (schema.additionalProperties === false) {
    const properties = schema.properties ?? {}
    for (const field of Object.keys(value)) {
      if (!Object.hasOwn(properties, field)) {
        errors.push(`${path}.${field} is not a supported target field`)
        valid = false
      }
    }
  }
  for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(value, field)) continue
    valid = validateSchemaNode(value[field], fieldSchema, `${path}.${field}`, errors) && valid
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${path} must not be empty`)
    valid = false
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path} has invalid format`)
    valid = false
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path} must be >= ${schema.minimum}`)
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
    errors.push(`${prefix} must be an object`)
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
    errors.push(`targets[${index}].id is required for plugin targets`)
    return false
  }
  return valid
}

function validateNativeComponents(manifest, pluginDir, schema, targetIndexesById, validTargetIndexes, errors, warnings) {
  if (!Array.isArray(manifest.nativeComponents)) {
    errors.push('nativeComponents must be an array when targets is declared; use [] for pure JS plugins')
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
      errors.push(`${prefix} must be an object`)
      return
    }

    for (const field of requiredFields) {
      if (!Object.hasOwn(component, field)) errors.push(`${prefix}.${field} is required`)
    }
    for (const field of Object.keys(component)) {
      if (!allowedFields.has(field)) errors.push(`${prefix}.${field} is not a supported component field`)
    }

    if (typeof component.id === 'string') {
      if (componentIds.has(component.id)) errors.push(`${prefix}.id is duplicated: ${component.id}`)
      componentIds.add(component.id)
    }
    for (const field of ['id', 'targetId']) {
      if (!Object.hasOwn(component, field)) continue
      const fieldErrors = []
      validateSchemaNode(component[field], schema.properties.id, `${prefix}.${field}`, fieldErrors)
      errors.push(...fieldErrors)
    }
    if (!NATIVE_COMPONENT_KINDS.has(component.kind)) {
      errors.push(`${prefix}.kind must be dll, shared-library, or worker`)
    }

    if (Object.hasOwn(component, 'arch')) {
      const archErrors = []
      validateSchemaNode(component.arch, schema.properties.arch, `${prefix}.arch`, archErrors)
      errors.push(...archErrors)
      if (component.arch === 'any') errors.push(`${prefix}.arch cannot be any; native components must declare a concrete architecture`)
    }
    if (Object.hasOwn(component, 'abi')) {
      const abiErrors = []
      validateSchemaNode(component.abi, schema.properties.abi, `${prefix}.abi`, abiErrors)
      errors.push(...abiErrors)
    }
    if (component.protocolVersion !== undefined &&
        (!Number.isInteger(component.protocolVersion) || component.protocolVersion < 1)) {
      errors.push(`${prefix}.protocolVersion must be an integer >= 1`)
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
        errors.push(`${prefix}.targetId must uniquely reference one targets entry: ${component.targetId}`)
      } else {
        targetIndex = matchingIndexes[0]
        const target = manifest.targets[targetIndex]

        if (component.abi === NATIVE_HOST32_DLL_ABI) {
          if (component.kind !== 'dll' || target.platform !== 'windows' || target.runtime !== 'electron') {
            errors.push(`${prefix}.abi=${NATIVE_HOST32_DLL_ABI} is only supported for Windows Electron kind=dll`)
          }
          if (component.arch !== 'ia32') {
            errors.push(`${prefix}.arch must declare concrete ia32 architecture when using ${NATIVE_HOST32_DLL_ABI}`)
          }
          if (component.protocolVersion !== 1) {
            errors.push(`${prefix}.protocolVersion must explicitly equal 1 when using ${NATIVE_HOST32_DLL_ABI}`)
          }
        }

        if (component.abi === WINDOWS_PE_DEPENDENCY_ABI) {
          if (component.kind !== 'shared-library' || target.platform !== 'windows' || target.runtime !== 'electron') {
            errors.push(`${prefix}.abi=${WINDOWS_PE_DEPENDENCY_ABI} is only supported for Windows Electron kind=shared-library`)
          }
          if (component.arch !== 'ia32') {
            errors.push(`${prefix}.arch must declare ia32 architecture when using ${WINDOWS_PE_DEPENDENCY_ABI}`)
          }
          if (typeof component.entry === 'string' && !component.entry.toLowerCase().endsWith('.dll')) {
            errors.push(`${prefix}.entry must end with .dll when using ${WINDOWS_PE_DEPENDENCY_ABI}`)
          }
        }

        if (component.hostComponentId !== undefined) {
          if (component.kind !== 'shared-library' || component.abi !== WINDOWS_PE_DEPENDENCY_ABI) {
            errors.push(`${prefix}.hostComponentId is only allowed for windows-pe/v1 shared-library components`)
          }
          if (typeof component.hostComponentId === 'string') {
            linkedHostComponent = componentsById.get(component.hostComponentId)
            if (!linkedHostComponent) {
              errors.push(`${prefix}.hostComponentId references unknown component: ${component.hostComponentId}`)
            } else if (linkedHostComponent.targetId !== component.targetId) {
              errors.push(`${prefix}.hostComponentId must reference a DLL bound to the same target`)
            } else if (
              linkedHostComponent.kind !== 'dll' || linkedHostComponent.arch !== 'ia32' ||
              linkedHostComponent.abi !== NATIVE_HOST32_DLL_ABI || linkedHostComponent.protocolVersion !== 1
            ) {
              errors.push(`${prefix}.hostComponentId must reference an ia32 ${NATIVE_HOST32_DLL_ABI} DLL with protocolVersion=1`)
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
            `${prefix}.arch must exactly equal targets[${targetIndex}].arch; the Windows Electron x64 ia32 exception requires ` +
            `a ${NATIVE_HOST32_DLL_ABI} DLL or a ${WINDOWS_PE_DEPENDENCY_ABI} shared-library bound to that DLL`
          )
        }
        if (!validTargetIndexes.has(targetIndex)) {
          errors.push(`${prefix}.targetId points to an invalid target: ${component.targetId}`)
        }
      }
    }

    if (component.kind === 'dll') {
      if (targetIndex !== undefined && manifest.targets[targetIndex].platform !== 'windows') {
        errors.push(`${prefix}.kind=dll can only bind to a Windows target`)
      }
      if (typeof component.entry === 'string' && !component.entry.toLowerCase().endsWith('.dll')) {
        errors.push(`${prefix}.entry for a DLL component must end with .dll`)
      }
    }

    const componentEntry = resolveSafePluginPath(pluginDir, component.entry)
    if (!componentEntry) {
      errors.push(`${prefix}.entry must be a safe relative path within the plugin directory`)
    } else if (!existsSync(componentEntry)) {
      warnings.push(`${prefix}.entry file has not been built yet: ${component.entry}`)
    } else if (!statSync(componentEntry).isFile()) {
      errors.push(`${prefix}.entry must point to a regular file`)
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
      errors.push('nativeComponents requires explicit targets declaration')
    }
    warnings.push('targets not declared: falling back to legacy Windows compatibility rules; macOS support is not implied')
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
        throw new Error('Target manifest root field whitelist does not match schema properties')
      }
      cachedTargetManifestKeys = new Set(allowedKeys)
    }
    allowedManifestKeys = cachedTargetManifestKeys
  } catch (error) {
    errors.push(`Failed to load target manifest contract ${PLUGIN_MANIFEST_SCHEMA_PATH}: ${error.message}`)
    return
  }
  for (const key of Object.keys(manifest)) {
    if (!allowedManifestKeys.has(key)) errors.push(`plugin.json.${key} is not a supported root field`)
  }

  if (!Array.isArray(manifest.targets)) {
    errors.push('targets must be an array of target objects')
    return
  }
  if (manifest.targets.length === 0) errors.push('targets must declare at least one target')

  let schema
  try {
    schema = loadTargetSchema()
  } catch (error) {
    errors.push(`Failed to load platform target contract ${TARGET_SCHEMA_PATH}: ${error.message}`)
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
    if (indexes.length > 1) errors.push(`targets.id must be unique: ${targetId} appears at ${indexes.join(', ')}`)
  }

  const validComponents = validateNativeComponents(
    manifest, pluginDir, schema, targetIndexesById, validTargetIndexes, errors, warnings
  )

  for (let leftIndex = 0; leftIndex < validTargets.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < validTargets.length; rightIndex += 1) {
      if (targetsOverlap(validTargets[leftIndex], validTargets[rightIndex])) {
        errors.push(`targets[${leftIndex}] and targets[${rightIndex}] overlap and cause ambiguous target selection`)
      }
    }
  }

  if (manifest.dllloader !== undefined || manifest.requireAdmin === true) {
    if (validTargets.some((target) => target.platform === 'macos')) {
      errors.push('Legacy dllloader/requireAdmin fields are Windows-only and cannot be combined with macOS targets')
    }
  }

  const validWindowsDllComponents = validComponents.filter(({ component, targetIndex }) =>
    component.kind === 'dll' && manifest.targets[targetIndex].platform === 'windows'
  )
  if (manifest.dllloader !== undefined && !validWindowsDllComponents.some(({ component }) =>
    component.entry === manifest.dllloader
  )) {
    errors.push('dllloader requires a Windows kind=dll component whose entry matches dllloader exactly')
  }
  if (manifest.requireAdmin === true && validWindowsDllComponents.length === 0) {
    errors.push('requireAdmin=true requires a kind=dll component bound to a Windows target')
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
    return { input, errors: [`Missing ${manifestPath}`], warnings }
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { input, errors: [`plugin.json is not valid JSON: ${error.message}`], warnings }
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { input, errors: ['plugin.json root must be an object'], warnings }
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      errors.push(`${field} must be a non-empty string`)
    }
  }

  if (manifest.id && !/^[a-z][a-z0-9-]*$/.test(manifest.id)) {
    errors.push('id must start with a lowercase letter and contain only lowercase letters, digits, and hyphens')
  }
  if (manifest.version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    errors.push('version must follow SemVer format, e.g. 1.0.0 or 1.0.0-beta.1')
  }
  const hasKeyword = typeof manifest.keyword === 'string' && manifest.keyword.trim() !== ''
  const hasKeywords = Array.isArray(manifest.keywords) &&
    manifest.keywords.length > 0 && manifest.keywords.every((item) => typeof item === 'string' && item.trim() !== '')
  if (!hasKeyword && !hasKeywords) {
    warnings.push('Neither keyword nor keywords is configured; the plugin still loads, but search discoverability is reduced')
  }

  for (const field of ['entry', 'icon']) {
    const value = manifest[field]
    const target = resolveSafePluginPath(pluginDir, value)
    if (!target) {
      errors.push(`${field} must be a safe relative path within the plugin directory`)
      continue
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      errors.push(`${field} target file does not exist: ${value}`)
    }
  }

  if (!manifest.window || typeof manifest.window !== 'object' || Array.isArray(manifest.window)) {
    errors.push('window must be an object')
  } else {
    const window = manifest.window
    for (const field of ['width', 'height']) {
      if (!Number.isInteger(window[field]) || window[field] <= 0) {
        errors.push(`window.${field} must be a positive integer`)
      }
    }
    for (const field of ['minWidth', 'minHeight']) {
      if (window[field] !== undefined && (!Number.isInteger(window[field]) || window[field] < 0)) {
        errors.push(`window.${field} must be a non-negative integer`)
      }
    }
    if (window.minWidth > window.width) errors.push('window.minWidth must not exceed window.width')
    if (window.minHeight > window.height) errors.push('window.minHeight must not exceed window.height')
    if (typeof window.resizable !== 'boolean') errors.push('window.resizable must be a boolean')
    if (typeof window.singleInstance !== 'boolean') errors.push('window.singleInstance must be a boolean')
    if (window.controls !== undefined) {
      if (!window.controls || typeof window.controls !== 'object' || Array.isArray(window.controls)) {
        errors.push('window.controls must be an object')
      } else {
        for (const field of ['minimize', 'maximize']) {
          if (typeof window.controls[field] !== 'boolean') {
            errors.push(`window.controls.${field} must be a boolean`)
          }
        }
      }
    }
  }

  if (manifest.requireAdmin !== undefined && typeof manifest.requireAdmin !== 'boolean') {
    errors.push('requireAdmin must be a boolean')
  }
  validateTargets(manifest, pluginDir, errors, warnings)
  if (manifest.commonLibs !== undefined &&
      (!Array.isArray(manifest.commonLibs) || manifest.commonLibs.some((item) => typeof item !== 'string' || !item))) {
    errors.push('commonLibs must be an array of non-empty strings')
  }
  if (manifest.dllloader !== undefined) {
    const dllPath = resolveSafePluginPath(pluginDir, manifest.dllloader)
    if (!dllPath || typeof manifest.dllloader !== 'string' || !manifest.dllloader.toLowerCase().endsWith('.dll')) {
      errors.push('dllloader must be a .dll relative path within the plugin directory')
    } else if (!existsSync(dllPath)) {
      warnings.push(`DLL has not been built yet: ${manifest.dllloader} (must exist before packaging or loading)`)
    } else if (!statSync(dllPath).isFile()) {
      errors.push('dllloader must point to a regular file within the plugin directory')
    }
  }

  const entryPath = resolveSafePluginPath(pluginDir, manifest.entry)
  if (entryPath && existsSync(entryPath) && statSync(entryPath).isFile()) {
    const html = readFileSync(entryPath, 'utf8')
    if (!html.includes('ztools://web/sdk/ztools-api.js')) {
      errors.push('Entry HTML must include ztools://web/sdk/ztools-api.js')
    }
    if (!html.includes('ztools://web/sdk/plugin-sdk.js')) {
      warnings.push('plugin-sdk.js is not included; high-level lifecycle, theme, and drag-and-drop capabilities will be unavailable')
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
    return { input, errors: [`Missing ${manifestPath}`], warnings }
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { input, errors: [`plugin.json is not valid JSON: ${error.message}`], warnings }
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { input, errors: ['plugin.json root must be an object'], warnings }
  }

  validateTargets(manifest, pluginDir, errors, warnings)
  return { input, errors, warnings }
}

const args = process.argv.slice(2)
const targetsOnly = args[0] === '--targets-only'
const inputs = targetsOnly ? args.slice(1) : args
if (inputs.length === 0) {
  console.error('Usage: node scripts/validate-plugin.mjs [--targets-only] <plugin-dir> [...]')
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

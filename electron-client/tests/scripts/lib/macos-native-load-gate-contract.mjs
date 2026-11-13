import fs from 'node:fs'
import path from 'node:path'

function extractFunctionBody(source, signature) {
  const signatureIndex = source.indexOf(signature)
  if (signatureIndex < 0) throw new Error('MAC_NATIVE_LOAD_GATE_FUNCTION_MISSING')
  const openingBrace = source.indexOf('{', signatureIndex + signature.length)
  if (openingBrace < 0) throw new Error('MAC_NATIVE_LOAD_GATE_BODY_MISSING')
  let depth = 0
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(openingBrace + 1, index)
    }
  }
  throw new Error('MAC_NATIVE_LOAD_GATE_BODY_UNTERMINATED')
}

export function runMacNativeLoadGateSourceContracts(repositoryRoot) {
  const sourcePath = path.join(repositoryRoot, 'native', 'ZToolsMacNative', 'darwin', 'trust_gate.cpp')
  const source = fs.readFileSync(sourcePath, 'utf8')
  const body = extractFunctionBody(source, 'uint32_t zt_mac_native_load_candidate_v1(')
  const preflightIndex = body.indexOf('zt_mac_native_validate_candidate_v1(request, result)')
  const blockedIndex = body.indexOf('ZT_MAC_TRUST_SAME_OBJECT_LOAD_UNPROVEN')
  const blockedReturnIndex = body.indexOf('return result->status', blockedIndex)
  const checks = [
    preflightIndex >= 0 && blockedIndex > preflightIndex,
    blockedReturnIndex > blockedIndex,
    !/\b(?:dlopen|dlsym|dladdr|dlclose)\s*\(/.test(body),
    !/mappedVnodeMatches|sameFsid/.test(body),
    !/same_object_load_proven\s*=\s*1|dependency_closure_validated\s*=\s*1|may_load\s*=\s*1/.test(body),
    /Keep the\s*\n\s*\/\/ production loader closed/.test(body),
  ]
  const failed = checks.findIndex((passed) => !passed)
  if (failed >= 0) throw new Error(`MAC_NATIVE_LOAD_GATE_SOURCE_CONTRACT_${failed + 1}_FAILED`)
  return {
    status: 'PASS',
    scope: 'mac-native-production-load-blocked-before-dlopen',
    checks: checks.length,
    productionLoad: 'SAME_OBJECT_LOAD_UNPROVEN',
    dlopenCallsInProductionGate: 0,
  }
}

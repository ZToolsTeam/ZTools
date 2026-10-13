// Native bundle metadata and the SDK/update version have different contracts.
// Product values must be supplied explicitly; never truncate a four-part version.
export function validateMacBundleVersions(shortVersion, buildVersion) {
  const integer = '(?:0|[1-9][0-9]*)'
  if (typeof shortVersion !== 'string' || !new RegExp(`^${integer}\\.${integer}\\.${integer}$`).test(shortVersion)) {
    throw new Error('INVALID_MAC_SHORT_VERSION: --short-version requires three integer components')
  }
  if (typeof buildVersion !== 'string' || !new RegExp(`^${integer}(?:\\.${integer}){0,2}$`).test(buildVersion)) {
    throw new Error('INVALID_MAC_BUILD_VERSION: --build-version requires one to three integer components')
  }
  if ([shortVersion, buildVersion].some(value => value.length > 64 || value.split('.').some(part => !Number.isSafeInteger(Number(part))))) {
    throw new Error('INVALID_MAC_BUNDLE_VERSION_RANGE')
  }
  return { shortVersion, buildVersion }
}

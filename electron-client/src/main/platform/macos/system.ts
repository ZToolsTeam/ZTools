import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import type { SystemPlatformAdapter } from '../system.js'
import { getRuntimeCapabilityTarget } from '../runtime-capability-target.js'

export function createMacosSystemPlatformAdapter(
  userDataPath: string,
  getProductVersion: () => string = () => process.getSystemVersion()
): SystemPlatformAdapter {
  return {
    userDataPath,
    getRuntimeTarget: () => getRuntimeCapabilityTarget('darwin', process.arch),
    getProductVersion,
    async getNativeId() {
      throw new ZToolsError(errorCodes.notSupported, 'macOS does not expose the Windows volume serial number')
    }
  }
}

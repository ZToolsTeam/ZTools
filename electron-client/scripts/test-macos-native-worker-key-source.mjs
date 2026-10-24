import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMacNativeWorkerKeySourceContracts } from './lib/macos-native-worker-key-contract.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
console.log(JSON.stringify(runMacNativeWorkerKeySourceContracts(root)))

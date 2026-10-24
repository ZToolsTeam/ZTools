import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const schemaPath = path.resolve(__dirname, '../plugin.schema.json')

export const pluginSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))

export * from './validator.js'
export * from './host-requirements.js'

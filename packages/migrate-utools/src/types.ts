/**
 * types.ts
 * Type definitions for @ztools/migrate
 */

export type CompatTierCode =
  | 'TIER_1_PURE_FRONTEND'
  | 'TIER_2_MANIFEST_ONLY'
  | 'TIER_3_SYNC_ADAPT'
  | 'TIER_4_NODE_BRIDGE'
  | 'TIER_5_NATIVE_BLOCKED'

export interface CompatTier {
  code: CompatTierCode
  title: string
  color: string
  level: number
  description: string
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface RiskItem {
  level: RiskLevel
  message: string
  remedy?: string
}

export interface ApiUsageItem {
  api: string
  category: string
  isSync: boolean
  ztoolsCounterpart: string
  count: number
  locations: Array<{ file: string; line: number }>
}

export interface NodeUsageItem {
  module: string
  count: number
  locations: Array<{ file: string; line: number }>
}

export interface NativeModuleItem {
  package: string
  type: 'binary_node' | 'c_cpp_package'
  locations: Array<{ file: string; line?: number }>
}

export interface ScanResult {
  manifest: {
    valid: boolean
    errors: string[]
    warnings: string[]
    raw: Record<string, any> | null
    name?: string
    version?: string
    main?: string
    preload?: string
    mode: 'standard-web' | 'template-list' | 'template-select' | 'template-doc' | 'unknown'
    featuresCount: number
    cmdsCount: number
  }
  apiUsage: {
    totalCalls: number
    uniqueApisCount: number
    coveredApisCount: number
    uncoveredApisCount: number
    coveragePercent: number
    details: ApiUsageItem[]
  }
  nodeUsage: {
    totalCount: number
    modules: NodeUsageItem[]
  }
  nativeUsage: {
    hasHeavyNative: boolean
    modules: NativeModuleItem[]
  }
  syncCalls: {
    hasSyncDb: boolean
    hasSyncNode: boolean
    hasSyncDialog: boolean
    totalSyncCount: number
  }
  servicesScan: {
    hasCustomServices: boolean
    hasWindowExports: boolean
    servicesMethods: string[]
    rendererCalls: string[]
  }
  readinessScore: number
  tier: CompatTier
  risks: RiskItem[]
}

export interface TriggerItem {
  type: string
  featureCode: string
  keyword?: string
  label?: string
  pattern?: string
  minLength?: number
  maxLength?: number
  exclude?: string[]
  fileType?: string
  extensions?: string[]
  match?: any
  raw?: any
}

export interface NormalizedManifest {
  id: string
  name: string
  version: string
  description: string
  category: string[]
  author: string
  entry: string
  icon: string
  targets?: Array<{
    id: string
    platform: string
    runtime: string
    arch: string
  }>
  nativeComponents?: any[]
  features: Array<{ code: string; explain: string }>
  triggers?: TriggerItem[]
  platforms?: string[]
  window?: {
    width: number
    height: number
    minWidth: number
    minHeight: number
    resizable: boolean
    singleInstance: boolean
    controls: {
      minimize: boolean
      maximize: boolean
    }
  }
  keywords?: string[]
  keyword?: string
  preload?: string
  [key: string]: any
}

export type OperationType = 'CREATE' | 'MODIFY' | 'DELETE' | 'RETAIN'

export interface MigrationOperation {
  type: OperationType
  relativePath: string
  sourcePath: string | null
  targetPath: string
  sourceHash: string | null
  targetHash: string | null
  targetContent: string | Buffer | null
  lineEnding?: 'CRLF' | 'LF' | 'UNKNOWN'
  reason: string
}

export interface MigrationPlan {
  planId: string
  timestamp: string
  sourceDir: string
  targetDir: string
  backupDir: string | null
  isDryRun: boolean
  dirtyWarning: string | null
  operations: MigrationOperation[]
  summary: {
    total: number
    create: number
    modify: number
    delete: number
    retain: number
  }
}

export interface UndoLogItem {
  type: 'DELETE_CREATED' | 'RESTORE_ORIGINAL'
  filePath: string
  content?: Buffer | string
}

export interface RollbackResult {
  restoredCount: number
  deletedCount: number
  totalReverted: number
}

export interface TransactionResult {
  success: boolean
  committed: boolean
  isDryRun: boolean
  plan: MigrationPlan
  backupPath: string | null
  appliedCount: number
  undoLog?: UndoLogItem[]
}

export interface CliOptions {
  sourceDir: string
  targetDir?: string
  dryRun?: boolean
  analyzeOnly?: boolean
  rollback?: boolean
  allowDirty?: boolean
  pluginId?: string
  json?: boolean
}

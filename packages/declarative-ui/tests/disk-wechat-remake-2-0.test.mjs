import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  renderDeclarativeRoot,
  DiskAnalyzerCommand,
  WechatCleanerCommand,
  QQCleanerCommand
} from '../dist/index.js'
import {
  OFFICIAL_FILE_TYPE_GROUPS,
  classifyFileExtension,
  computeExtStats,
  computeGroupStats,
  fetchDiskAnalysisSnapshot,
  deleteDiskFileItem,
  batchDeleteDiskFileItems,
  validateInvocationPayload as validateDiskPayload,
  invokeNativeCapability as invokeDiskNative
} from '../dist/examples/disk-analyzer/logic.js'
import {
  OFFICIAL_WECHAT_OWNER_RULES,
  classifyWechatFilePath,
  fetchWechatCleanSnapshot,
  executeWechatCleanup,
  validateInvocationPayload as validateWechatPayload,
  invokeNativeCapability as invokeWechatNative
} from '../dist/examples/wechat-cleaner/logic.js'
import {
  OFFICIAL_QQ_GROUP_RULES,
  classifyQQFilePath,
  fetchQQCleanSnapshot,
  executeQQCleanup,
  validateInvocationPayload as validateQQPayload,
  invokeNativeCapability as invokeQQNative
} from '../dist/examples/qq-cleaner/logic.js'

describe('Declarative UI 2.0 深度复刻集成与破坏性异常测试: DiskAnalyzer, WechatCleaner & QQCleaner', () => {
  describe('1. DiskAnalyzer (磁盘文件空间分析 1:1 复刻)', () => {
    it('1.1 [Happy Path] 10 大官方 FileTypeGroup (1~9, 99) 规则完备且分类精确', () => {
      assert.equal(OFFICIAL_FILE_TYPE_GROUPS.length, 10)
      const ids = OFFICIAL_FILE_TYPE_GROUPS.map(g => g.groupId)
      assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7, 8, 9, 99])

      assert.equal(classifyFileExtension('C:\\Videos\\demo.mp4').groupId, 1)
      assert.equal(classifyFileExtension('C:\\Music\\song.flac').groupId, 2)
      assert.equal(classifyFileExtension('C:\\Pictures\\design.psd').groupId, 3)
      assert.equal(classifyFileExtension('C:\\Docs\\spec.pdf').groupId, 4)
      assert.equal(classifyFileExtension('C:\\Downloads\\ubuntu.iso').groupId, 5)
      assert.equal(classifyFileExtension('C:\\Downloads\\setup.exe').groupId, 6)
      assert.equal(classifyFileExtension('E:\\ZTools\\index.ts').groupId, 7)
      assert.equal(classifyFileExtension('C:\\Windows\\System32\\kernel32.dll').groupId, 8)
      assert.equal(classifyFileExtension('D:\\Data\\msg.sqlite3').groupId, 9)
      assert.equal(classifyFileExtension('C:\\Temp\\unknown.xyz123').groupId, 99)
    })

    it('1.2 [Integration] fetchDiskAnalysisSnapshot 端到端链路聚合分区、10 大分类占比与二级扩展名排行', async () => {
      const mockHost = {
        system_get_disk_usage: async ({ drive }) => {
          if (drive === 'C:\\') {
            return {
              success: true,
              data: { total: 200 * 1024 ** 3, used: 180 * 1024 ** 3, available: 20 * 1024 ** 3, percent: 90 }
            }
          }
          if (drive === 'D:\\') {
            return {
              success: true,
              data: { total: 500 * 1024 ** 3, used: 250 * 1024 ** 3, available: 250 * 1024 ** 3, percent: 50 }
            }
          }
          return { success: false, error: 'DRIVE_NOT_MOUNTED' }
        },
        system_get_path: async ({ name }) => ({
          success: true,
          data: { path: `C:\\Users\\Geek\\${name}` }
        }),
        system_search_files: async ({ query }) => {
          if (String(query).includes('downloads')) {
            return {
              success: true,
              data: {
                files: [
                  { name: 'movie.mp4', path: 'C:\\Users\\Geek\\downloads\\movie.mp4', is_dir: false, size: 500 * 1024 * 1024, mtime: 1710000000 },
                  { name: 'installer.exe', path: 'C:\\Users\\Geek\\downloads\\installer.exe', is_dir: false, size: 120 * 1024 * 1024, mtime: 1710000100 },
                  { name: 'archive.7z', path: 'D:\\Backup\\archive.7z', is_dir: false, size: 300 * 1024 * 1024, mtime: 1710000200 }
                ],
                total_matches: 3,
                total_bytes: 920 * 1024 * 1024
              }
            }
          }
          return { success: true, data: { files: [], total_matches: 0, total_bytes: 0 } }
        }
      }

      const snap = await fetchDiskAnalysisSnapshot(mockHost)
      assert.equal(snap.drives.length, 2)
      assert.equal(snap.drives[0].drive, 'C:')
      assert.equal(snap.drives[0].status, 'danger')
      assert.equal(snap.files.length, 3)
      assert.equal(snap.groupStats.length, 10)

      const videoGroup = snap.groupStats.find(g => g.groupId === 1)
      assert.ok(videoGroup)
      assert.equal(videoGroup.fileCount, 1)
      assert.equal(videoGroup.totalSizeBytes, 500 * 1024 * 1024)
      assert.equal(videoGroup.topExtensions[0].extension, '.mp4')
    })

    it('1.3 [Declarative UI 2.0 复合描述符] DiskAnalyzerCommand 渲染 MetricGrid + DistributionBar + FilterBar + 左导航树 + 右可勾选文件列表 (subList)', () => {
      const root = renderDeclarativeRoot(DiskAnalyzerCommand)
      const desc = root.getLatest()
      assert.equal(desc.type, 'List')
      assert.ok(desc.props.metricGrid, '应包含顶部 4 宫格 MetricGrid')
      assert.ok(desc.props.distributionBar, '应包含 10 大官方分类彩色分段条 distributionBar')
      assert.equal(desc.props.distributionBar.segments.length > 0, true)
      assert.ok(desc.props.filterBar, '应包含多维筛选与批量操作栏 filterBar')
      assert.equal(desc.props.filterBar.groups.length, 3, '应包含 盘符 / 10大类型 / 二级后缀 3 组筛选器')
      assert.ok(desc.props.subList, '应包含方案 2 右侧可勾选大文件列表 subList')
      assert.equal(desc.props.subList.items.length > 0, true, '右侧大文件列表应包含可清理大文件条目')
      const firstSubItem = desc.props.subList.items[0]
      assert.ok(
        firstSubItem.props.accessories.some(acc => acc.progress !== undefined),
        '右侧大文件列表行应包含体积占比进度条 progress'
      )
      assert.equal(typeof firstSubItem.props.onToggleCheck, 'function', '右侧可清理大文件应支持勾选框 onToggleCheck')
      root.unmount()
    })

    it('1.4 [Beyond Happy Path 安全与异常测试] 拦截系统目录删除、空路径、越界参数与部分失败回退', async () => {
      // 1) 拦截系统核心目录与引导文件
      const sysRes = await deleteDiskFileItem('C:\\Windows\\System32\\ntoskrnl.exe')
      assert.equal(sysRes.ok, false)
      assert.match(sysRes.error || '', /系统核心目录/)

      const mftRes = await deleteDiskFileItem('C:\\Program Files\\Windows NT\\Accessories\\wordpad.exe')
      assert.equal(mftRes.ok, false)

      const emptyRes = await deleteDiskFileItem('')
      assert.equal(emptyRes.ok, false)

      // 2) 批量清理中部分受保护、部分正常移入回收站
      const trashed = []
      const mockTrashHost = {
        shell_trash_item: async ({ fullPath }) => {
          if (fullPath.includes('locked.mp4')) {
            return { success: false, error: 'EBUSY: file locked by another process' }
          }
          trashed.push(fullPath)
          return { success: true, data: { trashed: true } }
        }
      }

      const batchRes = await batchDeleteDiskFileItems(
        [
          'C:\\Users\\Geek\\Downloads\\ok1.mp4',
          'C:\\Windows\\System32\\cmd.exe',
          'C:\\Users\\Geek\\Downloads\\locked.mp4'
        ],
        mockTrashHost
      )
      assert.deepEqual(batchRes.succeeded, ['C:\\Users\\Geek\\Downloads\\ok1.mp4'])
      assert.equal(batchRes.failed.length, 2)

      // 3) 畸形 DLL 响应异常断言
      await assert.rejects(
        () =>
          invokeDiskNative('GetGroupFiles', { groupId: 1 }, {
            dllplugin: {
              call: async () => '{corrupted_json_payload'
            }
          }),
        /MALFORMED_DLL_RESPONSE/
      )
      assert.equal(validateDiskPayload('', {}).valid, false)
      assert.equal(validateDiskPayload('GetGroupFiles', null).valid, false)
    })
  })

  describe('2. WechatCleaner (微信专项深度清理 1:1 复刻)', () => {
    it('2.1 [Happy Path] 9 大官方 Owner (107~115) 规则与 Owner 999 聊天数据库硬件级锁定完备', () => {
      assert.equal(OFFICIAL_WECHAT_OWNER_RULES.length, 10)
      const ownerIds = OFFICIAL_WECHAT_OWNER_RULES.map(r => r.ownerId)
      assert.deepEqual(ownerIds, [107, 115, 113, 112, 111, 114, 109, 108, 110, 999])

      const knownAccounts = ['liaoguobo_7f67', 'wxid_geek001']

      // 聊天核心数据库必须强制归入 999 且 isProtected === true
      const dbCls = classifyWechatFilePath(
        'C:\\Users\\hopob\\Documents\\xwechat_files\\liaoguobo_7f67\\db_storage\\message\\message_0.db',
        knownAccounts
      )
      assert.equal(dbCls.ownerId, 999)
      assert.equal(dbCls.isProtected, true)
      assert.equal(dbCls.accountId, 'liaoguobo_7f67')

      // 朋友圈缓存 -> 107
      const snsCls = classifyWechatFilePath(
        'D:\\Local\\Roaming\\Tencent\\xwechat\\radium\\web\\profiles\\sns_cache.data',
        knownAccounts
      )
      assert.equal(snsCls.ownerId, 107)
      assert.equal(snsCls.isProtected, false)

      // 小程序与 XPlugin -> 115
      const xplugCls = classifyWechatFilePath(
        'C:\\Users\\hopob\\AppData\\Roaming\\Tencent\\xwechat\\xplugin\\Plugins\\WeChatAppEx\\8555\\WeChatAppEx.exe',
        knownAccounts
      )
      assert.equal(xplugCls.ownerId, 115)

      // XLog 运行跟踪日志 -> 113
      const logCls = classifyWechatFilePath(
        'C:\\Users\\hopob\\AppData\\Roaming\\Tencent\\xwechat\\log\\mm_20261015.xlog',
        knownAccounts
      )
      assert.equal(logCls.ownerId, 113)
    })

    it('2.2 [Integration] fetchWechatCleanSnapshot 端到端多账号识别、9大专项聚合与符号链接去重', async () => {
      const mockHost = {
        system_get_path: async ({ name }) => {
          const map = {
            documents: 'C:\\Users\\hopob\\Documents',
            appData: 'C:\\Users\\hopob\\AppData\\Roaming',
            temp: 'C:\\Users\\hopob\\AppData\\Local\\Temp'
          }
          return { success: true, data: { path: map[name] || '' } }
        },
        system_get_disk_usage: async () => ({
          success: true,
          data: { total: 168 * 1024 ** 3, used: 159 * 1024 ** 3, available: 9 * 1024 ** 3, percent: 95 }
        }),
        system_search_files: async ({ query }) => {
          const q = String(query)
          if (q.includes('xwechat_files')) {
            return {
              success: true,
              data: {
                files: [
                  {
                    name: 'message_0.db',
                    path: 'C:\\Users\\hopob\\Documents\\xwechat_files\\liaoguobo_7f67\\db_storage\\message\\message_0.db',
                    is_dir: false,
                    size: 25 * 1024 * 1024,
                    mtime: 1710000000
                  },
                  {
                    name: 'sticker.gif',
                    path: 'C:\\Users\\hopob\\Documents\\xwechat_files\\liaoguobo_7f67\\resource\\emoticon\\sticker.gif',
                    is_dir: false,
                    size: 5 * 1024 * 1024,
                    mtime: 1700000000
                  },
                  {
                    name: 'chat_video.mp4',
                    path: 'C:\\Users\\hopob\\Documents\\xwechat_files\\wxid_second\\msg\\video\\chat_video.mp4',
                    is_dir: false,
                    size: 80 * 1024 * 1024,
                    mtime: 1690000000
                  }
                ],
                total_matches: 3,
                total_bytes: 110 * 1024 * 1024,
                subdirs: [
                  { name: 'liaoguobo_7f67', path: 'C:\\Users\\hopob\\Documents\\xwechat_files\\liaoguobo_7f67', fileCount: 2, totalBytes: 30 * 1024 * 1024 },
                  { name: 'wxid_second', path: 'C:\\Users\\hopob\\Documents\\xwechat_files\\wxid_second', fileCount: 1, totalBytes: 80 * 1024 * 1024 }
                ]
              }
            }
          }
          return { success: true, data: { files: [], total_matches: 0, total_bytes: 0, subdirs: [] } }
        }
      }

      const snap = await fetchWechatCleanSnapshot(mockHost)
      assert.ok(snap.detectedAccounts.includes('liaoguobo_7f67'))
      assert.ok(snap.detectedAccounts.includes('wxid_second'))
      assert.equal(snap.protectedDbBytes, 25 * 1024 * 1024)
      assert.equal(snap.totalScannableBytes, 85 * 1024 * 1024)

      const dbCat = snap.categories.find(c => c.ownerId === 999)
      assert.ok(dbCat)
      assert.equal(dbCat.checked, false, '核心聊天数据库分类严禁默认勾选')
      assert.equal(dbCat.safetyLevel, 'protected')
    })

    it('2.3 [Declarative UI 2.0 复合描述符] WechatCleanerCommand 渲染 4 步向导 + 9 大专项分布条 + 账号/时间筛选器', () => {
      const root = renderDeclarativeRoot(WechatCleanerCommand)
      const desc = root.getLatest()
      assert.equal(desc.type, 'List')
      assert.ok(desc.props.metricGrid, '应包含顶部 4 宫格 MetricGrid')
      assert.ok(desc.props.filterBar, '应包含向导步骤与筛选工具栏 filterBar')
      assert.equal(desc.props.filterBar.wizardSteps.length, 4, '应包含 4 步清理向导状态条')
      assert.equal(desc.props.filterBar.groups.length, 3, '应包含 微信账号 / 时间范围 / 9大专项 3 组筛选器')
      root.unmount()
    })

    it('2.4 [Beyond Happy Path 安全防线测试] executeWechatCleanup 铁律拦截聊天记录数据库 (db_storage / MSG*.db)', async () => {
      const trashedPaths = []
      const mockTrashHost = {
        shell_trash_item: async ({ fullPath }) => {
          trashedPaths.push(fullPath)
          return { success: true, data: { trashed: true } }
        }
      }

      const res = await executeWechatCleanup(
        [
          'C:\\Users\\hopob\\Documents\\xwechat_files\\liaoguobo_7f67\\db_storage\\message\\message_0.db',
          'C:\\Users\\hopob\\Documents\\WeChat Files\\wxid_123\\Msg\\Multi\\MSG0.db',
          'C:\\Users\\hopob\\AppData\\Roaming\\Tencent\\xwechat\\log\\mm_20261015.xlog'
        ],
        mockTrashHost
      )

      // 两个核心数据库必须被安全防线拦截，仅 .xlog 被移入回收站
      assert.deepEqual(res.deletedPaths, [
        'C:\\Users\\hopob\\AppData\\Roaming\\Tencent\\xwechat\\log\\mm_20261015.xlog'
      ])
      assert.equal(res.skippedPaths.length, 2)
      assert.equal(trashedPaths.length, 1)

      // 校验参数防御
      assert.equal(validateWechatPayload('CleanWeChat', { path: 'C:\\xwechat_files\\u\\db_storage\\a.db' }).valid, false)
      await assert.rejects(
        () =>
          invokeWechatNative('ScanWeChat', {}, {
            dllplugin: {
              call: async () => '<<<invalid_json>>>'
            }
          }),
        /MALFORMED_DLL_RESPONSE/
      )
    })
  })

  describe('3. QQCleaner (QQ / NTQQ / TIM 专项深度清理 1:1 复刻)', () => {
    it('3.1 [Happy Path] 12 大官方 Group (201~213) 规则与 Group 999 聊天记录库锁定完备', () => {
      assert.equal(OFFICIAL_QQ_GROUP_RULES.length, 13)
      const groupIds = OFFICIAL_QQ_GROUP_RULES.map(r => r.groupId)
      assert.deepEqual(groupIds, [203, 201, 208, 202, 209, 211, 205, 206, 207, 212, 204, 213, 999])

      // Msg3.0.db 必须归入 999 且 isProtected === true
      const msgDb = classifyQQFilePath('C:\\Users\\hopob\\Documents\\Tencent Files\\19982507\\Msg3.0.db')
      assert.equal(msgDb.groupId, 999)
      assert.equal(msgDb.isProtected, true)
      assert.equal(msgDb.accountId, '19982507')

      // QQ.tlg.1 -> 203 日志
      const tlg = classifyQQFilePath('D:\\Local\\Roaming\\Tencent\\Logs\\QQ.tlg.1')
      assert.equal(tlg.groupId, 203)
      assert.equal(tlg.isProtected, false)

      // MiscHead.db -> 208 头像缓存
      const head = classifyQQFilePath('C:\\Users\\hopob\\Documents\\Tencent Files\\19982507\\MiscHead.db')
      assert.equal(head.groupId, 208)
      assert.equal(head.accountId, '19982507')

      // CustomFace.dbc -> 212 收藏表情
      const fav = classifyQQFilePath('C:\\Users\\hopob\\Documents\\Tencent Files\\19982507\\CustomFace.dbc')
      assert.equal(fav.groupId, 212)
    })

    it('3.2 [Integration] fetchQQCleanSnapshot 端到端多 UIN 账号识别与 12 大分组汇总', async () => {
      const mockHost = {
        system_get_path: async ({ name }) => {
          const map = {
            documents: 'C:\\Users\\hopob\\Documents',
            appData: 'C:\\Users\\hopob\\AppData\\Roaming',
            home: 'C:\\Users\\hopob',
            temp: 'C:\\Users\\hopob\\AppData\\Local\\Temp'
          }
          return { success: true, data: { path: map[name] || '' } }
        },
        system_get_disk_usage: async () => ({
          success: true,
          data: { total: 168 * 1024 ** 3, used: 159 * 1024 ** 3, available: 9 * 1024 ** 3, percent: 95 }
        }),
        system_search_files: async ({ query }) => {
          const q = String(query)
          if (q.includes('Tencent Files')) {
            return {
              success: true,
              data: {
                files: [
                  {
                    name: 'Msg3.0.db',
                    path: 'C:\\Users\\hopob\\Documents\\Tencent Files\\19982507\\Msg3.0.db',
                    is_dir: false,
                    size: 10 * 1024 * 1024,
                    mtime: 1710000000
                  },
                  {
                    name: 'MiscHead.db',
                    path: 'C:\\Users\\hopob\\Documents\\Tencent Files\\19982507\\MiscHead.db',
                    is_dir: false,
                    size: 20 * 1024 * 1024,
                    mtime: 1710000000
                  }
                ],
                total_matches: 2,
                total_bytes: 30 * 1024 * 1024,
                subdirs: [
                  { name: '19982507', path: 'C:\\Users\\hopob\\Documents\\Tencent Files\\19982507', fileCount: 2, totalBytes: 30 * 1024 * 1024 }
                ]
              }
            }
          }
          if (q.includes('\\Tencent\\Logs')) {
            return {
              success: true,
              data: {
                files: [
                  {
                    name: 'QQ.tlg.1',
                    path: 'C:\\Users\\hopob\\AppData\\Roaming\\Tencent\\Logs\\QQ.tlg.1',
                    is_dir: false,
                    size: 105 * 1024 * 1024,
                    mtime: 1710000000
                  }
                ],
                total_matches: 1,
                total_bytes: 105 * 1024 * 1024,
                subdirs: []
              }
            }
          }
          return { success: true, data: { files: [], total_matches: 0, total_bytes: 0, subdirs: [] } }
        }
      }

      const snap = await fetchQQCleanSnapshot(mockHost)
      assert.ok(snap.detectedAccounts.includes('19982507'))
      assert.equal(snap.protectedDbBytes, 10 * 1024 * 1024)
      assert.equal(snap.totalScannableBytes, 125 * 1024 * 1024)
    })

    it('3.3 [Declarative UI 2.0 复合描述符] QQCleanerCommand 渲染 4 步向导 + 12 大分组分布条 + UIN/时间筛选器', () => {
      const root = renderDeclarativeRoot(QQCleanerCommand)
      const desc = root.getLatest()
      assert.equal(desc.type, 'List')
      assert.ok(desc.props.metricGrid, '应包含顶部 4 宫格 MetricGrid')
      assert.ok(desc.props.distributionBar, '应包含 12 大专项分布条 distributionBar')
      assert.ok(desc.props.filterBar, '应包含向导步骤与筛选工具栏 filterBar')
      assert.equal(desc.props.filterBar.wizardSteps.length, 4)
      assert.equal(desc.props.filterBar.groups.length, 3)
      root.unmount()
    })

    it('3.4 [Beyond Happy Path 安全防线测试] executeQQCleanup 铁律拦截 Msg3.0.db / nt_msg.db / Registry.db', async () => {
      const trashedPaths = []
      const mockTrashHost = {
        shell_trash_item: async ({ fullPath }) => {
          trashedPaths.push(fullPath)
          return { success: true, data: { trashed: true } }
        }
      }

      const res = await executeQQCleanup(
        [
          'C:\\Users\\hopob\\Documents\\Tencent Files\\19982507\\Msg3.0.db',
          'C:\\Users\\hopob\\Documents\\Tencent Files\\19982507\\Registry.db',
          'C:\\Users\\hopob\\AppData\\Roaming\\Tencent\\Logs\\QQ.tlg.1'
        ],
        mockTrashHost
      )

      assert.deepEqual(res.deletedPaths, [
        'C:\\Users\\hopob\\AppData\\Roaming\\Tencent\\Logs\\QQ.tlg.1'
      ])
      assert.equal(res.skippedPaths.length, 2)
      assert.equal(validateQQPayload('CleanQQ', { path: 'C:\\Tencent Files\\19982507\\Msg3.0.db' }).valid, false)
    })
  })
})


import path from 'node:path'

export const QUICK_FOLDERS_PLUGIN_ID = 'quick-folders'
export const QUICK_FOLDERS_DOCUMENT_IDS = Object.freeze({
  favorites: 'favorite-folders',
  customizations: 'folder-customizations'
})
export const QUICK_FOLDERS_POWER_SHELL_PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
export const QUICK_FOLDERS_MAIN_STATE_KEY = '__ztoolsP031QuickFoldersMainGuard__'
export const QUICK_FOLDERS_DIALOG_TITLE = '选择要收藏的文件夹'
export const QUICK_FOLDERS_DIALOG_PROPERTIES = Object.freeze(['openDirectory', 'createDirectory'])

export const QUICK_FOLDERS_NORMAL_APP_MATRIX = Object.freeze({
  install: 'PUBLIC_PLUGIN_INSTALL_FROM_FRESH_ZIP',
  open: 'PUBLIC_PLUGIN_OPEN_ZTOOLS_PLUGIN_PAGE',
  initialReadFailure: 'ONE_EXACT_FAVORITE_DOCUMENT_QUERY_FAILURE_THEN_UI_RETRY',
  systemRecords: 'NOT_RUN_PROCESS_START_BLOCKED_BEFORE_SPAWN',
  favoriteCreation: 'SYNTHETIC_MAIN_DIALOG_RESULT_AND_PUBLIC_DATABASE_PUT',
  customization: 'TRUSTED_CONTEXT_MENU_INPUT_AND_PUBLIC_DATABASE_PUT',
  persistence: 'CLOSE_REOPEN_AND_SAME_PROFILE_APP_RESTART',
  nativeFolderDialogUi: 'NOT_RUN_MAIN_ONLY_SYNTHETIC_RESULT',
  macOSDeviceExecution: 'NOT_RUN'
})

export function isQuickFoldersCaller(caller) {
  return caller?.type === 'plugin' && caller.pluginId === 'quick-folders'
}

export function isQuickFoldersPluginUrl(url) {
  return typeof url === 'string' && url.startsWith('ztools://plugins/quick-folders/')
}

export function inspectQuickFoldersCaller(caller, electron) {
  if (!isQuickFoldersCaller(caller)) return { status: 'OTHER' }
  if (!Number.isSafeInteger(caller.webContentsId) || caller.webContentsId < 1) return { status: 'UNVERIFIED' }
  try {
    const contents = electron?.webContents?.fromId?.(caller.webContentsId)
    if (!contents || contents.isDestroyed?.()) return { status: 'UNVERIFIED' }
    const url = contents.getURL?.()
    return isQuickFoldersPluginUrl(url) ? { status: 'QUICK_FOLDERS', url } : { status: 'UNVERIFIED' }
  } catch {
    return { status: 'UNVERIFIED' }
  }
}

export function matchesFavoriteDocumentQuery(params) {
  return params?.plugin_id === 'quick-folders' && params.prefix === 'favorite-folders'
}

export function classifyFavoriteReadFailure(callerStatus, params, failureArmed) {
  if (callerStatus === 'OTHER') return 'DELEGATE'
  if (callerStatus !== 'QUICK_FOLDERS') return 'REJECT_UNVERIFIED_CALLER'
  if (!matchesFavoriteDocumentQuery(params)) return 'DELEGATE'
  return failureArmed ? 'INJECT_ONE_FAILURE' : 'DELEGATE'
}

export function advanceFavoriteReadFailure(state, callerStatus, params) {
  const decision = classifyFavoriteReadFailure(callerStatus, params, state.favoriteFailureState === 'ARMED')
  if (decision === 'INJECT_ONE_FAILURE') {
    state.favoriteFailureState = 'CONSUMED'
    state.favoriteFailureInjectedCount += 1
  }
  if (decision === 'REJECT_UNVERIFIED_CALLER') state.unverifiedQuickFoldersCallCount += 1
  return decision
}

export function normalizeWindowsExecutable(value) {
  return typeof value === 'string'
    ? value.replaceAll('/', '\\').replace(/\\+$/, '').toLocaleLowerCase('en-US')
    : ''
}

export function classifyQuickFoldersPowerShellRequest(params, expectedExecutable, expectedTempPath, pathApi = path.win32) {
  const executableMatched = normalizeWindowsExecutable(params?.path) === normalizeWindowsExecutable(expectedExecutable)
  const switches = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']
  const args = params?.args
  const argsMatched = Array.isArray(args) && args.length === switches.length + 1 &&
    switches.every((value, index) => args[index] === value) && typeof args[switches.length] === 'string' &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(args[switches.length])
  if (!executableMatched || params?.show !== false || !argsMatched) {
    return { status: 'UNEXPECTED_QUICK_FOLDERS_PROCESS', executableMatched, argsMatched, outputInsideProfileTemp: false,
      readsWindowsRecent: false, readsTypedPaths: false, readsQuickAccess: false }
  }

  let script = ''
  try {
    const bytes = Buffer.from(args[switches.length], 'base64')
    if (bytes.length === 0 || bytes.length > 64 * 1024 || bytes.length % 2 !== 0 ||
        bytes.toString('base64').replace(/=+$/, '') !== args[switches.length].replace(/=+$/, '')) {
      throw new Error('INVALID_POWERSHELL_PAYLOAD')
    }
    script = bytes.toString('utf16le')
  } catch {
    return { status: 'UNEXPECTED_QUICK_FOLDERS_PROCESS', executableMatched, argsMatched, outputInsideProfileTemp: false,
      readsWindowsRecent: false, readsTypedPaths: false, readsQuickAccess: false }
  }

  const outputMatch = /\$outputPath\s*=\s*'((?:[^']|'')*)'/i.exec(script)
  let outputInsideProfileTemp = false
  if (outputMatch && typeof expectedTempPath === 'string' && pathApi.isAbsolute(expectedTempPath)) {
    const outputPath = outputMatch[1].replace(/''/g, "'")
    if (pathApi.isAbsolute(outputPath)) {
      const root = pathApi.resolve(expectedTempPath)
      const resolved = pathApi.resolve(outputPath)
      const relative = pathApi.relative(root, resolved)
      outputInsideProfileTemp = relative !== '' && !pathApi.isAbsolute(relative) &&
        relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && pathApi.dirname(resolved) === root &&
        /^quick-folders-[0-9]+-[a-z0-9]{1,12}\.json$/i.test(pathApi.basename(resolved))
    }
  }

  const readsWindowsRecent = script.includes("[Environment]::GetFolderPath('Recent')")
  const readsTypedPaths = script.includes('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\TypedPaths')
  const readsQuickAccess = script.includes("New-Object -ComObject Shell.Application") && script.includes("shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}")
  const expected = outputInsideProfileTemp && readsWindowsRecent && readsTypedPaths && readsQuickAccess
  return { status: expected ? 'EXPECTED_BLOCKED_SYSTEM_RECORD_READ' : 'UNEXPECTED_QUICK_FOLDERS_PROCESS',
    executableMatched, argsMatched, outputInsideProfileTemp, readsWindowsRecent, readsTypedPaths, readsQuickAccess }
}

export function classifyQuickFoldersFolderDialog(ownerUrl, options, syntheticFolderPath, outputRoot, pathApi = path.win32) {
  if (!isQuickFoldersPluginUrl(ownerUrl)) return 'NON_QUICK_FOLDERS_DIALOG'
  const properties = options?.properties
  const propertiesMatched = Array.isArray(properties) && properties.length === QUICK_FOLDERS_DIALOG_PROPERTIES.length &&
    properties.every((value, index) => value === QUICK_FOLDERS_DIALOG_PROPERTIES[index])
  const allowedKeys = options && typeof options === 'object' && !Array.isArray(options)
    ? Object.keys(options).every(key => key === 'title' || key === 'properties')
    : false
  if (options?.title !== QUICK_FOLDERS_DIALOG_TITLE || !propertiesMatched || !allowedKeys ||
      !pathApi.isAbsolute(syntheticFolderPath) || !pathApi.isAbsolute(outputRoot)) return 'REJECT_UNEXPECTED_DIALOG'
  const root = pathApi.resolve(outputRoot)
  const target = pathApi.resolve(syntheticFolderPath)
  const relative = pathApi.relative(root, target)
  if (!relative || pathApi.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${pathApi.sep}`)) {
    return 'REJECT_UNEXPECTED_DIALOG'
  }
  return 'RETURN_SYNTHETIC_DIRECTORY'
}

export function advanceFolderDialog(state, ownerUrl, options, config, pathApi = path.win32) {
  const decision = classifyQuickFoldersFolderDialog(ownerUrl, options, config.syntheticFolderPath, config.outputRoot, pathApi)
  if (decision === 'NON_QUICK_FOLDERS_DIALOG') {
    state.unscopedDialogBlockedCount += 1
    return 'BLOCK_UNSCOPED_DIALOG'
  }
  state.folderDialogAttemptCount += 1
  if (decision !== 'RETURN_SYNTHETIC_DIRECTORY') {
    state.unexpectedFolderDialogCount += 1
    return 'BLOCK_INVALID_DIALOG'
  }
  if (state.folderDialogState !== 'ARMED') {
    state.unexpectedFolderDialogCount += 1
    return 'BLOCK_REPEAT_DIALOG'
  }
  state.folderDialogState = 'CONSUMED'
  state.folderDialogAcceptedCount += 1
  return 'RETURN_SYNTHETIC_DIRECTORY'
}

const embeddedHelpers = [
  isQuickFoldersCaller,
  isQuickFoldersPluginUrl,
  inspectQuickFoldersCaller,
  matchesFavoriteDocumentQuery,
  classifyFavoriteReadFailure,
  advanceFavoriteReadFailure,
  normalizeWindowsExecutable,
  classifyQuickFoldersPowerShellRequest,
  classifyQuickFoldersFolderDialog,
  advanceFolderDialog
]

function requireAbsoluteConfigPath(value, key) {
  if (typeof value !== 'string' || !path.win32.isAbsolute(value)) throw new Error(`QUICK_FOLDERS_${key.toUpperCase()}_ABSOLUTE_PATH_REQUIRED`)
  return value
}

export function buildQuickFoldersMainGuardInstallExpression(options) {
  const config = {
    token: typeof options?.token === 'string' && /^[0-9a-f-]{36}$/i.test(options.token) ? options.token : null,
    outputRoot: requireAbsoluteConfigPath(options?.outputRoot, 'output_root'),
    syntheticFolderPath: requireAbsoluteConfigPath(options?.syntheticFolderPath, 'synthetic_folder'),
    expectedTempPath: requireAbsoluteConfigPath(options?.expectedTempPath, 'temp'),
    injectFavoriteFailure: options?.injectFavoriteFailure === true,
    allowOneFolderDialog: options?.allowOneFolderDialog === true
  }
  if (!config.token) throw new Error('QUICK_FOLDERS_MAIN_GUARD_TOKEN_REQUIRED')
  if (classifyQuickFoldersFolderDialog('ztools://plugins/quick-folders/index.html', {
    title: QUICK_FOLDERS_DIALOG_TITLE, properties: [...QUICK_FOLDERS_DIALOG_PROPERTIES]
  }, config.syntheticFolderPath, config.outputRoot, path.win32) !== 'RETURN_SYNTHETIC_DIRECTORY') {
    throw new Error('QUICK_FOLDERS_SYNTHETIC_DIRECTORY_OUTSIDE_OUTPUT_ROOT')
  }
  const helperSource = embeddedHelpers.map(helper => helper.toString()).join('\n')
  return `(() => {
    const mainModule = process.mainModule;
    if (!mainModule || typeof mainModule.require !== 'function') throw new Error('MAIN_MODULE_REQUIRE_UNAVAILABLE');
    const requireMain = mainModule.require.bind(mainModule);
    const electron = requireMain('electron');
    const pathApi = requireMain('node:path').win32;
    const fs = requireMain('node:fs');
    const config = ${JSON.stringify(config)};
    const QUICK_FOLDERS_DIALOG_TITLE = ${JSON.stringify(QUICK_FOLDERS_DIALOG_TITLE)};
    const QUICK_FOLDERS_DIALOG_PROPERTIES = ${JSON.stringify(QUICK_FOLDERS_DIALOG_PROPERTIES)};
    const stateKey = ${JSON.stringify(QUICK_FOLDERS_MAIN_STATE_KEY)};
    if (globalThis[stateKey]) throw new Error('QUICK_FOLDERS_MAIN_GUARD_ALREADY_INSTALLED');
    ${helperSource}
    const mainRoot = pathApi.join(electron.app.getAppPath(), 'out', 'main');
    const databaseModule = requireMain(pathApi.join(mainRoot, 'services', 'database-service.js'));
    const processModule = requireMain(pathApi.join(mainRoot, 'services', 'process-service.js'));
    if (typeof databaseModule?.DatabaseService !== 'function' || typeof databaseModule.DatabaseService.prototype?.query !== 'function' ||
        typeof processModule?.ProcessService !== 'function' || typeof processModule.ProcessService.prototype?.start !== 'function' ||
        typeof electron?.dialog?.showOpenDialog !== 'function') throw new Error('QUICK_FOLDERS_MAIN_GUARD_TARGET_UNAVAILABLE');
    const state = {
      token: config.token,
      favoriteFailureState: config.injectFavoriteFailure ? 'ARMED' : 'DISABLED',
      favoriteFailureInjectedCount: 0,
      unverifiedQuickFoldersCallCount: 0,
      blockedProcessCallCount: 0,
      expectedSystemReadBlockCount: 0,
      unexpectedQuickFoldersProcessCount: 0,
      unverifiedProcessCallerCount: 0,
      folderDialogState: config.allowOneFolderDialog ? 'ARMED' : 'DISABLED',
      folderDialogAttemptCount: 0,
      folderDialogAcceptedCount: 0,
      unexpectedFolderDialogCount: 0,
      unscopedDialogBlockedCount: 0,
      restored: false
    };
    function capture(object, key) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      const original = object[key];
      if (typeof original !== 'function' || (descriptor && !descriptor.configurable && descriptor.writable !== true) ||
          (!descriptor && !Object.isExtensible(object))) throw new Error('QUICK_FOLDERS_MAIN_GUARD_TARGET_NOT_PATCHABLE');
      return { object, key, descriptor, original, applied: false };
    }
    const patches = [
      capture(databaseModule.DatabaseService.prototype, 'query'),
      capture(processModule.ProcessService.prototype, 'start'),
      capture(electron.dialog, 'showOpenDialog')
    ];
    function applyPatch(record, replacement) {
      const descriptor = record.descriptor
        ? { ...record.descriptor, value: replacement }
        : { configurable: true, enumerable: true, writable: true, value: replacement };
      Object.defineProperty(record.object, record.key, descriptor);
      record.applied = true;
    }
    function restorePatch(record) {
      if (!record.applied) return true;
      try {
        if (record.descriptor) Object.defineProperty(record.object, record.key, record.descriptor);
        else delete record.object[record.key];
        record.applied = false;
        return record.object[record.key] === record.original;
      } catch { return false; }
    }
    try {
      applyPatch(patches[0], async function quickFoldersQuery(params, caller, signal) {
        const inspected = inspectQuickFoldersCaller(caller, electron);
        const decision = advanceFavoriteReadFailure(state, inspected.status, params);
        if (decision === 'REJECT_UNVERIFIED_CALLER') throw new Error('P031_QUICK_FOLDERS_DB_CALLER_UNVERIFIED');
        if (decision === 'INJECT_ONE_FAILURE') throw new Error('P031_SYNTHETIC_FAVORITE_DOCUMENT_READ_FAILURE');
        return Reflect.apply(patches[0].original, this, [params, caller, signal]);
      });
      applyPatch(patches[1], async function quickFoldersProcessStart(params, caller, signal) {
        const inspected = inspectQuickFoldersCaller(caller, electron);
        if (inspected.status === 'OTHER') return Reflect.apply(patches[1].original, this, [params, caller, signal]);
        state.blockedProcessCallCount += 1;
        if (inspected.status !== 'QUICK_FOLDERS') {
          state.unverifiedProcessCallerCount += 1;
          throw new Error('P031_QUICK_FOLDERS_PROCESS_CALLER_UNVERIFIED');
        }
        const classification = classifyQuickFoldersPowerShellRequest(params, ${JSON.stringify(QUICK_FOLDERS_POWER_SHELL_PATH)}, config.expectedTempPath, pathApi);
        if (classification.status === 'EXPECTED_BLOCKED_SYSTEM_RECORD_READ') state.expectedSystemReadBlockCount += 1;
        else state.unexpectedQuickFoldersProcessCount += 1;
        throw new Error('P031_QUICK_FOLDERS_SYSTEM_PROCESS_BLOCKED_BEFORE_SPAWN');
      });
      applyPatch(patches[2], async function quickFoldersDialogGuard(...args) {
        const owner = args.length >= 2 ? args[0] : null;
        let ownerUrl = '';
        try { ownerUrl = owner?.webContents?.getURL?.() ?? ''; } catch {}
        const options = args.length >= 2 ? args[1] : args[0];
        const decision = advanceFolderDialog(state, ownerUrl, options, config, pathApi);
        if (decision === 'RETURN_SYNTHETIC_DIRECTORY') {
          const stat = fs.lstatSync(config.syntheticFolderPath);
          const real = fs.realpathSync.native(config.syntheticFolderPath);
          const relative = pathApi.relative(pathApi.resolve(config.outputRoot), pathApi.resolve(real));
          if (!stat.isDirectory() || stat.isSymbolicLink() || pathApi.resolve(real) !== pathApi.resolve(config.syntheticFolderPath) ||
              !relative || pathApi.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + pathApi.sep)) {
            state.unexpectedFolderDialogCount += 1;
            throw new Error('P031_SYNTHETIC_FOLDER_IDENTITY_INVALID');
          }
          return { canceled: false, filePaths: [config.syntheticFolderPath] };
        }
        throw new Error(decision === 'BLOCK_UNSCOPED_DIALOG' ? 'P031_UNEXPECTED_NATIVE_DIALOG_BLOCKED' : 'P031_FOLDER_DIALOG_BLOCKED');
      });
      state.patches = patches;
      state.restorePatch = restorePatch;
      globalThis[stateKey] = state;
    } catch (error) {
      for (const record of [...patches].reverse()) restorePatch(record);
      throw error;
    }
    return { installed: true, token: config.token, methods: ['DatabaseService.query', 'ProcessService.start', 'dialog.showOpenDialog'],
      favoriteFailureState: state.favoriteFailureState, folderDialogState: state.folderDialogState };
  })()`
}

export function buildQuickFoldersMainGuardReportExpression(token) {
  if (typeof token !== 'string' || !/^[0-9a-f-]{36}$/i.test(token)) throw new Error('QUICK_FOLDERS_MAIN_GUARD_TOKEN_REQUIRED')
  return `(() => { const state = globalThis[${JSON.stringify(QUICK_FOLDERS_MAIN_STATE_KEY)}];
    if (!state || state.token !== ${JSON.stringify(token)}) throw new Error('QUICK_FOLDERS_MAIN_GUARD_NOT_INSTALLED');
    return { token: state.token, favoriteFailureState: state.favoriteFailureState,
      favoriteFailureInjectedCount: state.favoriteFailureInjectedCount, unverifiedQuickFoldersCallCount: state.unverifiedQuickFoldersCallCount,
      blockedProcessCallCount: state.blockedProcessCallCount, expectedSystemReadBlockCount: state.expectedSystemReadBlockCount,
      unexpectedQuickFoldersProcessCount: state.unexpectedQuickFoldersProcessCount, unverifiedProcessCallerCount: state.unverifiedProcessCallerCount,
      folderDialogState: state.folderDialogState, folderDialogAttemptCount: state.folderDialogAttemptCount,
      folderDialogAcceptedCount: state.folderDialogAcceptedCount, unexpectedFolderDialogCount: state.unexpectedFolderDialogCount,
      unscopedDialogBlockedCount: state.unscopedDialogBlockedCount, restored: state.restored === true }; })()`
}

export function buildQuickFoldersMainGuardRestoreExpression(token) {
  if (typeof token !== 'string' || !/^[0-9a-f-]{36}$/i.test(token)) throw new Error('QUICK_FOLDERS_MAIN_GUARD_TOKEN_REQUIRED')
  return `(() => { const key = ${JSON.stringify(QUICK_FOLDERS_MAIN_STATE_KEY)}; const state = globalThis[key];
    if (!state || state.token !== ${JSON.stringify(token)}) throw new Error('QUICK_FOLDERS_MAIN_GUARD_NOT_INSTALLED');
    if (state.restored) return { restored: true, alreadyRestored: true, methods: state.restoreResults };
    const results = [];
    for (const patch of [...state.patches].reverse()) results.push(Boolean(state.restorePatch(patch)));
    state.restoreResults = results; state.restored = results.every(Boolean);
    if (state.restored) delete globalThis[key];
    return { restored: state.restored, alreadyRestored: false, methods: results }; })()`
}

export function summarizeQuickFoldersDocuments(favoritesDocument, customizationsDocument) {
  const validate = (value, id) => {
    if (value === null) return { present: false, documentId: id, itemCount: 0 }
    if (!value || typeof value !== 'object' || value._id !== id || !Array.isArray(value.items)) {
      throw new Error('QUICK_FOLDERS_PUBLIC_DATABASE_DOCUMENT_INVALID')
    }
    return { present: true, documentId: id, itemCount: value.items.length, items: value.items }
  }
  return {
    favorites: validate(favoritesDocument, QUICK_FOLDERS_DOCUMENT_IDS.favorites),
    customizations: validate(customizationsDocument, QUICK_FOLDERS_DOCUMENT_IDS.customizations)
  }
}

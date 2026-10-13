/**
 * transformer.ts
 * Code transformation and runtime shim injection engine
 */

import fs from 'node:fs'
import path from 'node:path'
import { StaticScanAnalyzer } from './scanner.ts'
import { normalizeManifest } from './manifest.ts'
import { LineEndingHelper } from './helpers/line-ending.ts'
import type { ScanResult } from './types.ts'

export const EMBEDDED_SYNC_DB_SHIM_CODE = `/**
 * ZTools uTools Compatibility Layer - Synchronous Database Shim (Runtime)
 * Automatically adapts utools.db.* and utools.dbStorage.* synchronous read/write
 */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var shim = factory();
    root.UtoolsDbSyncShim = shim.UtoolsDbSyncShim;
    if (typeof root.utools === 'undefined') root.utools = {};
    var instance = new shim.UtoolsDbSyncShim({
      pluginId: (root.__ZTOOLS_PLUGIN_ID__ || 'ztools-compat-plugin')
    });
    root.utools.db = instance.db;
    root.utools.dbStorage = instance.dbStorage;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function() {
  function clone(val) {
    if (val === undefined || val === null) return val;
    if (typeof val !== 'object') return val;
    return JSON.parse(JSON.stringify(val));
  }

  function UtoolsDbSyncShim(options) {
    options = options || {};
    this.pluginId = options.pluginId || 'compat-plugin';
    this.docStore = new Map();
    this.kvStore = new Map();
    this.attachmentStore = new Map();

    this._restoreFromLocalStorage();

    this.db = this._createDbFacade();
    this.dbStorage = this._createDbStorageFacade();
  }

  UtoolsDbSyncShim.prototype._restoreFromLocalStorage = function() {
    try {
      if (typeof localStorage !== 'undefined') {
        var docPrefix = '__ztools_db_doc:' + this.pluginId + ':';
        var kvPrefix = '__ztools_db_kv:' + this.pluginId + ':';
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (!k) continue;
          if (k.indexOf(docPrefix) === 0) {
            var docId = k.slice(docPrefix.length);
            this.docStore.set(docId, JSON.parse(localStorage.getItem(k)));
          } else if (k.indexOf(kvPrefix) === 0) {
            var kvKey = k.slice(kvPrefix.length);
            this.kvStore.set(kvKey, JSON.parse(localStorage.getItem(k)));
          }
        }
      }
    } catch (e) {
      // Ignore storage limitations
    }
  };

  UtoolsDbSyncShim.prototype._persistDoc = function(id, doc) {
    try {
      if (typeof localStorage !== 'undefined') {
        var k = '__ztools_db_doc:' + this.pluginId + ':' + id;
        if (doc) localStorage.setItem(k, JSON.stringify(doc));
        else localStorage.removeItem(k);
        return true;
      }
      return false;
    } catch (e) {
      console.error('[utools-db-sync-shim] _persistDoc failed:', e);
      return false;
    }
  };

  UtoolsDbSyncShim.prototype._persistKv = function(key, val) {
    try {
      if (typeof localStorage !== 'undefined') {
        var k = '__ztools_db_kv:' + this.pluginId + ':' + key;
        if (val !== undefined) localStorage.setItem(k, JSON.stringify(val));
        else localStorage.removeItem(k);
        return true;
      }
      return false;
    } catch (e) {
      console.error('[utools-db-sync-shim] _persistKv failed:', e);
      return false;
    }
  };

  UtoolsDbSyncShim.prototype._createDbFacade = function() {
    var self = this;
    var facade = {
      get: function(id) {
        if (!id || typeof id !== 'string') return null;
        var doc = self.docStore.get(id);
        return doc ? clone(doc) : null;
      },
      put: function(doc) {
        if (!doc || typeof doc !== 'object' || !doc._id) {
          return { error: true, message: 'Invalid doc: _id is required' };
        }
        var existing = self.docStore.get(doc._id);
        if (existing && doc._rev && doc._rev !== existing._rev) {
          return { error: true, name: 'conflict', message: 'Document update conflict' };
        }
        var curGen = 1;
        if (existing) {
          var revParts = (existing._rev || '1-0').split('-');
          curGen = (parseInt(revParts[0], 10) || 1) + 1;
        }
        var newRev = curGen + '-' + Math.random().toString(16).slice(2, 10);
        var toSave = clone(doc);
        toSave._rev = newRev;
        var persisted = self._persistDoc(doc._id, toSave);
        if (!persisted && typeof localStorage !== 'undefined') {
          return { error: true, message: 'Storage quota exceeded or persistence failed' };
        }
        self.docStore.set(doc._id, toSave);
        return { id: doc._id, ok: true, rev: newRev };
      },
      remove: function(docOrId) {
        var id = typeof docOrId === 'string' ? docOrId : (docOrId && docOrId._id);
        if (!id || !self.docStore.has(id)) {
          return { error: true, message: 'not found' };
        }
        var existing = self.docStore.get(id);
        if (typeof docOrId === 'object' && docOrId._rev && existing && docOrId._rev !== existing._rev) {
          return { error: true, name: 'conflict', message: 'Document update conflict' };
        }
        self._persistDoc(id, null);
        self.docStore.delete(id);
        return { id: id, ok: true };
      },
      allDocs: function(keyOrPrefix) {
        var res = [];
        self.docStore.forEach(function(doc, id) {
          if (!keyOrPrefix || id.indexOf(keyOrPrefix) === 0) {
            res.push(clone(doc));
          }
        });
        return res;
      },
      bulkDocs: function(docs) {
        if (!Array.isArray(docs)) return [];
        return docs.map(function(d) { return facade.put(d); });
      },
      postAttachment: function(docId, attachment, type) {
        self.attachmentStore.set(docId, { data: attachment, type: type || 'application/octet-stream' });
        return { ok: true, id: docId };
      },
      getAttachment: function(docId) {
        var item = self.attachmentStore.get(docId);
        return item ? item.data : null;
      },
      getAttachmentType: function(docId) {
        var item = self.attachmentStore.get(docId);
        return item ? item.type : null;
      },
      promises: {
        get: function(id) { return Promise.resolve(facade.get(id)); },
        put: function(doc) { return Promise.resolve(facade.put(doc)); },
        remove: function(docOrId) { return Promise.resolve(facade.remove(docOrId)); },
        allDocs: function(k) { return Promise.resolve(facade.allDocs(k)); },
        bulkDocs: function(d) { return Promise.resolve(facade.bulkDocs(d)); }
      }
    };
    return facade;
  };

  UtoolsDbSyncShim.prototype._createDbStorageFacade = function() {
    var self = this;
    return {
      setItem: function(key, val) {
        self.kvStore.set(key, clone(val));
        self._persistKv(key, val);
      },
      getItem: function(key) {
        var val = self.kvStore.get(key);
        return val !== undefined ? clone(val) : null;
      },
      removeItem: function(key) {
        self.kvStore.delete(key);
        self._persistKv(key, undefined);
      }
    };
  };

  return { UtoolsDbSyncShim: UtoolsDbSyncShim };
});
`

export const EMBEDDED_SERVICES_ADAPTER_CODE = `/**
 * ZTools Services Adapter
 * Ensures window.services and global services are unified in the Web/Renderer container
 */
(function(global) {
  var existing = global.services || (global.window && global.window.services) || {};
  global.services = existing;
  if (global.window) global.window.services = existing;

  if (typeof global.utools === 'undefined') {
    global.utools = {};
  }
  if (global.window && typeof global.window.utools === 'undefined') {
    global.window.utools = global.utools;
  }

  if (typeof global.utools.isWindows === 'undefined') {
    global.utools.isWindows = function() { return navigator.userAgent.indexOf('Windows') !== -1; };
    global.utools.isMacOS = function() { return navigator.userAgent.indexOf('Mac') !== -1; };
    global.utools.isLinux = function() { return navigator.userAgent.indexOf('Linux') !== -1; };
    global.utools.isDev = function() { return false; };
  }

  console.log('[ZTools Compat] Services adapter initialized.');
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
`

export function generateTemplateContainerHtml(pluginName: string, featureCode: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pluginName || 'ZTools 模板插件'}</title>
  <script src="ztools://web/sdk/ztools-api.js"></script>
  <script src="./services-adapter.js"></script>
  <script src="./preload.js"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 12px; background: #fff; color: #333; }
    .search-box { width: 100%; box-sizing: border-box; padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; margin-bottom: 12px; }
    .list-container { list-style: none; padding: 0; margin: 0; }
    .list-item { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; cursor: pointer; border-radius: 4px; }
    .list-item:hover { background-color: #f5f7fa; }
    .item-title { font-weight: 500; font-size: 14px; }
    .item-desc { font-size: 12px; color: #888; margin-top: 4px; }
  </style>
</head>
<body>
  <input type="text" id="subInput" class="search-box" placeholder="搜索..." />
  <ul id="itemList" class="list-container"></ul>
  <script>
    (function() {
      var featureCode = "${featureCode || ''}";
      var subInput = document.getElementById('subInput');
      var listElem = document.getElementById('itemList');
      var exportsMap = window.exports || {};
      var targetFeature = exportsMap[featureCode] || Object.values(exportsMap)[0];

      function renderItems(items) {
        listElem.innerHTML = '';
        if (!items || !items.length) return;
        items.forEach(function(item) {
          var li = document.createElement('li');
          li.className = 'list-item';
          li.innerHTML = '<div class="item-title">' + (item.title || '') + '</div><div class="item-desc">' + (item.description || '') + '</div>';
          li.onclick = function() {
            if (targetFeature && targetFeature.args && targetFeature.args.select) {
              targetFeature.args.select({ code: featureCode }, item, renderItems);
            }
          };
          listElem.appendChild(li);
        });
      }

      if (targetFeature && targetFeature.args) {
        if (targetFeature.args.placeholder) {
          subInput.placeholder = targetFeature.args.placeholder;
        }
        if (targetFeature.args.enter) {
          targetFeature.args.enter({ code: featureCode }, renderItems);
        }
        subInput.oninput = function() {
          if (targetFeature.args.search) {
            targetFeature.args.search({ code: featureCode }, subInput.value, renderItems);
          }
        };
      }
    })();
  </script>
</body>
</html>
`
}

export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function injectScriptsIntoHtml(
  htmlContent: string,
  scriptsToInject: Array<{ src: string }>
): { content: string; injected: string[]; skipped: string[] } {
  const injected: string[] = []
  const skipped: string[] = []
  let content = htmlContent

  for (const script of scriptsToInject) {
    const regex = new RegExp(`<script\\b[^>]*src=["']${escapeRegExp(script.src)}["'][^>]*>`, 'i')
    if (regex.test(content)) {
      skipped.push(script.src)
      continue
    }

    const scriptTag = `<script src="${script.src}"></script>\n`

    if (/<\/head>/i.test(content)) {
      content = content.replace(/<\/head>/i, `  ${scriptTag}</head>`)
      injected.push(script.src)
    } else if (/<body\b[^>]*>/i.test(content)) {
      content = content.replace(/(<body\b[^>]*>)/i, `$1\n  ${scriptTag}`)
      injected.push(script.src)
    } else {
      content = `${scriptTag}${content}`
      injected.push(script.src)
    }
  }

  return { content, injected, skipped }
}

export class TransformerEngine {
  /**
   * Prepares transform operations for a plugin
   */
  static planTransform(
    sourceDir: string,
    targetDir: string,
    options: { pluginId?: string; strictTargets?: boolean } = {}
  ): {
    scanResult: ScanResult
    normalizedManifest: any
    filesToCreateOrModify: Array<{
      relativePath: string
      content: string | Buffer
      reason: string
    }>
  } {
    const scanResult = StaticScanAnalyzer.scan(sourceDir)
    if (!scanResult.manifest.valid) {
      throw new Error(`扫描原工程失败: ${scanResult.manifest.errors.join('; ')}`)
    }

    const rawManifest = scanResult.manifest.raw || {}
    const { manifest: normalizedManifest, diagnostics } = normalizeManifest(rawManifest, {
      pluginDir: sourceDir,
      customId: options.pluginId,
      strictTargets: options.strictTargets
    })

    if (!normalizedManifest) {
      throw new Error(`Manifest 归一化失败: ${diagnostics.errors.join('; ')}`)
    }

    const filesToCreateOrModify: Array<{ relativePath: string; content: string | Buffer; reason: string }> = []

    // 1. plugin.utools.json (备份原 Manifest 证据)
    filesToCreateOrModify.push({
      relativePath: 'plugin.utools.json',
      content: JSON.stringify(rawManifest, null, 2) + '\n',
      reason: '备份原 uTools plugin.json 作为追溯凭证'
    })

    // 2. plugin.json (归一化 Manifest)
    filesToCreateOrModify.push({
      relativePath: 'plugin.json',
      content: JSON.stringify(normalizedManifest, null, 2) + '\n',
      reason: '规范化 uTools Manifest 并对齐 ZTools 规范'
    })

    // 3. 入口 HTML 脚本注入
    const entryFileName = normalizedManifest.entry || 'index.html'
    const isTemplatePluginWithoutHtml = !scanResult.manifest.main && scanResult.manifest.preload

    const scriptsToInject: Array<{ src: string }> = [
      { src: 'ztools://web/sdk/ztools-api.js' }
    ]

    const needsDbShim = scanResult.syncCalls.hasSyncDb || scanResult.syncCalls.hasSyncNode
    if (needsDbShim) {
      scriptsToInject.push({ src: './utools-db-sync-shim.js' })
    }

    const needsServicesAdapter = scanResult.servicesScan.hasCustomServices
    if (needsServicesAdapter) {
      scriptsToInject.push({ src: './services-adapter.js' })
    }

    if (isTemplatePluginWithoutHtml) {
      const featCode = scanResult.manifest.raw?.features?.[0]?.code || 'main'
      const templateHtml = generateTemplateContainerHtml(normalizedManifest.name, featCode)
      filesToCreateOrModify.push({
        relativePath: entryFileName,
        content: templateHtml,
        reason: '为 uTools 模板插件自动生成交互容器 index.html 页面'
      })
    } else {
      const sourceEntryPath = path.join(sourceDir, entryFileName)
      if (fs.existsSync(sourceEntryPath)) {
        const rawHtml = fs.readFileSync(sourceEntryPath, 'utf8')
        const { content: updatedHtml } = injectScriptsIntoHtml(rawHtml, scriptsToInject)
        filesToCreateOrModify.push({
          relativePath: entryFileName,
          content: updatedHtml,
          reason: `在 ${entryFileName} 中注入 ZTools SDK 与适配脚本`
        })
      }
    }

    // 4. utools-db-sync-shim.js
    if (needsDbShim) {
      filesToCreateOrModify.push({
        relativePath: 'utools-db-sync-shim.js',
        content: EMBEDDED_SYNC_DB_SHIM_CODE,
        reason: '植入 CouchDB 乐观 MVCC 内存同步数据库 Shim'
      })
    }

    // 5. services-adapter.js
    if (needsServicesAdapter || isTemplatePluginWithoutHtml) {
      filesToCreateOrModify.push({
        relativePath: 'services-adapter.js',
        content: EMBEDDED_SERVICES_ADAPTER_CODE,
        reason: '植入轻量 window.services 运行时环境桥接适配器'
      })
    }

    return {
      scanResult,
      normalizedManifest,
      filesToCreateOrModify
    }
  }
}

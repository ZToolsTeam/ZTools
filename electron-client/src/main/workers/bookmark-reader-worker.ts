import { parentPort, workerData } from 'node:worker_threads'
import { scanBrowserBookmarks } from '../services/bookmark-reader.js'
import { errorMessage, type BookmarkEnvironment } from '../services/bookmark-discovery.js'
if (!parentPort) throw new Error('书签读取必须在 worker 中运行')
try { parentPort.postMessage(scanBrowserBookmarks(workerData as BookmarkEnvironment)) }
catch (error) { parentPort.postMessage({ success: false, error: errorMessage(error) }) }
finally { parentPort.close() }

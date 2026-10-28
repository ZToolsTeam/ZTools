import { parentPort, workerData } from 'node:worker_threads'
import { scanRecentProjects, type ProjectsEnvironment } from '../services/recent-projects-reader.js'
import { projectError } from '../services/recent-projects-parser.js'
if (!parentPort) throw new Error('最近项目读取必须在 worker 中运行')
try { parentPort.postMessage(scanRecentProjects(workerData as ProjectsEnvironment)) }
catch (error) { parentPort.postMessage({ success: false, error: projectError(error) }) }
finally { parentPort.close() }

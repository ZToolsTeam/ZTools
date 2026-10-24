import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ICON_SCRIPT = `
ObjC.import('AppKit')
function run(argv) {
  const source = $.NSWorkspace.sharedWorkspace.iconForFile($(argv[0]))
  const image = $.NSImage.alloc.initWithSize($.NSMakeSize(64, 64))
  image.lockFocus
  try {
    source.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 64, 64), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1)
  } finally {
    image.unlockFocus
  }
  const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation)
  const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}))
  return ObjC.unwrap(png.base64EncodedStringWithOptions(0))
}`

type IconRunner = (executable: string, args: readonly string[]) => Promise<string>
const runIconScript: IconRunner = async (executable, args) => {
  const { stdout } = await execFileAsync(executable, args, {
    encoding: 'utf8', timeout: 2000, maxBuffer: 256 * 1024, shell: false
  })
  return stdout
}

/** NSWorkspace resolves the bundle's real icon; Electron's MIME icon can be generic for .app. */
export async function readMacosApplicationIcon(appPath: string, run: IconRunner = runIconScript): Promise<string> {
  if (!path.posix.isAbsolute(appPath) || appPath.includes('\0') || !appPath.toLowerCase().endsWith('.app')) {
    throw new Error('无效的 macOS 应用路径')
  }
  const base64 = (await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ICON_SCRIPT, appPath])).trim()
  if (base64.length > 256 * 1024 || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error('macOS 应用图标读取失败')
  }
  return `data:image/png;base64,${base64}`
}

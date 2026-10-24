import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const digest = data => createHash('sha256').update(data).digest('hex')

export async function createMacFixtures(outputRoot) {
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)) throw new Error('ABSOLUTE_FIXTURE_ROOT_REQUIRED')
  // Resolve the dependency before creating files; Node 22.12 requires --experimental-sqlite.
  const { DatabaseSync } = await import('node:sqlite')
  fs.mkdirSync(path.dirname(outputRoot), { recursive: true })
  fs.mkdirSync(outputRoot) // A caller cannot reuse a user profile or an earlier run.
  const root = fs.realpathSync(outputRoot)
  const runId = randomUUID(), files = []
  const target = relative => {
    if (path.isAbsolute(relative) || relative.split('/').some(part => ['.', '..', ''].includes(part))) throw new Error('INVALID_FIXTURE_PATH')
    return path.join(root, ...relative.split('/'))
  }
  const record = relative => files.push({ path: relative, sha256: digest(fs.readFileSync(target(relative))) })
  const write = (relative, content) => {
    const file = target(relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content, { flag: 'wx' })
    record(relative)
  }
  write('.ztools-fixture-owner.json', JSON.stringify({ version: 1, runId, root, scope: 'synthetic-only' }) + '\n')
  write('files/space name.txt', 'synthetic space path\n')
  write('files/中文-é.txt', 'synthetic Unicode path\n')
  write('files/e\u0301.txt', 'synthetic decomposed Unicode\n')
  write('files/empty.txt', '')
  write('files/source.txt', 'original source\n')
  write('outside/sentinel.txt', 'outside-scope sentinel must remain unchanged\n')
  write('chat/wechat-test/Account/synthetic/messages.json', JSON.stringify([{ id: 1, text: 'synthetic message', attachment: 'attachment.txt' }]) + '\n')
  write('chat/wechat-test/Account/synthetic/attachment.txt', 'synthetic attachment\n')
  write('chat/qq-test/synthetic/cache/item.txt', 'synthetic cache\n')
  write('configuration/hosts', '127.0.0.1 localhost\n::1 localhost\n127.0.0.1 fixture.invalid\n')
  // Browser fixture paths are explicit; no discovery of a real user's browser profile occurs.
  const bookmark = { version: 1, roots: {
    bookmark_bar: { children: [{ id: '1', type: 'url', name: 'Synthetic 示例', url: 'https://example.invalid/fixture', date_added: '13348540800000000' }], type: 'folder', name: 'Bookmarks bar', id: '0' },
    other: { children: [], type: 'folder', name: 'Other bookmarks', id: '2' }
  } }
  write('browser/chromium/Default/Bookmarks', JSON.stringify(bookmark) + '\n')
  const sqlite = (relative, sql) => {
    const file = target(relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    try { db.exec(sql) } finally { db.close() }
    record(relative)
  }
  sqlite('browser/chromium/Default/History', `
    CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER);
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);
    INSERT INTO urls VALUES (1, 'https://example.invalid/history', 'Synthetic 历史', 1);
    INSERT INTO visits VALUES (1, 1, 13348540800000000);
  `)
  sqlite('browser/firefox/test.default/places.sqlite', `
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER);
    CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, parent INTEGER, type INTEGER, title TEXT, fk INTEGER, dateAdded INTEGER, lastModified INTEGER, guid TEXT);
    INSERT INTO moz_places VALUES (1, 'https://example.invalid/firefox', 'Synthetic Firefox', 1);
    INSERT INTO moz_historyvisits VALUES (1, 1, 1704067200000000);
    INSERT INTO moz_bookmarks VALUES (1, 2, 1, 'Synthetic bookmark', 1, 1704067200000000, 1704067200000000, 'fixtureguid1');
  `)
  write('browser/corrupt/History', 'synthetic invalid SQLite file\n')
  write('data/migration-expectations.json', JSON.stringify({ synthetic: true, entries: [{ key: 'fixture-counter', value: 3 }], note: 'Expectations only; this file is not an encrypted legacy vault or a LevelDB store.' }) + '\n')
  const manifest = { version: 1, runId, root, scope: 'synthetic-only', files,
    scenarios: ['M04-file-boundaries', 'M08-loopback-config', 'M10-migration-expectations-only', 'M13-browser-source', 'M15-synthetic-chat'],
    pending: ['APFS volumes', 'symlink/readonly permission setup', 'encrypted legacy vault', 'legacy LevelDB', 'OS permission/device fixtures'] }
  fs.writeFileSync(path.join(root, 'fixture-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  return manifest
}

export function verifyMacFixtures(root) {
  const canonicalRoot = fs.realpathSync(root)
  const manifest = JSON.parse(fs.readFileSync(path.join(canonicalRoot, 'fixture-manifest.json'), 'utf8'))
  const owner = JSON.parse(fs.readFileSync(path.join(canonicalRoot, '.ztools-fixture-owner.json'), 'utf8'))
  if (manifest.version !== 1 || manifest.root !== canonicalRoot || owner.root !== canonicalRoot ||
      manifest.runId !== owner.runId || owner.scope !== 'synthetic-only' || manifest.scope !== 'synthetic-only' ||
      !/^[a-f0-9-]{36}$/.test(manifest.runId) || !Array.isArray(manifest.files)) throw new Error('FIXTURE_OWNER_MISMATCH')
  const seen = new Set()
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || file.path.includes('\\') || path.isAbsolute(file.path) ||
        file.path.split('/').some(part => ['.', '..', ''].includes(part)) || seen.has(file.path)) throw new Error('INVALID_FIXTURE_PATH')
    seen.add(file.path)
    const candidate = path.join(canonicalRoot, ...file.path.split('/'))
    const real = fs.realpathSync(candidate)
    const relative = path.relative(canonicalRoot, real)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
        !fs.lstatSync(candidate).isFile() || digest(fs.readFileSync(real)) !== file.sha256) throw new Error('FIXTURE_CHANGED')
  }
  return { status: 'PASS', runId: manifest.runId, files: manifest.files.length, pending: manifest.pending }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({ args: argv, options: { output: { type: 'string' }, verify: { type: 'string' }, help: { type: 'boolean' } } })
    if (values.help) { console.log('npm run test:mac:fixtures -- --output <fresh absolute root> | --verify <fixture root>'); return 0 }
    if (!!values.output === !!values.verify) throw new Error('SELECT_CREATE_OR_VERIFY')
    console.log(JSON.stringify(values.verify ? verifyMacFixtures(values.verify) : await createMacFixtures(values.output)))
    return 0
  } catch { console.error('MAC_FIXTURE_OPERATION_FAILED'); return 1 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main()

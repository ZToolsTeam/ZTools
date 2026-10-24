import { crc32, deflateRawSync } from 'node:zlib'
export function buildZipFixture(files = [{ name: '文档.txt', data: Buffer.from('hello') }], corrupt = false, deflated = false) {
  const locals: Buffer[] = [], centrals: Buffer[] = []; let offset = 0
  for (const file of files) {
    const content = deflated ? deflateRawSync(file.data) : file.data
    const name = Buffer.from(file.name), crc = crc32(file.data), header = Buffer.alloc(30), central = Buffer.alloc(46)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6)
    header.writeUInt32LE(corrupt ? (crc ^ 1) >>> 0 : crc, 14); header.writeUInt16LE(deflated ? 8 : 0, 8); header.writeUInt32LE(content.length, 18); header.writeUInt32LE(file.data.length, 22); header.writeUInt16LE(name.length, 26)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8)
    central.writeUInt32LE(corrupt ? (crc ^ 1) >>> 0 : crc, 16); central.writeUInt16LE(deflated ? 8 : 0, 10); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(file.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(header, name, content); centrals.push(central, name); offset += header.length + name.length + content.length
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

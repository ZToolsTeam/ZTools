import Cocoa
import Foundation

struct Representation: Codable { let type: String; let data: Data }
struct Snapshot: Codable { let items: [[Representation]] }
let board = NSPasteboard.general
let arguments = CommandLine.arguments
func snapshot() throws -> Snapshot {
    let count = board.changeCount
    let items = try (board.pasteboardItems ?? []).map { item in
        try item.types.map { type -> Representation in
            guard board.changeCount == count, let data = item.data(forType: type) else {
                throw NSError(domain: "clipboard-snapshot", code: 1)
            }
            return Representation(type: type.rawValue, data: data)
        }
    }
    guard board.changeCount == count else { throw NSError(domain: "clipboard-snapshot", code: 2) }
    return Snapshot(items: items)
}
func matches(_ left: Snapshot, _ right: Snapshot) -> Bool {
    guard left.items.count == right.items.count else { return false }
    return zip(left.items, right.items).allSatisfy {
        Dictionary(uniqueKeysWithValues: $0.map { ($0.type, $0.data) }) ==
        Dictionary(uniqueKeysWithValues: $1.map { ($0.type, $0.data) })
    }
}
do {
    let file = URL(fileURLWithPath: arguments[2])
    switch arguments[1] {
    case "save":
        try JSONEncoder().encode(snapshot()).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    case "restore":
        let original = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: file))
        let items = original.items.map { representations -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for representation in representations {
                item.setData(representation.data, forType: NSPasteboard.PasteboardType(representation.type))
            }
            return item
        }
        board.clearContents()
        if !items.isEmpty && !board.writeObjects(items) { throw NSError(domain: "clipboard-restore", code: 1) }
        // snapshot 同步物化全部原始表示，避免恢复进程退出后丢失后续 item。
        guard matches(original, try snapshot()) else { throw NSError(domain: "clipboard-restore", code: 2) }
    case "verify":
        let original = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: file))
        guard matches(original, try snapshot()) else { throw NSError(domain: "clipboard-verify", code: 1) }
    default:
        throw NSError(domain: "clipboard-command", code: 1)
    }
} catch {
    // 不输出剪贴板类型、内容或操作系统错误详情。
    fputs("剪贴板快照或恢复校验失败\n", stderr)
    exit(1)
}

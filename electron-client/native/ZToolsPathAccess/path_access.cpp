#include "path_access.hpp"
#include <algorithm>
#include <array>
#include <cstring>
#include <filesystem>
#include <mutex>
#include <limits>
#include <random>
#include <stdexcept>
#include <utility>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <Windows.h>
#include <winternl.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <dirent.h>
#include <cerrno>
#include <cstdio>
#ifdef __APPLE__
#include <sys/attr.h>
#endif
#endif

namespace ztools::path_access {
namespace {
[[noreturn]] void Fail() { throw std::runtime_error("PATH_ACCESS_DENIED"); }
void Segment(const std::string& text) {
  if (text.empty() || text.size() > 4096 || text == "." || text == "..") Fail();
  for (unsigned char c : text) {
    if (c == 0 || c == '/') Fail();
#ifdef _WIN32
    if (c < 32 || c == '\\' || c == ':') Fail();
#endif
  }
}
bool InternalName(const std::string& text) {
  constexpr char prefix[] = ".ztools-save-";
  if (text.size() < sizeof(prefix) - 1) return false;
  for (std::size_t i = 0; i < sizeof(prefix) - 1; ++i) {
    const auto letter = text[i] >= 'A' && text[i] <= 'Z' ? static_cast<char>(text[i] + ('a' - 'A')) : text[i];
    if (letter != prefix[i]) return false;
  }
  return true;
}
void UserSegment(const std::string& text) { Segment(text); if (InternalName(text)) Fail(); }
enum class OpenMode { read, create, remove, metadata, selection };
#ifdef _WIN32
using Handle = HANDLE;
const Handle Invalid = INVALID_HANDLE_VALUE;
void Close(Handle h) { if (h != Invalid) CloseHandle(h); }
Handle Duplicate(Handle h) {
  Handle result = Invalid;
  if (!DuplicateHandle(GetCurrentProcess(), h, GetCurrentProcess(), &result, 0, FALSE, DUPLICATE_SAME_ACCESS)) Fail();
  return result;
}
struct Identity { FILE_ID_INFO id{}; bool directory = false; };
Identity Inspect(Handle h) {
  FILE_ATTRIBUTE_TAG_INFO tag{};
  FILE_STANDARD_INFO standard{};
  Identity result;
  if (GetFileType(h) != FILE_TYPE_DISK || !GetFileInformationByHandleEx(h, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      !GetFileInformationByHandleEx(h, FileStandardInfo, &standard, sizeof(standard)) ||
      !GetFileInformationByHandleEx(h, FileIdInfo, &result.id, sizeof(result.id))) Fail();
  result.directory = standard.Directory != FALSE;
  if (!result.directory && standard.NumberOfLinks != 1) Fail();
  return result;
}
bool Same(const Identity& a, const Identity& b) {
  return a.directory == b.directory && a.id.VolumeSerialNumber == b.id.VolumeSerialNumber &&
    std::memcmp(a.id.FileId.Identifier, b.id.FileId.Identifier, sizeof(a.id.FileId.Identifier)) == 0;
}
std::wstring Wide(const std::string& text) {
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
  if (length <= 0 || length > 2048) Fail();
  std::wstring value(static_cast<std::size_t>(length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), value.data(), length) != length) Fail();
  return value;
}
Handle OpenChild(Handle parent, const std::string& segment, bool directory, OpenMode mode = OpenMode::read, bool* created = nullptr) {
  const bool create = mode == OpenMode::create, remove = mode == OpenMode::remove;
  Segment(segment);
  const auto name = Wide(segment);
  UNICODE_STRING unicode{};
  unicode.Buffer = const_cast<PWSTR>(name.data());
  unicode.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  unicode.MaximumLength = unicode.Length;
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes); attributes.RootDirectory = parent; attributes.ObjectName = &unicode;
  // Exact lookup: honor case-sensitive directories rather than guessing from the OS name.
  IO_STATUS_BLOCK status{}; Handle result = Invalid;
  using Create = NTSTATUS(NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
    PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
  const auto function = reinterpret_cast<Create>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtCreateFile"));
  if (!function) Fail();
  constexpr ULONG open_existing = 1, synchronous = 0x20, no_reparse = 0x00200000;
  const ULONG type = mode == OpenMode::selection ? 0UL : directory ? 1UL : 0x40UL;
  const ACCESS_MASK access = SYNCHRONIZE | FILE_READ_ATTRIBUTES | (directory ? FILE_TRAVERSE | FILE_LIST_DIRECTORY :
    create ? FILE_WRITE_DATA | DELETE : mode == OpenMode::metadata ? 0 : FILE_READ_DATA) | (remove ? DELETE : 0);
  const auto opened = function(&result, access, &attributes, &status, nullptr, 0,
      create ? FILE_SHARE_READ : FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      create ? directory ? 3UL : 2UL : open_existing, synchronous | no_reparse | type, nullptr, 0);
  if (opened < 0) {
    if (mode == OpenMode::metadata && static_cast<ULONG>(opened) == 0xC0000034UL) return Invalid;
    Fail();
  }
  if (created) *created = create && status.Information == 2;
  return result;
}
void RenameFile(Handle source, Handle parent, const std::string& basename, bool replace) {
  const auto name = Wide(basename);
  struct Rename { ULONG flags; HANDLE root; ULONG bytes; WCHAR name[1]; };
  const auto size = offsetof(Rename, name) + name.size() * sizeof(wchar_t);
  std::vector<std::uint64_t> storage((size + 7) / 8);
  auto* information = reinterpret_cast<Rename*>(storage.data());
  information->flags = replace ? 3UL : 0UL; information->root = parent;
  information->bytes = static_cast<ULONG>(name.size() * sizeof(wchar_t));
  std::copy(name.begin(), name.end(), information->name);
  using Set = NTSTATUS(NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
  const auto function = reinterpret_cast<Set>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtSetInformationFile"));
  IO_STATUS_BLOCK status{}; if (!function) Fail();
  const auto renamed = function(source, &status, information, static_cast<ULONG>(size), static_cast<FILE_INFORMATION_CLASS>(65));
  if (renamed < 0) {
    if (!replace && static_cast<ULONG>(renamed) == 0xC0000035UL) throw std::runtime_error("PATH_OUTPUT_EXISTS");
    if (static_cast<ULONG>(renamed) == 0xC00000D4UL) throw std::runtime_error("PATH_CROSS_DEVICE");
    Fail();
  }
}
#else
using Handle = int;
constexpr Handle Invalid = -1;
void Close(Handle h) { if (h != Invalid) close(h); }
Handle Duplicate(Handle h) { const auto result = fcntl(h, F_DUPFD_CLOEXEC, 0); if (result < 0) Fail(); return result; }
struct Identity { dev_t device{}; ino_t inode{}; bool directory = false; };
Identity Inspect(Handle h) {
  struct stat value{};
  if (fstat(h, &value) != 0 || (!S_ISREG(value.st_mode) && !S_ISDIR(value.st_mode)) || (S_ISREG(value.st_mode) && value.st_nlink != 1)) Fail();
  return {value.st_dev, value.st_ino, S_ISDIR(value.st_mode)};
}
bool Same(const Identity& a, const Identity& b) { return a.device == b.device && a.inode == b.inode && a.directory == b.directory; }
Handle OpenChild(Handle parent, const std::string& segment, bool directory, OpenMode mode = OpenMode::read, bool* created = nullptr) {
  const bool create = mode == OpenMode::create;
  Segment(segment);
  bool made = false;
  if (create && directory) { if (mkdirat(parent, segment.c_str(), 0700) == 0) made = true; else if (errno != EEXIST) Fail(); }
  if (created) *created = create && (directory ? made : true);
  const int access = create && !directory ? O_WRONLY | O_CREAT | O_EXCL :
#ifdef __APPLE__
    mode == OpenMode::metadata ? O_EVTONLY :
#endif
    O_RDONLY;
  const int flags = access | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | (directory ? O_DIRECTORY : 0);
  auto h = openat(parent, segment.c_str(), flags, 0600);
#ifdef __APPLE__
  if (h == Invalid && directory && !create && mode != OpenMode::metadata && (errno == EPERM || errno == EACCES)) {
    h = openat(parent, segment.c_str(), O_EXEC | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | O_DIRECTORY, 0600);
  }
#endif
  if (h == Invalid) { if (mode == OpenMode::metadata && errno == ENOENT) return Invalid; Fail(); }
  return h;
}
#endif
void FlushFile(Handle file) {
#ifdef _WIN32
  if (!FlushFileBuffers(file)) Fail();
#elif defined(__APPLE__)
  // Request the device-cache barrier too; ordinary fsync alone is not a power-loss receipt.
  // Unsupported/failed barriers fail closed instead of silently weakening journal durability.
  if (fcntl(file, F_FULLFSYNC) != 0) Fail();
#else
  (void)file; Fail();
#endif
}
struct Owned {
  Handle value = Invalid;
  explicit Owned(Handle h) : value(h) {}
  ~Owned() { Close(value); }
  Owned(Owned&& other) noexcept : value(std::exchange(other.value, Invalid)) {}
  Owned& operator=(Owned&& other) noexcept { if (this != &other) { Close(value); value = std::exchange(other.value, Invalid); } return *this; }
  Owned(const Owned&) = delete;
};
std::string PublicObjectName(Handle file) {
#ifdef _WIN32
  std::array<wchar_t, 8192> name{};
  const auto size = GetFinalPathNameByHandleW(file, name.data(), static_cast<DWORD>(name.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_NONE);
  if (!size || size >= name.size()) Fail();
  const std::wstring full(name.data(), size);
  const auto begin = full.find_last_of(L'\\');
  const auto leaf = full.substr(begin == std::wstring::npos ? 0 : begin + 1);
  const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, leaf.data(), static_cast<int>(leaf.size()), nullptr, 0, nullptr, nullptr);
  if (bytes <= 0) Fail();
  std::string basename(static_cast<std::size_t>(bytes), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, leaf.data(), static_cast<int>(leaf.size()), basename.data(), bytes, nullptr, nullptr) != bytes) Fail();
  UserSegment(basename); return basename;
#elif defined(__APPLE__)
  struct attrlist attributes{}; attributes.bitmapcount = ATTR_BIT_MAP_COUNT; attributes.commonattr = ATTR_CMN_NAME;
  std::array<unsigned char, 8192> bytes{};
  if (fgetattrlist(file, &attributes, bytes.data(), bytes.size(), 0) != 0) Fail();
  std::uint32_t length = 0; attrreference_t reference{};
  std::memcpy(&length, bytes.data(), sizeof(length)); std::memcpy(&reference, bytes.data() + sizeof(length), sizeof(reference));
  const auto position = static_cast<std::int64_t>(sizeof(length)) + reference.attr_dataoffset;
  if (length > bytes.size() || position < static_cast<std::int64_t>(sizeof(length) + sizeof(reference)) ||
      !reference.attr_length || position > length || reference.attr_length > length - static_cast<std::size_t>(position) ||
      bytes[static_cast<std::size_t>(position) + reference.attr_length - 1] != 0) Fail();
  const std::string basename(reinterpret_cast<const char*>(bytes.data() + position), reference.attr_length - 1);
  UserSegment(basename); return basename;
#else
  (void)file; Fail();
#endif
}
Handle OpenUserChild(Handle parent, const std::string& segment, bool directory, OpenMode mode = OpenMode::read, bool* created = nullptr) {
  UserSegment(segment);
  Owned file(OpenChild(parent, segment, directory, mode, created));
  if (file.value != Invalid) {
    Inspect(file.value);
    // The filesystem may resolve a case/normalization alias even without case-insensitive open flags.
    // Compare bytes from this same retained object, never a second path lookup.
    if (PublicObjectName(file.value) != segment) Fail();
  }
  return std::exchange(file.value, Invalid);
}
void CheckOutputSlot(Handle parent, const std::string& basename) {
  Owned current(OpenUserChild(parent, basename, false, OpenMode::metadata));
}
struct Anchor {
  Owned handle;
  std::string name;
  Identity identity;
};
using Proof = std::vector<unsigned char>;
void ProofNumber(Proof& proof, std::uint64_t value) {
  for (unsigned shift = 0; shift < 64; shift += 8) proof.push_back(static_cast<unsigned char>(value >> shift));
}
void ProofIdentity(Proof& proof, const Identity& identity) {
#ifdef _WIN32
  ProofNumber(proof, identity.id.VolumeSerialNumber);
  proof.insert(proof.end(), std::begin(identity.id.FileId.Identifier), std::end(identity.id.FileId.Identifier));
#else
  ProofNumber(proof, static_cast<std::uint64_t>(identity.device));
  ProofNumber(proof, static_cast<std::uint64_t>(identity.inode));
#endif
  proof.push_back(identity.directory ? 1 : 0);
}
std::uint64_t FileSize(Handle file) {
#ifdef _WIN32
  LARGE_INTEGER size{}; if (!GetFileSizeEx(file, &size) || size.QuadPart < 0) Fail();
  return static_cast<std::uint64_t>(size.QuadPart);
#else
  struct stat value{}; if (fstat(file, &value) != 0 || value.st_size < 0) Fail();
  return static_cast<std::uint64_t>(value.st_size);
#endif
}
Handle OpenParent(Handle root, const std::vector<std::string>& segments, std::vector<Owned>& traversal,
  const std::function<bool()>& cancelled) {
  if (segments.empty() || segments.size() > 64) Fail();
  for (const auto& part : segments) UserSegment(part);
  for (std::size_t i = 0; i + 1 < segments.size(); ++i) {
    if (cancelled && cancelled()) throw std::runtime_error("PATH_ACCESS_CANCELLED");
    Owned child(OpenUserChild(root, segments[i], true));
    if (!Inspect(child.value).directory) Fail();
    root = child.value; traversal.push_back(std::move(child));
  }
  return root;
}
}
struct PinnedPath::Impl {
  std::vector<Anchor> chain;
  Kind kind;
  std::string save_name;
  mutable std::mutex mutex;
  void Validate() const {
    for (std::size_t i = 1; i < chain.size(); ++i) {
      Owned current(OpenChild(chain[i - 1].handle.value, chain[i].name, chain[i].identity.directory));
      if (!Same(Inspect(current.value), chain[i].identity)) Fail();
    }
  }
};
PinnedPath::PinnedPath(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
PinnedPath::PinnedPath(PinnedPath&&) noexcept = default;
PinnedPath& PinnedPath::operator=(PinnedPath&&) noexcept = default;
PinnedPath::~PinnedPath() = default;

PinnedPath PinnedPath::Open(const std::string& absolute, Kind kind) {
  if (absolute.empty() || absolute.size() > 4096 || absolute.find('\0') != std::string::npos) Fail();
  const auto path = std::filesystem::u8path(absolute);
  if (!path.is_absolute() || (kind != Kind::file && kind != Kind::directory && kind != Kind::save && kind != Kind::selected)) Fail();
  auto impl = std::make_unique<Impl>(); impl->kind = kind;
#ifdef _WIN32
  const auto root = path.root_path().wstring();
  if (root.size() != 3 || root[1] != L':' || root[2] != L'\\' || GetDriveTypeW(root.c_str()) != DRIVE_FIXED) Fail();
  Owned initial(CreateFileW(root.c_str(), FILE_TRAVERSE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
#else
  Owned initial(open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
#endif
  if (initial.value == Invalid) Fail();
  auto identity = Inspect(initial.value);
  impl->chain.push_back({std::move(initial), {}, identity});
  std::vector<std::string> parts;
  for (const auto& part : path.relative_path()) { auto text = part.u8string(); UserSegment(text); parts.push_back(std::move(text)); }
  if (parts.size() > 64 || (parts.empty() && kind != Kind::directory && kind != Kind::selected)) Fail();
  if (kind == Kind::save) { impl->save_name = parts.back(); parts.pop_back(); }
  for (std::size_t i = 0; i < parts.size(); ++i) {
    const bool selected_leaf = kind == Kind::selected && i + 1 == parts.size();
    const bool directory = !selected_leaf && (i + 1 < parts.size() || kind != Kind::file);
    Owned h(OpenUserChild(impl->chain.back().handle.value, parts[i], directory, selected_leaf ? OpenMode::selection : OpenMode::read));
    identity = Inspect(h.value);
    if (!selected_leaf && identity.directory != directory) Fail();
    impl->chain.push_back({std::move(h), parts[i], identity});
  }
  if (kind == Kind::selected) impl->kind = identity.directory ? Kind::directory : Kind::file;
  impl->Validate();
  if (kind == Kind::save) CheckOutputSlot(impl->chain.back().handle.value, impl->save_name);
  return PinnedPath(std::move(impl));
}

std::vector<unsigned char> PinnedPath::Read(const std::vector<std::string>& segments, std::size_t max_bytes,
  const std::function<bool()>& cancelled) const {
  return ReadImpl(segments, 0, max_bytes, true, cancelled);
}

std::vector<unsigned char> PinnedPath::ReadRange(const std::vector<std::string>& segments, std::uint64_t offset,
  std::size_t length, const std::function<bool()>& cancelled) const {
  return ReadImpl(segments, offset, length, false, cancelled);
}

std::vector<unsigned char> PinnedPath::ReadImpl(const std::vector<std::string>& segments, std::uint64_t start,
  std::size_t max_bytes, bool entire, const std::function<bool()>& cancelled) const {
  if (!impl_ || impl_->kind == Kind::save || max_bytes > 16 * 1024 * 1024 || segments.size() > 64 ||
      start > 9'007'199'254'740'991ULL || max_bytes > 9'007'199'254'740'991ULL - start ||
      (impl_->kind == Kind::file && !segments.empty()) || (impl_->kind == Kind::directory && segments.empty())) Fail();
  const std::lock_guard<std::mutex> lock(impl_->mutex);
  const auto check = [&] { if (cancelled && cancelled()) throw std::runtime_error("PATH_ACCESS_CANCELLED"); };
  check(); impl_->Validate();
  Handle file = impl_->chain.back().handle.value;
  std::vector<Owned> traversal;
  for (std::size_t i = 0; i < segments.size(); ++i) {
    check(); Owned child(OpenUserChild(file, segments[i], i + 1 < segments.size()));
    if (Inspect(child.value).directory != (i + 1 < segments.size())) Fail();
    file = child.value; traversal.push_back(std::move(child));
  }
  if (Inspect(file).directory) Fail();
  std::vector<unsigned char> bytes;
  std::array<unsigned char, 64 * 1024> chunk{};
  std::uint64_t offset = start;
  for (;;) {
    check(); std::size_t count = 0;
    if (!entire && bytes.size() == max_bytes) break;
    const auto requested = entire ? chunk.size() : std::min(chunk.size(), max_bytes - bytes.size());
#ifdef _WIN32
    LARGE_INTEGER position{}; position.QuadPart = static_cast<LONGLONG>(offset);
    DWORD received = 0;
    if (!SetFilePointerEx(file, position, nullptr, FILE_BEGIN) || !ReadFile(file, chunk.data(), static_cast<DWORD>(requested), &received, nullptr)) Fail();
    count = received;
#else
    const auto received = pread(file, chunk.data(), requested, static_cast<off_t>(offset));
    if (received < 0) Fail();
    count = static_cast<std::size_t>(received);
#endif
    if (!count) break;
    if (count > max_bytes - bytes.size()) throw std::runtime_error("PATH_ACCESS_TOO_LARGE");
    bytes.insert(bytes.end(), chunk.begin(), chunk.begin() + static_cast<std::ptrdiff_t>(count));
    offset += count;
  }
  check(); return bytes;
}

PinnedPath PinnedPath::SaveChild(const std::vector<std::string>& segments) const {
  return Child(segments, Kind::save);
}

PinnedPath PinnedPath::ReadChild(const std::vector<std::string>& segments) const {
  return Child(segments, Kind::file);
}
PinnedPath PinnedPath::DirectoryChild(const std::vector<std::string>& segments) const {
  return Child(segments, Kind::directory);
}

PinnedPath PinnedPath::Child(const std::vector<std::string>& segments, Kind kind) const {
  if (!impl_ || impl_->kind != Kind::directory || segments.empty() || segments.size() > 64) Fail();
  for (const auto& part : segments) UserSegment(part);
  const std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->Validate();
  auto child = std::make_unique<Impl>(); child->kind = kind;
  if (kind == Kind::save) child->save_name = segments.back();
  for (const auto& anchor : impl_->chain) child->chain.push_back({Owned(Duplicate(anchor.handle.value)), anchor.name, anchor.identity});
  if (child->chain.size() + segments.size() > 65) Fail();
  const auto count = kind == Kind::save ? segments.size() - 1 : segments.size();
  for (std::size_t i = 0; i < count; ++i) {
    const bool directory = kind != Kind::file || i + 1 < segments.size();
    Owned current(OpenUserChild(child->chain.back().handle.value, segments[i], directory));
    const auto identity = Inspect(current.value); if (identity.directory != directory) Fail();
    child->chain.push_back({std::move(current), segments[i], identity});
  }
  child->Validate();
  if (kind == Kind::save) CheckOutputSlot(child->chain.back().handle.value, child->save_name);
  return PinnedPath(std::move(child));
}

void PinnedPath::RemoveChild(const std::vector<std::string>& segments, bool directory, const std::function<bool()>& cancelled) const {
  if (!impl_ || impl_->kind != Kind::directory) Fail();
  const std::lock_guard<std::mutex> lock(impl_->mutex);
  const auto check = [&] { if (cancelled && cancelled()) throw std::runtime_error("PATH_ACCESS_CANCELLED"); };
  check(); impl_->Validate();
  std::vector<Owned> traversal;
  const auto parent = OpenParent(impl_->chain.back().handle.value, segments, traversal, cancelled);
#ifdef _WIN32
  Owned leaf(OpenUserChild(parent, segments.back(), directory, OpenMode::remove));
  if (Inspect(leaf.value).directory != directory) Fail();
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  if (!GetFileInformationByHandleEx(leaf.value, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
      (!directory && (attributes.FileAttributes & FILE_ATTRIBUTE_READONLY))) Fail();
  check();
  FILE_DISPOSITION_INFO_EX disposition{}; disposition.Flags = FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS;
  if (!SetFileInformationByHandle(leaf.value, FileDispositionInfoEx, &disposition, sizeof(disposition))) Fail();
#else
  Owned checked_leaf(OpenUserChild(parent, segments.back(), directory));
  struct stat leaf{};
  if (fstatat(parent, segments.back().c_str(), &leaf, AT_SYMLINK_NOFOLLOW) != 0 ||
      (directory ? !S_ISDIR(leaf.st_mode) : !S_ISREG(leaf.st_mode) || leaf.st_nlink != 1)) Fail();
  check();
  // unlinkat removes this directory's current entry itself; it never follows a replacement leaf symlink.
  if (unlinkat(parent, segments.back().c_str(), directory ? AT_REMOVEDIR : 0) != 0) Fail();
  if (fsync(parent) != 0) throw std::runtime_error("PATH_COMMIT_UNCONFIRMED");
#endif
}

bool PinnedPath::CreateDirectoryChild(const std::vector<std::string>& segments, const std::function<bool()>& cancelled) const {
  if (!impl_ || impl_->kind != Kind::directory) Fail();
  const std::lock_guard<std::mutex> lock(impl_->mutex);
  if (cancelled && cancelled()) throw std::runtime_error("PATH_ACCESS_CANCELLED");
  impl_->Validate();
  std::vector<Owned> traversal;
  const auto parent = OpenParent(impl_->chain.back().handle.value, segments, traversal, cancelled);
  if (cancelled && cancelled()) throw std::runtime_error("PATH_ACCESS_CANCELLED");
  bool created = false;
  try {
    Owned directory(OpenUserChild(parent, segments.back(), true, OpenMode::create, &created));
    if (!Inspect(directory.value).directory) Fail();
    if (created) {
      impl_->Validate();
#ifndef _WIN32
      if (fsync(parent) != 0) Fail();
#endif
    }
    return created;
  } catch (...) { if (created) throw std::runtime_error("PATH_COMMIT_UNCONFIRMED"); throw; }
}

void PinnedPath::MoveChild(const std::vector<std::string>& segments, const PinnedPath& destination,
  bool replace, const std::function<bool()>& cancelled) const {
  if (!impl_ || !destination.impl_ || impl_->kind != Kind::directory || destination.impl_->kind != Kind::save ||
      impl_.get() == destination.impl_.get()) Fail();
  const std::scoped_lock lock(impl_->mutex, destination.impl_->mutex);
  const auto check = [&] { if (cancelled && cancelled()) throw std::runtime_error("PATH_ACCESS_CANCELLED"); };
  check(); impl_->Validate(); destination.impl_->Validate();
  std::vector<Owned> traversal;
  const auto parent = OpenParent(impl_->chain.back().handle.value, segments, traversal, cancelled);
  const auto target_parent = destination.impl_->chain.back().handle.value;
  Owned source(OpenUserChild(parent, segments.back(), false, OpenMode::remove));
  const auto identity = Inspect(source.value), target_identity = Inspect(target_parent);
  if (identity.directory) Fail();
#ifdef _WIN32
  if (identity.id.VolumeSerialNumber != target_identity.id.VolumeSerialNumber) throw std::runtime_error("PATH_CROSS_DEVICE");
#else
  if (identity.device != target_identity.device) throw std::runtime_error("PATH_CROSS_DEVICE");
#endif
  if (Same(Inspect(parent), target_identity) && segments.back() == destination.impl_->save_name) Fail();
  check(); impl_->Validate(); destination.impl_->Validate();
  CheckOutputSlot(target_parent, destination.impl_->save_name);
#ifdef _WIN32
  RenameFile(source.value, target_parent, destination.impl_->save_name, replace);
#elif defined(__APPLE__)
  // Directory write permission covers the current name slot, never a raw path from Renderer.
  if (renameatx_np(parent, segments.back().c_str(), target_parent, destination.impl_->save_name.c_str(), replace ? 0U : RENAME_EXCL) != 0) {
    if (!replace && (errno == EEXIST || errno == ENOTEMPTY)) throw std::runtime_error("PATH_OUTPUT_EXISTS");
    if (errno == EXDEV) throw std::runtime_error("PATH_CROSS_DEVICE");
    Fail();
  }
#else
  (void)replace; Fail();
#endif
  try {
    Owned committed(OpenChild(target_parent, destination.impl_->save_name, false));
    if (!Same(Inspect(committed.value), identity)) Fail();
#ifndef _WIN32
    if (fsync(parent) != 0 || fsync(target_parent) != 0) Fail();
#endif
  } catch (...) { throw std::runtime_error("PATH_COMMIT_UNCONFIRMED"); }
}

Metadata PinnedPath::Describe() const {
  if (!impl_ || impl_->kind == Kind::save) Fail();
  const std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->Validate(); const auto handle = impl_->chain.back().handle.value;
  const auto identity = Inspect(handle);
  std::uint64_t size = 0; std::int64_t modified = 0;
#ifdef _WIN32
  FILE_STANDARD_INFO standard{}; FILE_BASIC_INFO basic{};
  if (!GetFileInformationByHandleEx(handle, FileStandardInfo, &standard, sizeof(standard)) ||
      !GetFileInformationByHandleEx(handle, FileBasicInfo, &basic, sizeof(basic)) ||
      standard.EndOfFile.QuadPart < 0 || basic.LastWriteTime.QuadPart < 0) Fail();
  size = identity.directory ? 0 : static_cast<std::uint64_t>(standard.EndOfFile.QuadPart);
  modified = basic.LastWriteTime.QuadPart / 10'000 - 11'644'473'600'000LL;
#else
  struct stat info{}; if (fstat(handle, &info) != 0 || info.st_size < 0) Fail();
  size = identity.directory ? 0 : static_cast<std::uint64_t>(info.st_size);
#if defined(__APPLE__)
  const auto time = info.st_mtimespec;
#else
  const auto time = info.st_mtim;
#endif
  if (time.tv_sec < -8'640'000'000'000LL || time.tv_sec > 8'640'000'000'000LL || time.tv_nsec < 0 || time.tv_nsec >= 1'000'000'000) Fail();
  modified = static_cast<std::int64_t>(time.tv_sec) * 1000 + time.tv_nsec / 1'000'000;
#endif
  if (size > 9'007'199'254'740'991ULL || modified < -8'640'000'000'000'000LL || modified > 8'640'000'000'000'000LL) Fail();
  return {identity.directory, size, modified};
}

void PinnedPath::Save(const std::vector<unsigned char>& bytes, bool replace, const std::function<bool()>& cancelled) const {
  if (bytes.size() > 16 * 1024 * 1024) Fail();
  SaveProduced(bytes.size(), [&](const ByteSink& write_bytes) { write_bytes(bytes.data(), bytes.size()); }, replace, cancelled);
}

std::uint64_t PinnedPath::CopyFrom(const PinnedPath& source, bool replace, const std::function<bool()>& cancelled) const {
  if (&source == this) Fail();
  const auto metadata = source.Describe();
  if (metadata.directory) Fail();
  if (metadata.size > 2ULL * 1024 * 1024 * 1024) throw std::runtime_error("PATH_ACCESS_TOO_LARGE");
  SaveProduced(static_cast<std::size_t>(metadata.size), [&](const ByteSink& write_bytes) {
    for (std::uint64_t offset = 0; offset < metadata.size;) {
      const auto count = static_cast<std::size_t>(std::min<std::uint64_t>(64 * 1024, metadata.size - offset));
      const auto bytes = source.ReadRange({}, offset, count, cancelled);
      if (bytes.size() != count) Fail();
      write_bytes(bytes.data(), bytes.size()); offset += bytes.size();
    }
    const auto after = source.Describe();
    if (after.directory || after.size != metadata.size || after.modified_ms != metadata.modified_ms) Fail();
  }, replace, cancelled);
  return metadata.size;
}

struct StagedWrite::Impl {
  std::unique_ptr<PinnedPath::Impl> target;
  Owned stage{Invalid};
  Identity identity{};
  std::string temporary;
  std::uint64_t expected = 0, received = 0;
  bool replace = false;
  enum class State { staging, committed, aborted, unknown } state = State::staging;
  std::mutex mutex;
  void Discard() {
    if (stage.value == Invalid) return;
    // Never truncate after a successful or uncertain rename: this FD may now be the user's output.
    if (state == State::staging || state == State::aborted) {
      try {
        if (!Same(Inspect(stage.value), identity)) Fail();
#ifdef _WIN32
        LARGE_INTEGER zero{};
        if (!SetFilePointerEx(stage.value, zero, nullptr, FILE_BEGIN) || !SetEndOfFile(stage.value)) Fail();
#else
        if (ftruncate(stage.value, 0) != 0) Fail();
#endif
        FlushFile(stage.value);
      } catch (...) { throw std::runtime_error("PATH_STAGING_RETAINED"); }
    }
    stage = Owned(Invalid);
  }
  ~Impl() { try { Discard(); } catch (...) { /* Retain contents when object identity or cleanup cannot be confirmed. */ } }
};
StagedWrite::StagedWrite(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
StagedWrite::StagedWrite(StagedWrite&&) noexcept = default;
StagedWrite& StagedWrite::operator=(StagedWrite&&) noexcept = default;
StagedWrite::~StagedWrite() = default;

std::vector<unsigned char> StagedWrite::RecoveryProof() const {
  if (!impl_) Fail();
  const std::lock_guard<std::mutex> lock(impl_->mutex);
  if (impl_->state != Impl::State::staging || impl_->stage.value == Invalid) Fail();
  impl_->target->Validate();
  if (!Same(Inspect(impl_->stage.value), impl_->identity)) Fail();
  FlushFile(impl_->stage.value);
#ifndef _WIN32
  // Publish recovery evidence only after its initially empty inode and parent entry are durable.
  if (fsync(impl_->target->chain.back().handle.value) != 0) Fail();
  FlushFile(impl_->stage.value);
#endif
  Proof proof{'Z', 'P', 'W', '1',
#ifdef _WIN32
    1,
#else
    2,
#endif
    static_cast<unsigned char>(impl_->target->chain.size())};
  for (const auto& anchor : impl_->target->chain) ProofIdentity(proof, anchor.identity);
  ProofIdentity(proof, impl_->identity);
  ProofNumber(proof, impl_->target->save_name.size());
  proof.insert(proof.end(), impl_->target->save_name.begin(), impl_->target->save_name.end());
  proof.insert(proof.end(), impl_->temporary.begin(), impl_->temporary.end());
  return proof;
}

WriteObservation PinnedPath::ObserveWrite(const std::vector<unsigned char>& proof) const {
  if (!impl_ || impl_->kind != Kind::save || proof.size() > 8192) Fail();
  const std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->Validate();
  Proof prefix{'Z', 'P', 'W', '1',
#ifdef _WIN32
    1,
#else
    2,
#endif
    static_cast<unsigned char>(impl_->chain.size())};
  for (const auto& anchor : impl_->chain) ProofIdentity(prefix, anchor.identity);
  constexpr std::size_t identity_size =
#ifdef _WIN32
    25;
#else
    17;
#endif
  constexpr std::size_t temporary_length = sizeof(".ztools-save-") - 1 + 32;
  if (proof.size() < prefix.size() + identity_size + 8 + temporary_length || !std::equal(prefix.begin(), prefix.end(), proof.begin())) Fail();
  const auto identity_begin = prefix.size();
  if (proof[identity_begin + identity_size - 1] != 0) Fail();
  std::size_t offset = identity_begin + identity_size;
  std::uint64_t name_length = 0;
  for (unsigned shift = 0; shift < 64; shift += 8) name_length |= static_cast<std::uint64_t>(proof[offset++]) << shift;
  if (name_length != impl_->save_name.size() || name_length > proof.size() - offset || proof.size() - offset - name_length != temporary_length ||
      std::memcmp(impl_->save_name.data(), proof.data() + offset, impl_->save_name.size()) != 0) Fail();
  offset += static_cast<std::size_t>(name_length);
  const std::string temporary(proof.begin() + static_cast<std::ptrdiff_t>(offset), proof.end());
  if (temporary.rfind(".ztools-save-", 0) != 0 || temporary == impl_->save_name ||
      temporary.find_first_not_of("0123456789abcdef", sizeof(".ztools-save-") - 1) != std::string::npos) Fail();
  const auto observe = [&](const std::string& name) -> std::unique_ptr<Owned> {
    try {
      auto file = std::make_unique<Owned>(OpenChild(impl_->chain.back().handle.value, name, false));
      Proof identity; ProofIdentity(identity, Inspect(file->value));
      if (!std::equal(identity.begin(), identity.end(), proof.begin() + static_cast<std::ptrdiff_t>(identity_begin))) return {};
      return file;
    } catch (...) { return {}; }
  };
  // No inode-check-then-unlink/truncate race: recovery performs no name-slot mutations.
  auto stage = observe(temporary), target = observe(impl_->save_name);
  impl_->Validate();
  if (stage && !target) return {WriteObservation::State::staging, FileSize(stage->value)};
  if (target && !stage) return {WriteObservation::State::committed_object, FileSize(target->value)};
  return {WriteObservation::State::unresolved, 0};
}

StagedWrite PinnedPath::BeginWrite(std::uint64_t expected_size, bool replace, const std::function<bool()>& cancelled) const {
  if (!impl_ || impl_->kind != Kind::save || (expected_size != std::numeric_limits<std::uint64_t>::max() && expected_size > 2ULL * 1024 * 1024 * 1024)) Fail();
  const std::lock_guard<std::mutex> lock(impl_->mutex);
  if (cancelled && cancelled()) throw std::runtime_error("PATH_ACCESS_CANCELLED");
  impl_->Validate();
  auto result = std::make_unique<StagedWrite::Impl>();
  result->target = std::make_unique<PinnedPath::Impl>(); result->target->kind = Kind::save;
  result->target->save_name = impl_->save_name;
  for (const auto& anchor : impl_->chain) result->target->chain.push_back({Owned(Duplicate(anchor.handle.value)), anchor.name, anchor.identity});
  result->expected = expected_size; result->replace = replace;
  std::random_device random; constexpr char hex[] = "0123456789abcdef";
  result->temporary = ".ztools-save-";
  for (int i = 0; i < 32; ++i) result->temporary += hex[random() & 15U];
  CheckOutputSlot(result->target->chain.back().handle.value, result->target->save_name);
  result->stage = Owned(OpenChild(result->target->chain.back().handle.value, result->temporary, false, OpenMode::create));
  result->identity = Inspect(result->stage.value);
  if (result->identity.directory) Fail();
  return StagedWrite(std::move(result));
}

void StagedWrite::Append(const unsigned char* bytes, std::size_t size, const std::function<bool()>& cancelled) {
  if (!impl_) Fail();
  const std::lock_guard<std::mutex> lock(impl_->mutex);
  if (impl_->state != Impl::State::staging) Fail();
  try {
    if (size > 64 * 1024 || size > impl_->expected - impl_->received || size > 2ULL * 1024 * 1024 * 1024 - impl_->received || (size && !bytes)) Fail();
    if (cancelled && cancelled()) throw std::runtime_error("PATH_ACCESS_CANCELLED");
    impl_->target->Validate();
    for (std::size_t offset = 0; offset < size;) {
#ifdef _WIN32
      DWORD written = 0;
      if (!WriteFile(impl_->stage.value, bytes + offset, static_cast<DWORD>(size - offset), &written, nullptr) || !written) Fail();
      offset += written;
#else
      const auto written = write(impl_->stage.value, bytes + offset, size - offset);
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) Fail();
      offset += static_cast<std::size_t>(written);
#endif
    }
    impl_->received += size;
  } catch (...) { impl_->state = Impl::State::aborted; impl_->Discard(); throw; }
}

std::uint64_t StagedWrite::Commit(const std::function<bool()>& cancelled) {
  if (!impl_) Fail();
  const std::lock_guard<std::mutex> lock(impl_->mutex);
  if (impl_->state != Impl::State::staging) Fail();
  try {
  if (impl_->expected != std::numeric_limits<std::uint64_t>::max() && impl_->received != impl_->expected) Fail();
  if (cancelled && cancelled()) throw std::runtime_error("PATH_ACCESS_CANCELLED");
  const auto parent = impl_->target->chain.back().handle.value;
  FlushFile(impl_->stage.value);
  if (cancelled && cancelled()) throw std::runtime_error("PATH_ACCESS_CANCELLED");
  impl_->target->Validate();
  CheckOutputSlot(parent, impl_->target->save_name);
#ifdef _WIN32
  RenameFile(impl_->stage.value, parent, impl_->target->save_name, impl_->replace);
#elif defined(__APPLE__)
  // Atomic name-slot commit; EXCL prevents an accidental overwrite when replace is false.
  Owned before(OpenChild(parent, impl_->temporary, false));
  if (!Same(Inspect(before.value), impl_->identity)) Fail();
  if (renameatx_np(parent, impl_->temporary.c_str(), parent, impl_->target->save_name.c_str(), impl_->replace ? 0U : RENAME_EXCL) != 0) {
    if (!impl_->replace && (errno == EEXIST || errno == ENOTEMPTY)) throw std::runtime_error("PATH_OUTPUT_EXISTS");
    Fail();
  }
#else
  // No non-atomic fallback on platforms without the approved exclusive rename primitive.
  Fail();
#endif
  // After commit, failures are outcome-unknown; callers must not promise rollback.
  try {
    Owned committed(OpenChild(parent, impl_->target->save_name, false));
    if (!Same(Inspect(committed.value), impl_->identity)) Fail();
#ifndef _WIN32
    if (fsync(parent) != 0) Fail();
    FlushFile(impl_->stage.value);
#endif
  } catch (...) { impl_->state = Impl::State::unknown; throw std::runtime_error("PATH_COMMIT_UNCONFIRMED"); }
  impl_->state = Impl::State::committed; impl_->stage = Owned(Invalid); return impl_->received;
  } catch (...) { if (impl_->state != Impl::State::unknown) impl_->state = Impl::State::aborted; impl_->Discard(); throw; }
}

void StagedWrite::Abort() {
  if (!impl_) return;
  const std::lock_guard<std::mutex> lock(impl_->mutex);
  if (impl_->state == Impl::State::staging) impl_->state = Impl::State::aborted;
  // Clear only our exact retained scratch inode. Its empty basename remains for journal recovery.
  impl_->Discard();
}

void PinnedPath::SaveProduced(std::size_t expected_size, const std::function<void(const ByteSink&)>& producer,
  bool replace, const std::function<bool()>& cancelled) const {
  auto staged = BeginWrite(expected_size, replace, cancelled);
  try {
  producer([&](const unsigned char* bytes, std::size_t size) {
    if (size && !bytes) Fail();
    for (std::size_t offset = 0; offset < size;) {
      const auto count = std::min<std::size_t>(64 * 1024, size - offset);
      staged.Append(bytes + offset, count, cancelled); offset += count;
    }
  });
  staged.Commit(cancelled);
  } catch (...) { staged.Abort(); throw; }
}

std::vector<DirectoryEntry> PinnedPath::List(const std::vector<std::string>& segments,
  const std::function<bool()>& cancelled) const {
  if (!impl_ || impl_->kind != Kind::directory || segments.size() > 64) Fail();
  const std::lock_guard<std::mutex> lock(impl_->mutex);
  const auto check = [&] { if (cancelled && cancelled()) throw std::runtime_error("PATH_ACCESS_CANCELLED"); };
  check(); impl_->Validate();
  Handle directory = impl_->chain.back().handle.value;
  std::vector<Owned> traversal;
  for (const auto& segment : segments) {
    check(); Owned child(OpenUserChild(directory, segment, true));
    if (!Inspect(child.value).directory) Fail();
    directory = child.value; traversal.push_back(std::move(child));
  }
  std::vector<DirectoryEntry> result;
  std::size_t name_bytes = 0;
  const auto append = [&](std::string name, bool is_directory, std::uint64_t size) {
    if (name == "." || name == ".." || InternalName(name)) return;
    Segment(name);
    if (result.size() >= 10'000 || name.size() > 1024 * 1024 - name_bytes || size > 9'007'199'254'740'991ULL) {
      throw std::runtime_error("PATH_ACCESS_TOO_LARGE");
    }
    name_bytes += name.size(); result.push_back({std::move(name), is_directory, size});
  };
#ifdef _WIN32
  alignas(FILE_ID_BOTH_DIR_INFO) std::array<unsigned char, 64 * 1024> buffer{};
  bool first = true;
  for (;;) {
    check();
    const auto mode = first ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo;
    first = false;
    if (!GetFileInformationByHandleEx(directory, mode, buffer.data(), static_cast<DWORD>(buffer.size()))) {
      if (GetLastError() == ERROR_NO_MORE_FILES) break;
      Fail();
    }
    std::size_t offset = 0;
    for (;;) {
      constexpr std::size_t header = offsetof(FILE_ID_BOTH_DIR_INFO, FileName);
      if (offset > buffer.size() - header) Fail();
      const auto* entry = reinterpret_cast<const FILE_ID_BOTH_DIR_INFO*>(buffer.data() + offset);
      if (entry->FileNameLength % sizeof(wchar_t) || entry->FileNameLength > buffer.size() - offset - header || entry->FileNameLength > 4096) Fail();
      if (!(entry->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
        const int length = static_cast<int>(entry->FileNameLength / sizeof(wchar_t));
        const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, entry->FileName, length, nullptr, 0, nullptr, nullptr);
        if (bytes <= 0) Fail();
        std::string name(static_cast<std::size_t>(bytes), '\0');
        if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, entry->FileName, length, name.data(), bytes, nullptr, nullptr) != bytes) Fail();
        const bool folder = (entry->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        if (entry->EndOfFile.QuadPart < 0) Fail();
        append(std::move(name), folder, folder ? 0 : static_cast<std::uint64_t>(entry->EndOfFile.QuadPart));
      }
      if (!entry->NextEntryOffset) break;
      if (entry->NextEntryOffset < header || entry->NextEntryOffset > buffer.size() - offset) Fail();
      offset += entry->NextEntryOffset;
    }
  }
#else
  const int duplicate = fcntl(directory, F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) Fail();
  DIR* stream = fdopendir(duplicate);
  if (!stream) { close(duplicate); Fail(); }
  const std::unique_ptr<DIR, decltype(&closedir)> owned(stream, &closedir);
  rewinddir(stream);
  for (;;) {
    check(); errno = 0;
    const auto* entry = readdir(stream);
    if (!entry) { if (errno) Fail(); break; }
    const std::string name(entry->d_name);
    if (name == "." || name == "..") continue;
    struct stat info{};
    if (fstatat(directory, name.c_str(), &info, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) continue;
      Fail();
    }
    if (!S_ISDIR(info.st_mode) && !S_ISREG(info.st_mode)) continue;
    if (info.st_size < 0) Fail();
    append(name, S_ISDIR(info.st_mode), S_ISDIR(info.st_mode) ? 0 : static_cast<std::uint64_t>(info.st_size));
  }
#endif
  check(); return result;
}
}

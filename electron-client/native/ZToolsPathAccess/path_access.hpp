#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace ztools::path_access {
enum class Kind { file, directory, save, selected };
struct DirectoryEntry { std::string name; bool directory; std::uint64_t size; };
struct Metadata { bool directory; std::uint64_t size; std::int64_t modified_ms; };
// Recovery only observes authenticated main-owned records. It never replays or removes entries.
struct WriteObservation { enum class State { unresolved, staging, committed_object } state; std::uint64_t size; };
class StagedWrite;
class PinnedPath {
 public:
  static PinnedPath Open(const std::string& absolute_utf8, Kind kind);
  PinnedPath(PinnedPath&&) noexcept;
  PinnedPath& operator=(PinnedPath&&) noexcept;
  ~PinnedPath();
  PinnedPath(const PinnedPath&) = delete;
  PinnedPath& operator=(const PinnedPath&) = delete;
  std::vector<unsigned char> Read(const std::vector<std::string>& segments,
    std::size_t max_bytes, const std::function<bool()>& cancelled = {}) const;
  std::vector<unsigned char> ReadRange(const std::vector<std::string>& segments,
    std::uint64_t offset, std::size_t length, const std::function<bool()>& cancelled = {}) const;
  std::vector<DirectoryEntry> List(const std::vector<std::string>& segments,
    const std::function<bool()>& cancelled = {}) const;
  // Save grants authorize a basename slot in an existing pinned parent, never an existing inode.
  void Save(const std::vector<unsigned char>& bytes, bool replace,
    const std::function<bool()>& cancelled = {}) const;
  PinnedPath SaveChild(const std::vector<std::string>& segments) const;
  PinnedPath ReadChild(const std::vector<std::string>& segments) const;
  PinnedPath DirectoryChild(const std::vector<std::string>& segments) const;
  Metadata Describe() const;
  std::uint64_t CopyFrom(const PinnedPath& source, bool replace,
    const std::function<bool()>& cancelled = {}) const;
  // Directory write scope authorizes current child name slots; exact read-file grants cannot mutate them.
  void RemoveChild(const std::vector<std::string>& segments, bool directory,
    const std::function<bool()>& cancelled = {}) const;
  void MoveChild(const std::vector<std::string>& segments, const PinnedPath& destination, bool replace,
    const std::function<bool()>& cancelled = {}) const;
  bool CreateDirectoryChild(const std::vector<std::string>& segments, const std::function<bool()>& cancelled = {}) const;
  StagedWrite BeginWrite(std::uint64_t expected_size, bool replace,
    const std::function<bool()>& cancelled = {}) const;
  WriteObservation ObserveWrite(const std::vector<unsigned char>& proof) const;
 private:
  friend class StagedWrite;
  struct Impl;
  explicit PinnedPath(std::unique_ptr<Impl> impl);
  PinnedPath Child(const std::vector<std::string>& segments, Kind kind) const;
  using ByteSink = std::function<void(const unsigned char*, std::size_t)>;
  void SaveProduced(std::size_t expected_size, const std::function<void(const ByteSink&)>& producer,
    bool replace, const std::function<bool()>& cancelled) const;
  std::vector<unsigned char> ReadImpl(const std::vector<std::string>& segments,
    std::uint64_t offset, std::size_t length, bool entire, const std::function<bool()>& cancelled) const;
  std::unique_ptr<Impl> impl_;
};
class StagedWrite {
 public:
  StagedWrite(StagedWrite&&) noexcept;
  StagedWrite& operator=(StagedWrite&&) noexcept;
  ~StagedWrite();
  StagedWrite(const StagedWrite&) = delete;
  StagedWrite& operator=(const StagedWrite&) = delete;
  void Append(const unsigned char* bytes, std::size_t size, const std::function<bool()>& cancelled = {});
  std::uint64_t Commit(const std::function<bool()>& cancelled = {});
  void Abort();
  std::vector<unsigned char> RecoveryProof() const;
 private:
  friend class PinnedPath;
  struct Impl;
  explicit StagedWrite(std::unique_ptr<Impl> impl);
  std::unique_ptr<Impl> impl_;
};
}

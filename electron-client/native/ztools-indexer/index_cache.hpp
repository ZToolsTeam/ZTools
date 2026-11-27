#pragma once

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

#include "file_scanner.hpp"

namespace ztools::indexer {

// Atomic binary index snapshot (.zidx) for instant cold-start loading.
class IndexSnapshotCache {
public:
  static constexpr char kMagic[8] = {'Z', 'I', 'D', 'X', '0', '0', '0', '2'};
  static constexpr uint32_t kMaxEntries = 5000000u;
  static constexpr uint32_t kMaxStringLen = 32768u;

  static bool Save(
    const std::string& cache_path,
    const std::vector<FileEntry>& entries,
    const std::vector<std::string>& drive_roots
  ) {
    if (cache_path.empty()) return false;
    const std::string tmp_path = cache_path + ".tmp";

    std::ofstream out(tmp_path, std::ios::binary | std::ios::trunc);
    if (!out.is_open()) return false;

    auto write_u32 = [&](uint32_t v) { out.write(reinterpret_cast<const char*>(&v), sizeof(v)); };
    auto write_u64 = [&](uint64_t v) { out.write(reinterpret_cast<const char*>(&v), sizeof(v)); };
    auto write_u8 = [&](uint8_t v) { out.write(reinterpret_cast<const char*>(&v), sizeof(v)); };
    auto write_str = [&](const std::string& s) {
      const uint32_t len = static_cast<uint32_t>(s.size());
      write_u32(len);
      if (len > 0) out.write(s.data(), static_cast<std::streamsize>(len));
    };

    out.write(kMagic, sizeof(kMagic));
    write_u32(static_cast<uint32_t>(drive_roots.size()));
    for (const auto& root : drive_roots) {
      write_str(root);
    }

    const uint32_t count = static_cast<uint32_t>((std::min)(entries.size(), static_cast<size_t>(kMaxEntries)));
    write_u32(count);
    for (uint32_t i = 0; i < count; ++i) {
      const auto& e = entries[i];
      write_str(e.path);
      write_str(e.name);
      write_u64(e.size);
      write_u64(e.mtime);
      write_u8(e.is_dir ? 1u : 0u);
    }

    out.flush();
    const bool good = out.good();
    out.close();
    if (!good) {
      std::remove(tmp_path.c_str());
      return false;
    }

#ifdef _WIN32
    const std::wstring wtmp = Utf8ToWide(tmp_path);
    const std::wstring wdst = Utf8ToWide(cache_path);
    if (!MoveFileExW(wtmp.c_str(), wdst.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
      std::remove(tmp_path.c_str());
      return false;
    }
    return true;
#else
    if (std::rename(tmp_path.c_str(), cache_path.c_str()) != 0) {
      std::remove(tmp_path.c_str());
      return false;
    }
    return true;
#endif
  }

  static bool Load(
    const std::string& cache_path,
    std::vector<FileEntry>& out_entries,
    std::vector<std::string>& out_drive_roots
  ) {
    out_entries.clear();
    out_drive_roots.clear();
    if (cache_path.empty()) return false;

    std::ifstream in(cache_path, std::ios::binary);
    if (!in.is_open()) return false;

    char magic[8]{};
    if (!in.read(magic, sizeof(magic)) || std::memcmp(magic, kMagic, sizeof(kMagic)) != 0) {
      return false;
    }

    auto read_u32 = [&](uint32_t& v) -> bool {
      return static_cast<bool>(in.read(reinterpret_cast<char*>(&v), sizeof(v)));
    };
    auto read_u64 = [&](uint64_t& v) -> bool {
      return static_cast<bool>(in.read(reinterpret_cast<char*>(&v), sizeof(v)));
    };
    auto read_u8 = [&](uint8_t& v) -> bool {
      return static_cast<bool>(in.read(reinterpret_cast<char*>(&v), sizeof(v)));
    };
    auto read_str = [&](std::string& s) -> bool {
      uint32_t len = 0;
      if (!read_u32(len) || len > kMaxStringLen) return false;
      s.resize(len);
      if (len == 0) return true;
      return static_cast<bool>(in.read(s.data(), static_cast<std::streamsize>(len)));
    };

    uint32_t root_count = 0;
    if (!read_u32(root_count) || root_count > 128) return false;
    out_drive_roots.reserve(root_count);
    for (uint32_t i = 0; i < root_count; ++i) {
      std::string root;
      if (!read_str(root)) return false;
      out_drive_roots.push_back(std::move(root));
    }

    uint32_t count = 0;
    if (!read_u32(count) || count > kMaxEntries) return false;
    out_entries.reserve(count);

    for (uint32_t i = 0; i < count; ++i) {
      FileEntry e;
      uint8_t dir_flag = 0;
      if (!read_str(e.path) || !read_str(e.name) || !read_u64(e.size) || !read_u64(e.mtime) || !read_u8(dir_flag)) {
        out_entries.clear();
        out_drive_roots.clear();
        return false;
      }
      e.is_dir = (dir_flag != 0);
      FinalizeFileEntryMetadata(e);
      out_entries.push_back(std::move(e));
    }
    return true;
  }
};

} // namespace ztools::indexer

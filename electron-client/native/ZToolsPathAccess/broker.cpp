#include "path_access.hpp"
#include <cstdint>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
using Bytes = std::vector<unsigned char>;
namespace {
constexpr std::size_t MaxRequest = 16 * 1024 * 1024 + 32 * 1024;
void Put(Bytes& bytes, std::uint32_t value) {
  for (unsigned shift = 0; shift < 32; shift += 8) bytes.push_back(static_cast<unsigned char>(value >> shift));
}
struct Input {
  const Bytes& bytes;
  std::size_t position = 0;
  unsigned char Byte() { if (position == bytes.size()) throw std::runtime_error("INVALID_FRAME"); return bytes[position++]; }
  std::uint32_t Uint() {
    std::uint32_t value = 0;
    for (unsigned shift = 0; shift < 32; shift += 8) value |= static_cast<std::uint32_t>(Byte()) << shift;
    return value;
  }
  std::uint64_t Uint64() { const auto low = Uint(); return low | (static_cast<std::uint64_t>(Uint()) << 32); }
  Bytes Data() {
    const auto size = Uint();
    if (size > 16 * 1024 * 1024 || size > bytes.size() - position) throw std::runtime_error("INVALID_FRAME");
    Bytes result(bytes.begin() + static_cast<std::ptrdiff_t>(position), bytes.begin() + static_cast<std::ptrdiff_t>(position + size));
    position += size; return result;
  }
  std::string String() {
    const auto size = Uint();
    if (size > 4096 || size > bytes.size() - position) throw std::runtime_error("INVALID_FRAME");
    std::string result(bytes.begin() + static_cast<std::ptrdiff_t>(position), bytes.begin() + static_cast<std::ptrdiff_t>(position + size));
    position += size; return result;
  }
  void End() { if (position != bytes.size()) throw std::runtime_error("INVALID_FRAME"); }
};
bool Read(Bytes& bytes, std::size_t size) {
  bytes.resize(size);
  return static_cast<bool>(std::cin.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(size)));
}
void Reply(std::uint32_t request, bool success, const Bytes& data) {
  Bytes header; Put(header, static_cast<std::uint32_t>(5 + data.size())); Put(header, request); header.push_back(success ? 1 : 0);
  std::cout.write(reinterpret_cast<const char*>(header.data()), static_cast<std::streamsize>(header.size()));
  if (!data.empty()) std::cout.write(reinterpret_cast<const char*>(data.data()), static_cast<std::streamsize>(data.size()));
  std::cout.flush();
}
}
int main(int argc, char**) {
  if (argc != 1) return 2;
#ifdef _WIN32
  if (_setmode(_fileno(stdin), _O_BINARY) == -1 || _setmode(_fileno(stdout), _O_BINARY) == -1) return 2;
#endif
  std::map<std::uint32_t, ztools::path_access::PinnedPath> objects;
  std::uint32_t next_handle = 1;
  std::map<std::uint32_t, ztools::path_access::StagedWrite> writes;
  std::uint32_t next_write = 1;
  std::cout.write("ZPA1", 4); std::cout.flush();
  for (;;) {
    Bytes header;
    if (!Read(header, 4)) return std::cin.eof() && std::cin.gcount() == 0 ? 0 : 2;
    Input length{header}; const auto size = length.Uint();
    if (size < 5 || size > MaxRequest) return 2;
    Bytes frame;
    if (!Read(frame, size)) return 2;
    Input input{frame}; const auto request = input.Uint();
    try {
      const auto operation = input.Byte(); Bytes result;
      if (operation != 6 && operation != 14 && frame.size() > 32 * 1024) throw std::runtime_error("INVALID_FRAME");
      if (operation == 14 && frame.size() > 64 * 1024 + 32) throw std::runtime_error("INVALID_FRAME");
      switch (operation) {
        case 1: {
          const auto kind = input.Byte(); const auto path = input.String(); input.End();
          if (kind > 2 || objects.size() >= 256 || next_handle == 0) throw std::runtime_error("DENIED");
          auto object = ztools::path_access::PinnedPath::Open(path,
            kind == 0 ? ztools::path_access::Kind::file : kind == 1 ? ztools::path_access::Kind::directory : ztools::path_access::Kind::save);
          const auto handle = next_handle++; objects.emplace(handle, std::move(object)); Put(result, handle); break;
        }
        case 2: {
          const auto handle = input.Uint(), max_bytes = input.Uint(), count = input.Uint();
          if (count > 64) throw std::runtime_error("DENIED");
          std::vector<std::string> segments;
          for (std::uint32_t i = 0; i < count; ++i) segments.push_back(input.String());
          input.End();
          const auto found = objects.find(handle); if (found == objects.end()) throw std::runtime_error("DENIED");
          result = found->second.Read(segments, max_bytes); break;
        }
        case 21: {
          const auto path = input.String(); input.End();
          if (objects.size() >= 256 || next_handle == 0) throw std::runtime_error("DENIED");
          auto object = ztools::path_access::PinnedPath::Open(path, ztools::path_access::Kind::selected);
          const auto directory = object.Describe().directory;
          const auto handle = next_handle++; objects.emplace(handle, std::move(object));
          Put(result, handle); result.push_back(directory ? 1 : 0); break;
        }
        case 3: {
          const auto handle = input.Uint(); input.End();
          if (objects.erase(handle) != 1) throw std::runtime_error("DENIED"); break;
        }
        case 22:
        case 4: {
          const auto handle = input.Uint(), count = input.Uint();
          if (count > 64) throw std::runtime_error("DENIED");
          std::vector<std::string> segments;
          for (std::uint32_t i = 0; i < count; ++i) segments.push_back(input.String());
          input.End();
          const auto found = objects.find(handle); if (found == objects.end()) throw std::runtime_error("DENIED");
          const auto entries = found->second.List(segments, {}, operation == 22);
          Put(result, static_cast<std::uint32_t>(entries.size()));
          for (const auto& entry : entries) {
            Put(result, static_cast<std::uint32_t>(entry.name.size())); result.insert(result.end(), entry.name.begin(), entry.name.end());
            result.push_back(entry.directory ? 1 : 0);
            Put(result, static_cast<std::uint32_t>(entry.size)); Put(result, static_cast<std::uint32_t>(entry.size >> 32));
          }
          break;
        }
        case 5: {
          const auto handle = input.Uint(); const auto offset = input.Uint64();
          const auto range_length = input.Uint(), count = input.Uint();
          if (count > 64) throw std::runtime_error("DENIED");
          std::vector<std::string> segments;
          for (std::uint32_t i = 0; i < count; ++i) segments.push_back(input.String());
          input.End();
          const auto found = objects.find(handle); if (found == objects.end()) throw std::runtime_error("DENIED");
          result = found->second.ReadRange(segments, offset, range_length); break;
        }
        case 6: {
          const auto handle = input.Uint(); const auto replace = input.Byte(); const auto data = input.Data(); input.End();
          if (replace > 1) throw std::runtime_error("DENIED");
          const auto found = objects.find(handle); if (found == objects.end()) throw std::runtime_error("DENIED");
          found->second.Save(data, replace != 0); result.push_back(1); Put(result, static_cast<std::uint32_t>(data.size())); break;
        }
        case 7:
        case 8:
        case 20: {
          const auto handle = input.Uint(), count = input.Uint();
          if (!count || count > 64 || objects.size() >= 256 || next_handle == 0) throw std::runtime_error("DENIED");
          std::vector<std::string> segments;
          for (std::uint32_t i = 0; i < count; ++i) segments.push_back(input.String());
          input.End();
          const auto found = objects.find(handle); if (found == objects.end()) throw std::runtime_error("DENIED");
          auto child = operation == 7 ? found->second.SaveChild(segments) : operation == 8 ? found->second.ReadChild(segments) : found->second.DirectoryChild(segments);
          const auto id = next_handle++; objects.emplace(id, std::move(child)); Put(result, id); break;
        }
        case 9: {
          const auto handle = input.Uint(); input.End();
          const auto found = objects.find(handle); if (found == objects.end()) throw std::runtime_error("DENIED");
          const auto metadata = found->second.Describe(); result.push_back(metadata.directory ? 1 : 0);
          Put(result, static_cast<std::uint32_t>(metadata.size)); Put(result, static_cast<std::uint32_t>(metadata.size >> 32));
          const auto modified = static_cast<std::uint64_t>(metadata.modified_ms);
          Put(result, static_cast<std::uint32_t>(modified)); Put(result, static_cast<std::uint32_t>(modified >> 32)); break;
        }
        case 23: {
          const auto handle = input.Uint(); input.End();
          const auto found = objects.find(handle); if (found == objects.end()) throw std::runtime_error("DENIED");
          found->second.Trash(); result.push_back(1); break;
        }
        case 24: {
          const auto handle = input.Uint(); const auto name = input.String(); input.End();
          const auto found = objects.find(handle); if (found == objects.end()) throw std::runtime_error("DENIED");
          found->second.Rename(name); objects.erase(found); result.push_back(1); break;
        }
        case 10: {
          const auto source = input.Uint(), destination = input.Uint(); const auto replace = input.Byte(); input.End();
          const auto src = objects.find(source), dst = objects.find(destination);
          if (replace > 1 || src == objects.end() || dst == objects.end()) throw std::runtime_error("DENIED");
          const auto size_copied = dst->second.CopyFrom(src->second, replace != 0);
          result.push_back(1); Put(result, static_cast<std::uint32_t>(size_copied)); break;
        }
        case 11: {
          const auto handle = input.Uint(); const auto directory = input.Byte(); const auto count = input.Uint();
          if (directory > 1 || !count || count > 64) throw std::runtime_error("DENIED");
          std::vector<std::string> segments;
          for (std::uint32_t i = 0; i < count; ++i) segments.push_back(input.String());
          input.End();
          const auto found = objects.find(handle); if (found == objects.end()) throw std::runtime_error("DENIED");
          found->second.RemoveChild(segments, directory != 0); result.push_back(1); break;
        }
        case 12: {
          const auto source = input.Uint(), destination = input.Uint(); const auto replace = input.Byte(); const auto count = input.Uint();
          if (replace > 1 || !count || count > 64) throw std::runtime_error("DENIED");
          std::vector<std::string> segments;
          for (std::uint32_t i = 0; i < count; ++i) segments.push_back(input.String());
          input.End();
          const auto src = objects.find(source), dst = objects.find(destination);
          if (src == objects.end() || dst == objects.end()) throw std::runtime_error("DENIED");
          src->second.MoveChild(segments, dst->second, replace != 0); result.push_back(1); break;
        }
        case 13: {
          const auto handle = input.Uint(); const auto expected = input.Uint64(); const auto replace = input.Byte(); input.End();
          const auto found = objects.find(handle);
          if (replace > 1 || found == objects.end() || writes.size() >= 8 || next_write == 0) throw std::runtime_error("DENIED");
          auto write = found->second.BeginWrite(expected, replace != 0);
          const auto id = next_write++; writes.emplace(id, std::move(write)); Put(result, id); break;
        }
        case 14: {
          const auto id = input.Uint(); const auto bytes = input.Data(); input.End();
          const auto found = writes.find(id); if (found == writes.end()) throw std::runtime_error("DENIED");
          try { found->second.Append(bytes.data(), bytes.size()); }
          catch (...) { writes.erase(found); throw; }
          Put(result, static_cast<std::uint32_t>(bytes.size())); break;
        }
        case 15: {
          const auto id = input.Uint(); input.End();
          const auto found = writes.find(id); if (found == writes.end()) throw std::runtime_error("DENIED");
          std::uint64_t written = 0;
          try { written = found->second.Commit(); }
          catch (...) { writes.erase(found); throw; }
          writes.erase(found); result.push_back(1); Put(result, static_cast<std::uint32_t>(written)); break;
        }
        case 16: {
          const auto id = input.Uint(); input.End();
          const auto found = writes.find(id); if (found == writes.end()) throw std::runtime_error("DENIED");
          found->second.Abort(); writes.erase(found); break;
        }
        case 17: {
          const auto handle = input.Uint(), count = input.Uint();
          if (!count || count > 64) throw std::runtime_error("DENIED");
          std::vector<std::string> segments;
          for (std::uint32_t i = 0; i < count; ++i) segments.push_back(input.String());
          input.End();
          const auto found = objects.find(handle); if (found == objects.end()) throw std::runtime_error("DENIED");
          result.push_back(found->second.CreateDirectoryChild(segments) ? 1 : 0); break;
        }
        case 18: {
          const auto id = input.Uint(); input.End();
          const auto found = writes.find(id); if (found == writes.end()) throw std::runtime_error("DENIED");
          result = found->second.RecoveryProof(); break;
        }
        case 19: {
          const auto id = input.Uint(); const auto proof = input.Data(); input.End();
          const auto found = objects.find(id); if (found == objects.end()) throw std::runtime_error("DENIED");
          const auto observed = found->second.ObserveWrite(proof);
          result.push_back(observed.state == ztools::path_access::WriteObservation::State::staging ? 1 :
            observed.state == ztools::path_access::WriteObservation::State::committed_object ? 2 : 0);
          Put(result, static_cast<std::uint32_t>(observed.size)); Put(result, static_cast<std::uint32_t>(observed.size >> 32)); break;
        }
        default: throw std::runtime_error("INVALID_FRAME");
      }
      Reply(request, true, result);
    } catch (const std::exception& error) {
      // Never return file paths, OS diagnostics, or file contents in failure frames.
      const std::string code(error.what());
      const unsigned char status = code == "PATH_COMMIT_UNCONFIRMED" ? 2 : code == "PATH_OUTPUT_EXISTS" ? 3 : code == "PATH_ACCESS_TOO_LARGE" ? 4 : code == "PATH_CROSS_DEVICE" ? 5 : code == "PATH_STAGING_RETAINED" ? 6 : 1;
      Reply(request, false, {status});
    }
    if (!std::cout) return 2;
  }
}

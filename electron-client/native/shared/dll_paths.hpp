#pragma once
#include <Windows.h>
#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <cwctype>
#include <filesystem>
#include <limits>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace ztools::dll_paths {
class UniqueHandle {
 public:
  explicit UniqueHandle(HANDLE value = INVALID_HANDLE_VALUE) : value_(value) {}
  ~UniqueHandle() {
    if (value_ != INVALID_HANDLE_VALUE && value_ != nullptr) CloseHandle(value_);
  }
  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;
  UniqueHandle(UniqueHandle&& other) noexcept : value_(other.value_) {
    other.value_ = INVALID_HANDLE_VALUE;
  }
  UniqueHandle& operator=(UniqueHandle&& other) noexcept {
    if (this == &other) return *this;
    if (value_ != INVALID_HANDLE_VALUE && value_ != nullptr) CloseHandle(value_);
    value_ = other.value_;
    other.value_ = INVALID_HANDLE_VALUE;
    return *this;
  }
  HANDLE Get() const { return value_; }
  bool Valid() const { return value_ != INVALID_HANDLE_VALUE && value_ != nullptr; }
  HANDLE Release() {
    const HANDLE value = value_;
    value_ = INVALID_HANDLE_VALUE;
    return value;
  }

 private:
  HANDLE value_;
};

inline std::string LowerAscii(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::tolower(character));
  });
  return value;
}

inline std::wstring LowerWide(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(), [](wchar_t character) {
    return static_cast<wchar_t>(std::towlower(character));
  });
  return value;
}

inline bool NormalizeLocalRoot(std::wstring value, std::wstring& output) {
  std::replace(value.begin(), value.end(), L'/', L'\\');
  if (value.size() < 3 || value.size() > 32000 ||
      !std::iswalpha(value[0]) || value[1] != L':' || value[2] != L'\\') {
    return false;
  }
  const DWORD required = GetFullPathNameW(value.c_str(), 0, nullptr, nullptr);
  if (required == 0 || required > 32767) return false;
  std::vector<wchar_t> buffer(static_cast<std::size_t>(required) + 1);
  const DWORD length = GetFullPathNameW(
    value.c_str(), static_cast<DWORD>(buffer.size()), buffer.data(), nullptr);
  if (length == 0 || length >= buffer.size()) return false;
  output.assign(buffer.data(), length);
  while (output.size() > 3 && output.back() == L'\\') output.pop_back();
  return output.size() >= 3 && output[1] == L':' && output[2] == L'\\';
}

inline bool IsSafeIdentifier(std::string_view value, bool function_name = false) {
  if (value.empty() || value.size() > 128) return false;
  for (std::size_t index = 0; index < value.size(); ++index) {
    const unsigned char character = static_cast<unsigned char>(value[index]);
    const bool alpha = (character >= 'a' && character <= 'z') ||
      (character >= 'A' && character <= 'Z');
    const bool digit = character >= '0' && character <= '9';
    const bool punctuation = character == '_' || character == '-' || character == '.';
    const bool valid_first = function_name ? (alpha || character == '_') : (alpha || digit);
    if (!(alpha || digit || punctuation) || (index == 0 && !valid_first)) {
      return false;
    }
  }
  if (value.back() == '.') return false;
  if (!function_name) {
    const std::string lower = LowerAscii(std::string(value.substr(0, value.find('.'))));
    if (lower == "con" || lower == "prn" || lower == "aux" || lower == "nul") return false;
    if (lower.size() == 4 && (lower.starts_with("com") || lower.starts_with("lpt")) &&
        lower[3] >= '1' && lower[3] <= '9') {
      return false;
    }
  }
  return true;
}

inline bool Utf8ToWide(std::string_view value, std::wstring& output) {
  if (value.empty() || value.size() > 4096 || value.size() > static_cast<std::size_t>(INT_MAX)) return false;
  const int length = MultiByteToWideChar(
    CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (length <= 0) return false;
  output.resize(static_cast<std::size_t>(length));
  return MultiByteToWideChar(
    CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
    output.data(), length) == length;
}

inline bool IsWithinRoot(const std::wstring& root, const std::wstring& target) {
  return target.size() > root.size() && target[root.size()] == L'\\' &&
    CompareStringOrdinal(
      root.data(), static_cast<int>(root.size()),
      target.data(), static_cast<int>(root.size()), TRUE) == CSTR_EQUAL;
}

inline bool FinalHandleIsWithinRoot(HANDLE handle, const std::wstring& root) {
  const DWORD required = GetFinalPathNameByHandleW(
    handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (required == 0 || required > 32767) return false;
  std::vector<wchar_t> buffer(static_cast<std::size_t>(required) + 1);
  const DWORD length = GetFinalPathNameByHandleW(
    handle, buffer.data(), static_cast<DWORD>(buffer.size()),
    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (length == 0 || length >= buffer.size()) return false;
  std::wstring final_path(buffer.data(), length);
  if (final_path.starts_with(L"\\\\?\\")) final_path.erase(0, 4);
  return IsWithinRoot(root, final_path);
}

inline bool IsOrdinaryTreePath(const std::wstring& root, const std::wstring& target) {
  const DWORD root_attributes = GetFileAttributesW(root.c_str());
  if (root_attributes == INVALID_FILE_ATTRIBUTES ||
      (root_attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (root_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    return false;
  }
  if (!IsWithinRoot(root, target)) return false;
  std::wstring current = root;
  std::size_t offset = root.size() + 1;
  while (offset <= target.size()) {
    const std::size_t separator = target.find(L'\\', offset);
    current += L"\\" + target.substr(
      offset, separator == std::wstring::npos ? std::wstring::npos : separator - offset);
    const DWORD attributes = GetFileAttributesW(current.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
      return false;
    }
    const bool final = separator == std::wstring::npos;
    if (final) return (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) return false;
    offset = separator + 1;
  }
  return false;
}

inline bool ReadExactAt(HANDLE file, std::uint64_t offset, std::span<std::uint8_t> output) {
  LARGE_INTEGER position{};
  position.QuadPart = static_cast<LONGLONG>(offset);
  if (!SetFilePointerEx(file, position, nullptr, FILE_BEGIN)) return false;
  std::size_t total = 0;
  while (total < output.size()) {
    DWORD read = 0;
    const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(
      output.size() - total, std::numeric_limits<DWORD>::max()));
    if (!ReadFile(file, output.data() + total, requested, &read, nullptr) || read == 0) return false;
    total += read;
  }
  return true;
}

inline std::uint16_t ReadU16(const std::uint8_t* value) {
  return static_cast<std::uint16_t>(value[0]) |
    static_cast<std::uint16_t>(static_cast<std::uint16_t>(value[1]) << 8U);
}

inline std::uint32_t ReadU32(const std::uint8_t* value) {
  return static_cast<std::uint32_t>(value[0]) |
    (static_cast<std::uint32_t>(value[1]) << 8U) |
    (static_cast<std::uint32_t>(value[2]) << 16U) |
    (static_cast<std::uint32_t>(value[3]) << 24U);
}

inline bool IsX86Pe(HANDLE file, std::uint64_t file_size) {
  std::array<std::uint8_t, 64> dos{};
  if (file_size < dos.size() || !ReadExactAt(file, 0, dos) || ReadU16(dos.data()) != 0x5a4dU) return false;
  const std::uint32_t pe_offset = ReadU32(dos.data() + 0x3c);
  if (pe_offset < dos.size() || static_cast<std::uint64_t>(pe_offset) + 26U > file_size) return false;
  std::array<std::uint8_t, 26> header{};
  if (!ReadExactAt(file, pe_offset, header) || ReadU32(header.data()) != 0x00004550U) return false;
  const std::uint16_t machine = ReadU16(header.data() + 4);
  const std::uint16_t sections = ReadU16(header.data() + 6);
  const std::uint16_t optional_size = ReadU16(header.data() + 20);
  const std::uint16_t characteristics = ReadU16(header.data() + 22);
  const std::uint16_t optional_magic = ReadU16(header.data() + 24);
  const std::uint64_t section_table_end = static_cast<std::uint64_t>(pe_offset) + 24U +
    optional_size + static_cast<std::uint64_t>(sections) * 40U;
  return machine == IMAGE_FILE_MACHINE_I386 && sections > 0 && sections <= 96 &&
    optional_size >= 96 && optional_magic == IMAGE_NT_OPTIONAL_HDR32_MAGIC &&
    (characteristics & IMAGE_FILE_EXECUTABLE_IMAGE) != 0 &&
    (characteristics & IMAGE_FILE_DLL) != 0 && section_table_end <= file_size;
}

inline bool OpenOrdinaryFile(
  const std::wstring& path,
  std::uint64_t maximum,
  UniqueHandle& handle,
  std::uint64_t& size) {
  handle = UniqueHandle(CreateFileW(
    path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!handle.Valid()) return false;
  BY_HANDLE_FILE_INFORMATION information{};
  if (!GetFileInformationByHandle(handle.Get(), &information) ||
      (information.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    return false;
  }
  LARGE_INTEGER file_size{};
  if (!GetFileSizeEx(handle.Get(), &file_size) || file_size.QuadPart <= 0 ||
      static_cast<std::uint64_t>(file_size.QuadPart) > maximum) {
    return false;
  }
  size = static_cast<std::uint64_t>(file_size.QuadPart);
  return true;
}


// Resolve installed DLLs directly. There is no trust manifest or function allowlist.
template<class Result>
Result Resolve(const std::wstring& configured_root, const std::string& plugin_id,
               const std::string& dll_id, const std::optional<std::string>& function_name) {
  const auto fail = [](const char* code, const char* message) {
    Result result; result.code = code; result.message = message; return result;
  };
  if (!IsSafeIdentifier(plugin_id) || !IsSafeIdentifier(dll_id) ||
      (function_name && !IsSafeIdentifier(*function_name, true))) {
    return fail("INVALID_REQUEST", "plugin, dll, or function identifier is invalid");
  }
  std::wstring root, plugin, dll;
  if (!NormalizeLocalRoot(configured_root, root) ||
      !Utf8ToWide(plugin_id, plugin) || !Utf8ToWide(dll_id, dll)) {
    return fail("DLL_PATH_INVALID", "plugin directory is not configured");
  }
  const std::filesystem::path directory = std::filesystem::path(root) / plugin;
  const std::wstring filename = LowerWide(dll + L".dll");
  std::wstring target;
  try {
    const DWORD attributes = GetFileAttributesW(directory.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) return fail("DLL_UNAVAILABLE", "plugin directory is unavailable");
    if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return fail("DLL_PATH_INVALID", "plugin directory is a reparse point");
    for (auto it = std::filesystem::recursive_directory_iterator(directory);
         it != std::filesystem::recursive_directory_iterator(); ++it) {
      const auto current = it->path();
      const DWORD current_attributes = GetFileAttributesW(current.c_str());
      if ((current_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        it.disable_recursion_pending();
        continue;
      }
      if (!it->is_regular_file() || LowerWide(current.filename().wstring()) != filename) continue;
      if (!target.empty()) return fail("DLL_PATH_INVALID", "multiple DLL files have the same identifier");
      target = current.wstring();
    }
  } catch (const std::filesystem::filesystem_error&) {
    return fail("DLL_UNAVAILABLE", "plugin directory cannot be read");
  }
  if (target.empty()) return fail("DLL_UNAVAILABLE", "dll file is unavailable");
  if (!IsOrdinaryTreePath(root, target)) return fail("DLL_PATH_INVALID", "dll path is outside the plugin directory");
  UniqueHandle file;
  std::uint64_t size = 0;
  if (!OpenOrdinaryFile(target, 512ULL * 1024ULL * 1024ULL, file, size)) return fail("DLL_UNAVAILABLE", "dll file cannot be opened");
  if (!FinalHandleIsWithinRoot(file.Get(), directory.wstring())) return fail("DLL_PATH_INVALID", "dll resolved outside its plugin directory");
  if (!IsX86Pe(file.Get(), size)) return fail("DLL_ARCH_INVALID", "dll is not an x86 PE image");
  Result result;
  result.success = true;
  result.path = std::move(target);
  result.validation_handle = file.Release();
  return result;
}
}  // namespace ztools::dll_paths

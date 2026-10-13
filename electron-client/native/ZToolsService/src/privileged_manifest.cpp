#include "ztools_service/privileged_manifest.hpp"

#include "ztools_service/service_auth.hpp"

#include <Windows.h>
#include <bcrypt.h>
#include <shlwapi.h>
#include <wrl/client.h>
#include <xmllite.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <cwctype>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace ztools::service {
namespace {

using Microsoft::WRL::ComPtr;

constexpr wchar_t kManifestRegistrySubkey[] = L"SOFTWARE\\ZTools\\Service";
constexpr wchar_t kManifestRegistryValue[] = L"PrivilegedManifestSha256";
constexpr wchar_t kManifestFileName[] = L"privileged-dlls-v1.xml";
constexpr std::uint64_t kMaxManifestBytes = 1024U * 1024U;
constexpr std::uint64_t kMaxDllBytes = 512ULL * 1024ULL * 1024ULL;
constexpr std::size_t kMaxPlugins = 1000;
constexpr std::size_t kMaxDlls = 4096;
constexpr std::size_t kMaxFunctionsPerDll = 1024;

class UniqueHandle final {
 public:
  explicit UniqueHandle(const HANDLE value = INVALID_HANDLE_VALUE) noexcept
      : value_(value) {}
  ~UniqueHandle() {
    if (value_ != INVALID_HANDLE_VALUE && value_ != nullptr) {
      CloseHandle(value_);
    }
  }
  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;
  UniqueHandle(UniqueHandle&& other) noexcept : value_(other.value_) {
    other.value_ = INVALID_HANDLE_VALUE;
  }
  UniqueHandle& operator=(UniqueHandle&& other) noexcept {
    if (this != &other) {
      if (value_ != INVALID_HANDLE_VALUE && value_ != nullptr) {
        CloseHandle(value_);
      }
      value_ = other.value_;
      other.value_ = INVALID_HANDLE_VALUE;
    }
    return *this;
  }
  HANDLE get() const noexcept { return value_; }
  bool valid() const noexcept {
    return value_ != INVALID_HANDLE_VALUE && value_ != nullptr;
  }
  HANDLE release() noexcept {
    const HANDLE value = value_;
    value_ = INVALID_HANDLE_VALUE;
    return value;
  }

 private:
  HANDLE value_;
};

class AlgorithmHandle final {
 public:
  ~AlgorithmHandle() {
    if (value_ != nullptr) {
      BCryptCloseAlgorithmProvider(value_, 0);
    }
  }
  BCRYPT_ALG_HANDLE* address() noexcept { return &value_; }
  BCRYPT_ALG_HANDLE get() const noexcept { return value_; }

 private:
  BCRYPT_ALG_HANDLE value_ = nullptr;
};

class HashHandle final {
 public:
  ~HashHandle() {
    if (value_ != nullptr) {
      BCryptDestroyHash(value_);
    }
  }
  BCRYPT_HASH_HANDLE* address() noexcept { return &value_; }
  BCRYPT_HASH_HANDLE get() const noexcept { return value_; }

 private:
  BCRYPT_HASH_HANDLE value_ = nullptr;
};

struct ManifestEntry {
  std::string plugin_id;
  std::string dll_id;
  std::string relative_path;
  std::array<std::uint8_t, kPrivilegedManifestSha256Bytes> sha256{};
  std::set<std::string> functions;
};

PrivilegedManifestCheckResult Failure(
    const std::string_view code,
    const std::string_view message) {
  return {false, std::string(code), std::string(message)};
}

PrivilegedManifestResolveResult ResolveFailure(
    const std::string_view code,
    const std::string_view message) {
  PrivilegedManifestResolveResult result;
  result.code = code;
  result.message = message;
  return result;
}

std::string LowerAscii(std::string value) {
  std::transform(
      value.begin(), value.end(), value.begin(), [](const unsigned char character) {
        return static_cast<char>(std::tolower(character));
      });
  return value;
}

std::wstring LowerWide(std::wstring value) {
  std::transform(
      value.begin(), value.end(), value.begin(), [](const wchar_t character) {
        return static_cast<wchar_t>(std::towlower(character));
      });
  return value;
}

bool ParseHex(
    const std::wstring_view value,
    const std::span<std::uint8_t> output) noexcept {
  if (value.size() != output.size() * 2) {
    return false;
  }
  const auto nibble = [](const wchar_t character, std::uint8_t* const result) {
    if (character >= L'0' && character <= L'9') {
      *result = static_cast<std::uint8_t>(character - L'0');
      return true;
    }
    if (character >= L'a' && character <= L'f') {
      *result = static_cast<std::uint8_t>(character - L'a' + 10);
      return true;
    }
    if (character >= L'A' && character <= L'F') {
      *result = static_cast<std::uint8_t>(character - L'A' + 10);
      return true;
    }
    return false;
  };
  for (std::size_t index = 0; index < output.size(); ++index) {
    std::uint8_t high = 0;
    std::uint8_t low = 0;
    if (!nibble(value[index * 2], &high) ||
        !nibble(value[index * 2 + 1], &low)) {
      return false;
    }
    output[index] = static_cast<std::uint8_t>((high << 4U) | low);
  }
  return true;
}

bool NormalizeLocalRoot(std::wstring value, std::wstring* const output) {
  std::replace(value.begin(), value.end(), L'/', L'\\');
  if (value.size() < 3 || value.size() > 32000 ||
      std::iswalpha(value[0]) == 0 || value[1] != L':' || value[2] != L'\\') {
    return false;
  }
  const DWORD required = GetFullPathNameW(value.c_str(), 0, nullptr, nullptr);
  if (required == 0 || required > 32767) {
    return false;
  }
  std::vector<wchar_t> buffer(static_cast<std::size_t>(required) + 1);
  const DWORD length = GetFullPathNameW(
      value.c_str(), static_cast<DWORD>(buffer.size()), buffer.data(), nullptr);
  if (length == 0 || length >= buffer.size()) {
    return false;
  }
  output->assign(buffer.data(), length);
  while (output->size() > 3 && output->back() == L'\\') {
    output->pop_back();
  }
  return output->size() >= 3 && (*output)[1] == L':' && (*output)[2] == L'\\';
}

bool IsSafeIdentifier(
    const std::string_view value,
    const bool function_name = false) {
  if (value.empty() || value.size() > 128) {
    return false;
  }
  for (std::size_t index = 0; index < value.size(); ++index) {
    const unsigned char character = static_cast<unsigned char>(value[index]);
    const bool alpha = (character >= 'a' && character <= 'z') ||
                       (character >= 'A' && character <= 'Z');
    const bool digit = character >= '0' && character <= '9';
    const bool punctuation =
        character == '_' || character == '-' || character == '.';
    const bool valid_first = function_name ? (alpha || character == '_')
                                           : (alpha || digit);
    if (!(alpha || digit || punctuation) || (index == 0 && !valid_first)) {
      return false;
    }
  }
  if (value.back() == '.') {
    return false;
  }
  if (!function_name) {
    const std::string lower =
        LowerAscii(std::string(value.substr(0, value.find('.'))));
    if (lower == "con" || lower == "prn" || lower == "aux" || lower == "nul") {
      return false;
    }
    if (lower.size() == 4 &&
        (lower.starts_with("com") || lower.starts_with("lpt")) &&
        lower[3] >= '1' && lower[3] <= '9') {
      return false;
    }
  }
  return true;
}

bool IsReservedSegment(const std::wstring_view segment) {
  const std::size_t dot = segment.find(L'.');
  const std::wstring base = LowerWide(std::wstring(segment.substr(0, dot)));
  if (base == L"con" || base == L"prn" || base == L"aux" || base == L"nul") {
    return true;
  }
  return base.size() == 4 &&
         (base.starts_with(L"com") || base.starts_with(L"lpt")) &&
         base[3] >= L'1' && base[3] <= L'9';
}

bool Utf8ToWide(const std::string_view value, std::wstring* const output) {
  if (value.empty() || value.size() > 4096 ||
      value.size() > static_cast<std::size_t>(INT_MAX)) {
    return false;
  }
  const int length = MultiByteToWideChar(
      CP_UTF8,
      MB_ERR_INVALID_CHARS,
      value.data(),
      static_cast<int>(value.size()),
      nullptr,
      0);
  if (length <= 0) {
    return false;
  }
  output->resize(static_cast<std::size_t>(length));
  return MultiByteToWideChar(
             CP_UTF8,
             MB_ERR_INVALID_CHARS,
             value.data(),
             static_cast<int>(value.size()),
             output->data(),
             length) == length;
}

bool WideToUtf8(const std::wstring_view value, std::string* const output) {
  if (value.empty() || value.size() > static_cast<std::size_t>(INT_MAX)) {
    return false;
  }
  const int length = WideCharToMultiByte(
      CP_UTF8,
      WC_ERR_INVALID_CHARS,
      value.data(),
      static_cast<int>(value.size()),
      nullptr,
      0,
      nullptr,
      nullptr);
  if (length <= 0) {
    return false;
  }
  output->resize(static_cast<std::size_t>(length));
  return WideCharToMultiByte(
             CP_UTF8,
             WC_ERR_INVALID_CHARS,
             value.data(),
             static_cast<int>(value.size()),
             output->data(),
             length,
             nullptr,
             nullptr) == length;
}

bool IsWithinRoot(const std::wstring& root, const std::wstring& target) {
  return target.size() > root.size() && target[root.size()] == L'\\' &&
         CompareStringOrdinal(
             root.data(),
             static_cast<int>(root.size()),
             target.data(),
             static_cast<int>(root.size()),
             TRUE) == CSTR_EQUAL;
}

bool FinalHandleIsWithinRoot(const HANDLE handle, const std::wstring& root) {
  const DWORD required = GetFinalPathNameByHandleW(
      handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (required == 0 || required > 32767) {
    return false;
  }
  std::vector<wchar_t> buffer(static_cast<std::size_t>(required) + 1);
  const DWORD length = GetFinalPathNameByHandleW(
      handle,
      buffer.data(),
      static_cast<DWORD>(buffer.size()),
      FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (length == 0 || length >= buffer.size()) {
    return false;
  }
  std::wstring final_path(buffer.data(), length);
  if (final_path.starts_with(L"\\\\?\\")) {
    final_path.erase(0, 4);
  }
  return IsWithinRoot(root, final_path);
}

bool ValidateRelativeDllPath(
    const std::wstring& plugin_root,
    const std::string& plugin_id,
    const std::string& relative_path,
    std::wstring* const target) {
  if (!IsSafeIdentifier(plugin_id) || relative_path.empty() ||
      relative_path.size() > 4096 || relative_path.front() == '/' ||
      relative_path.find('\\') != std::string::npos ||
      relative_path.find(':') != std::string::npos) {
    return false;
  }
  std::wstring wide_path;
  if (!Utf8ToWide(relative_path, &wide_path)) {
    return false;
  }
  std::vector<std::wstring> segments;
  std::size_t offset = 0;
  while (offset <= wide_path.size()) {
    const std::size_t separator = wide_path.find(L'/', offset);
    const std::wstring segment = wide_path.substr(
        offset,
        separator == std::wstring::npos ? std::wstring::npos
                                        : separator - offset);
    if (segment.empty() || segment == L"." || segment == L".." ||
        segment.back() == L'.' || segment.back() == L' ' ||
        IsReservedSegment(segment)) {
      return false;
    }
    segments.push_back(segment);
    if (separator == std::wstring::npos) {
      break;
    }
    offset = separator + 1;
  }
  if (segments.size() < 2 || LowerWide(segments.front()) != L"lib" ||
      !LowerWide(segments.back()).ends_with(L".dll")) {
    return false;
  }

  std::wstring combined = plugin_root + L"\\";
  combined.append(plugin_id.begin(), plugin_id.end());
  for (const auto& segment : segments) {
    combined += L"\\" + segment;
  }
  const DWORD required = GetFullPathNameW(combined.c_str(), 0, nullptr, nullptr);
  if (required == 0 || required > 32767) {
    return false;
  }
  std::vector<wchar_t> buffer(static_cast<std::size_t>(required) + 1);
  const DWORD length = GetFullPathNameW(
      combined.c_str(),
      static_cast<DWORD>(buffer.size()),
      buffer.data(),
      nullptr);
  if (length == 0 || length >= buffer.size()) {
    return false;
  }
  target->assign(buffer.data(), length);
  return IsWithinRoot(plugin_root, *target);
}

bool IsOrdinaryTreePath(const std::wstring& root, const std::wstring& target) {
  const DWORD root_attributes = GetFileAttributesW(root.c_str());
  if (root_attributes == INVALID_FILE_ATTRIBUTES ||
      (root_attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (root_attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
      !IsWithinRoot(root, target)) {
    return false;
  }
  std::wstring current = root;
  std::size_t offset = root.size() + 1;
  while (offset <= target.size()) {
    const std::size_t separator = target.find(L'\\', offset);
    current += L"\\" + target.substr(
                           offset,
                           separator == std::wstring::npos
                               ? std::wstring::npos
                               : separator - offset);
    const DWORD attributes = GetFileAttributesW(current.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES ||
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
      return false;
    }
    const bool final = separator == std::wstring::npos;
    if (final) {
      return (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
    }
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
      return false;
    }
    offset = separator + 1;
  }
  return false;
}

bool CreateSha256(
    AlgorithmHandle* const algorithm,
    HashHandle* const hash,
    std::vector<std::uint8_t>* const object) {
  if (BCryptOpenAlgorithmProvider(
          algorithm->address(), BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) {
    return false;
  }
  DWORD object_length = 0;
  DWORD copied = 0;
  if (BCryptGetProperty(
          algorithm->get(),
          BCRYPT_OBJECT_LENGTH,
          reinterpret_cast<PUCHAR>(&object_length),
          sizeof(object_length),
          &copied,
          0) != 0) {
    return false;
  }
  object->resize(object_length);
  return BCryptCreateHash(
             algorithm->get(),
             hash->address(),
             object->data(),
             object_length,
             nullptr,
             0,
             0) == 0;
}

bool HashBytes(
    const std::span<const std::uint8_t> bytes,
    std::array<std::uint8_t, kPrivilegedManifestSha256Bytes>* const output) {
  if (bytes.size() > std::numeric_limits<ULONG>::max()) {
    return false;
  }
  AlgorithmHandle algorithm;
  HashHandle hash;
  std::vector<std::uint8_t> object;
  if (!CreateSha256(&algorithm, &hash, &object)) {
    return false;
  }
  const bool success =
      BCryptHashData(
          hash.get(),
          const_cast<PUCHAR>(bytes.data()),
          static_cast<ULONG>(bytes.size()),
          0) == 0 &&
      BCryptFinishHash(
          hash.get(), output->data(), static_cast<ULONG>(output->size()), 0) == 0;
  SecureEraseServiceBytes(object);
  return success;
}

bool HashFile(
    const HANDLE file,
    std::array<std::uint8_t, kPrivilegedManifestSha256Bytes>* const output) {
  LARGE_INTEGER start{};
  if (SetFilePointerEx(file, start, nullptr, FILE_BEGIN) == FALSE) {
    return false;
  }
  AlgorithmHandle algorithm;
  HashHandle hash;
  std::vector<std::uint8_t> object;
  if (!CreateSha256(&algorithm, &hash, &object)) {
    return false;
  }
  std::array<std::uint8_t, 64U * 1024U> buffer{};
  while (true) {
    DWORD read = 0;
    if (ReadFile(
            file,
            buffer.data(),
            static_cast<DWORD>(buffer.size()),
            &read,
            nullptr) == FALSE) {
      SecureEraseServiceBytes(object);
      return false;
    }
    if (read == 0) {
      break;
    }
    if (BCryptHashData(hash.get(), buffer.data(), read, 0) != 0) {
      SecureEraseServiceBytes(object);
      return false;
    }
  }
  const bool success = BCryptFinishHash(
                           hash.get(),
                           output->data(),
                           static_cast<ULONG>(output->size()),
                           0) == 0;
  SecureEraseServiceBytes(object);
  return success;
}

bool ReadExactAt(
    const HANDLE file,
    const std::uint64_t offset,
    const std::span<std::uint8_t> output) {
  LARGE_INTEGER position{};
  position.QuadPart = static_cast<LONGLONG>(offset);
  if (SetFilePointerEx(file, position, nullptr, FILE_BEGIN) == FALSE) {
    return false;
  }
  std::size_t total = 0;
  while (total < output.size()) {
    DWORD read = 0;
    const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(
        output.size() - total, std::numeric_limits<DWORD>::max()));
    if (ReadFile(file, output.data() + total, requested, &read, nullptr) == FALSE ||
        read == 0) {
      return false;
    }
    total += read;
  }
  return true;
}

std::uint16_t ReadU16(const std::uint8_t* const value) noexcept {
  return static_cast<std::uint16_t>(value[0]) |
         static_cast<std::uint16_t>(
             static_cast<std::uint16_t>(value[1]) << 8U);
}

std::uint32_t ReadU32(const std::uint8_t* const value) noexcept {
  return static_cast<std::uint32_t>(value[0]) |
         (static_cast<std::uint32_t>(value[1]) << 8U) |
         (static_cast<std::uint32_t>(value[2]) << 16U) |
         (static_cast<std::uint32_t>(value[3]) << 24U);
}

bool IsX86Pe(const HANDLE file, const std::uint64_t file_size) {
  std::array<std::uint8_t, 64> dos{};
  if (file_size < dos.size() || !ReadExactAt(file, 0, dos) ||
      ReadU16(dos.data()) != 0x5a4dU) {
    return false;
  }
  const std::uint32_t pe_offset = ReadU32(dos.data() + 0x3c);
  if (pe_offset < dos.size() ||
      static_cast<std::uint64_t>(pe_offset) + 26U > file_size) {
    return false;
  }
  std::array<std::uint8_t, 26> header{};
  if (!ReadExactAt(file, pe_offset, header) ||
      ReadU32(header.data()) != 0x00004550U) {
    return false;
  }
  const std::uint16_t machine = ReadU16(header.data() + 4);
  const std::uint16_t sections = ReadU16(header.data() + 6);
  const std::uint16_t optional_size = ReadU16(header.data() + 20);
  const std::uint16_t characteristics = ReadU16(header.data() + 22);
  const std::uint16_t optional_magic = ReadU16(header.data() + 24);
  const std::uint64_t section_table_end =
      static_cast<std::uint64_t>(pe_offset) + 24U + optional_size +
      static_cast<std::uint64_t>(sections) * 40U;
  return machine == IMAGE_FILE_MACHINE_I386 && sections > 0 && sections <= 96 &&
         optional_size >= 96 &&
         optional_magic == IMAGE_NT_OPTIONAL_HDR32_MAGIC &&
         (characteristics & IMAGE_FILE_EXECUTABLE_IMAGE) != 0 &&
         (characteristics & IMAGE_FILE_DLL) != 0 &&
         section_table_end <= file_size;
}

bool OpenOrdinaryFile(
    const std::wstring& path,
    const std::uint64_t maximum,
    UniqueHandle* const handle,
    std::uint64_t* const size) {
  *handle = UniqueHandle(CreateFileW(
      path.c_str(),
      GENERIC_READ,
      FILE_SHARE_READ,
      nullptr,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr));
  if (!handle->valid()) {
    return false;
  }
  BY_HANDLE_FILE_INFORMATION information{};
  if (GetFileInformationByHandle(handle->get(), &information) == FALSE ||
      (information.dwFileAttributes &
       (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    return false;
  }
  LARGE_INTEGER file_size{};
  if (GetFileSizeEx(handle->get(), &file_size) == FALSE ||
      file_size.QuadPart <= 0 ||
      static_cast<std::uint64_t>(file_size.QuadPart) > maximum) {
    return false;
  }
  *size = static_cast<std::uint64_t>(file_size.QuadPart);
  return true;
}

bool ReadFileBytes(
    const std::wstring& path,
    const std::uint64_t maximum,
    std::vector<std::uint8_t>* const bytes,
    UniqueHandle* const handle) {
  std::uint64_t size = 0;
  if (!OpenOrdinaryFile(path, maximum, handle, &size) ||
      size > std::numeric_limits<std::size_t>::max()) {
    return false;
  }
  bytes->resize(static_cast<std::size_t>(size));
  return ReadExactAt(handle->get(), 0, *bytes);
}

bool ReadAttributes(
    IXmlReader* const reader,
    std::map<std::wstring, std::wstring>* const attributes,
    std::string* const error) {
  HRESULT result = reader->MoveToFirstAttribute();
  if (result == S_FALSE) {
    return true;
  }
  while (result == S_OK) {
    const wchar_t* prefix = nullptr;
    const wchar_t* namespace_uri = nullptr;
    const wchar_t* local_name = nullptr;
    const wchar_t* value = nullptr;
    UINT prefix_length = 0;
    UINT namespace_length = 0;
    UINT name_length = 0;
    UINT value_length = 0;
    if (FAILED(reader->GetPrefix(&prefix, &prefix_length)) || prefix_length != 0 ||
        FAILED(reader->GetNamespaceUri(&namespace_uri, &namespace_length)) ||
        namespace_length != 0 ||
        FAILED(reader->GetLocalName(&local_name, &name_length)) || name_length == 0 ||
        FAILED(reader->GetValue(&value, &value_length)) || value_length > 4096) {
      *error = "manifest attribute is invalid";
      return false;
    }
    const std::wstring name(local_name, name_length);
    if (!attributes->emplace(name, std::wstring(value, value_length)).second) {
      *error = "manifest contains duplicate attributes";
      return false;
    }
    result = reader->MoveToNextAttribute();
  }
  if (FAILED(result) || FAILED(reader->MoveToElement())) {
    *error = "manifest attributes cannot be read";
    return false;
  }
  return true;
}

bool HasExactAttributes(
    const std::map<std::wstring, std::wstring>& attributes,
    const std::initializer_list<std::wstring_view> names) {
  if (attributes.size() != names.size()) {
    return false;
  }
  return std::all_of(
      names.begin(), names.end(), [&attributes](const std::wstring_view name) {
        return attributes.contains(std::wstring(name));
      });
}

bool ElementName(IXmlReader* const reader, std::wstring* const name) {
  const wchar_t* local_name = nullptr;
  const wchar_t* prefix = nullptr;
  const wchar_t* namespace_uri = nullptr;
  UINT name_length = 0;
  UINT prefix_length = 0;
  UINT namespace_length = 0;
  if (FAILED(reader->GetPrefix(&prefix, &prefix_length)) || prefix_length != 0 ||
      FAILED(reader->GetNamespaceUri(&namespace_uri, &namespace_length)) ||
      namespace_length != 0 ||
      FAILED(reader->GetLocalName(&local_name, &name_length)) || name_length == 0) {
    return false;
  }
  name->assign(local_name, name_length);
  return true;
}

bool ParseManifest(
    const std::vector<std::uint8_t>& bytes,
    std::vector<ManifestEntry>* const entries,
    std::string* const error) {
  if (bytes.size() > std::numeric_limits<UINT>::max()) {
    return false;
  }
  ComPtr<IStream> stream;
  stream.Attach(SHCreateMemStream(bytes.data(), static_cast<UINT>(bytes.size())));
  if (!stream) {
    *error = "manifest stream cannot be created";
    return false;
  }
  ComPtr<IXmlReader> reader;
  if (FAILED(CreateXmlReader(
          __uuidof(IXmlReader),
          reinterpret_cast<void**>(reader.GetAddressOf()),
          nullptr)) ||
      FAILED(reader->SetProperty(
          XmlReaderProperty_DtdProcessing, DtdProcessing_Prohibit)) ||
      FAILED(reader->SetProperty(XmlReaderProperty_MaxElementDepth, 8)) ||
      FAILED(reader->SetInput(stream.Get()))) {
    *error = "manifest parser cannot be initialized";
    return false;
  }

  bool root_open = false;
  bool root_closed = false;
  std::string current_plugin;
  std::optional<ManifestEntry> current_dll;
  std::set<std::string> plugin_keys;
  std::set<std::string> dll_keys;
  XmlNodeType node_type = XmlNodeType_None;
  HRESULT result = S_OK;
  while ((result = reader->Read(&node_type)) == S_OK) {
    if (node_type == XmlNodeType_XmlDeclaration ||
        node_type == XmlNodeType_Whitespace) {
      continue;
    }
    UINT depth = 0;
    if (FAILED(reader->GetDepth(&depth))) {
      *error = "manifest depth cannot be read";
      return false;
    }
    std::wstring name;
    if ((node_type == XmlNodeType_Element ||
         node_type == XmlNodeType_EndElement) &&
        !ElementName(reader.Get(), &name)) {
      *error = "manifest element name is invalid";
      return false;
    }

    if (node_type == XmlNodeType_Element) {
      if (root_closed) {
        *error = "manifest contains data after the root element";
        return false;
      }
      std::map<std::wstring, std::wstring> attributes;
      if (!ReadAttributes(reader.Get(), &attributes, error)) {
        return false;
      }
      const BOOL empty = reader->IsEmptyElement();
      if (depth == 0 && name == L"privilegedDllManifest" && !root_open) {
        if (!HasExactAttributes(attributes, {L"version"}) ||
            attributes[L"version"] != L"1") {
          *error = "manifest root attributes are invalid";
          return false;
        }
        root_open = empty == FALSE;
        root_closed = empty != FALSE;
        continue;
      }
      if (!root_open || depth == 0) {
        *error = "manifest root element is invalid";
        return false;
      }
      if (depth == 1 && name == L"plugin" && current_plugin.empty() &&
          !current_dll) {
        if (!HasExactAttributes(attributes, {L"id"}) || empty != FALSE ||
            !WideToUtf8(attributes[L"id"], &current_plugin) ||
            !IsSafeIdentifier(current_plugin) ||
            plugin_keys.size() >= kMaxPlugins ||
            !plugin_keys.insert(LowerAscii(current_plugin)).second) {
          *error = "manifest plugin entry is invalid";
          return false;
        }
        continue;
      }
      if (depth == 2 && name == L"dll" && !current_plugin.empty() &&
          !current_dll) {
        if (!HasExactAttributes(attributes, {L"id", L"path", L"sha256", L"arch"}) ||
            empty != FALSE || attributes[L"arch"] != L"x86") {
          *error = "manifest dll entry is invalid";
          return false;
        }
        ManifestEntry entry;
        entry.plugin_id = current_plugin;
        if (!WideToUtf8(attributes[L"id"], &entry.dll_id) ||
            !IsSafeIdentifier(entry.dll_id) ||
            !WideToUtf8(attributes[L"path"], &entry.relative_path) ||
            !ParseHex(attributes[L"sha256"], entry.sha256)) {
          *error = "manifest dll attributes are invalid";
          return false;
        }
        const std::string dll_key = LowerAscii(entry.plugin_id) +
                                    std::string(1, '\0') +
                                    LowerAscii(entry.dll_id);
        if (dll_keys.size() >= kMaxDlls ||
            !dll_keys.insert(dll_key).second) {
          *error = "manifest contains duplicate dll identifiers";
          return false;
        }
        current_dll = std::move(entry);
        continue;
      }
      if (depth == 3 && name == L"function" && current_dll) {
        std::string function_name;
        if (!HasExactAttributes(attributes, {L"name"}) || empty == FALSE ||
            !WideToUtf8(attributes[L"name"], &function_name) ||
            !IsSafeIdentifier(function_name, true) ||
            current_dll->functions.size() >= kMaxFunctionsPerDll ||
            !current_dll->functions.insert(function_name).second) {
          *error = "manifest function entry is invalid";
          return false;
        }
        continue;
      }
      *error = "manifest contains an unsupported element";
      return false;
    }

    if (node_type == XmlNodeType_EndElement) {
      if (name == L"dll" && current_dll && !current_plugin.empty()) {
        if (current_dll->functions.empty()) {
          *error = "manifest dll has no allowed functions";
          return false;
        }
        entries->push_back(std::move(*current_dll));
        current_dll.reset();
        continue;
      }
      if (name == L"plugin" && !current_plugin.empty() && !current_dll) {
        current_plugin.clear();
        continue;
      }
      if (name == L"privilegedDllManifest" && root_open &&
          current_plugin.empty() && !current_dll) {
        root_open = false;
        root_closed = true;
        continue;
      }
      std::string closing_name;
      WideToUtf8(name, &closing_name);
      *error = "manifest closing element is invalid at depth " +
               std::to_string(depth) + ": " + closing_name;
      return false;
    }

    *error = "manifest contains unsupported XML content";
    return false;
  }
  if (result != S_FALSE || !root_closed || root_open ||
      !current_plugin.empty() || current_dll) {
    *error = "manifest XML is incomplete or invalid";
    return false;
  }
  return true;
}

PrivilegedManifestCheckResult LoadManifest(
    const PrivilegedManifestTrustConfig& config,
    std::vector<ManifestEntry>* const entries) {
  const std::wstring service_root = config.data_root + L"\\Service";
  const std::wstring manifest_path = service_root + L"\\" + kManifestFileName;
  if (!IsOrdinaryTreePath(config.data_root, manifest_path)) {
    return Failure(
        "MANIFEST_UNAVAILABLE", "trusted privileged manifest is unavailable");
  }
  std::vector<std::uint8_t> bytes;
  UniqueHandle manifest;
  if (!ReadFileBytes(
          manifest_path, kMaxManifestBytes, &bytes, &manifest)) {
    return Failure(
        "MANIFEST_UNAVAILABLE", "trusted privileged manifest cannot be read");
  }
  if (!FinalHandleIsWithinRoot(manifest.get(), service_root)) {
    return Failure(
        "MANIFEST_UNAVAILABLE",
        "trusted privileged manifest resolved outside the service root");
  }
  std::array<std::uint8_t, kPrivilegedManifestSha256Bytes> digest{};
  if (!HashBytes(bytes, &digest) ||
      !ConstantTimeServiceEqual(digest, config.manifest_sha256)) {
    SecureEraseServiceBytes(digest);
    return Failure(
        "MANIFEST_INTEGRITY", "trusted privileged manifest digest mismatch");
  }
  SecureEraseServiceBytes(digest);
  std::string error;
  if (!ParseManifest(bytes, entries, &error)) {
    return Failure("MANIFEST_INVALID", error);
  }
  return {true, {}, {}};
}

PrivilegedManifestResolveResult ValidateDllFile(
    const PrivilegedManifestTrustConfig& config,
    const ManifestEntry& entry) {
  const std::wstring plugin_root = config.data_root + L"\\Plugins";
  std::wstring target;
  if (!ValidateRelativeDllPath(
          plugin_root,
          entry.plugin_id,
          entry.relative_path,
          &target) ||
      !IsOrdinaryTreePath(plugin_root, target)) {
    return ResolveFailure(
        "DLL_PATH_INVALID", "dll path is outside the trusted plugin root");
  }
  UniqueHandle file;
  std::uint64_t size = 0;
  if (!OpenOrdinaryFile(target, kMaxDllBytes, &file, &size)) {
    return ResolveFailure("DLL_UNAVAILABLE", "dll file is unavailable");
  }
  if (!FinalHandleIsWithinRoot(file.get(), plugin_root)) {
    return ResolveFailure(
        "DLL_PATH_INVALID", "dll handle resolved outside the trusted plugin root");
  }
  if (!IsX86Pe(file.get(), size)) {
    return ResolveFailure("DLL_ARCH_INVALID", "dll is not an x86 PE image");
  }
  std::array<std::uint8_t, kPrivilegedManifestSha256Bytes> digest{};
  if (!HashFile(file.get(), &digest) ||
      !ConstantTimeServiceEqual(digest, entry.sha256)) {
    SecureEraseServiceBytes(digest);
    return ResolveFailure("DLL_INTEGRITY", "dll digest mismatch");
  }
  SecureEraseServiceBytes(digest);
  PrivilegedManifestResolveResult result;
  result.success = true;
  result.path = std::move(target);
  result.validation_handle = file.release();
  return result;
}

}  // namespace

bool ParsePrivilegedManifestSha256(
    const std::wstring& value,
    std::array<std::uint8_t, kPrivilegedManifestSha256Bytes>* const output) noexcept {
  if (output == nullptr) {
    return false;
  }
  output->fill(0);
  if (!ParseHex(value, *output)) {
    SecureEraseServiceBytes(*output);
    return false;
  }
  return true;
}

bool ReadInstalledPrivilegedManifestTrustConfig(
    const std::wstring& data_root,
    PrivilegedManifestTrustConfig* const config,
    DWORD* const error) noexcept {
  if (config == nullptr || error == nullptr) {
    return false;
  }
  config->data_root.clear();
  SecureEraseServiceBytes(config->manifest_sha256);
  config->trusted = false;
  *error = ERROR_SUCCESS;
  try {
    config->data_root = data_root;
  } catch (...) {
    *error = ERROR_NOT_ENOUGH_MEMORY;
    return false;
  }

  std::array<wchar_t, 65> value{};
  DWORD type = REG_NONE;
  DWORD bytes = static_cast<DWORD>(value.size() * sizeof(wchar_t));
  const LSTATUS registry_result = RegGetValueW(
      HKEY_LOCAL_MACHINE,
      kManifestRegistrySubkey,
      kManifestRegistryValue,
      RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY | RRF_NOEXPAND,
      &type,
      value.data(),
      &bytes);
  if (registry_result != ERROR_SUCCESS) {
    *error = static_cast<DWORD>(registry_result);
    return true;
  }
  std::size_t digest_length = 0;
  while (digest_length < value.size() && value[digest_length] != L'\0') {
    ++digest_length;
  }
  const bool valid_digest =
      type == REG_SZ && digest_length == 64 &&
      ParseHex(
          std::wstring_view(value.data(), digest_length),
          config->manifest_sha256);
  SecureZeroMemory(value.data(), value.size() * sizeof(wchar_t));
  if (!valid_digest) {
    SecureEraseServiceBytes(config->manifest_sha256);
    *error = ERROR_INVALID_DATA;
    return true;
  }
  config->trusted = true;
  return true;
}

PrivilegedManifestResolver::PrivilegedManifestResolver(
    PrivilegedManifestTrustConfig config)
    : config_(std::move(config)) {
  std::wstring normalized_root;
  if (!config_.trusted ||
      !NormalizeLocalRoot(config_.data_root, &normalized_root)) {
    config_.trusted = false;
    config_.data_root.clear();
    SecureEraseServiceBytes(config_.manifest_sha256);
    return;
  }
  config_.data_root = std::move(normalized_root);
}

PrivilegedManifestResolver::~PrivilegedManifestResolver() {
  SecureEraseServiceBytes(config_.manifest_sha256);
}

bool PrivilegedManifestResolver::trusted() const noexcept {
  return config_.trusted;
}

PrivilegedManifestCheckResult PrivilegedManifestResolver::Check(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::string& function_name) const {
  PrivilegedManifestResolveResult result =
      Resolve(plugin_id, dll_id, function_name);
  return {result.success, std::move(result.code), std::move(result.message)};
}

PrivilegedManifestResolveResult PrivilegedManifestResolver::Resolve(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::optional<std::string>& function_name) const {
  if (!config_.trusted) {
    return ResolveFailure(
        "MANIFEST_UNTRUSTED", "trusted privileged manifest is not configured");
  }
  if (!IsSafeIdentifier(plugin_id) || !IsSafeIdentifier(dll_id) ||
      (function_name && !IsSafeIdentifier(*function_name, true))) {
    return ResolveFailure(
        "INVALID_REQUEST", "plugin, dll, or function identifier is invalid");
  }
  std::vector<ManifestEntry> entries;
  const PrivilegedManifestCheckResult loaded = LoadManifest(config_, &entries);
  if (!loaded.success) {
    return ResolveFailure(loaded.code, loaded.message);
  }
  const auto entry = std::find_if(
      entries.begin(), entries.end(), [&](const ManifestEntry& item) {
        return item.plugin_id == plugin_id && item.dll_id == dll_id;
      });
  if (entry == entries.end()) {
    return ResolveFailure(
        "DLL_NOT_ALLOWED", "dll is not present in the trusted manifest");
  }
  if (function_name && !entry->functions.contains(*function_name)) {
    return ResolveFailure(
        "FUNCTION_NOT_ALLOWED",
        "function is not allowed by the trusted manifest");
  }
  return ValidateDllFile(config_, *entry);
}

PrivilegedManifestResolveResult::~PrivilegedManifestResolveResult() {
  if (validation_handle != INVALID_HANDLE_VALUE && validation_handle != nullptr) {
    CloseHandle(validation_handle);
  }
}

PrivilegedManifestResolveResult::PrivilegedManifestResolveResult(
    PrivilegedManifestResolveResult&& other) noexcept
    : success(other.success),
      code(std::move(other.code)),
      message(std::move(other.message)),
      path(std::move(other.path)),
      validation_handle(other.validation_handle) {
  other.validation_handle = INVALID_HANDLE_VALUE;
}

PrivilegedManifestResolveResult&
PrivilegedManifestResolveResult::operator=(
    PrivilegedManifestResolveResult&& other) noexcept {
  if (this != &other) {
    if (validation_handle != INVALID_HANDLE_VALUE && validation_handle != nullptr) {
      CloseHandle(validation_handle);
    }
    success = other.success;
    code = std::move(other.code);
    message = std::move(other.message);
    path = std::move(other.path);
    validation_handle = other.validation_handle;
    other.validation_handle = INVALID_HANDLE_VALUE;
  }
  return *this;
}

}  // namespace ztools::service

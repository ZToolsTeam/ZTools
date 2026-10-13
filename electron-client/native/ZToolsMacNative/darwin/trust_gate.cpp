#include "ztools_mac_native_trust_gate_v1.h"

#include <CommonCrypto/CommonDigest.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <dlfcn.h>
#include <mach-o/fat.h>
#include <mach-o/loader.h>
#include <sys/codesign.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

namespace {

constexpr uint64_t kMaximumComponentBytes = 512ull * 1024ull * 1024ull;
constexpr uint32_t kMaximumMachCommandsBytes = 16u * 1024u * 1024u;

template <typename T>
class CFRef final {
 public:
  explicit CFRef(T value = nullptr) noexcept : value_(value) {}
  ~CFRef() { if (value_ != nullptr) CFRelease(value_); }
  CFRef(const CFRef&) = delete;
  CFRef& operator=(const CFRef&) = delete;
  T get() const noexcept { return value_; }
  T* address() noexcept { return &value_; }
  explicit operator bool() const noexcept { return value_ != nullptr; }

 private:
  T value_;
};

class UniqueFd final {
 public:
  explicit UniqueFd(int descriptor = -1) noexcept : descriptor_(descriptor) {}
  ~UniqueFd() { reset(); }
  UniqueFd(const UniqueFd&) = delete;
  UniqueFd& operator=(const UniqueFd&) = delete;
  int get() const noexcept { return descriptor_; }
  int release() noexcept {
    const int descriptor = descriptor_;
    descriptor_ = -1;
    return descriptor;
  }
  void reset(int descriptor = -1) noexcept {
    if (descriptor_ >= 0) close(descriptor_);
    descriptor_ = descriptor;
  }

 private:
  int descriptor_;
};

void setResult(zt_mac_native_trust_result_v1* result, zt_mac_native_trust_status_v1 status,
               OSStatus securityStatus = errSecSuccess) noexcept {
  if (result == nullptr) return;
  *result = {};
  result->struct_size = static_cast<uint32_t>(sizeof(*result));
  result->status = static_cast<uint32_t>(status);
  result->security_status = securityStatus;
  result->may_load = 0;
}

bool isValidUtf8(const uint8_t* data, uint32_t length) noexcept {
  if (data == nullptr || length == 0) return false;
  uint32_t index = 0;
  while (index < length) {
    const uint8_t first = data[index];
    if (first <= 0x7f) {
      ++index;
      continue;
    }
    uint32_t continuationCount = 0;
    uint8_t minimumSecond = 0x80;
    uint8_t maximumSecond = 0xbf;
    if (first >= 0xc2 && first <= 0xdf) {
      continuationCount = 1;
    } else if (first == 0xe0) {
      continuationCount = 2;
      minimumSecond = 0xa0;
    } else if (first >= 0xe1 && first <= 0xec) {
      continuationCount = 2;
    } else if (first == 0xed) {
      continuationCount = 2;
      maximumSecond = 0x9f;
    } else if (first >= 0xee && first <= 0xef) {
      continuationCount = 2;
    } else if (first == 0xf0) {
      continuationCount = 3;
      minimumSecond = 0x90;
    } else if (first >= 0xf1 && first <= 0xf3) {
      continuationCount = 3;
    } else if (first == 0xf4) {
      continuationCount = 3;
      maximumSecond = 0x8f;
    } else {
      return false;
    }
    if (length - index <= continuationCount || data[index + 1] < minimumSecond ||
        data[index + 1] > maximumSecond) {
      return false;
    }
    for (uint32_t offset = 2; offset <= continuationCount; ++offset) {
      if (data[index + offset] < 0x80 || data[index + offset] > 0xbf) return false;
    }
    index += continuationCount + 1;
  }
  return true;
}

bool readField(const uint8_t* data, uint32_t length, uint32_t maximum, std::string* output) {
  if (data == nullptr || output == nullptr || length == 0 || length > maximum ||
      std::memchr(data, 0, length) != nullptr || !isValidUtf8(data, length)) {
    return false;
  }
  output->assign(reinterpret_cast<const char*>(data), length);
  return true;
}

bool isTeamIdentifier(const std::string& value) noexcept {
  if (value.size() != 10) return false;
  for (const unsigned char character : value) {
    if (!((character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9'))) return false;
  }
  return true;
}

bool isBundleIdentifier(const std::string& value) noexcept {
  if (value.size() < 3 || value.find('.') == std::string::npos) return false;
  for (const unsigned char character : value) {
    if (!((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') ||
          (character >= '0' && character <= '9') || character == '.' || character == '-')) {
      return false;
    }
  }
  return true;
}

bool isSha256Hex(const std::string& value) noexcept {
  if (value.size() != 64) return false;
  for (const unsigned char character : value) {
    if (!((character >= 'A' && character <= 'F') || (character >= 'a' && character <= 'f') ||
          (character >= '0' && character <= '9'))) {
      return false;
    }
  }
  return true;
}

bool isSafePathSegment(const std::string& value) noexcept {
  if (value.empty() || value == "." || value == "..") return false;
  for (const unsigned char character : value) {
    if (!((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') ||
          (character >= '0' && character <= '9') || character == '.' || character == '_' || character == '-')) {
      return false;
    }
  }
  return true;
}

bool isSafeRootPathSegment(const std::string& value) noexcept {
  return !value.empty() && value != "." && value != ".." && value.size() <= 255 &&
      value.find('\0') == std::string::npos && value.find('/') == std::string::npos;
}

bool openAbsoluteDirectoryNoFollow(const std::string& absolutePath, int* output) {
  if (output == nullptr || absolutePath.empty() || absolutePath.front() != '/' ||
      absolutePath.size() > 4096 || absolutePath.find('\\') != std::string::npos) return false;
  UniqueFd current(open("/", O_RDONLY | O_CLOEXEC | O_DIRECTORY));
  if (current.get() < 0) return false;
  size_t start = 1;
  while (start < absolutePath.size()) {
    const size_t end = absolutePath.find('/', start);
    const std::string segment = absolutePath.substr(start,
        end == std::string::npos ? std::string::npos : end - start);
    if (!isSafeRootPathSegment(segment)) return false;
    const int next = openat(current.get(), segment.c_str(), O_RDONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW);
    if (next < 0) return false;
    current.reset(next);
    if (end == std::string::npos) break;
    start = end + 1;
  }
  *output = current.release();
  return true;
}

bool openPinnedCandidate(const std::string& rootPath, const std::string& pluginId,
                         const std::string& relativePath, int* output, struct stat* statOutput) {
  if (output == nullptr || statOutput == nullptr || !isSafePathSegment(pluginId) ||
      relativePath.empty() || relativePath.front() == '/' || relativePath.size() > 1024 ||
      relativePath.find('\\') != std::string::npos) return false;
  int current = -1;
  if (!openAbsoluteDirectoryNoFollow(rootPath, &current)) return false;
  UniqueFd currentDirectory(current);
  const int pluginDirectory = openat(currentDirectory.get(), pluginId.c_str(), O_RDONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW);
  if (pluginDirectory < 0) return false;
  currentDirectory.reset(pluginDirectory);
  size_t start = 0;
  while (true) {
    const size_t end = relativePath.find('/', start);
    const std::string segment = relativePath.substr(start,
        end == std::string::npos ? std::string::npos : end - start);
    if (!isSafePathSegment(segment)) return false;
    if (end == std::string::npos) {
      if (segment.size() <= 6 || segment.substr(segment.size() - 6) != ".dylib") {
        return false;
      }
      UniqueFd descriptor(openat(currentDirectory.get(), segment.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
      if (descriptor.get() < 0) return false;
      struct stat info {};
      if (fstat(descriptor.get(), &info) != 0 || !S_ISREG(info.st_mode) || info.st_size <= 0 ||
          static_cast<uint64_t>(info.st_size) > kMaximumComponentBytes) {
        return false;
      }
      *output = descriptor.release();
      *statOutput = info;
      return true;
    }
    const int next = openat(currentDirectory.get(), segment.c_str(), O_RDONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW);
    if (next < 0) return false;
    currentDirectory.reset(next);
    start = end + 1;
  }
}

bool hashDescriptor(int descriptor, const struct stat& before, std::string* hexDigest) {
  if (descriptor < 0 || hexDigest == nullptr || lseek(descriptor, 0, SEEK_SET) < 0) return false;
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  uint8_t buffer[64 * 1024];
  uint64_t totalBytes = 0;
  while (true) {
    const ssize_t count = read(descriptor, buffer, sizeof(buffer));
    if (count == 0) break;
    if (count < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    const uint64_t readBytes = static_cast<uint64_t>(count);
    if (readBytes > kMaximumComponentBytes - totalBytes) return false;
    totalBytes += readBytes;
    CC_SHA256_Update(&context, buffer, static_cast<CC_LONG>(count));
  }
  struct stat after {};
  if (fstat(descriptor, &after) != 0 || before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
      before.st_size != after.st_size || before.st_mtime != after.st_mtime || before.st_ctime != after.st_ctime ||
      before.st_gen != after.st_gen || totalBytes != static_cast<uint64_t>(before.st_size)) return false;
  uint8_t digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &context);
  static constexpr char kHex[] = "0123456789abcdef";
  hexDigest->clear();
  hexDigest->reserve(sizeof(digest) * 2);
  for (const uint8_t byte : digest) {
    hexDigest->push_back(kHex[byte >> 4]);
    hexDigest->push_back(kHex[byte & 0x0f]);
  }
  return true;
}

bool readAt(int descriptor, off_t offset, void* target, size_t length) {
  auto* bytes = static_cast<uint8_t*>(target);
  size_t total = 0;
  while (total < length) {
    const ssize_t count = pread(descriptor, bytes + total, length - total, offset + static_cast<off_t>(total));
    if (count <= 0) {
      if (count < 0 && errno == EINTR) continue;
      return false;
    }
    total += static_cast<size_t>(count);
  }
  return true;
}

uint32_t swap32(uint32_t value) noexcept { return __builtin_bswap32(value); }
uint64_t swap64(uint64_t value) noexcept { return __builtin_bswap64(value); }

bool parseVersion(const std::string& value, uint32_t output[3]) noexcept {
  if (output == nullptr || value.empty()) return false;
  output[0] = output[1] = output[2] = 0;
  size_t partIndex = 0;
  uint32_t part = 0;
  size_t digits = 0;
  for (size_t index = 0; index <= value.size(); ++index) {
    const char character = index == value.size() ? '.' : value[index];
    if (character == '.') {
      if (digits == 0 || partIndex >= 3) return false;
      output[partIndex++] = part;
      part = 0;
      digits = 0;
      continue;
    }
    if (character < '0' || character > '9' || part > 6553 || (part == 6553 && character > '5')) return false;
    part = part * 10 + static_cast<uint32_t>(character - '0');
    ++digits;
  }
  return partIndex >= 2 && partIndex <= 3;
}

bool versionLess(const uint32_t lhs[3], const uint32_t rhs[3]) noexcept {
  for (size_t index = 0; index < 3; ++index) {
    if (lhs[index] != rhs[index]) return lhs[index] < rhs[index];
  }
  return false;
}

bool readCurrentOsVersion(uint32_t output[3]) {
  char value[128]{};
  size_t length = sizeof(value);
  if (sysctlbyname("kern.osproductversion", value, &length, nullptr, 0) != 0 || length == 0) return false;
  const size_t valueLength = strnlen(value, sizeof(value));
  if (valueLength == sizeof(value)) return false;
  return parseVersion(std::string(value, valueLength), output);
}

bool isSystemLibraryPath(const std::string& path) noexcept {
  if (path.rfind("/System/Library/", 0) != 0 && path.rfind("/usr/lib/", 0) != 0) return false;
  size_t start = 1;
  while (start < path.size()) {
    const size_t end = path.find('/', start);
    const std::string segment = path.substr(start, end == std::string::npos ? std::string::npos : end - start);
    if (segment.empty() || segment == "." || segment == "..") return false;
    for (const unsigned char character : segment) {
      if (!((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') ||
            (character >= '0' && character <= '9') || character == '.' || character == '_' ||
            character == '-' || character == '+')) return false;
    }
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return path.back() != '/';
}

enum class LoadValidationResult { Valid, ArchitectureInvalid, DependencyClosureUnproven };

LoadValidationResult validateLoadCommands(int descriptor, const std::string& architecture,
                                          const std::string& approvedMinimumOs) {
  struct stat fileInfo {};
  if (fstat(descriptor, &fileInfo) != 0 || fileInfo.st_size < static_cast<off_t>(sizeof(mach_header_64))) {
    return LoadValidationResult::DependencyClosureUnproven;
  }
  uint64_t sliceOffset = 0;
  uint64_t sliceSize = static_cast<uint64_t>(fileInfo.st_size);
  uint32_t magic = 0;
  if (!readAt(descriptor, 0, &magic, sizeof(magic))) return LoadValidationResult::DependencyClosureUnproven;
  const bool fat = magic == FAT_MAGIC || magic == FAT_CIGAM || magic == FAT_MAGIC_64 || magic == FAT_CIGAM_64;
  if (fat) {
    const bool swapped = magic == FAT_CIGAM || magic == FAT_CIGAM_64;
    struct fat_header header {};
    if (!readAt(descriptor, 0, &header, sizeof(header))) return LoadValidationResult::DependencyClosureUnproven;
    const uint32_t count = swapped ? swap32(header.nfat_arch) : header.nfat_arch;
    const bool wide = magic == FAT_MAGIC_64 || magic == FAT_CIGAM_64;
    const size_t archBytes = wide ? sizeof(struct fat_arch_64) : sizeof(struct fat_arch);
    if (count == 0 || count > 32 || sizeof(header) + static_cast<uint64_t>(count) * archBytes > sliceSize) {
      return LoadValidationResult::DependencyClosureUnproven;
    }
    bool found = false;
    for (uint32_t index = 0; index < count; ++index) {
      const uint64_t position = sizeof(header) + static_cast<uint64_t>(index) * archBytes;
      cpu_type_t cpuType = CPU_TYPE_ANY;
      uint64_t offset = 0;
      uint64_t size = 0;
      if (wide) {
        struct fat_arch_64 architectureEntry {};
        if (!readAt(descriptor, static_cast<off_t>(position), &architectureEntry, sizeof(architectureEntry))) {
          return LoadValidationResult::DependencyClosureUnproven;
        }
        cpuType = swapped ? static_cast<cpu_type_t>(swap32(static_cast<uint32_t>(architectureEntry.cputype)))
                          : architectureEntry.cputype;
        offset = swapped ? swap64(architectureEntry.offset) : architectureEntry.offset;
        size = swapped ? swap64(architectureEntry.size) : architectureEntry.size;
      } else {
        struct fat_arch architectureEntry {};
        if (!readAt(descriptor, static_cast<off_t>(position), &architectureEntry, sizeof(architectureEntry))) {
          return LoadValidationResult::DependencyClosureUnproven;
        }
        cpuType = swapped ? static_cast<cpu_type_t>(swap32(static_cast<uint32_t>(architectureEntry.cputype)))
                          : architectureEntry.cputype;
        offset = swapped ? swap32(architectureEntry.offset) : architectureEntry.offset;
        size = swapped ? swap32(architectureEntry.size) : architectureEntry.size;
      }
      const cpu_type_t expected = architecture == "arm64" ? CPU_TYPE_ARM64 : CPU_TYPE_X86_64;
      if (cpuType == expected) {
        if (found || size < sizeof(mach_header_64) || offset > sliceSize || size > sliceSize - offset) {
          return LoadValidationResult::DependencyClosureUnproven;
        }
        sliceOffset = offset;
        sliceSize = size;
        found = true;
      }
    }
    if (!found) return LoadValidationResult::ArchitectureInvalid;
  }

  struct mach_header_64 header {};
  if (!readAt(descriptor, static_cast<off_t>(sliceOffset), &header, sizeof(header))) {
    return LoadValidationResult::DependencyClosureUnproven;
  }
  const bool swapped = header.magic == MH_CIGAM_64;
  if (header.magic != MH_MAGIC_64 && !swapped) return LoadValidationResult::DependencyClosureUnproven;
  const cpu_type_t expectedCpu = architecture == "arm64" ? CPU_TYPE_ARM64 : CPU_TYPE_X86_64;
  const cpu_type_t actualCpu = swapped ? static_cast<cpu_type_t>(swap32(static_cast<uint32_t>(header.cputype))) : header.cputype;
  const uint32_t commandCount = swapped ? swap32(header.ncmds) : header.ncmds;
  const uint32_t commandBytes = swapped ? swap32(header.sizeofcmds) : header.sizeofcmds;
  if (actualCpu != expectedCpu) return LoadValidationResult::ArchitectureInvalid;
  if (commandCount == 0 || commandCount > 16384 || commandBytes == 0 ||
      commandBytes > kMaximumMachCommandsBytes || sizeof(header) + commandBytes > sliceSize) {
    return LoadValidationResult::DependencyClosureUnproven;
  }
  std::vector<uint8_t> commands(commandBytes);
  if (!readAt(descriptor, static_cast<off_t>(sliceOffset + sizeof(header)), commands.data(), commands.size())) {
    return LoadValidationResult::DependencyClosureUnproven;
  }
  size_t cursor = 0;
  bool minimumOsFound = false;
  uint32_t componentMinimum[3]{};
  uint32_t approvedMinimum[3]{};
  uint32_t currentOs[3]{};
  if (!parseVersion(approvedMinimumOs, approvedMinimum) || !readCurrentOsVersion(currentOs)) {
    return LoadValidationResult::DependencyClosureUnproven;
  }
  for (uint32_t index = 0; index < commandCount; ++index) {
    if (commands.size() - cursor < sizeof(load_command)) return LoadValidationResult::DependencyClosureUnproven;
    load_command command{};
    std::memcpy(&command, commands.data() + cursor, sizeof(command));
    const uint32_t commandType = swapped ? swap32(command.cmd) : command.cmd;
    const uint32_t commandSize = swapped ? swap32(command.cmdsize) : command.cmdsize;
    if (commandSize < sizeof(load_command) || (commandSize & 3u) != 0 || commandSize > commands.size() - cursor) {
      return LoadValidationResult::DependencyClosureUnproven;
    }
    if (commandType == LC_RPATH) return LoadValidationResult::DependencyClosureUnproven;
#ifdef LC_DYLD_ENVIRONMENT
    if (commandType == LC_DYLD_ENVIRONMENT) return LoadValidationResult::DependencyClosureUnproven;
#endif
    if (commandType == LC_BUILD_VERSION) {
      if (commandSize < sizeof(build_version_command) || minimumOsFound) {
        return LoadValidationResult::DependencyClosureUnproven;
      }
      build_version_command build{};
      std::memcpy(&build, commands.data() + cursor, sizeof(build));
      const uint32_t platform = swapped ? swap32(build.platform) : build.platform;
      const uint32_t toolCount = swapped ? swap32(build.ntools) : build.ntools;
      if (platform != PLATFORM_MACOS ||
          static_cast<uint64_t>(sizeof(build_version_command)) +
              static_cast<uint64_t>(toolCount) * sizeof(build_tool_version) != commandSize) {
        return LoadValidationResult::DependencyClosureUnproven;
      }
      const uint32_t minimum = swapped ? swap32(build.minos) : build.minos;
      componentMinimum[0] = minimum >> 16;
      componentMinimum[1] = (minimum >> 8) & 0xffu;
      componentMinimum[2] = minimum & 0xffu;
      minimumOsFound = true;
    } else if (commandType == LC_VERSION_MIN_MACOSX) {
      if (commandSize != sizeof(version_min_command) || minimumOsFound) {
        return LoadValidationResult::DependencyClosureUnproven;
      }
      version_min_command build{};
      std::memcpy(&build, commands.data() + cursor, sizeof(build));
      const uint32_t minimum = swapped ? swap32(build.version) : build.version;
      componentMinimum[0] = minimum >> 16;
      componentMinimum[1] = (minimum >> 8) & 0xffu;
      componentMinimum[2] = minimum & 0xffu;
      minimumOsFound = true;
    } else if (commandType == LC_LOAD_DYLIB || commandType == LC_LOAD_WEAK_DYLIB ||
               commandType == LC_REEXPORT_DYLIB || commandType == LC_LOAD_UPWARD_DYLIB ||
               commandType == LC_LAZY_LOAD_DYLIB) {
      if (commandSize < sizeof(dylib_command)) return LoadValidationResult::DependencyClosureUnproven;
      dylib_command dependency{};
      std::memcpy(&dependency, commands.data() + cursor, sizeof(dependency));
      const uint32_t nameOffset = swapped ? swap32(dependency.dylib.name.offset) : dependency.dylib.name.offset;
      if (nameOffset < sizeof(dylib_command) || nameOffset >= commandSize) {
        return LoadValidationResult::DependencyClosureUnproven;
      }
      const char* rawName = reinterpret_cast<const char*>(commands.data() + cursor + nameOffset);
      const size_t available = commandSize - nameOffset;
      const void* terminator = std::memchr(rawName, 0, available);
      if (terminator == nullptr) return LoadValidationResult::DependencyClosureUnproven;
      const std::string dependencyPath(rawName, static_cast<const char*>(terminator) - rawName);
      if (!isSystemLibraryPath(dependencyPath)) return LoadValidationResult::DependencyClosureUnproven;
    }
    cursor += commandSize;
  }
  if (cursor != commands.size() || !minimumOsFound || versionLess(approvedMinimum, componentMinimum) ||
      versionLess(currentOs, componentMinimum) || versionLess(currentOs, approvedMinimum)) {
    return LoadValidationResult::DependencyClosureUnproven;
  }
  return LoadValidationResult::Valid;
}

std::string quoteRequirementString(const std::string& value) {
  std::string quoted;
  quoted.reserve(value.size() + 2);
  quoted.push_back('"');
  for (const char character : value) {
    if (character == '"' || character == '\\') quoted.push_back('\\');
    quoted.push_back(character);
  }
  quoted.push_back('"');
  return quoted;
}

CFStringRef makeCFString(const std::string& value) {
  return CFStringCreateWithBytes(kCFAllocatorDefault, reinterpret_cast<const UInt8*>(value.data()),
                                 static_cast<CFIndex>(value.size()), kCFStringEncodingUTF8, false);
}

bool equalCFString(CFTypeRef actual, CFStringRef expected) noexcept {
  return actual != nullptr && CFGetTypeID(actual) == CFStringGetTypeID() &&
         CFStringCompare(static_cast<CFStringRef>(actual), expected, 0) == kCFCompareEqualTo;
}

std::string quoteRequirementString(const std::string& value);

bool verifySignedIdentity(SecCodeRef code, const std::string& teamId, const std::string& identifier,
                          SecCSFlags flags) {
  if (code == nullptr || !isTeamIdentifier(teamId) || !isBundleIdentifier(identifier)) return false;
  const std::string requirementText =
      "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and "
      "certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = " +
      quoteRequirementString(teamId) + " and identifier " + quoteRequirementString(identifier);
  CFRef<CFStringRef> requirementSource(makeCFString(requirementText));
  CFRef<SecRequirementRef> requirement;
  if (!requirementSource || SecRequirementCreateWithString(requirementSource.get(), kSecCSDefaultFlags,
                                                           requirement.address()) != errSecSuccess || !requirement ||
      SecCodeCheckValidity(code, flags, requirement.get()) != errSecSuccess) return false;
  CFRef<CFDictionaryRef> information;
  if (SecCodeCopySigningInformation(code, kSecCSSigningInformation, information.address()) != errSecSuccess ||
      !information) return false;
  CFRef<CFStringRef> expectedTeam(makeCFString(teamId));
  CFRef<CFStringRef> expectedIdentifier(makeCFString(identifier));
  return expectedTeam && expectedIdentifier &&
      equalCFString(CFDictionaryGetValue(information.get(), kSecCodeInfoTeamIdentifier), expectedTeam.get()) &&
      equalCFString(CFDictionaryGetValue(information.get(), kSecCodeInfoIdentifier), expectedIdentifier.get());
}

bool verifyCurrentWorkerIdentity(const std::string& teamId, const std::string& runtimeIdentifier) {
  uint32_t codeSignFlags = 0;
  if (csops(getpid(), CS_OPS_STATUS, &codeSignFlags, sizeof(codeSignFlags)) != 0 ||
      (codeSignFlags & CS_RUNTIME) == 0 || (codeSignFlags & CS_REQUIRE_LV) == 0) return false;
  CFRef<SecCodeRef> code;
  return SecCodeCopySelf(kSecCSDefaultFlags, code.address()) == errSecSuccess && code &&
      verifySignedIdentity(code.get(), teamId, runtimeIdentifier,
          static_cast<SecCSFlags>(kSecCSStrictValidate | kSecCSCheckAllArchitectures));
}

bool verifyApprovedApplication(const std::string& appPath, const std::string& teamId,
                               const std::string& appBundleIdentifier) {
  CFRef<CFURLRef> appUrl(CFURLCreateFromFileSystemRepresentation(kCFAllocatorDefault,
      reinterpret_cast<const UInt8*>(appPath.data()), static_cast<CFIndex>(appPath.size()), true));
  CFRef<SecStaticCodeRef> appCode;
  return appUrl && SecStaticCodeCreateWithPath(appUrl.get(), kSecCSDefaultFlags, appCode.address()) == errSecSuccess &&
      appCode && verifySignedIdentity(appCode.get(), teamId, appBundleIdentifier,
          static_cast<SecCSFlags>(kSecCSStrictValidate | kSecCSCheckAllArchitectures));
}

bool processArchitectureMatches(const std::string& architecture) noexcept {
#if defined(__arm64__)
  return architecture == "arm64";
#elif defined(__x86_64__)
  return architecture == "x86_64";
#else
  (void)architecture;
  return false;
#endif
}

zt_mac_native_trust_status_v1 rejectSignature(zt_mac_native_trust_result_v1* result, OSStatus status) noexcept {
  setResult(result, ZT_MAC_TRUST_SIGNATURE_INVALID, status);
  return ZT_MAC_TRUST_SIGNATURE_INVALID;
}

uint32_t validatePinnedCandidate(const zt_mac_native_trust_request_v1* request,
                                 zt_mac_native_trust_result_v1* result,
                                 int* descriptorOutput, struct stat* statOutput) {
  setResult(result, ZT_MAC_TRUST_POLICY_INVALID);
  if (request == nullptr || result == nullptr || descriptorOutput == nullptr || statOutput == nullptr ||
      request->struct_size != sizeof(*request) || request->require_admin > 1) return ZT_MAC_TRUST_POLICY_INVALID;
  if (request->require_admin != 0) {
    setResult(result, ZT_MAC_TRUST_ADMIN_NATIVE_DENIED);
    return result->status;
  }

  std::string pluginRoot;
  std::string pluginId;
  std::string relativePath;
  std::string teamId;
  std::string appPath;
  std::string appBundleIdentifier;
  std::string runtimeIdentifier;
  std::string componentIdentifier;
  std::string expectedSha256;
  std::string architecture;
  std::string approvedMinimumOs;
  if (!readField(request->plugin_root_utf8, request->plugin_root_length, 4096, &pluginRoot) ||
      pluginRoot.front() != '/' ||
      !readField(request->plugin_id_utf8, request->plugin_id_length, 128, &pluginId) ||
      !isSafePathSegment(pluginId) ||
      !readField(request->relative_path_utf8, request->relative_path_length, 1024, &relativePath) ||
      !readField(request->approved_team_id_utf8, request->approved_team_id_length, 10, &teamId) ||
      !isTeamIdentifier(teamId) ||
      !readField(request->approved_app_path_utf8, request->approved_app_path_length, 4096, &appPath) ||
      appPath.front() != '/' || appPath.size() < 5 || appPath.substr(appPath.size() - 4) != ".app" ||
      !readField(request->approved_app_bundle_identifier_utf8, request->approved_app_bundle_identifier_length,
                 255, &appBundleIdentifier) || !isBundleIdentifier(appBundleIdentifier) ||
      !readField(request->expected_runtime_identifier_utf8, request->expected_runtime_identifier_length,
                 255, &runtimeIdentifier) || !isBundleIdentifier(runtimeIdentifier) ||
      !readField(request->expected_component_identifier_utf8, request->expected_component_identifier_length,
                 255, &componentIdentifier) || !isBundleIdentifier(componentIdentifier) ||
      !readField(request->expected_sha256_hex_utf8, request->expected_sha256_hex_length, 64, &expectedSha256) ||
      !isSha256Hex(expectedSha256) ||
      !readField(request->expected_architecture_utf8, request->expected_architecture_length, 16, &architecture) ||
      !readField(request->approved_minimum_os_utf8, request->approved_minimum_os_length, 16, &approvedMinimumOs)) {
    return result->status;
  }
  if ((architecture != "arm64" && architecture != "x86_64") || !processArchitectureMatches(architecture)) {
    setResult(result, ZT_MAC_TRUST_ARCHITECTURE_INVALID, errSecCSReqFailed);
    return result->status;
  }
  if (!verifyCurrentWorkerIdentity(teamId, runtimeIdentifier) ||
      !verifyApprovedApplication(appPath, teamId, appBundleIdentifier)) {
    setResult(result, ZT_MAC_TRUST_HOST_IDENTITY_INVALID, errSecCSReqFailed);
    return result->status;
  }
  if (relativePath.rfind("lib/", 0) != 0 ||
      !isSafePathSegment(relativePath.substr(0, relativePath.find('/'))) ||
      relativePath.find('\\') != std::string::npos || relativePath.front() == '/' ||
      relativePath.substr(relativePath.size() > 6 ? relativePath.size() - 6 : 0) != ".dylib") {
    return result->status;
  }
  std::transform(expectedSha256.begin(), expectedSha256.end(), expectedSha256.begin(), [](unsigned char character) {
    return static_cast<char>((character >= 'A' && character <= 'F') ? character + ('a' - 'A') : character);
  });

  int descriptor = -1;
  struct stat pinnedStat {};
  if (!openPinnedCandidate(pluginRoot, pluginId, relativePath, &descriptor, &pinnedStat)) {
    setResult(result, ZT_MAC_TRUST_IDENTITY_MISMATCH, errno == 0 ? errSecCSBadResource : errno);
    return result->status;
  }
  UniqueFd pinnedDescriptor(descriptor);
  const std::string fdPath = "/dev/fd/" + std::to_string(descriptor);

  const std::string requirementText =
      "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and "
      "certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = " +
      quoteRequirementString(teamId) + " and identifier " + quoteRequirementString(componentIdentifier);
  CFRef<CFStringRef> requirementString(makeCFString(requirementText));
  CFRef<SecRequirementRef> requirement;
  if (!requirementString || SecRequirementCreateWithString(requirementString.get(), kSecCSDefaultFlags,
                                                            requirement.address()) != errSecSuccess || !requirement) {
    pinnedDescriptor.reset();
    return result->status;
  }
  CFRef<CFURLRef> componentUrl(CFURLCreateFromFileSystemRepresentation(
      kCFAllocatorDefault, reinterpret_cast<const UInt8*>(fdPath.data()),
      static_cast<CFIndex>(fdPath.size()), false));
  if (!componentUrl) {
    pinnedDescriptor.reset();
    return result->status;
  }

  CFRef<SecStaticCodeRef> allArchitectures;
  OSStatus securityStatus = SecStaticCodeCreateWithPath(componentUrl.get(), kSecCSDefaultFlags,
                                                        allArchitectures.address());
  if (securityStatus != errSecSuccess || !allArchitectures) {
    pinnedDescriptor.reset();
    return rejectSignature(result, securityStatus);
  }
  securityStatus = SecStaticCodeCheckValidity(allArchitectures.get(),
      static_cast<SecCSFlags>(kSecCSStrictValidate | kSecCSCheckAllArchitectures), requirement.get());
  if (securityStatus != errSecSuccess) {
    pinnedDescriptor.reset();
    return rejectSignature(result, securityStatus);
  }
  result->signature_validated = 1;
  result->all_architectures_validated = 1;

  CFRef<CFStringRef> architectureString(makeCFString(architecture));
  if (!architectureString) {
    pinnedDescriptor.reset();
    return result->status;
  }
  const void* attributeKeys[] = {kSecCodeAttributeArchitecture};
  const void* attributeValues[] = {architectureString.get()};
  CFRef<CFDictionaryRef> attributes(CFDictionaryCreate(kCFAllocatorDefault, attributeKeys, attributeValues, 1,
                                                        &kCFTypeDictionaryKeyCallBacks,
                                                        &kCFTypeDictionaryValueCallBacks));
  if (!attributes) {
    pinnedDescriptor.reset();
    return result->status;
  }
  CFRef<SecStaticCodeRef> selectedArchitecture;
  securityStatus = SecStaticCodeCreateWithPathAndAttributes(componentUrl.get(), kSecCSDefaultFlags,
                                                             attributes.get(), selectedArchitecture.address());
  if (securityStatus != errSecSuccess || !selectedArchitecture) {
    pinnedDescriptor.reset();
    return rejectSignature(result, securityStatus);
  }
  securityStatus = SecStaticCodeCheckValidity(selectedArchitecture.get(), kSecCSStrictValidate, requirement.get());
  if (securityStatus != errSecSuccess) {
    pinnedDescriptor.reset();
    return rejectSignature(result, securityStatus);
  }
  result->selected_architecture_validated = 1;

  CFRef<CFDictionaryRef> signingInformation;
  securityStatus = SecCodeCopySigningInformation(selectedArchitecture.get(), kSecCSSigningInformation,
                                                  signingInformation.address());
  if (securityStatus != errSecSuccess || !signingInformation) {
    pinnedDescriptor.reset();
    return rejectSignature(result, securityStatus);
  }
  CFRef<CFStringRef> expectedTeam(makeCFString(teamId));
  CFRef<CFStringRef> expectedIdentifier(makeCFString(componentIdentifier));
  if (!expectedTeam || !expectedIdentifier) {
    pinnedDescriptor.reset();
    return result->status;
  }
  result->team_id_matched = equalCFString(CFDictionaryGetValue(signingInformation.get(), kSecCodeInfoTeamIdentifier),
                                          expectedTeam.get()) ? 1u : 0u;
  result->identifier_matched = equalCFString(CFDictionaryGetValue(signingInformation.get(), kSecCodeInfoIdentifier),
                                             expectedIdentifier.get()) ? 1u : 0u;
  if (result->team_id_matched == 0 || result->identifier_matched == 0) {
    pinnedDescriptor.reset();
    setResult(result, ZT_MAC_TRUST_IDENTITY_MISMATCH, errSecCSReqFailed);
    return result->status;
  }

  std::string actualSha256;
  if (!hashDescriptor(descriptor, pinnedStat, &actualSha256) || actualSha256 != expectedSha256) {
    pinnedDescriptor.reset();
    setResult(result, ZT_MAC_TRUST_SHA256_MISMATCH, errSecCSBadResource);
    return result->status;
  }
  result->manifest_sha256_matched = 1;
  const LoadValidationResult loadValidation = validateLoadCommands(descriptor, architecture, approvedMinimumOs);
  if (loadValidation == LoadValidationResult::ArchitectureInvalid) {
    pinnedDescriptor.reset();
    setResult(result, ZT_MAC_TRUST_ARCHITECTURE_INVALID, errSecCSReqFailed);
    return result->status;
  }
  if (loadValidation != LoadValidationResult::Valid) {
    pinnedDescriptor.reset();
    setResult(result, ZT_MAC_TRUST_DEPENDENCY_CLOSURE_UNPROVEN, errSecCSBadResource);
    return result->status;
  }
  result->dependency_closure_validated = 1;
  uint32_t codeSignFlags = 0;
  if (csops(getpid(), CS_OPS_STATUS, &codeSignFlags, sizeof(codeSignFlags)) != 0 ||
      (codeSignFlags & CS_RUNTIME) == 0 || (codeSignFlags & CS_REQUIRE_LV) == 0) {
    pinnedDescriptor.reset();
    setResult(result, ZT_MAC_TRUST_HARDENED_RUNTIME_REQUIRED, errno == 0 ? errSecCSReqFailed : errno);
    return result->status;
  }
  if (fcntl(descriptor, F_CHECK_LV, 0) != 0) {
    pinnedDescriptor.reset();
    setResult(result, ZT_MAC_TRUST_HARDENED_RUNTIME_REQUIRED, errno);
    return result->status;
  }
  setResult(result, ZT_MAC_TRUST_PREFLIGHT_OK, errSecSuccess);
  result->signature_validated = 1;
  result->all_architectures_validated = 1;
  result->selected_architecture_validated = 1;
  result->identifier_matched = 1;
  result->team_id_matched = 1;
  result->manifest_sha256_matched = 1;
  result->dependency_closure_validated = 1;
  *descriptorOutput = pinnedDescriptor.release();
  *statOutput = pinnedStat;
  return result->status;
}

}  // namespace

uint32_t zt_mac_native_validate_candidate_v1(const zt_mac_native_trust_request_v1* request,
                                             zt_mac_native_trust_result_v1* result) {
  if (result == nullptr) return ZT_MAC_TRUST_POLICY_INVALID;
  int descriptor = -1;
  struct stat pinnedStat {};
  try {
    const uint32_t status = validatePinnedCandidate(request, result, &descriptor, &pinnedStat);
    if (descriptor >= 0) close(descriptor);
    return status;
  } catch (...) {
    if (descriptor >= 0) close(descriptor);
    setResult(result, ZT_MAC_TRUST_POLICY_INVALID);
    return result->status;
  }
}

uint32_t zt_mac_native_load_candidate_v1(const zt_mac_native_trust_request_v1* request,
                                         zt_mac_native_trust_result_v1* result,
                                         zt_mac_native_loaded_component_v1* loaded) {
  if (result == nullptr || loaded == nullptr) return ZT_MAC_TRUST_POLICY_INVALID;
  *loaded = {};
  loaded->pinned_descriptor = -1;
  const uint32_t preflightStatus = zt_mac_native_validate_candidate_v1(request, result);
  if (preflightStatus != ZT_MAC_TRUST_PREFLIGHT_OK) return preflightStatus;

  // dyld may run component initializers before dlopen returns, so a mapped-vnode
  // check performed afterward cannot prove the object that executed. Keep the
  // production loader closed until a Darwin-supported pre-initializer proof exists.
  setResult(result, ZT_MAC_TRUST_SAME_OBJECT_LOAD_UNPROVEN, errSecCSBadResource);
  return result->status;
}

void zt_mac_native_unload_candidate_v1(zt_mac_native_loaded_component_v1* loaded) {
  if (loaded == nullptr) return;
  if (loaded->api != nullptr && loaded->initialized != 0) (void)loaded->api->destroy();
  if (loaded->library_handle != nullptr) dlclose(loaded->library_handle);
  delete loaded->api_snapshot;
  if (loaded->pinned_descriptor >= 0) close(loaded->pinned_descriptor);
  *loaded = {};
  loaded->pinned_descriptor = -1;
}

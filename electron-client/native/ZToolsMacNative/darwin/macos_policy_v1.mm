#import <Foundation/Foundation.h>

#include "macos_policy_v1.hpp"

#include <Security/Security.h>
#include <libproc.h>
#include <sys/codesign.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace ztools::macnative {
namespace {

constexpr size_t kMaximumPolicyBytes = 1024u * 1024u;

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

void setError(std::string* error, const char* value) noexcept {
  if (error == nullptr) return;
  try { *error = value; } catch (...) {}
}

bool safeIdentifier(const std::string& value, size_t maximum = 128) noexcept {
  if (value.empty() || value.size() > maximum) return false;
  for (const unsigned char character : value) {
    if (!((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') ||
          (character >= '0' && character <= '9') || character == '.' || character == '_' || character == '-')) {
      return false;
    }
  }
  return true;
}

bool safeBundleIdentifier(const std::string& value) noexcept {
  if (value.size() < 3 || value.size() > 255 || value.front() == '.' || value.back() == '.') return false;
  bool hasDot = false;
  bool previousDot = false;
  for (const unsigned char character : value) {
    if (character == '.') {
      if (previousDot) return false;
      hasDot = true;
      previousDot = true;
    } else if ((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') ||
               (character >= '0' && character <= '9') || character == '-') {
      previousDot = false;
    } else {
      return false;
    }
  }
  return hasDot && !previousDot;
}

bool safeTeamIdentifier(const std::string& value) noexcept {
  if (value.size() != 10) return false;
  for (const unsigned char character : value) {
    if (!((character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9'))) return false;
  }
  return true;
}

bool safeMinimumOs(const std::string& value) noexcept {
  if (value.empty() || value.size() > 16) return false;
  size_t dots = 0;
  bool digits = false;
  for (const char character : value) {
    if (character == '.') {
      if (!digits || ++dots > 2) return false;
      digits = false;
    } else if (character >= '0' && character <= '9') {
      digits = true;
    } else {
      return false;
    }
  }
  return digits && dots >= 1;
}

bool safeRelativeDylibPath(const std::string& value) noexcept {
  if (value.size() < 10 || value.size() > 1024 || value.rfind("lib/", 0) != 0 || value.front() == '/' ||
      value.find('\\') != std::string::npos) return false;
  size_t start = 0;
  while (start < value.size()) {
    const size_t end = value.find('/', start);
    const std::string segment = value.substr(start, end == std::string::npos ? std::string::npos : end - start);
    if (!safeIdentifier(segment, 255)) return false;
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return value.substr(value.size() - 6) == ".dylib";
}

bool readString(NSDictionary* dictionary, NSString* key, std::string* output) {
  if (dictionary == nil || key == nil || output == nullptr) return false;
  id value = dictionary[key];
  if (![value isKindOfClass:[NSString class]]) return false;
  NSData* data = [(NSString*)value dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
  if (data == nil || data.length == 0 || data.length > 4096) return false;
  output->assign(static_cast<const char*>(data.bytes), data.length);
  return true;
}

bool hasExactKeys(NSDictionary* dictionary, NSArray<NSString*>* keys) {
  if (dictionary == nil || keys == nil || dictionary.count != keys.count) return false;
  for (NSString* key in keys) if (dictionary[key] == nil) return false;
  return true;
}

std::string quoteRequirement(const std::string& value) {
  std::string result;
  result.reserve(value.size() + 2);
  result.push_back('"');
  for (const char character : value) {
    if (character == '"' || character == '\\') result.push_back('\\');
    result.push_back(character);
  }
  result.push_back('"');
  return result;
}

CFStringRef makeCFString(const std::string& value) {
  return CFStringCreateWithBytes(kCFAllocatorDefault, reinterpret_cast<const UInt8*>(value.data()),
                                 static_cast<CFIndex>(value.size()), kCFStringEncodingUTF8, false);
}

CFURLRef makeFileUrl(const std::string& path) {
  return CFURLCreateFromFileSystemRepresentation(kCFAllocatorDefault,
      reinterpret_cast<const UInt8*>(path.data()), static_cast<CFIndex>(path.size()),
      path.size() > 4 && path.substr(path.size() - 4) == ".app");
}

std::string developerIdRequirement(const std::string* team, const std::string* identifier) {
  std::string value = "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and "
      "certificate leaf[field.1.2.840.113635.100.6.1.13] exists";
  if (team != nullptr) value += " and certificate leaf[subject.OU] = " + quoteRequirement(*team);
  if (identifier != nullptr) value += " and identifier " + quoteRequirement(*identifier);
  return value;
}

bool createRequirement(const std::string* team, const std::string* identifier, SecRequirementRef* output) {
  if (output == nullptr) return false;
  *output = nullptr;
  const std::string text = developerIdRequirement(team, identifier);
  CFRef<CFStringRef> source(makeCFString(text));
  return source && SecRequirementCreateWithString(source.get(), kSecCSDefaultFlags, output) == errSecSuccess &&
         *output != nullptr;
}

bool copySigningIdentity(SecCodeRef code, std::string* team, std::string* identifier) {
  if (code == nullptr || team == nullptr || identifier == nullptr) return false;
  CFRef<CFDictionaryRef> information;
  if (SecCodeCopySigningInformation(code, kSecCSSigningInformation, information.address()) != errSecSuccess ||
      !information) return false;
  CFTypeRef teamValue = CFDictionaryGetValue(information.get(), kSecCodeInfoTeamIdentifier);
  CFTypeRef identifierValue = CFDictionaryGetValue(information.get(), kSecCodeInfoIdentifier);
  if (teamValue == nullptr || identifierValue == nullptr || CFGetTypeID(teamValue) != CFStringGetTypeID() ||
      CFGetTypeID(identifierValue) != CFStringGetTypeID()) return false;
  auto toUtf8 = [](CFStringRef value, std::string* output) {
    const CFIndex length = CFStringGetLength(value);
    const CFIndex capacity = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
    if (capacity <= 1 || capacity > 1024) return false;
    std::vector<char> buffer(static_cast<size_t>(capacity));
    if (!CFStringGetCString(value, buffer.data(), capacity, kCFStringEncodingUTF8)) return false;
    output->assign(buffer.data());
    return true;
  };
  return toUtf8(static_cast<CFStringRef>(teamValue), team) &&
         toUtf8(static_cast<CFStringRef>(identifierValue), identifier);
}

bool readPolicyBytes(const std::string& resourcesPath, std::vector<uint8_t>* output) {
  if (output == nullptr || resourcesPath.empty() || resourcesPath.front() != '/' || resourcesPath.size() > 4096) return false;
  struct stat resourcesStat{};
  if (lstat(resourcesPath.c_str(), &resourcesStat) != 0 || !S_ISDIR(resourcesStat.st_mode) ||
      S_ISLNK(resourcesStat.st_mode)) return false;
  const int resources = open(resourcesPath.c_str(), O_RDONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW);
  if (resources < 0) return false;
  const int native = openat(resources, "native", O_RDONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW);
  close(resources);
  if (native < 0) return false;
  const int policy = openat(native, "ztools-mac-native-policy.json", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  close(native);
  if (policy < 0) return false;
  struct stat info{};
  if (fstat(policy, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size <= 0 ||
      static_cast<uint64_t>(info.st_size) > kMaximumPolicyBytes) {
    close(policy);
    return false;
  }
  output->resize(static_cast<size_t>(info.st_size));
  size_t offset = 0;
  while (offset < output->size()) {
    const ssize_t count = read(policy, output->data() + offset, output->size() - offset);
    if (count <= 0) {
      if (count < 0 && errno == EINTR) continue;
      close(policy);
      return false;
    }
    offset += static_cast<size_t>(count);
  }
  struct stat after{};
  const bool unchanged = fstat(policy, &after) == 0 && info.st_dev == after.st_dev && info.st_ino == after.st_ino &&
      info.st_size == after.st_size && info.st_mtime == after.st_mtime && info.st_ctime == after.st_ctime;
  close(policy);
  return unchanged;
}

bool appCodeIdentity(const std::string& appPath, std::string* team, std::string* identifier) {
  CFRef<CFURLRef> url(makeFileUrl(appPath));
  if (!url) return false;
  CFRef<SecStaticCodeRef> appCode;
  if (SecStaticCodeCreateWithPath(url.get(), kSecCSDefaultFlags, appCode.address()) != errSecSuccess || !appCode) {
    return false;
  }
  CFRef<SecRequirementRef> requirement;
  if (!createRequirement(nullptr, nullptr, requirement.address()) ||
      SecStaticCodeCheckValidity(appCode.get(),
          static_cast<SecCSFlags>(kSecCSStrictValidate | kSecCSCheckAllArchitectures), requirement.get()) != errSecSuccess) {
    return false;
  }
  return copySigningIdentity(appCode.get(), team, identifier);
}

bool parsePolicyObject(id value, NativeRuntimePolicyV1* output) {
  if (output == nullptr || ![value isKindOfClass:[NSDictionary class]]) return false;
  NSDictionary* dictionary = (NSDictionary*)value;
  NSArray<NSString*>* policyKeys = @[@"schemaVersion", @"appBundleId", @"teamId", @"hostBundleId",
      @"workerBundleId", @"minimumOs", @"architectures", @"components"];
  if (!hasExactKeys(dictionary, policyKeys) || ![dictionary[@"schemaVersion"] isKindOfClass:[NSNumber class]] ||
      [dictionary[@"schemaVersion"] unsignedIntValue] != 1) return false;
  NativeRuntimePolicyV1 parsed;
  if (!readString(dictionary, @"appBundleId", &parsed.appBundleId) ||
      !safeBundleIdentifier(parsed.appBundleId) || !readString(dictionary, @"teamId", &parsed.teamId) ||
      !safeTeamIdentifier(parsed.teamId) || !readString(dictionary, @"hostBundleId", &parsed.hostBundleId) ||
      !safeBundleIdentifier(parsed.hostBundleId) || !readString(dictionary, @"workerBundleId", &parsed.workerBundleId) ||
      !safeBundleIdentifier(parsed.workerBundleId) || !readString(dictionary, @"minimumOs", &parsed.minimumOs) ||
      !safeMinimumOs(parsed.minimumOs)) return false;
  NSArray* architectures = dictionary[@"architectures"];
  NSArray* components = dictionary[@"components"];
  if (![architectures isKindOfClass:[NSArray class]] || architectures.count == 0 || architectures.count > 2 ||
      ![components isKindOfClass:[NSArray class]] || components.count == 0 || components.count > 512) return false;
  for (id architecture in architectures) {
    if (![architecture isKindOfClass:[NSString class]]) return false;
    const char* value = [(NSString*)architecture UTF8String];
    if (value == nullptr) return false;
    const std::string slice(value);
    if ((slice != "arm64" && slice != "x86_64") ||
        std::find(parsed.architectures.begin(), parsed.architectures.end(), slice) != parsed.architectures.end()) return false;
    parsed.architectures.push_back(slice);
  }
  std::set<std::pair<std::string, std::string>> componentKeys;
  for (id item in components) {
    if (![item isKindOfClass:[NSDictionary class]]) return false;
    NSDictionary* componentDictionary = (NSDictionary*)item;
    if (!hasExactKeys(componentDictionary, @[@"pluginId", @"dllId", @"relativePath", @"identifier", @"sha256"])) {
      return false;
    }
    NativeComponentPolicyV1 component;
    if (!readString(componentDictionary, @"pluginId", &component.pluginId) || !safeIdentifier(component.pluginId) ||
        !readString(componentDictionary, @"dllId", &component.dllId) || !safeIdentifier(component.dllId) ||
        !readString(componentDictionary, @"relativePath", &component.relativePath) ||
        !safeRelativeDylibPath(component.relativePath) ||
        !readString(componentDictionary, @"identifier", &component.identifier) ||
        !safeBundleIdentifier(component.identifier) || !readString(componentDictionary, @"sha256", &component.sha256) ||
        component.sha256.size() != 64) return false;
    for (char& character : component.sha256) {
      if (character >= 'A' && character <= 'F') character = static_cast<char>(character + ('a' - 'A'));
      else if (!((character >= 'a' && character <= 'f') || (character >= '0' && character <= '9'))) return false;
    }
    if (!componentKeys.emplace(component.pluginId, component.dllId).second) return false;
    parsed.components.push_back(std::move(component));
  }
  *output = std::move(parsed);
  return true;
}

bool verifySecCode(SecCodeRef code, const NativeRuntimePolicyV1& policy,
                   const std::string& expectedIdentifier, bool allArchitectures, std::string* error) {
  if (code == nullptr || !safeBundleIdentifier(expectedIdentifier)) {
    setError(error, "NATIVE_CODE_IDENTITY_INVALID");
    return false;
  }
  CFRef<SecRequirementRef> requirement;
  if (!createRequirement(&policy.teamId, &expectedIdentifier, requirement.address())) {
    setError(error, "NATIVE_REQUIREMENT_BUILD_FAILED");
    return false;
  }
  const SecCSFlags flags = allArchitectures
      ? static_cast<SecCSFlags>(kSecCSStrictValidate | kSecCSCheckAllArchitectures)
      : kSecCSStrictValidate;
  const OSStatus securityStatus = SecCodeCheckValidity(code, flags, requirement.get());
  if (securityStatus != errSecSuccess) {
    setError(error, "NATIVE_CODE_SIGNATURE_OR_IDENTITY_INVALID");
    return false;
  }
  std::string team;
  std::string identifier;
  if (!copySigningIdentity(code, &team, &identifier) || team != policy.teamId || identifier != expectedIdentifier) {
    setError(error, "NATIVE_CODE_IDENTITY_MISMATCH");
    return false;
  }
  return true;
}

bool hasHardenedRuntimeAndLibraryValidation(pid_t processId, std::string* error) {
  uint32_t flags = 0;
  if (csops(processId, CS_OPS_STATUS, &flags, sizeof(flags)) != 0 ||
      (flags & CS_RUNTIME) == 0 || (flags & CS_REQUIRE_LV) == 0) {
    setError(error, "NATIVE_HARDENED_RUNTIME_OR_LIBRARY_VALIDATION_REQUIRED");
    return false;
  }
  return true;
}

}  // namespace

bool loadVerifiedRuntimePolicyV1(const std::string& resourcesPath, const std::string& processArchitecture,
                                 NativeRuntimePolicyV1* output, std::string* error) noexcept {
#if defined(__arm64__)
  constexpr const char* kCompiledArchitecture = "arm64";
#elif defined(__x86_64__)
  constexpr const char* kCompiledArchitecture = "x86_64";
#else
  constexpr const char* kCompiledArchitecture = "unsupported";
#endif
  if (output == nullptr || resourcesPath.empty() || resourcesPath.front() != '/' ||
      resourcesPath.size() > 4096 || (processArchitecture != "arm64" && processArchitecture != "x86_64") ||
      processArchitecture != kCompiledArchitecture) {
    setError(error, "NATIVE_RUNTIME_INPUT_INVALID");
    return false;
  }
  try {
    char resolvedResources[PATH_MAX]{};
    if (realpath(resourcesPath.c_str(), resolvedResources) == nullptr) {
      setError(error, "NATIVE_RESOURCES_PATH_INVALID");
      return false;
    }
    const std::string canonicalResources(resolvedResources);
    const size_t contentsPosition = canonicalResources.rfind("/Contents/Resources");
    if (contentsPosition == std::string::npos || contentsPosition + std::strlen("/Contents/Resources") != canonicalResources.size()) {
      setError(error, "NATIVE_APP_BUNDLE_LAYOUT_INVALID");
      return false;
    }
    const std::string appPath = canonicalResources.substr(0, contentsPosition);
    if (appPath.size() < 5 || appPath.substr(appPath.size() - 4) != ".app") {
      setError(error, "NATIVE_APP_BUNDLE_PATH_INVALID");
      return false;
    }
    std::string appTeam;
    std::string appIdentifier;
    if (!appCodeIdentity(appPath, &appTeam, &appIdentifier)) {
      setError(error, "NATIVE_APP_SEAL_INVALID");
      return false;
    }
    std::vector<uint8_t> bytes;
    if (!readPolicyBytes(canonicalResources, &bytes)) {
      setError(error, "NATIVE_RUNTIME_POLICY_UNREADABLE");
      return false;
    }
    NSData* data = [NSData dataWithBytes:bytes.data() length:bytes.size()];
    NSError* parseError = nil;
    id json = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:&parseError];
    (void)parseError;
    NativeRuntimePolicyV1 parsed;
    if (!parsePolicyObject(json, &parsed) || parsed.teamId != appTeam || parsed.appBundleId != appIdentifier ||
        std::find(parsed.architectures.begin(), parsed.architectures.end(), processArchitecture) == parsed.architectures.end()) {
      setError(error, "NATIVE_RUNTIME_POLICY_IDENTITY_OR_SLICE_MISMATCH");
      return false;
    }
    std::string recheckedTeam;
    std::string recheckedIdentifier;
    if (!appCodeIdentity(appPath, &recheckedTeam, &recheckedIdentifier) ||
        recheckedTeam != appTeam || recheckedIdentifier != appIdentifier) {
      setError(error, "NATIVE_APP_SEAL_CHANGED_DURING_POLICY_READ");
      return false;
    }
    parsed.appBundlePath = appPath;
    *output = std::move(parsed);
    return true;
  } catch (...) {
    setError(error, "NATIVE_RUNTIME_POLICY_PARSE_FAILED");
    return false;
  }
}

bool verifyRunningCodeV1(const NativeRuntimePolicyV1& policy, const std::string& expectedIdentifier,
                         std::string* error) noexcept {
  if (!hasHardenedRuntimeAndLibraryValidation(getpid(), error)) return false;
  CFRef<SecCodeRef> code;
  if (SecCodeCopySelf(kSecCSDefaultFlags, code.address()) != errSecSuccess || !code ||
      !verifySecCode(code.get(), policy, expectedIdentifier, true, error)) return false;
  return true;
}

bool verifyGuestCodeV1(pid_t processId, const NativeRuntimePolicyV1& policy,
                       const std::string& expectedIdentifier, const std::string& processArchitecture,
                       std::string* error) noexcept {
  if (processId <= 0) {
    setError(error, "NATIVE_GUEST_PID_INVALID");
    return false;
  }
  CFRef<CFNumberRef> pidNumber(CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &processId));
  CFRef<CFMutableDictionaryRef> attributes(CFDictionaryCreateMutable(kCFAllocatorDefault, 1,
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks));
  if (!pidNumber || !attributes) {
    setError(error, "NATIVE_GUEST_ATTRIBUTE_ALLOCATION_FAILED");
    return false;
  }
  CFDictionarySetValue(attributes.get(), kSecGuestAttributePid, pidNumber.get());
  CFRef<SecCodeRef> code;
  if (SecCodeCopyGuestWithAttributes(nullptr, attributes.get(), kSecCSDefaultFlags, code.address()) != errSecSuccess ||
      !code || !verifySecCode(code.get(), policy, expectedIdentifier, true, error)) return false;
  if (!hasHardenedRuntimeAndLibraryValidation(processId, error)) return false;
  struct proc_archinfo architectureInfo{};
  const int bytes = proc_pidinfo(processId, PROC_PIDARCHINFO, 0, &architectureInfo, sizeof(architectureInfo));
  const cpu_type_t expectedCpu = processArchitecture == "arm64" ? CPU_TYPE_ARM64 : CPU_TYPE_X86_64;
  if (bytes != static_cast<int>(sizeof(architectureInfo)) || architectureInfo.p_cputype != expectedCpu) {
    setError(error, "NATIVE_GUEST_ARCHITECTURE_MISMATCH");
    return false;
  }
  return true;
}

bool verifyStaticCodeV1(const std::string& path, const NativeRuntimePolicyV1& policy,
                        const std::string& expectedIdentifier, std::string* error) noexcept {
  CFRef<CFURLRef> url(makeFileUrl(path));
  CFRef<SecStaticCodeRef> code;
  if (!url || SecStaticCodeCreateWithPath(url.get(), kSecCSDefaultFlags, code.address()) != errSecSuccess || !code ||
      !verifySecCode(code.get(), policy, expectedIdentifier, true, error)) {
    if (error != nullptr && error->empty()) setError(error, "NATIVE_STATIC_CODE_INVALID");
    return false;
  }
  return true;
}

const NativeComponentPolicyV1* findComponentPolicyV1(const NativeRuntimePolicyV1& policy,
                                                      const std::string& pluginId,
                                                      const std::string& dllId) noexcept {
  const auto found = std::find_if(policy.components.begin(), policy.components.end(),
      [&](const NativeComponentPolicyV1& component) {
        return component.pluginId == pluginId && component.dllId == dllId;
      });
  return found == policy.components.end() ? nullptr : &*found;
}

}  // namespace ztools::macnative

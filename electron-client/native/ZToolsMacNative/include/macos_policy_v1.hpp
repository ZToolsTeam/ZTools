#ifndef ZTOOLS_MACOS_POLICY_V1_HPP
#define ZTOOLS_MACOS_POLICY_V1_HPP

#include <cstdint>
#include <string>
#include <sys/types.h>
#include <vector>

namespace ztools::macnative {

struct NativeComponentPolicyV1 {
  std::string pluginId;
  std::string dllId;
  std::string relativePath;
  std::string identifier;
  std::string sha256;
};

struct NativeRuntimePolicyV1 {
  std::string appBundlePath;
  std::string appBundleId;
  std::string teamId;
  std::string hostBundleId;
  std::string workerBundleId;
  std::string minimumOs;
  std::vector<std::string> architectures;
  std::vector<NativeComponentPolicyV1> components;
};

bool loadVerifiedRuntimePolicyV1(const std::string& resourcesPath, const std::string& processArchitecture,
                                 NativeRuntimePolicyV1* output, std::string* error) noexcept;
bool verifyRunningCodeV1(const NativeRuntimePolicyV1& policy, const std::string& expectedIdentifier,
                         std::string* error) noexcept;
bool verifyGuestCodeV1(pid_t processId, const NativeRuntimePolicyV1& policy,
                       const std::string& expectedIdentifier, const std::string& processArchitecture,
                       std::string* error) noexcept;
bool verifyStaticCodeV1(const std::string& path, const NativeRuntimePolicyV1& policy,
                        const std::string& expectedIdentifier, std::string* error) noexcept;
const NativeComponentPolicyV1* findComponentPolicyV1(const NativeRuntimePolicyV1& policy,
                                                      const std::string& pluginId,
                                                      const std::string& dllId) noexcept;

}  // namespace ztools::macnative

#endif

#import <Foundation/Foundation.h>

#include "macos_policy_v1.hpp"
#include "wire_io_v1.hpp"
#include "ztools_mac_native_abi.h"
#include "ztools_mac_native_trust_gate_v1.h"

#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <limits.h>
#include <map>
#include <mach-o/dyld.h>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <unistd.h>

namespace {

using ztools::macnative::FrameHeaderV1;
using ztools::macnative::NativeComponentPolicyV1;
using ztools::macnative::NativeRuntimePolicyV1;
using ztools::macnative::WorkerSessionV1;
using ztools::macnative::WireFrameV1;
using ztools::macnative::WireError;
using ztools::macnative::decodeFrameHeaderV1;
using ztools::macnative::isAllowedNativeRoleV1;
using ztools::macnative::readFrameBlockingV1;
using ztools::macnative::writeFrameTextV1;

constexpr size_t kMaximumStringBytes = 1024;

struct LoadedComponent {
  zt_mac_native_loaded_component_v1 loaded{};
  std::string pluginId;
  std::string dllId;
};

bool isSafeId(const std::string& value) noexcept {
  if (value.empty() || value.size() > 128) return false;
  for (const unsigned char character : value) {
    if (!((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') ||
          (character >= '0' && character <= '9') || character == '.' || character == '_' || character == '-')) return false;
  }
  return true;
}

bool isSafePluginInstanceId(const std::string& value) noexcept {
  if (isSafeId(value)) return true;
  constexpr const char* prefix = "main:";
  if (value.rfind(prefix, 0) != 0 || value.size() <= 5 || value.size() > 21 || value[5] == '0') return false;
  for (size_t index = 5; index < value.size(); ++index) {
    if (value[index] < '0' || value[index] > '9') return false;
  }
  return true;
}

bool readString(NSDictionary* value, NSString* key, std::string* output, size_t maximum = kMaximumStringBytes) {
  if (value == nil || key == nil || output == nullptr) return false;
  id raw = value[key];
  if (![raw isKindOfClass:[NSString class]]) return false;
  NSData* data = [(NSString*)raw dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
  if (data == nil || data.length == 0 || data.length > maximum) return false;
  output->assign(static_cast<const char*>(data.bytes), data.length);
  return true;
}

NSData* serialize(id value) {
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingFragmentsAllowed error:&error];
  (void)error;
  return data;
}

bool writeJson(uint16_t type, uint64_t owner, uint64_t generation, uint64_t taskId, NSString* requestId,
               bool success, id result, NSString* error) {
  NSMutableDictionary* payload = [NSMutableDictionary dictionaryWithCapacity:4];
  if (requestId != nil) payload[@"requestId"] = requestId;
  payload[@"ok"] = @(success);
  if (success) payload[@"result"] = result ?: [NSNull null];
  else payload[@"error"] = error ?: @"MAC_NATIVE_OPERATION_FAILED";
  NSData* encoded = serialize(payload);
  if (encoded == nil || encoded.length > ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES) return false;
  return writeFrameTextV1(STDOUT_FILENO, type, owner, generation, taskId,
      std::string(static_cast<const char*>(encoded.bytes), encoded.length));
}

bool parseJson(const std::vector<uint8_t>& bytes, NSDictionary** output) {
  if (output == nullptr || bytes.empty() || bytes.size() > ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES) return false;
  NSData* data = [NSData dataWithBytes:bytes.data() length:bytes.size()];
  NSError* error = nil;
  id value = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:&error];
  (void)error;
  if (![value isKindOfClass:[NSDictionary class]]) return false;
  *output = (NSDictionary*)value;
  return true;
}

bool parseUnsigned(const char* text, uint64_t* output) {
  if (text == nullptr || output == nullptr || text[0] == '\0' || text[0] == '-') return false;
  try {
    size_t parsed = 0;
    const unsigned long long value = std::stoull(text, &parsed, 10);
    if (text[parsed] != '\0' || value == 0) return false;
    *output = static_cast<uint64_t>(value);
    return true;
  } catch (...) {
    return false;
  }
}

bool parseArguments(int argc, char** argv, std::string* resources, std::string* pluginRoot,
                    std::string* architecture, std::string* pluginInstanceId,
                    uint64_t* owner, uint64_t* generation) {
  if (resources == nullptr || pluginRoot == nullptr || architecture == nullptr || pluginInstanceId == nullptr ||
      owner == nullptr || generation == nullptr) return false;
  std::map<std::string, std::string*> values = {
      {"--resources", resources}, {"--plugin-root", pluginRoot}, {"--architecture", architecture},
      {"--plugin-instance", pluginInstanceId}};
  const std::map<std::string, uint64_t*> numbers = {{"--owner", owner}, {"--generation", generation}};
  for (int index = 1; index < argc; ++index) {
    const std::string key(argv[index]);
    if (index + 1 >= argc) return false;
    const std::string raw(argv[++index]);
    const auto stringFound = values.find(key);
    if (stringFound != values.end()) {
      if (!stringFound->second->empty()) return false;
      *stringFound->second = raw;
      continue;
    }
    const auto numberFound = numbers.find(key);
    if (numberFound == numbers.end() || *numberFound->second != 0 || !parseUnsigned(raw.c_str(), numberFound->second)) return false;
  }
  return !resources->empty() && !pluginRoot->empty() && !architecture->empty() &&
      isSafePluginInstanceId(*pluginInstanceId) && *owner != 0 && *generation != 0;
}

std::string macArchitecture() {
#if defined(__arm64__)
  return "arm64";
#elif defined(__x86_64__)
  return "x86_64";
#else
  return "unsupported";
#endif
}

bool currentExecutableMatches(const std::string& expectedPath) {
  uint32_t capacity = PATH_MAX;
  std::vector<char> buffer(capacity);
  if (_NSGetExecutablePath(buffer.data(), &capacity) != 0) return false;
  char resolved[PATH_MAX]{};
  return realpath(buffer.data(), resolved) != nullptr && expectedPath == resolved;
}

std::string nativeStatusError(uint32_t status) {
  switch (status) {
    case ZT_MAC_TRUST_ADMIN_NATIVE_DENIED: return "MAC_NATIVE_ADMIN_DENIED";
    case ZT_MAC_TRUST_IDENTITY_MISMATCH: return "MAC_NATIVE_COMPONENT_IDENTITY_MISMATCH";
    case ZT_MAC_TRUST_SHA256_MISMATCH: return "MAC_NATIVE_COMPONENT_HASH_MISMATCH";
    case ZT_MAC_TRUST_ARCHITECTURE_INVALID: return "MAC_NATIVE_COMPONENT_ARCHITECTURE_MISMATCH";
    case ZT_MAC_TRUST_DEPENDENCY_CLOSURE_UNPROVEN: return "MAC_NATIVE_COMPONENT_DEPENDENCY_CLOSURE_REJECTED";
    case ZT_MAC_TRUST_SAME_OBJECT_LOAD_UNPROVEN: return "MAC_NATIVE_COMPONENT_SAME_OBJECT_UNPROVEN";
    case ZT_MAC_TRUST_HARDENED_RUNTIME_REQUIRED: return "MAC_NATIVE_HARDENED_RUNTIME_OR_LIBRARY_VALIDATION_REQUIRED";
    default: return "MAC_NATIVE_COMPONENT_TRUST_REJECTED";
  }
}

bool validNativeJson(const uint8_t* data, uint32_t length) {
  if (data == nullptr || length == 0 || length > ZT_MAC_NATIVE_MAX_JSON_BYTES) return false;
  NSData* bytes = [NSData dataWithBytes:data length:length];
  NSError* error = nil;
  id value = [NSJSONSerialization JSONObjectWithData:bytes options:NSJSONReadingFragmentsAllowed error:&error];
  (void)error;
  return value != nil;
}

bool copyNativeOutput(const zt_mac_native_api_v1* api, zt_mac_native_status status,
                      zt_mac_native_output_v1* output, id* jsonOutput) {
  if (api == nullptr || output == nullptr || jsonOutput == nullptr) return false;
  bool valid = status == ZT_MAC_NATIVE_OK && output->data != nullptr && output->length > 0 &&
      output->length <= ZT_MAC_NATIVE_MAX_JSON_BYTES && validNativeJson(output->data, output->length);
  id parsed = nil;
  if (valid) {
    NSData* data = [NSData dataWithBytes:output->data length:output->length];
    NSError* error = nil;
    parsed = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:&error];
    (void)error;
    valid = parsed != nil;
  }
  zt_mac_native_status freeStatus = ZT_MAC_NATIVE_OK;
  if (output->data != nullptr) freeStatus = api->free_buffer(output->data, output->length);
  *output = {nullptr, 0};
  if (freeStatus != ZT_MAC_NATIVE_OK || !valid) return false;
  *jsonOutput = parsed;
  return true;
}

bool makeTrustRequest(const NativeRuntimePolicyV1& policy, const NativeComponentPolicyV1& component,
                      const std::string& pluginRoot, const std::string& architecture,
                      zt_mac_native_trust_request_v1* request) {
  if (request == nullptr || !isAllowedNativeRoleV1(false)) return false;
  *request = {};
  request->struct_size = sizeof(*request);
  request->require_admin = 0;
  request->plugin_root_utf8 = reinterpret_cast<const uint8_t*>(pluginRoot.data());
  request->plugin_root_length = static_cast<uint32_t>(pluginRoot.size());
  request->plugin_id_utf8 = reinterpret_cast<const uint8_t*>(component.pluginId.data());
  request->plugin_id_length = static_cast<uint32_t>(component.pluginId.size());
  request->relative_path_utf8 = reinterpret_cast<const uint8_t*>(component.relativePath.data());
  request->relative_path_length = static_cast<uint32_t>(component.relativePath.size());
  request->approved_team_id_utf8 = reinterpret_cast<const uint8_t*>(policy.teamId.data());
  request->approved_team_id_length = static_cast<uint32_t>(policy.teamId.size());
  request->approved_app_path_utf8 = reinterpret_cast<const uint8_t*>(policy.appBundlePath.data());
  request->approved_app_path_length = static_cast<uint32_t>(policy.appBundlePath.size());
  request->approved_app_bundle_identifier_utf8 = reinterpret_cast<const uint8_t*>(policy.appBundleId.data());
  request->approved_app_bundle_identifier_length = static_cast<uint32_t>(policy.appBundleId.size());
  request->expected_runtime_identifier_utf8 = reinterpret_cast<const uint8_t*>(policy.workerBundleId.data());
  request->expected_runtime_identifier_length = static_cast<uint32_t>(policy.workerBundleId.size());
  request->expected_component_identifier_utf8 = reinterpret_cast<const uint8_t*>(component.identifier.data());
  request->expected_component_identifier_length = static_cast<uint32_t>(component.identifier.size());
  request->expected_sha256_hex_utf8 = reinterpret_cast<const uint8_t*>(component.sha256.data());
  request->expected_sha256_hex_length = static_cast<uint32_t>(component.sha256.size());
  request->expected_architecture_utf8 = reinterpret_cast<const uint8_t*>(architecture.data());
  request->expected_architecture_length = static_cast<uint32_t>(architecture.size());
  request->approved_minimum_os_utf8 = reinterpret_cast<const uint8_t*>(policy.minimumOs.data());
  request->approved_minimum_os_length = static_cast<uint32_t>(policy.minimumOs.size());
  return true;
}

std::string componentKey(const std::string& pluginId, const std::string& dllId) {
  return pluginId + '\0' + dllId;
}

LoadedComponent* loadComponent(const NativeRuntimePolicyV1& policy, const std::string& pluginRoot,
                               const std::string& architecture, const std::string& pluginId,
                               const std::string& dllId, const std::string& pluginInstanceId,
                               uint64_t owner, uint64_t generation,
                               std::map<std::string, LoadedComponent>* loaded,
                               std::string* error) {
  const std::string key = componentKey(pluginId, dllId);
  auto existing = loaded->find(key);
  if (existing != loaded->end()) return &existing->second;
  const NativeComponentPolicyV1* component = ztools::macnative::findComponentPolicyV1(policy, pluginId, dllId);
  if (component == nullptr) {
    if (error != nullptr) *error = "MAC_NATIVE_COMPONENT_NOT_IN_SEALED_CATALOG";
    return nullptr;
  }
  zt_mac_native_trust_request_v1 request{};
  if (!makeTrustRequest(policy, *component, pluginRoot, architecture, &request)) {
    if (error != nullptr) *error = "MAC_NATIVE_TRUST_REQUEST_INVALID";
    return nullptr;
  }
  zt_mac_native_trust_result_v1 result{};
  zt_mac_native_loaded_component_v1 nativeLoaded{};
  nativeLoaded.pinned_descriptor = -1;
  const uint32_t status = zt_mac_native_load_candidate_v1(&request, &result, &nativeLoaded);
  if (status != ZT_MAC_TRUST_COMPONENT_READY || result.may_load != 1 ||
      result.same_object_load_proven != 1 || result.dependency_closure_validated != 1) {
    zt_mac_native_unload_candidate_v1(&nativeLoaded);
    if (error != nullptr) *error = nativeStatusError(status);
    return nullptr;
  }
  NSDictionary* initConfig = @{
      @"pluginId": [NSString stringWithUTF8String:pluginId.c_str()],
      @"dllId": [NSString stringWithUTF8String:dllId.c_str()],
      @"pluginInstanceId": [NSString stringWithUTF8String:pluginInstanceId.c_str()],
      @"ownerToken": [NSString stringWithFormat:@"%llu", static_cast<unsigned long long>(owner)],
      @"generation": [NSString stringWithFormat:@"%llu", static_cast<unsigned long long>(generation)],
  };
  NSData* initData = serialize(initConfig);
  if (initData == nil || initData.length == 0 || initData.length > ZT_MAC_NATIVE_MAX_JSON_BYTES) {
    zt_mac_native_unload_candidate_v1(&nativeLoaded);
    if (error != nullptr) *error = "MAC_NATIVE_INIT_CONFIG_INVALID";
    return nullptr;
  }
  const zt_mac_native_status initStatus = nativeLoaded.api->init({
      static_cast<const uint8_t*>(initData.bytes), static_cast<uint32_t>(initData.length)});
  if (initStatus != ZT_MAC_NATIVE_OK) {
    zt_mac_native_unload_candidate_v1(&nativeLoaded);
    if (error != nullptr) *error = "MAC_NATIVE_COMPONENT_INIT_FAILED";
    return nullptr;
  }
  nativeLoaded.initialized = 1;
  try {
    auto inserted = loaded->emplace(key, LoadedComponent{nativeLoaded, pluginId, dllId});
    return &inserted.first->second;
  } catch (...) {
    zt_mac_native_unload_candidate_v1(&nativeLoaded);
    if (error != nullptr) *error = "MAC_NATIVE_OUT_OF_MEMORY";
    return nullptr;
  }
}

bool processFrame(const WireFrameV1& request, const NativeRuntimePolicyV1& policy, const std::string& pluginRoot,
                  const std::string& architecture, uint64_t owner, uint64_t generation,
                  const std::string& pluginInstanceId, WorkerSessionV1* session,
                  std::map<std::string, LoadedComponent>* components) {
  if (request.header.owner != owner || request.header.generation != generation || session == nullptr || components == nullptr) return false;
  NSDictionary* body = nil;
  if (!parseJson(request.payload, &body)) return false;
  std::string requestId;
  if (!readString(body, @"requestId", &requestId, 32)) return false;
  if (request.header.type == ZT_MAC_FRAME_SHUTDOWN) {
    session->beginStop();
    for (auto& entry : *components) zt_mac_native_unload_candidate_v1(&entry.second.loaded);
    components->clear();
    writeJson(ZT_MAC_FRAME_RESPONSE, owner, generation, request.header.taskId,
        [NSString stringWithUTF8String:requestId.c_str()], true, @{@"stopped": @YES}, nil);
    return false;
  }
  if (request.header.type == ZT_MAC_FRAME_DESTROY) {
    std::string operation;
    if (!readString(body, @"operation", &operation, 32) || operation != "unload") return false;
    std::string pluginId;
    std::string dllId;
    if (!readString(body, @"pluginId", &pluginId) || !readString(body, @"dllId", &dllId)) return false;
    const auto found = components->find(componentKey(pluginId, dllId));
    if (found != components->end()) {
      zt_mac_native_unload_candidate_v1(&found->second.loaded);
      components->erase(found);
    }
    return writeJson(ZT_MAC_FRAME_RESPONSE, owner, generation, request.header.taskId,
        [NSString stringWithUTF8String:requestId.c_str()], true, @{@"unloaded": @YES}, nil);
  }
  std::string pluginId;
  std::string dllId;
  std::string instanceId;
  if (!readString(body, @"pluginId", &pluginId) || !isSafeId(pluginId) ||
      !readString(body, @"dllId", &dllId) || !isSafeId(dllId) ||
      !readString(body, @"pluginInstanceId", &instanceId) || instanceId != pluginInstanceId) return false;
  std::string operation;
  if (!readString(body, @"operation", &operation, 32)) return false;
  if (request.header.type == ZT_MAC_FRAME_INFO && operation == "info") {
    std::string error;
    LoadedComponent* component = loadComponent(policy, pluginRoot, architecture, pluginId, dllId,
        pluginInstanceId, owner, generation, components, &error);
    if (component == nullptr) {
      return writeJson(ZT_MAC_FRAME_ERROR, owner, generation, 0,
          [NSString stringWithUTF8String:requestId.c_str()], false, nil,
          [NSString stringWithUTF8String:error.c_str()]);
    }
    zt_mac_native_output_v1 output{nullptr, 0};
    const zt_mac_native_status status = component->loaded.api->get_info(&output);
    id info = nil;
    if (!copyNativeOutput(component->loaded.api, status, &output, &info)) {
      return writeJson(ZT_MAC_FRAME_ERROR, owner, generation, 0,
          [NSString stringWithUTF8String:requestId.c_str()], false, nil, @"MAC_NATIVE_DLL_INFO_INVALID");
    }
    return writeJson(ZT_MAC_FRAME_RESPONSE, owner, generation, 0,
        [NSString stringWithUTF8String:requestId.c_str()], true, info, nil);
  }
  if (request.header.type == ZT_MAC_FRAME_CALL && operation == "call") {
    if (!session->beginTask(request.header.taskId)) return false;
    std::string error;
    LoadedComponent* component = loadComponent(policy, pluginRoot, architecture, pluginId, dllId,
        pluginInstanceId, owner, generation, components, &error);
    if (component == nullptr) {
      const FrameHeaderV1 errorHeader{ZT_MAC_NATIVE_WIRE_V1, ZT_MAC_FRAME_ERROR, 0, owner, generation,
                                      request.header.taskId};
      if (session->acceptWorkerFrame(errorHeader) != ztools::macnative::FrameDisposition::Accepted) return false;
      const bool written = writeJson(ZT_MAC_FRAME_ERROR, owner, generation, request.header.taskId,
          [NSString stringWithUTF8String:requestId.c_str()], false, nil,
          [NSString stringWithUTF8String:error.c_str()]);
      if (!session->clearTask(request.header.taskId)) return false;
      return written;
    }
    std::string functionName;
    if (!readString(body, @"functionName", &functionName, 128) ||
        functionName.empty() ||
        !((functionName[0] >= 'A' && functionName[0] <= 'Z') ||
          (functionName[0] >= 'a' && functionName[0] <= 'z') || functionName[0] == '_')) return false;
    for (const unsigned char character : functionName) {
      if (!((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') ||
            (character >= '0' && character <= '9') || character == '_' || character == '.' || character == '-')) return false;
    }
    id params = body[@"params"] ?: [NSNull null];
    NSDictionary* nativeRequest = @{
      @"functionName": [NSString stringWithUTF8String:functionName.c_str()],
      @"params": params
    };
    NSData* nativeData = serialize(nativeRequest);
    if (nativeData == nil || nativeData.length == 0 || nativeData.length > ZT_MAC_NATIVE_MAX_JSON_BYTES) return false;
    zt_mac_native_output_v1 output{nullptr, 0};
    const zt_mac_native_status status = component->loaded.api->call({
        static_cast<const uint8_t*>(nativeData.bytes), static_cast<uint32_t>(nativeData.length)}, &output);
    id result = nil;
    if (!copyNativeOutput(component->loaded.api, status, &output, &result)) {
      const FrameHeaderV1 errorHeader{ZT_MAC_NATIVE_WIRE_V1, ZT_MAC_FRAME_ERROR, 0, owner, generation,
                                      request.header.taskId};
      if (session->acceptWorkerFrame(errorHeader) != ztools::macnative::FrameDisposition::Accepted) return false;
      const bool written = writeJson(ZT_MAC_FRAME_ERROR, owner, generation, request.header.taskId,
          [NSString stringWithUTF8String:requestId.c_str()], false, nil, @"MAC_NATIVE_COMPONENT_CALL_FAILED");
      if (!session->clearTask(request.header.taskId)) return false;
      return written;
    }
    const FrameHeaderV1 responseHeader{ZT_MAC_NATIVE_WIRE_V1, ZT_MAC_FRAME_RESPONSE, 0, owner, generation,
                                       request.header.taskId};
    if (session->acceptWorkerFrame(responseHeader) != ztools::macnative::FrameDisposition::Accepted) return false;
    const bool written = writeJson(ZT_MAC_FRAME_RESPONSE, owner, generation, request.header.taskId,
        [NSString stringWithUTF8String:requestId.c_str()], true, result, nil);
    if (!session->clearTask(request.header.taskId)) return false;
    return written;
  }
  return false;
}

}  // namespace

int main(int argc, char** argv) {
  @autoreleasepool {
    std::string resourcesPath;
    std::string pluginRoot;
    std::string architecture;
    std::string pluginInstanceId;
    uint64_t owner = 0;
    uint64_t generation = 0;
    if (!parseArguments(argc, argv, &resourcesPath, &pluginRoot, &architecture, &pluginInstanceId,
                        &owner, &generation)) {
      std::cerr << "MAC_NATIVE_WORKER_ARGUMENTS_INVALID\n";
      return 64;
    }
    NativeRuntimePolicyV1 policy;
    std::string trustError;
    char canonicalResourcesBuffer[PATH_MAX]{};
    const bool resourcesResolved = realpath(resourcesPath.c_str(), canonicalResourcesBuffer) != nullptr;
    const std::string expectedWorkerPath = resourcesResolved
        ? std::string(canonicalResourcesBuffer) + "/native/ZToolsMacNativeWorker" : std::string();
    if (architecture != macArchitecture() ||
        !resourcesResolved || !currentExecutableMatches(expectedWorkerPath) ||
        !ztools::macnative::loadVerifiedRuntimePolicyV1(resourcesPath, architecture, &policy, &trustError) ||
        !ztools::macnative::verifyRunningCodeV1(policy, policy.workerBundleId, &trustError) ||
        !ztools::macnative::verifyGuestCodeV1(getppid(), policy, policy.hostBundleId, architecture, &trustError)) {
      std::cerr << (trustError.empty() ? "MAC_NATIVE_WORKER_TRUST_CHECK_FAILED" : trustError) << '\n';
      return 78;
    }
    WorkerSessionV1 session(owner, generation);
    if (!session.beginStart() || !session.beginHandshake()) return 65;
    WireFrameV1 handshake;
    if (!readFrameBlockingV1(STDIN_FILENO, &handshake) || handshake.header.type != ZT_MAC_FRAME_HANDSHAKE ||
        handshake.header.owner != owner || handshake.header.generation != generation || handshake.header.taskId != 0) {
      return 66;
    }
    NSDictionary* handshakeBody = nil;
    if (!parseJson(handshake.payload, &handshakeBody)) return 67;
    std::string parentOwner;
    std::string parentGeneration;
    std::string parentInstance;
    std::string parentArchitecture;
    std::string parentTeam;
    std::string parentIdentifier;
    if (![handshakeBody[@"wireVersion"] isKindOfClass:[NSNumber class]] ||
        [handshakeBody[@"wireVersion"] unsignedIntValue] != ZT_MAC_NATIVE_WIRE_V1 ||
        ![handshakeBody[@"abiVersion"] isKindOfClass:[NSNumber class]] ||
        [handshakeBody[@"abiVersion"] unsignedIntValue] != ZT_MAC_NATIVE_ABI_V1 ||
        !readString(handshakeBody, @"ownerToken", &parentOwner) ||
        parentOwner != std::to_string(owner) ||
        !readString(handshakeBody, @"generation", &parentGeneration) ||
        parentGeneration != std::to_string(generation) ||
        !readString(handshakeBody, @"pluginInstanceId", &parentInstance) || parentInstance != pluginInstanceId ||
        !readString(handshakeBody, @"architecture", &parentArchitecture) || parentArchitecture != architecture ||
        !readString(handshakeBody, @"teamId", &parentTeam) || parentTeam != policy.teamId ||
        !readString(handshakeBody, @"identifier", &parentIdentifier) || parentIdentifier != policy.hostBundleId ||
        [handshakeBody[@"hardenedRuntime"] boolValue] != YES ||
        [handshakeBody[@"libraryValidation"] boolValue] != YES) return 67;
    (void)parentOwner;
    (void)parentGeneration;
    if (!session.acceptHandshake(handshake.header, ZT_MAC_NATIVE_ABI_V1, 0)) return 68;
    NSDictionary* handshakeResult = @{
      @"status": @"ready",
      @"wireVersion": @(ZT_MAC_NATIVE_WIRE_V1),
      @"abiVersion": @(ZT_MAC_NATIVE_ABI_V1),
      @"capabilities": @0,
      @"architecture": [NSString stringWithUTF8String:architecture.c_str()],
      @"teamId": [NSString stringWithUTF8String:policy.teamId.c_str()],
      @"identifier": [NSString stringWithUTF8String:policy.workerBundleId.c_str()],
      @"hardenedRuntime": @YES,
      @"libraryValidation": @YES
    };
    NSData* handshakeData = serialize(handshakeResult);
    if (handshakeData == nil || !writeFrameTextV1(STDOUT_FILENO, ZT_MAC_FRAME_HANDSHAKE, owner, generation, 0,
        std::string(static_cast<const char*>(handshakeData.bytes), handshakeData.length))) return 69;

    WireFrameV1 firstRequest;
    std::map<std::string, LoadedComponent> components;
    while (readFrameBlockingV1(STDIN_FILENO, &firstRequest)) {
      @autoreleasepool {
        if (!processFrame(firstRequest, policy, pluginRoot, architecture, owner, generation,
                          pluginInstanceId, &session, &components)) {
          if (firstRequest.header.type == ZT_MAC_FRAME_SHUTDOWN) return 0;
          return 71;
        }
      }
    }
    session.beginStop();
    for (auto& entry : components) zt_mac_native_unload_candidate_v1(&entry.second.loaded);
    session.onWorkerExit(0);
    return 0;
  }
}

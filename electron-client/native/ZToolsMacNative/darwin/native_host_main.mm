#import <Foundation/Foundation.h>

#include "macos_policy_v1.hpp"
#include "wire_io_v1.hpp"
#include "worker_key_v1.hpp"
#include "ztools_mac_native_abi.h"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <limits.h>
#include <mach-o/dyld.h>
#include <fcntl.h>
#include <map>
#include <memory>
#include <poll.h>
#include <spawn.h>
#include <string>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <utility>
#include <vector>

namespace {

using ztools::macnative::FrameAccumulatorV1;
using ztools::macnative::NativeRuntimePolicyV1;
using ztools::macnative::WireFrameV1;
using ztools::macnative::WorkerSessionV1;
using ztools::macnative::WorkerKeyV1;
using ztools::macnative::FrameDisposition;

constexpr size_t kMaximumRequestIdBytes = 32;
constexpr size_t kMaximumQueuedRequestsPerWorker = 8;
constexpr size_t kMaximumWorkers = 64;
constexpr int kHandshakeTimeoutMs = 5000;
constexpr int kGracefulWorkerStopMs = 500;
constexpr int kTerminatedWorkerStopMs = 150;
constexpr int kEventLoopPollMs = 100;

struct Options {
  std::string resourcesPath;
  std::string pluginRoot;
  std::string architecture;
  std::string workerPath;
};

using WorkerKey = WorkerKeyV1;

struct PendingRequest {
  WireFrameV1 frame;
  std::string requestId;
  bool call = false;
};

struct WorkerProcess {
  WorkerProcess(uint64_t ownerValue, uint64_t generationValue, std::string instanceValue,
                std::string pluginValue)
      : owner(ownerValue), generation(generationValue), pluginInstanceId(std::move(instanceValue)),
        pluginId(std::move(pluginValue)),
        session(ownerValue, generationValue) {}

  uint64_t owner;
  uint64_t generation;
  std::string pluginInstanceId;
  std::string pluginId;
  pid_t pid = -1;
  int input = -1;
  int output = -1;
  bool closed = false;
  WorkerSessionV1 session;
  FrameAccumulatorV1 outputFrames;
  std::vector<uint8_t> initialHandshakePayload;
  std::unique_ptr<PendingRequest> pending;
  std::vector<WireFrameV1> queued;
};

using WorkerMap = std::map<WorkerKey, std::shared_ptr<WorkerProcess>>;

void setError(std::string* output, const char* error) noexcept {
  if (output == nullptr) return;
  try { *output = error; } catch (...) {}
}

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

bool isSafeRequestId(const std::string& value) noexcept {
  if (value.empty() || value.size() > kMaximumRequestIdBytes || value[0] == '0') return false;
  for (const unsigned char character : value) {
    if (character < '0' || character > '9') return false;
  }
  return true;
}

bool readString(NSDictionary* dictionary, NSString* key, std::string* output, size_t maximum = 1024) {
  if (dictionary == nil || key == nil || output == nullptr) return false;
  id value = dictionary[key];
  if (![value isKindOfClass:[NSString class]]) return false;
  NSData* bytes = [(NSString*)value dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
  if (bytes == nil || bytes.length == 0 || bytes.length > maximum) return false;
  output->assign(static_cast<const char*>(bytes.bytes), bytes.length);
  return output->find('\0') == std::string::npos;
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

NSData* serialize(id value) {
  NSError* error = nil;
  NSData* data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingFragmentsAllowed error:&error];
  (void)error;
  return data;
}

uint64_t parseOwner(const std::string& value) noexcept {
  if (value.empty() || value.size() > 20 || value[0] == '0') return 0;
  uint64_t result = 0;
  for (const char character : value) {
    if (character < '0' || character > '9') return 0;
    const uint64_t digit = static_cast<uint64_t>(character - '0');
    if (result > (UINT64_MAX - digit) / 10) return 0;
    result = result * 10 + digit;
  }
  return result;
}

bool decodeRequest(const WireFrameV1& frame, NSDictionary** body, std::string* requestId,
                   std::string* operation, std::string* pluginInstanceId) {
  if (!parseJson(frame.payload, body) ||
      !readString(*body, @"requestId", requestId, kMaximumRequestIdBytes) || !isSafeRequestId(*requestId) ||
      !readString(*body, @"operation", operation, 32)) return false;
  if (frame.header.type == ZT_MAC_FRAME_SHUTDOWN && *operation == "shutdown") {
    pluginInstanceId->clear();
    return frame.header.owner == 1 && frame.header.generation == 1 && frame.header.taskId == 0;
  }
  if (frame.header.type == ZT_MAC_FRAME_DESTROY && *operation == "releasePlugin") {
    std::string pluginId;
    pluginInstanceId->clear();
    return frame.header.owner == 1 && frame.header.generation == 1 && frame.header.taskId == 0 &&
        readString(*body, @"pluginId", &pluginId, 128) && isSafeId(pluginId);
  }
  return readString(*body, @"pluginInstanceId", pluginInstanceId, 128) &&
      isSafePluginInstanceId(*pluginInstanceId);
}

bool writeMainFrame(uint16_t type, uint64_t owner, uint64_t generation, uint64_t taskId,
                    const std::vector<uint8_t>& payload) {
  if (payload.size() > ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES) return false;
  return ztools::macnative::writeFrameV1(STDOUT_FILENO, type, owner, generation, taskId,
      payload.empty() ? nullptr : payload.data(), static_cast<uint32_t>(payload.size()));
}

bool writeMainJson(uint16_t type, uint64_t owner, uint64_t generation, uint64_t taskId,
                   NSString* requestId, bool ok, id result, NSString* error) {
  NSMutableDictionary* payload = [NSMutableDictionary dictionaryWithCapacity:4];
  if (requestId != nil) payload[@"requestId"] = requestId;
  payload[@"ok"] = @(ok);
  if (ok) payload[@"result"] = result ?: [NSNull null];
  else payload[@"error"] = error ?: @"MAC_NATIVE_OPERATION_FAILED";
  NSData* bytes = serialize(payload);
  if (bytes == nil || bytes.length > ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES) return false;
  const auto* begin = static_cast<const uint8_t*>(bytes.bytes);
  return ztools::macnative::writeFrameV1(STDOUT_FILENO, type, owner, generation, taskId,
      begin, static_cast<uint32_t>(bytes.length));
}

bool writeWorkerFrame(WorkerProcess& worker, const WireFrameV1& frame) {
  if (worker.closed || worker.input < 0) return false;
  return ztools::macnative::writeFrameV1(worker.input, frame.header.type, frame.header.owner,
      frame.header.generation, frame.header.taskId,
      frame.payload.empty() ? nullptr : frame.payload.data(), static_cast<uint32_t>(frame.payload.size()));
}

bool writeWorkerHandshake(WorkerProcess& worker, const NativeRuntimePolicyV1& policy,
                          const std::string& architecture) {
  NSDictionary* handshake = @{
    @"wireVersion": @(ZT_MAC_NATIVE_WIRE_V1),
    @"abiVersion": @(ZT_MAC_NATIVE_ABI_V1),
    @"ownerToken": [NSString stringWithFormat:@"%llu", static_cast<unsigned long long>(worker.owner)],
    @"generation": [NSString stringWithFormat:@"%llu", static_cast<unsigned long long>(worker.generation)],
    @"pluginInstanceId": [NSString stringWithUTF8String:worker.pluginInstanceId.c_str()],
    @"architecture": [NSString stringWithUTF8String:architecture.c_str()],
    @"teamId": [NSString stringWithUTF8String:policy.teamId.c_str()],
    @"identifier": [NSString stringWithUTF8String:policy.hostBundleId.c_str()],
    @"hardenedRuntime": @YES,
    @"libraryValidation": @YES
  };
  NSData* bytes = serialize(handshake);
  if (bytes == nil || bytes.length > ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES) return false;
  return ztools::macnative::writeFrameTextV1(worker.input, ZT_MAC_FRAME_HANDSHAKE,
      worker.owner, worker.generation, 0,
      std::string(static_cast<const char*>(bytes.bytes), bytes.length));
}

bool closeDescriptor(int* descriptor) noexcept {
  if (descriptor == nullptr || *descriptor < 0) return true;
  const int current = *descriptor;
  *descriptor = -1;
  return close(current) == 0 || errno == EINTR;
}

void closePipePair(int pipeDescriptors[2]) noexcept {
  closeDescriptor(&pipeDescriptors[0]);
  closeDescriptor(&pipeDescriptors[1]);
}

bool setNonBlocking(int descriptor) noexcept {
  const int flags = fcntl(descriptor, F_GETFL, 0);
  return flags >= 0 && fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0;
}

bool readFrameWithDeadline(int descriptor, FrameAccumulatorV1* accumulator,
                           WireFrameV1* output, int timeoutMs) {
  if (descriptor < 0 || accumulator == nullptr || output == nullptr) return false;
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
  for (;;) {
    if (accumulator->take(output)) return true;
    if (accumulator->invalidPrefix()) return false;
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) return false;
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
    struct pollfd descriptorPoll{descriptor, POLLIN, 0};
    const int result = poll(&descriptorPoll, 1, static_cast<int>(std::max<int64_t>(1, remaining)));
    if (result < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    if (result == 0 || (descriptorPoll.revents & (POLLERR | POLLNVAL)) != 0 ||
        ((descriptorPoll.revents & POLLHUP) != 0 && (descriptorPoll.revents & POLLIN) == 0)) return false;
    uint8_t buffer[16 * 1024];
    const ssize_t count = read(descriptor, buffer, sizeof(buffer));
    if (count <= 0) {
      if (count < 0 && errno == EINTR) continue;
      return false;
    }
    if (!accumulator->append(buffer, static_cast<size_t>(count))) return false;
  }
}

bool parseArguments(int argc, char** argv, Options* options) {
  if (options == nullptr) return false;
  std::map<std::string, std::string*> fields = {
    {"--resources", &options->resourcesPath},
    {"--plugin-root", &options->pluginRoot},
    {"--architecture", &options->architecture},
    {"--worker", &options->workerPath}
  };
  for (int index = 1; index < argc; ++index) {
    const std::string name(argv[index]);
    const auto found = fields.find(name);
    if (found == fields.end() || index + 1 >= argc || !found->second->empty()) return false;
    *found->second = argv[++index];
  }
  return !options->resourcesPath.empty() && !options->pluginRoot.empty() && options->pluginRoot.front() == '/' &&
      !options->architecture.empty() && !options->workerPath.empty();
}

bool canonicalPath(const std::string& path, std::string* output) {
  if (path.empty() || path.front() != '/' || path.size() > 4096 || output == nullptr) return false;
  char resolved[PATH_MAX]{};
  if (realpath(path.c_str(), resolved) == nullptr) return false;
  output->assign(resolved);
  return true;
}

bool currentExecutablePath(std::string* output) {
  if (output == nullptr) return false;
  uint32_t capacity = PATH_MAX;
  std::vector<char> buffer(capacity);
  if (_NSGetExecutablePath(buffer.data(), &capacity) != 0) return false;
  return canonicalPath(buffer.data(), output);
}

bool validateExecutablePaths(const Options& options, std::string* canonicalResources,
                             std::string* canonicalWorker) {
  if (!canonicalPath(options.resourcesPath, canonicalResources) ||
      !canonicalPath(options.workerPath, canonicalWorker)) return false;
  const std::string expectedWorker = *canonicalResources + "/native/ZToolsMacNativeWorker";
  if (*canonicalWorker != expectedWorker) return false;
  struct stat workerInfo{};
  struct stat workerLinkInfo{};
  if (lstat(options.workerPath.c_str(), &workerLinkInfo) != 0 || S_ISLNK(workerLinkInfo.st_mode) ||
      !S_ISREG(workerLinkInfo.st_mode) || stat(canonicalWorker->c_str(), &workerInfo) != 0 ||
      workerInfo.st_dev != workerLinkInfo.st_dev || workerInfo.st_ino != workerLinkInfo.st_ino) return false;
  struct stat rootInfo{};
  if (lstat(options.pluginRoot.c_str(), &rootInfo) != 0 || S_ISLNK(rootInfo.st_mode) || !S_ISDIR(rootInfo.st_mode)) return false;
  return true;
}

bool createPipe(int descriptors[2]) noexcept {
  descriptors[0] = descriptors[1] = -1;
  if (pipe(descriptors) != 0) return false;
  for (int index = 0; index < 2; ++index) {
    const int flags = fcntl(descriptors[index], F_GETFD, 0);
    if (flags < 0 || fcntl(descriptors[index], F_SETFD, flags | FD_CLOEXEC) != 0) {
      closePipePair(descriptors);
      return false;
    }
  }
  return true;
}

void reapWorker(WorkerProcess& worker, int gracefulTimeoutMs = kGracefulWorkerStopMs) noexcept {
  if (worker.closed) return;
  worker.closed = true;
  closeDescriptor(&worker.input);
  if (worker.pid > 0) {
    int status = 0;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(gracefulTimeoutMs);
    for (;;) {
      const pid_t result = waitpid(worker.pid, &status, WNOHANG);
      if (result == worker.pid || (result < 0 && errno == ECHILD)) {
        worker.pid = -1;
        break;
      }
      if (result < 0 && errno != EINTR) break;
      if (std::chrono::steady_clock::now() >= deadline) break;
      (void)poll(nullptr, 0, 15);
    }
    if (worker.pid > 0) {
      (void)kill(worker.pid, SIGTERM);
      const auto termDeadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(kTerminatedWorkerStopMs);
      for (;;) {
        const pid_t result = waitpid(worker.pid, &status, WNOHANG);
        if (result == worker.pid || (result < 0 && errno == ECHILD)) {
          worker.pid = -1;
          break;
        }
        if (result < 0 && errno != EINTR) break;
        if (std::chrono::steady_clock::now() >= termDeadline) break;
        (void)poll(nullptr, 0, 10);
      }
    }
    if (worker.pid > 0) {
      (void)kill(worker.pid, SIGKILL);
      while (waitpid(worker.pid, &status, 0) < 0 && errno == EINTR) {}
      worker.pid = -1;
    }
  }
  closeDescriptor(&worker.output);
  worker.session.beginStop();
  worker.session.onWorkerExit(0);
}

bool spawnWorkerProcess(WorkerProcess& worker, const Options& options,
                        const NativeRuntimePolicyV1& policy, std::string* error) {
  int childInput[2]{};
  int childOutput[2]{};
  if (!createPipe(childInput) || !createPipe(childOutput)) {
    closePipePair(childInput);
    closePipePair(childOutput);
    setError(error, "MAC_NATIVE_WORKER_PIPE_FAILED");
    return false;
  }
  if (!worker.session.beginStart() || !worker.session.beginHandshake()) {
    closePipePair(childInput);
    closePipePair(childOutput);
    setError(error, "MAC_NATIVE_WORKER_STATE_INVALID");
    return false;
  }

  posix_spawn_file_actions_t actions;
  if (posix_spawn_file_actions_init(&actions) != 0) {
    closePipePair(childInput);
    closePipePair(childOutput);
    setError(error, "MAC_NATIVE_WORKER_SPAWN_ACTIONS_FAILED");
    return false;
  }
  bool actionsReady = true;
  actionsReady = actionsReady && posix_spawn_file_actions_adddup2(&actions, childInput[0], STDIN_FILENO) == 0;
  actionsReady = actionsReady && posix_spawn_file_actions_adddup2(&actions, childOutput[1], STDOUT_FILENO) == 0;
  for (const int descriptor : {childInput[0], childInput[1], childOutput[0], childOutput[1]}) {
    if (descriptor != STDIN_FILENO && descriptor != STDOUT_FILENO) {
      actionsReady = actionsReady && posix_spawn_file_actions_addclose(&actions, descriptor) == 0;
    }
  }
  if (!actionsReady) {
    posix_spawn_file_actions_destroy(&actions);
    closePipePair(childInput);
    closePipePair(childOutput);
    setError(error, "MAC_NATIVE_WORKER_SPAWN_ACTIONS_FAILED");
    return false;
  }
  posix_spawnattr_t attributes;
  if (posix_spawnattr_init(&attributes) != 0) {
    posix_spawn_file_actions_destroy(&actions);
    closePipePair(childInput);
    closePipePair(childOutput);
    setError(error, "MAC_NATIVE_WORKER_SPAWN_ATTRIBUTES_FAILED");
    return false;
  }
#ifdef POSIX_SPAWN_CLOEXEC_DEFAULT
  const bool attributeFlagsReady = posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT) == 0;
#else
  const bool attributeFlagsReady = false;
#endif
  if (!attributeFlagsReady) {
    posix_spawnattr_destroy(&attributes);
    posix_spawn_file_actions_destroy(&actions);
    closePipePair(childInput);
    closePipePair(childOutput);
    setError(error, "MAC_NATIVE_WORKER_SPAWN_FLAGS_UNAVAILABLE");
    return false;
  }

  std::vector<std::string> arguments = {
    options.workerPath,
    "--resources", options.resourcesPath,
    "--plugin-root", options.pluginRoot,
    "--architecture", options.architecture,
    "--plugin-instance", worker.pluginInstanceId,
    "--owner", std::to_string(worker.owner),
    "--generation", std::to_string(worker.generation)
  };
  std::vector<char*> argumentPointers;
  argumentPointers.reserve(arguments.size() + 1);
  for (std::string& argument : arguments) argumentPointers.push_back(argument.data());
  argumentPointers.push_back(nullptr);
  char pathEnvironment[] = "PATH=/usr/bin:/bin:/usr/sbin:/sbin";
  char languageEnvironment[] = "LANG=C";
  char* environment[] = {pathEnvironment, languageEnvironment, nullptr};
  const int spawnStatus = posix_spawn(&worker.pid, options.workerPath.c_str(), &actions, &attributes,
      argumentPointers.data(), environment);
  posix_spawnattr_destroy(&attributes);
  posix_spawn_file_actions_destroy(&actions);
  closeDescriptor(&childInput[0]);
  closeDescriptor(&childOutput[1]);
  if (spawnStatus != 0) {
    closeDescriptor(&childInput[1]);
    closeDescriptor(&childOutput[0]);
    worker.pid = -1;
    setError(error, "MAC_NATIVE_WORKER_SPAWN_FAILED");
    return false;
  }
  worker.input = childInput[1];
  worker.output = childOutput[0];
  if (!setNonBlocking(worker.output)) {
    setError(error, "MAC_NATIVE_WORKER_PIPE_NONBLOCK_FAILED");
    reapWorker(worker, 0);
    return false;
  }

  if (!ztools::macnative::verifyGuestCodeV1(worker.pid, policy, policy.workerBundleId,
        options.architecture, error)) {
    reapWorker(worker, 0);
    return false;
  }
  if (!writeWorkerHandshake(worker, policy, options.architecture)) {
    setError(error, "MAC_NATIVE_WORKER_HANDSHAKE_WRITE_FAILED");
    reapWorker(worker, 0);
    return false;
  }
  WireFrameV1 handshakeFrame;
  if (!readFrameWithDeadline(worker.output, &worker.outputFrames, &handshakeFrame, kHandshakeTimeoutMs)) {
    setError(error, "MAC_NATIVE_WORKER_HANDSHAKE_TIMEOUT_OR_INVALID");
    reapWorker(worker, 0);
    return false;
  }
  NSDictionary* handshakeBody = nil;
  std::string status;
  std::string architecture;
  std::string teamId;
  std::string identifier;
  if (handshakeFrame.header.type != ZT_MAC_FRAME_HANDSHAKE ||
      handshakeFrame.header.owner != worker.owner || handshakeFrame.header.generation != worker.generation ||
      handshakeFrame.header.taskId != 0 || !parseJson(handshakeFrame.payload, &handshakeBody) ||
      !readString(handshakeBody, @"status", &status, 16) || status != "ready" ||
      ![handshakeBody[@"wireVersion"] isKindOfClass:[NSNumber class]] ||
      [handshakeBody[@"wireVersion"] unsignedIntValue] != ZT_MAC_NATIVE_WIRE_V1 ||
      ![handshakeBody[@"abiVersion"] isKindOfClass:[NSNumber class]] ||
      [handshakeBody[@"abiVersion"] unsignedIntValue] != ZT_MAC_NATIVE_ABI_V1 ||
      !readString(handshakeBody, @"architecture", &architecture, 16) || architecture != options.architecture ||
      !readString(handshakeBody, @"teamId", &teamId, 16) || teamId != policy.teamId ||
      !readString(handshakeBody, @"identifier", &identifier, 255) || identifier != policy.workerBundleId ||
      ![handshakeBody[@"hardenedRuntime"] isKindOfClass:[NSNumber class]] ||
      ![handshakeBody[@"hardenedRuntime"] boolValue] ||
      ![handshakeBody[@"libraryValidation"] isKindOfClass:[NSNumber class]] ||
      ![handshakeBody[@"libraryValidation"] boolValue] ||
      !worker.session.acceptHandshake(handshakeFrame.header, ZT_MAC_NATIVE_ABI_V1, 0) ||
      !ztools::macnative::verifyGuestCodeV1(worker.pid, policy, policy.workerBundleId,
          options.architecture, error)) {
    if (error == nullptr || error->empty()) setError(error, "MAC_NATIVE_WORKER_HANDSHAKE_INVALID");
    reapWorker(worker, 0);
    return false;
  }
  return true;
}

bool writeHostHandshake(const NativeRuntimePolicyV1& policy, const std::string& architecture) {
  NSDictionary* handshake = @{
    @"status": @"ready",
    @"wireVersion": @(ZT_MAC_NATIVE_WIRE_V1),
    @"abiVersion": @(ZT_MAC_NATIVE_ABI_V1),
    @"capabilities": @0,
    @"architecture": [NSString stringWithUTF8String:architecture.c_str()],
    @"teamId": [NSString stringWithUTF8String:policy.teamId.c_str()],
    @"identifier": [NSString stringWithUTF8String:policy.hostBundleId.c_str()],
    @"hardenedRuntime": @YES,
    @"libraryValidation": @YES
  };
  NSData* bytes = serialize(handshake);
  if (bytes == nil || bytes.length > ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES) return false;
  return ztools::macnative::writeFrameTextV1(STDOUT_FILENO, ZT_MAC_FRAME_HANDSHAKE, 1, 1, 0,
      std::string(static_cast<const char*>(bytes.bytes), bytes.length));
}

void removeWorker(WorkerMap* workers, const WorkerKey& key, const std::shared_ptr<WorkerProcess>& worker,
                  NSString* pendingError = @"MAC_NATIVE_WORKER_RECYCLED") {
  if (workers == nullptr || !worker) return;
  if (worker->pending) {
    if (worker->pending->call) (void)worker->session.timeOutTask(worker->pending->frame.header.taskId);
    (void)writeMainJson(ZT_MAC_FRAME_ERROR, worker->owner, worker->generation,
        worker->pending->frame.header.taskId,
        [NSString stringWithUTF8String:worker->pending->requestId.c_str()], false, nil, pendingError);
    worker->pending.reset();
  }
  for (const WireFrameV1& queued : worker->queued) {
    NSDictionary* body = nil;
    std::string requestId;
    if (parseJson(queued.payload, &body) && readString(body, @"requestId", &requestId, kMaximumRequestIdBytes)) {
      (void)writeMainJson(ZT_MAC_FRAME_ERROR, queued.header.owner, queued.header.generation,
          queued.header.taskId, [NSString stringWithUTF8String:requestId.c_str()], false, nil,
          @"MAC_NATIVE_WORKER_RECYCLED");
    }
  }
  worker->queued.clear();
  reapWorker(*worker);
  const auto found = workers->find(key);
  if (found != workers->end() && found->second == worker) workers->erase(found);
}

void dispatchNext(WorkerMap* workers, const WorkerKey& key, const std::shared_ptr<WorkerProcess>& worker) {
  if (workers == nullptr || !worker || worker->closed || worker->pending || worker->queued.empty()) return;
  WireFrameV1 frame = std::move(worker->queued.front());
  worker->queued.erase(worker->queued.begin());
  NSDictionary* body = nil;
  std::string requestId;
  std::string operation;
  std::string instanceId;
  std::string pluginId;
  if (!decodeRequest(frame, &body, &requestId, &operation, &instanceId)) {
    (void)writeMainJson(ZT_MAC_FRAME_ERROR, frame.header.owner, frame.header.generation, frame.header.taskId,
        nil, false, nil, @"MAC_NATIVE_REQUEST_INVALID");
    removeWorker(workers, key, worker, @"MAC_NATIVE_REQUEST_INVALID");
    return;
  }
  if (frame.header.owner != key.owner || frame.header.generation != key.generation ||
      instanceId != key.pluginInstanceId || !readString(body, @"pluginId", &pluginId, 128) ||
      !isSafeId(pluginId) || pluginId != key.pluginId || pluginId != worker->pluginId) {
    (void)writeMainJson(ZT_MAC_FRAME_ERROR, frame.header.owner, frame.header.generation, frame.header.taskId,
        [NSString stringWithUTF8String:requestId.c_str()], false, nil,
        @"MAC_NATIVE_PLUGIN_INSTANCE_IDENTITY_MISMATCH");
    removeWorker(workers, key, worker, @"MAC_NATIVE_REQUEST_INVALID");
    return;
  }
  const bool call = frame.header.type == ZT_MAC_FRAME_CALL && operation == "call";
  if (call && !worker->session.beginTask(frame.header.taskId)) {
    (void)writeMainJson(ZT_MAC_FRAME_ERROR, frame.header.owner, frame.header.generation, frame.header.taskId,
        [NSString stringWithUTF8String:requestId.c_str()], false, nil, @"MAC_NATIVE_TASK_ID_INVALID");
    removeWorker(workers, key, worker, @"MAC_NATIVE_TASK_ID_INVALID");
    return;
  }
  if (!writeWorkerFrame(*worker, frame)) {
    removeWorker(workers, key, worker, @"MAC_NATIVE_WORKER_WRITE_FAILED");
    return;
  }
  worker->pending = std::make_unique<PendingRequest>(PendingRequest{std::move(frame), requestId, call});
}

bool sendRequestToWorker(WorkerMap* workers, const Options& options, const NativeRuntimePolicyV1& policy,
                         const WireFrameV1& frame, const std::string& pluginInstanceId,
                         const std::string& pluginId,
                         std::string* error) {
  const WorkerKey key{pluginId, frame.header.owner, frame.header.generation, pluginInstanceId};
  auto found = workers->find(key);
  std::shared_ptr<WorkerProcess> worker;
  if (found == workers->end()) {
    if (workers->size() >= kMaximumWorkers) {
      setError(error, "MAC_NATIVE_WORKER_LIMIT_REACHED");
      return false;
    }
    worker = std::make_shared<WorkerProcess>(frame.header.owner, frame.header.generation,
        pluginInstanceId, pluginId);
    if (!spawnWorkerProcess(*worker, options, policy, error)) return false;
    workers->emplace(key, worker);
  } else {
    worker = found->second;
    if (worker->pluginId != pluginId) {
      setError(error, "MAC_NATIVE_PLUGIN_INSTANCE_IDENTITY_MISMATCH");
      return false;
    }
  }
  if (worker->queued.size() >= kMaximumQueuedRequestsPerWorker) {
    setError(error, "MAC_NATIVE_WORKER_QUEUE_FULL");
    return false;
  }
  worker->queued.push_back(frame);
  dispatchNext(workers, key, worker);
  return workers->find(key) != workers->end();
}

bool handleCancel(WorkerMap* workers, const WireFrameV1& frame, const std::string& pluginInstanceId,
                  NSDictionary* body, const std::string& requestId) {
  std::string pluginId;
  if (!readString(body, @"pluginId", &pluginId, 128) || !isSafeId(pluginId)) {
    return writeMainJson(ZT_MAC_FRAME_ERROR, frame.header.owner, frame.header.generation, frame.header.taskId,
        [NSString stringWithUTF8String:requestId.c_str()], false, nil, @"MAC_NATIVE_PLUGIN_ID_INVALID");
  }
  std::string targetText;
  const uint64_t targetTask = readString(body, @"targetTaskId", &targetText, 20) ? parseOwner(targetText) : 0;
  if (targetTask == 0 || targetTask != frame.header.taskId) {
    return writeMainJson(ZT_MAC_FRAME_ERROR, frame.header.owner, frame.header.generation, frame.header.taskId,
        [NSString stringWithUTF8String:requestId.c_str()], false, nil, @"MAC_NATIVE_CANCEL_TARGET_INVALID");
  }
  const WorkerKey key{pluginId, frame.header.owner, frame.header.generation, pluginInstanceId};
  const auto found = workers->find(key);
  if (found == workers->end()) {
    return writeMainJson(ZT_MAC_FRAME_RESPONSE, frame.header.owner, frame.header.generation, frame.header.taskId,
        [NSString stringWithUTF8String:requestId.c_str()], true, @{@"cancelled": @NO}, nil);
  }
  const auto worker = found->second;
  if (!worker->pending || !worker->pending->call || worker->pending->frame.header.taskId != targetTask) {
    return writeMainJson(ZT_MAC_FRAME_RESPONSE, frame.header.owner, frame.header.generation, frame.header.taskId,
        [NSString stringWithUTF8String:requestId.c_str()], true, @{@"cancelled": @NO}, nil);
  }
  removeWorker(workers, key, worker, @"MAC_NATIVE_CALL_CANCELLED_WORKER_RECYCLED");
  return writeMainJson(ZT_MAC_FRAME_RESPONSE, frame.header.owner, frame.header.generation, frame.header.taskId,
      [NSString stringWithUTF8String:requestId.c_str()], true, @{@"cancelled": @YES}, nil);
}

bool handleMainRequest(WorkerMap* workers, const Options& options, const NativeRuntimePolicyV1& policy,
                       const WireFrameV1& frame, bool* shouldStop) {
  NSDictionary* body = nil;
  std::string requestId;
  std::string operation;
  std::string pluginInstanceId;
  if (!decodeRequest(frame, &body, &requestId, &operation, &pluginInstanceId)) return false;
  if (frame.header.type == ZT_MAC_FRAME_SHUTDOWN) {
    for (auto iterator = workers->begin(); iterator != workers->end();) {
      const WorkerKey key = iterator->first;
      const auto worker = iterator->second;
      ++iterator;
      removeWorker(workers, key, worker, @"MAC_NATIVE_HOST_STOPPING");
    }
    *shouldStop = true;
    return writeMainJson(ZT_MAC_FRAME_RESPONSE, frame.header.owner, frame.header.generation, frame.header.taskId,
        [NSString stringWithUTF8String:requestId.c_str()], true, @{@"stopped": @YES}, nil);
  }
  if (frame.header.type == ZT_MAC_FRAME_DESTROY && operation == "releasePlugin") {
    std::string pluginId;
    if (!readString(body, @"pluginId", &pluginId, 128) || !isSafeId(pluginId)) return false;
    std::vector<std::pair<WorkerKey, std::shared_ptr<WorkerProcess>>> retiring;
    for (const auto& entry : *workers) {
      if (entry.first.matchesPlugin(pluginId)) retiring.emplace_back(entry.first, entry.second);
    }
    for (const auto& entry : retiring) {
      removeWorker(workers, entry.first, entry.second, @"MAC_NATIVE_PLUGIN_MAINTENANCE");
    }
    return writeMainJson(ZT_MAC_FRAME_RESPONSE, frame.header.owner, frame.header.generation, 0,
        [NSString stringWithUTF8String:requestId.c_str()], true, @{@"released": @YES}, nil);
  }
  if (frame.header.type == ZT_MAC_FRAME_CANCEL && operation == "cancel") {
    return handleCancel(workers, frame, pluginInstanceId, body, requestId);
  }
  if (frame.header.type == ZT_MAC_FRAME_DESTROY && operation == "releaseOwner" && frame.header.taskId == 0) {
    std::vector<std::pair<WorkerKey, std::shared_ptr<WorkerProcess>>> retiring;
    for (const auto& entry : *workers) {
      if (entry.first.matchesOwner(frame.header.owner, frame.header.generation, pluginInstanceId)) {
        retiring.emplace_back(entry.first, entry.second);
      }
    }
    for (const auto& entry : retiring) {
      removeWorker(workers, entry.first, entry.second, @"MAC_NATIVE_OWNER_RELEASED");
    }
    return writeMainJson(ZT_MAC_FRAME_RESPONSE, frame.header.owner, frame.header.generation, 0,
        [NSString stringWithUTF8String:requestId.c_str()], true, @{@"released": @YES}, nil);
  }
  std::string pluginId;
  if (!readString(body, @"pluginId", &pluginId, 128) || !isSafeId(pluginId)) {
    return writeMainJson(ZT_MAC_FRAME_ERROR, frame.header.owner, frame.header.generation, frame.header.taskId,
        [NSString stringWithUTF8String:requestId.c_str()], false, nil, @"MAC_NATIVE_PLUGIN_ID_INVALID");
  }
  bool supported = false;
  if (frame.header.type == ZT_MAC_FRAME_INFO && operation == "info" && frame.header.taskId == 0) supported = true;
  if (frame.header.type == ZT_MAC_FRAME_CALL && operation == "call" && frame.header.taskId != 0) supported = true;
  if (frame.header.type == ZT_MAC_FRAME_DESTROY && operation == "unload" && frame.header.taskId == 0) supported = true;
  if (!supported) {
    return writeMainJson(ZT_MAC_FRAME_ERROR, frame.header.owner, frame.header.generation, frame.header.taskId,
        [NSString stringWithUTF8String:requestId.c_str()], false, nil, @"MAC_NATIVE_OPERATION_UNSUPPORTED");
  }
  if (frame.header.type == ZT_MAC_FRAME_DESTROY && operation == "unload") {
    const WorkerKey key{pluginId, frame.header.owner, frame.header.generation, pluginInstanceId};
    const auto found = workers->find(key);
    if (found == workers->end()) {
      return writeMainJson(ZT_MAC_FRAME_RESPONSE, frame.header.owner, frame.header.generation, 0,
          [NSString stringWithUTF8String:requestId.c_str()], true, @{@"unloaded": @YES}, nil);
    }
  }
  std::string error;
  if (!sendRequestToWorker(workers, options, policy, frame, pluginInstanceId, pluginId, &error)) {
    const std::string reason = error.empty() ? "MAC_NATIVE_WORKER_START_FAILED" : error;
    return writeMainJson(ZT_MAC_FRAME_ERROR, frame.header.owner, frame.header.generation, frame.header.taskId,
        [NSString stringWithUTF8String:requestId.c_str()], false, nil,
        [NSString stringWithUTF8String:reason.c_str()]);
  }
  return true;
}

bool handleWorkerFrame(WorkerMap* workers, const WorkerKey& key,
                       const std::shared_ptr<WorkerProcess>& worker, const WireFrameV1& frame) {
  if (!worker || worker->closed || frame.header.owner != worker->owner ||
      frame.header.generation != worker->generation || !worker->pending ||
      (frame.header.type != ZT_MAC_FRAME_RESPONSE && frame.header.type != ZT_MAC_FRAME_ERROR) ||
      frame.header.taskId != worker->pending->frame.header.taskId) {
    removeWorker(workers, key, worker, @"MAC_NATIVE_WORKER_PROTOCOL_INVALID");
    return false;
  }
  NSDictionary* body = nil;
  std::string responseId;
  if (!parseJson(frame.payload, &body) || !readString(body, @"requestId", &responseId, kMaximumRequestIdBytes) ||
      responseId != worker->pending->requestId) {
    removeWorker(workers, key, worker, @"MAC_NATIVE_WORKER_RESPONSE_IDENTITY_MISMATCH");
    return false;
  }
  const bool call = worker->pending->call;
  if (call) {
    const FrameDisposition disposition = worker->session.acceptWorkerFrame(frame.header);
    if (disposition != FrameDisposition::Accepted || !worker->session.clearTask(frame.header.taskId)) {
      removeWorker(workers, key, worker, @"MAC_NATIVE_WORKER_TASK_STATE_INVALID");
      return false;
    }
  }
  if (!writeMainFrame(frame.header.type, frame.header.owner, frame.header.generation,
      frame.header.taskId, frame.payload)) {
    removeWorker(workers, key, worker, @"MAC_NATIVE_MAIN_PIPE_FAILED");
    return false;
  }
  worker->pending.reset();
  dispatchNext(workers, key, worker);
  return true;
}

void handleWorkerExit(WorkerMap* workers, const WorkerKey& key,
                      const std::shared_ptr<WorkerProcess>& worker) {
  if (!worker || worker->closed) return;
  int status = 0;
  const pid_t result = worker->pid > 0 ? waitpid(worker->pid, &status, WNOHANG) : -1;
  if (result == 0) return;
  removeWorker(workers, key, worker, @"MAC_NATIVE_WORKER_EXITED");
}

void cleanupWorkers(WorkerMap* workers) noexcept {
  if (workers == nullptr) return;
  while (!workers->empty()) {
    auto iterator = workers->begin();
    const WorkerKey key = iterator->first;
    const auto worker = iterator->second;
    removeWorker(workers, key, worker, @"MAC_NATIVE_HOST_STOPPING");
  }
}

int runHost(const Options& options) {
  std::string canonicalResources;
  std::string canonicalWorker;
  std::string canonicalHost;
  if ((options.architecture != "arm64" && options.architecture != "x86_64") ||
      !validateExecutablePaths(options, &canonicalResources, &canonicalWorker) ||
      !currentExecutablePath(&canonicalHost) ||
      canonicalHost != canonicalResources + "/native/ZToolsMacNativeHost") {
    std::cerr << "MAC_NATIVE_HOST_RESOURCE_LAYOUT_INVALID\n";
    return 64;
  }
  NativeRuntimePolicyV1 policy;
  Options verifiedOptions = options;
  verifiedOptions.resourcesPath = canonicalResources;
  verifiedOptions.workerPath = canonicalWorker;
  std::string error;
  if (!ztools::macnative::loadVerifiedRuntimePolicyV1(canonicalResources, options.architecture, &policy, &error) ||
      !ztools::macnative::verifyRunningCodeV1(policy, policy.hostBundleId, &error) ||
      !ztools::macnative::verifyGuestCodeV1(getppid(), policy, policy.appBundleId, options.architecture, &error) ||
      !ztools::macnative::verifyStaticCodeV1(canonicalWorker, policy, policy.workerBundleId, &error)) {
    std::cerr << (error.empty() ? "MAC_NATIVE_HOST_TRUST_CHECK_FAILED" : error) << '\n';
    return 78;
  }
  if (!writeHostHandshake(policy, options.architecture)) return 70;
  if (!setNonBlocking(STDIN_FILENO)) return 71;
  (void)std::signal(SIGPIPE, SIG_IGN);

  WorkerMap workers;
  FrameAccumulatorV1 mainFrames;
  bool shouldStop = false;
  bool mainClosed = false;
  uint8_t inputBuffer[64 * 1024];
  while (!shouldStop && !mainClosed) {
    std::vector<pollfd> pollDescriptors;
    std::vector<std::pair<WorkerKey, std::shared_ptr<WorkerProcess>>> workerSlots;
    pollDescriptors.push_back({STDIN_FILENO, POLLIN, 0});
    for (const auto& entry : workers) {
      if (!entry.second->closed && entry.second->output >= 0) {
        pollDescriptors.push_back({entry.second->output, POLLIN, 0});
        workerSlots.emplace_back(entry.first, entry.second);
      }
    }
    const int polled = poll(pollDescriptors.data(), static_cast<nfds_t>(pollDescriptors.size()), kEventLoopPollMs);
    if (polled < 0 && errno != EINTR) {
      cleanupWorkers(&workers);
      return 72;
    }

    for (size_t slot = 0; slot < workerSlots.size(); ++slot) {
      const short events = pollDescriptors[slot + 1].revents;
      if (events == 0) continue;
      const auto& key = workerSlots[slot].first;
      const auto& worker = workerSlots[slot].second;
      if (worker->closed) continue;
      if ((events & (POLLERR | POLLNVAL)) != 0) {
        removeWorker(&workers, key, worker, @"MAC_NATIVE_WORKER_PIPE_FAILED");
        continue;
      }
      for (;;) {
        const ssize_t count = read(worker->output, inputBuffer, sizeof(inputBuffer));
        if (count > 0) {
          if (!worker->outputFrames.append(inputBuffer, static_cast<size_t>(count))) {
            removeWorker(&workers, key, worker, @"MAC_NATIVE_WORKER_FRAME_SIZE_INVALID");
            break;
          }
          WireFrameV1 response;
          while (worker->outputFrames.take(&response)) {
            if (!handleWorkerFrame(&workers, key, worker, response) || worker->closed) break;
          }
          if (worker->closed) break;
          continue;
        }
        if (count == 0) {
          handleWorkerExit(&workers, key, worker);
          break;
        }
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
        removeWorker(&workers, key, worker, @"MAC_NATIVE_WORKER_READ_FAILED");
        break;
      }
      if (!worker->closed && worker->outputFrames.invalidPrefix()) {
        removeWorker(&workers, key, worker, @"MAC_NATIVE_WORKER_FRAME_INVALID");
      }
      if (!worker->closed && (events & POLLHUP) != 0) handleWorkerExit(&workers, key, worker);
    }

    const short mainEvents = pollDescriptors[0].revents;
    if ((mainEvents & (POLLERR | POLLNVAL)) != 0 ||
        ((mainEvents & POLLHUP) != 0 && (mainEvents & POLLIN) == 0)) {
      mainClosed = true;
      continue;
    }
    if ((mainEvents & POLLIN) != 0) {
      for (;;) {
        const ssize_t count = read(STDIN_FILENO, inputBuffer, sizeof(inputBuffer));
        if (count > 0) {
          if (!mainFrames.append(inputBuffer, static_cast<size_t>(count))) {
            mainClosed = true;
            break;
          }
          WireFrameV1 request;
          while (mainFrames.take(&request)) {
            @autoreleasepool {
              if (!handleMainRequest(&workers, verifiedOptions, policy, request, &shouldStop)) {
                mainClosed = true;
                break;
              }
            }
            if (shouldStop || mainClosed) break;
          }
          if (mainClosed || shouldStop) break;
          if (mainFrames.invalidPrefix()) {
            mainClosed = true;
            break;
          }
          continue;
        }
        if (count == 0) {
          mainClosed = true;
          break;
        }
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
        mainClosed = true;
        break;
      }
    }
    if (mainClosed || shouldStop) break;
    std::vector<std::pair<WorkerKey, std::shared_ptr<WorkerProcess>>> currentWorkers;
    currentWorkers.reserve(workers.size());
    for (const auto& entry : workers) currentWorkers.emplace_back(entry.first, entry.second);
    for (const auto& entry : currentWorkers) handleWorkerExit(&workers, entry.first, entry.second);
  }
  cleanupWorkers(&workers);
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  @autoreleasepool {
    Options options;
    if (!parseArguments(argc, argv, &options)) {
      std::cerr << "MAC_NATIVE_HOST_ARGUMENTS_INVALID\n";
      return 64;
    }
    return runHost(options);
  }
}

#ifndef ZTOOLS_MAC_NATIVE_WORKER_SESSION_V1_H
#define ZTOOLS_MAC_NATIVE_WORKER_SESSION_V1_H

#include "ztools_mac_native_wire_v1.h"

#include <cstddef>
#include <cstdint>
#include <map>

namespace ztools::macnative {

struct FrameHeaderV1 {
  uint16_t version = 0;
  uint16_t type = 0;
  uint32_t payloadLength = 0;
  uint64_t owner = 0;
  uint64_t generation = 0;
  uint64_t taskId = 0;
};

enum class WireError : uint8_t {
  None,
  NullBuffer,
  Truncated,
  MagicMismatch,
  UnknownVersion,
  UnknownType,
  PayloadTooLarge,
  LengthMismatch,
  MissingIdentity,
  InvalidTaskId,
};

enum class WorkerState : uint8_t {
  Created,
  Starting,
  Handshaking,
  Ready,
  Cancelling,
  Stopping,
  Stopped,
  Failed,
};

enum class TaskState : uint8_t {
  Pending,
  Running,
  CancelRequested,
  Cancelled,
  Completed,
  TimedOut,
  Failed,
};

enum class FrameDisposition : uint8_t {
  Accepted,
  DroppedStaleGeneration,
  DroppedCancelledTask,
  DroppedCompletedTask,
  Rejected,
};

struct TaskSnapshot {
  TaskState state = TaskState::Pending;
  uint32_t progressEvents = 0;
  uint32_t callbackEvents = 0;
};

WireError decodeFrameHeaderV1(const uint8_t* frame, size_t frameLength, FrameHeaderV1* output) noexcept;
bool encodeFrameHeaderV1(const FrameHeaderV1& header, uint8_t* output, size_t outputLength) noexcept;
bool isNextGenerationV1(uint64_t previous, uint64_t next) noexcept;
bool isAllowedNativeRoleV1(bool requireAdmin) noexcept;

class WorkerSessionV1 final {
 public:
  WorkerSessionV1(uint64_t owner, uint64_t generation) noexcept;

  WorkerState state() const noexcept { return state_; }
  uint64_t owner() const noexcept { return owner_; }
  uint64_t generation() const noexcept { return generation_; }
  bool beginStart() noexcept;
  bool beginHandshake() noexcept;
  bool acceptHandshake(const FrameHeaderV1& frame, uint32_t abiVersion, uint64_t capabilities) noexcept;
  bool beginTask(uint64_t taskId) noexcept;
  bool requestCancel(uint64_t taskId) noexcept;
  FrameDisposition acceptWorkerFrame(const FrameHeaderV1& frame) noexcept;
  bool queryTask(uint64_t taskId, TaskSnapshot* snapshot) const noexcept;
  bool clearTask(uint64_t taskId) noexcept;
  bool timeOutTask(uint64_t taskId) noexcept;
  void beginStop() noexcept;
  void onWorkerExit(int32_t exitCode) noexcept;

 private:
  void failActiveTask() noexcept;
  void protocolFailure() noexcept;

  const uint64_t owner_;
  const uint64_t generation_;
  WorkerState state_ = WorkerState::Created;
  uint64_t lastTaskId_ = 0;
  uint64_t activeTaskId_ = 0;
  std::map<uint64_t, TaskSnapshot> tasks_;
};

}  // namespace ztools::macnative

#endif

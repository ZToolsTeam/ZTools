#include "worker_session_v1.h"
#include "ztools_mac_native_abi.h"

#include <limits>

namespace ztools::macnative {
namespace {

constexpr uint8_t kMagic[4] = {'Z', 'T', 'M', 'N'};
constexpr size_t kVersionOffset = 4;
constexpr size_t kTypeOffset = 6;
constexpr size_t kPayloadLengthOffset = 8;
constexpr size_t kOwnerOffset = 12;
constexpr size_t kGenerationOffset = 20;
constexpr size_t kTaskIdOffset = 28;
constexpr size_t kMaxTrackedTasks = 4096;

uint16_t readU16(const uint8_t* bytes) noexcept {
  return static_cast<uint16_t>(bytes[0]) | static_cast<uint16_t>(static_cast<uint16_t>(bytes[1]) << 8);
}

uint32_t readU32(const uint8_t* bytes) noexcept {
  return static_cast<uint32_t>(bytes[0]) |
         (static_cast<uint32_t>(bytes[1]) << 8) |
         (static_cast<uint32_t>(bytes[2]) << 16) |
         (static_cast<uint32_t>(bytes[3]) << 24);
}

uint64_t readU64(const uint8_t* bytes) noexcept {
  uint64_t value = 0;
  for (size_t index = 0; index < 8; ++index) value |= static_cast<uint64_t>(bytes[index]) << (index * 8);
  return value;
}

void writeU16(uint8_t* bytes, uint16_t value) noexcept {
  bytes[0] = static_cast<uint8_t>(value & 0xffu);
  bytes[1] = static_cast<uint8_t>((value >> 8) & 0xffu);
}

void writeU32(uint8_t* bytes, uint32_t value) noexcept {
  for (size_t index = 0; index < 4; ++index) bytes[index] = static_cast<uint8_t>((value >> (index * 8)) & 0xffu);
}

void writeU64(uint8_t* bytes, uint64_t value) noexcept {
  for (size_t index = 0; index < 8; ++index) bytes[index] = static_cast<uint8_t>((value >> (index * 8)) & 0xffu);
}

bool knownType(uint16_t type) noexcept {
  switch (type) {
    case ZT_MAC_FRAME_HANDSHAKE:
    case ZT_MAC_FRAME_INIT:
    case ZT_MAC_FRAME_INFO:
    case ZT_MAC_FRAME_CALL:
    case ZT_MAC_FRAME_CANCEL:
    case ZT_MAC_FRAME_QUERY:
    case ZT_MAC_FRAME_CLEAR:
    case ZT_MAC_FRAME_DESTROY:
    case ZT_MAC_FRAME_SHUTDOWN:
    case ZT_MAC_FRAME_PROGRESS:
    case ZT_MAC_FRAME_CALLBACK:
    case ZT_MAC_FRAME_RESPONSE:
    case ZT_MAC_FRAME_CANCELLED:
    case ZT_MAC_FRAME_ERROR:
      return true;
    default:
      return false;
  }
}

bool needsTaskId(uint16_t type) noexcept {
  return type == ZT_MAC_FRAME_CALL || type == ZT_MAC_FRAME_CANCEL || type == ZT_MAC_FRAME_QUERY ||
         type == ZT_MAC_FRAME_CLEAR || type == ZT_MAC_FRAME_PROGRESS || type == ZT_MAC_FRAME_CALLBACK ||
         type == ZT_MAC_FRAME_CANCELLED;
}

bool allowsTaskId(uint16_t type) noexcept {
  return needsTaskId(type) || type == ZT_MAC_FRAME_RESPONSE || type == ZT_MAC_FRAME_ERROR;
}

bool validTaskId(uint16_t type, uint64_t taskId) noexcept {
  if (needsTaskId(type)) return taskId != 0;
  if (type == ZT_MAC_FRAME_RESPONSE || type == ZT_MAC_FRAME_ERROR) return true;
  return taskId == 0;
}

bool isTerminal(TaskState state) noexcept {
  return state == TaskState::Cancelled || state == TaskState::Completed || state == TaskState::TimedOut ||
         state == TaskState::Failed;
}

}  // namespace

WireError decodeFrameHeaderV1(const uint8_t* frame, size_t frameLength, FrameHeaderV1* output) noexcept {
  if (frame == nullptr || output == nullptr) return WireError::NullBuffer;
  if (frameLength < ZT_MAC_NATIVE_WIRE_HEADER_BYTES) return WireError::Truncated;
  if (frame[0] != kMagic[0] || frame[1] != kMagic[1] || frame[2] != kMagic[2] || frame[3] != kMagic[3]) {
    return WireError::MagicMismatch;
  }
  FrameHeaderV1 decoded;
  decoded.version = readU16(frame + kVersionOffset);
  decoded.type = readU16(frame + kTypeOffset);
  decoded.payloadLength = readU32(frame + kPayloadLengthOffset);
  decoded.owner = readU64(frame + kOwnerOffset);
  decoded.generation = readU64(frame + kGenerationOffset);
  decoded.taskId = readU64(frame + kTaskIdOffset);
  if (decoded.version != ZT_MAC_NATIVE_WIRE_V1) return WireError::UnknownVersion;
  if (!knownType(decoded.type)) return WireError::UnknownType;
  if (decoded.payloadLength > ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES) return WireError::PayloadTooLarge;
  if (frameLength - ZT_MAC_NATIVE_WIRE_HEADER_BYTES != decoded.payloadLength) return WireError::LengthMismatch;
  if (decoded.owner == 0 || decoded.generation == 0) return WireError::MissingIdentity;
  if (!validTaskId(decoded.type, decoded.taskId)) return WireError::InvalidTaskId;
  *output = decoded;
  return WireError::None;
}

bool encodeFrameHeaderV1(const FrameHeaderV1& header, uint8_t* output, size_t outputLength) noexcept {
  if (output == nullptr || outputLength < ZT_MAC_NATIVE_WIRE_HEADER_BYTES ||
      header.version != ZT_MAC_NATIVE_WIRE_V1 || !knownType(header.type) ||
      header.payloadLength > ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES || header.owner == 0 || header.generation == 0 ||
      !validTaskId(header.type, header.taskId)) {
    return false;
  }
  output[0] = kMagic[0];
  output[1] = kMagic[1];
  output[2] = kMagic[2];
  output[3] = kMagic[3];
  writeU16(output + kVersionOffset, header.version);
  writeU16(output + kTypeOffset, header.type);
  writeU32(output + kPayloadLengthOffset, header.payloadLength);
  writeU64(output + kOwnerOffset, header.owner);
  writeU64(output + kGenerationOffset, header.generation);
  writeU64(output + kTaskIdOffset, header.taskId);
  return true;
}

bool isNextGenerationV1(uint64_t previous, uint64_t next) noexcept {
  return previous != 0 && previous != std::numeric_limits<uint64_t>::max() && next == previous + 1;
}

bool isAllowedNativeRoleV1(bool requireAdmin) noexcept {
  return !requireAdmin;
}

WorkerSessionV1::WorkerSessionV1(uint64_t owner, uint64_t generation) noexcept
    : owner_(owner), generation_(generation) {
  if (owner == 0 || generation == 0) state_ = WorkerState::Failed;
}

bool WorkerSessionV1::beginStart() noexcept {
  if (state_ != WorkerState::Created) return false;
  state_ = WorkerState::Starting;
  return true;
}

bool WorkerSessionV1::beginHandshake() noexcept {
  if (state_ != WorkerState::Starting) return false;
  state_ = WorkerState::Handshaking;
  return true;
}

bool WorkerSessionV1::acceptHandshake(const FrameHeaderV1& frame, uint32_t abiVersion,
                                      uint64_t capabilities) noexcept {
  if (state_ != WorkerState::Handshaking || frame.type != ZT_MAC_FRAME_HANDSHAKE ||
      frame.owner != owner_ || frame.generation != generation_ || frame.version != ZT_MAC_NATIVE_WIRE_V1 ||
      abiVersion != ZT_MAC_NATIVE_ABI_V1 || capabilities != 0) {
    protocolFailure();
    return false;
  }
  state_ = WorkerState::Ready;
  return true;
}

bool WorkerSessionV1::beginTask(uint64_t taskId) noexcept {
  if (state_ != WorkerState::Ready || activeTaskId_ != 0 || taskId == 0 || taskId <= lastTaskId_ ||
      tasks_.size() >= kMaxTrackedTasks) {
    return false;
  }
  try {
    tasks_.emplace(taskId, TaskSnapshot{});
  } catch (...) {
    protocolFailure();
    return false;
  }
  lastTaskId_ = taskId;
  activeTaskId_ = taskId;
  return true;
}

bool WorkerSessionV1::requestCancel(uint64_t taskId) noexcept {
  if (state_ != WorkerState::Ready || activeTaskId_ != taskId) return false;
  const auto found = tasks_.find(taskId);
  if (found == tasks_.end() || (found->second.state != TaskState::Pending && found->second.state != TaskState::Running)) {
    return false;
  }
  found->second.state = TaskState::CancelRequested;
  state_ = WorkerState::Cancelling;
  return true;
}

FrameDisposition WorkerSessionV1::acceptWorkerFrame(const FrameHeaderV1& frame) noexcept {
  if (frame.owner != owner_) {
    protocolFailure();
    return FrameDisposition::Rejected;
  }
  if (frame.generation < generation_) return FrameDisposition::DroppedStaleGeneration;
  if (frame.generation > generation_) {
    protocolFailure();
    return FrameDisposition::Rejected;
  }
  if (frame.version != ZT_MAC_NATIVE_WIRE_V1 || !knownType(frame.type) || !allowsTaskId(frame.type) ||
      frame.taskId == 0 ||
      (state_ != WorkerState::Ready && state_ != WorkerState::Cancelling)) {
    protocolFailure();
    return FrameDisposition::Rejected;
  }
  const auto found = tasks_.find(frame.taskId);
  if (found == tasks_.end()) {
    if (frame.taskId != 0 && frame.taskId <= lastTaskId_) return FrameDisposition::DroppedCompletedTask;
    protocolFailure();
    return FrameDisposition::Rejected;
  }
  TaskSnapshot& task = found->second;
  if (isTerminal(task.state)) return FrameDisposition::DroppedCompletedTask;
  if (frame.taskId != activeTaskId_) {
    protocolFailure();
    return FrameDisposition::Rejected;
  }
  if (state_ == WorkerState::Cancelling || task.state == TaskState::CancelRequested) {
    if (frame.type == ZT_MAC_FRAME_CANCELLED) {
      task.state = TaskState::Cancelled;
      activeTaskId_ = 0;
      state_ = WorkerState::Ready;
      return FrameDisposition::Accepted;
    }
    if (frame.type == ZT_MAC_FRAME_PROGRESS || frame.type == ZT_MAC_FRAME_CALLBACK ||
        frame.type == ZT_MAC_FRAME_RESPONSE || frame.type == ZT_MAC_FRAME_ERROR) {
      return FrameDisposition::DroppedCancelledTask;
    }
    protocolFailure();
    return FrameDisposition::Rejected;
  }
  switch (frame.type) {
    case ZT_MAC_FRAME_PROGRESS:
      ++task.progressEvents;
      task.state = TaskState::Running;
      return FrameDisposition::Accepted;
    case ZT_MAC_FRAME_CALLBACK:
      ++task.callbackEvents;
      task.state = TaskState::Running;
      return FrameDisposition::Accepted;
    case ZT_MAC_FRAME_RESPONSE:
      task.state = TaskState::Completed;
      activeTaskId_ = 0;
      return FrameDisposition::Accepted;
    case ZT_MAC_FRAME_CANCELLED:
      protocolFailure();
      return FrameDisposition::Rejected;
    case ZT_MAC_FRAME_ERROR:
      task.state = TaskState::Failed;
      activeTaskId_ = 0;
      return FrameDisposition::Accepted;
    default:
      protocolFailure();
      return FrameDisposition::Rejected;
  }
}

bool WorkerSessionV1::queryTask(uint64_t taskId, TaskSnapshot* snapshot) const noexcept {
  if (snapshot == nullptr) return false;
  const auto found = tasks_.find(taskId);
  if (found == tasks_.end()) return false;
  *snapshot = found->second;
  return true;
}

bool WorkerSessionV1::clearTask(uint64_t taskId) noexcept {
  const auto found = tasks_.find(taskId);
  if (found == tasks_.end() || !isTerminal(found->second.state) || activeTaskId_ == taskId) return false;
  tasks_.erase(found);
  return true;
}

bool WorkerSessionV1::timeOutTask(uint64_t taskId) noexcept {
  if ((state_ != WorkerState::Ready && state_ != WorkerState::Cancelling) || activeTaskId_ != taskId) return false;
  const auto found = tasks_.find(taskId);
  if (found == tasks_.end() || isTerminal(found->second.state)) return false;
  found->second.state = TaskState::TimedOut;
  activeTaskId_ = 0;
  state_ = WorkerState::Stopping;
  return true;
}

void WorkerSessionV1::beginStop() noexcept {
  if (state_ == WorkerState::Stopped || state_ == WorkerState::Failed || state_ == WorkerState::Stopping) return;
  failActiveTask();
  state_ = WorkerState::Stopping;
}

void WorkerSessionV1::onWorkerExit(int32_t exitCode) noexcept {
  if (state_ == WorkerState::Stopping) {
    state_ = WorkerState::Stopped;
    return;
  }
  if (state_ != WorkerState::Stopped && state_ != WorkerState::Failed) {
    failActiveTask();
    (void)exitCode;
    state_ = WorkerState::Failed;
  }
}

void WorkerSessionV1::failActiveTask() noexcept {
  if (activeTaskId_ == 0) return;
  const auto found = tasks_.find(activeTaskId_);
  if (found != tasks_.end() && !isTerminal(found->second.state)) found->second.state = TaskState::Failed;
  activeTaskId_ = 0;
}

void WorkerSessionV1::protocolFailure() noexcept {
  failActiveTask();
  state_ = WorkerState::Failed;
}

}  // namespace ztools::macnative

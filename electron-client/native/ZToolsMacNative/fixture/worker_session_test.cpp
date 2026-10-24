#include "worker_session_v1.h"
#include "ztools_mac_native_abi.h"

#include <array>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <stdexcept>

namespace {

uint32_t g_checks = 0;

void check(bool condition, const char* code) {
  if (!condition) throw std::runtime_error(code);
  ++g_checks;
}

using ztools::macnative::FrameDisposition;
using ztools::macnative::FrameHeaderV1;
using ztools::macnative::TaskSnapshot;
using ztools::macnative::TaskState;
using ztools::macnative::WireError;
using ztools::macnative::WorkerSessionV1;
using ztools::macnative::WorkerState;

FrameHeaderV1 frame(uint16_t type, uint64_t owner, uint64_t generation, uint64_t taskId = 0) {
  return {ZT_MAC_NATIVE_WIRE_V1, type, 0, owner, generation, taskId};
}

void testWireFrames() {
  std::array<uint8_t, ZT_MAC_NATIVE_WIRE_HEADER_BYTES + 3> bytes{};
  FrameHeaderV1 input = frame(ZT_MAC_FRAME_CALL, 17, 4, 8);
  input.payloadLength = 3;
  check(ztools::macnative::encodeFrameHeaderV1(input, bytes.data(), bytes.size()), "WIRE_ENCODE_FAILED");
  bytes[ZT_MAC_NATIVE_WIRE_HEADER_BYTES] = '{';
  bytes[ZT_MAC_NATIVE_WIRE_HEADER_BYTES + 1] = '"';
  bytes[ZT_MAC_NATIVE_WIRE_HEADER_BYTES + 2] = '}';
  FrameHeaderV1 decoded{};
  check(ztools::macnative::decodeFrameHeaderV1(bytes.data(), bytes.size(), &decoded) == WireError::None,
        "VALID_FRAME_REJECTED");
  check(decoded.type == ZT_MAC_FRAME_CALL && decoded.owner == 17 && decoded.generation == 4 && decoded.taskId == 8 &&
            decoded.payloadLength == 3,
        "DECODED_FRAME_FIELDS_MISMATCH");
  std::array<uint8_t, ZT_MAC_NATIVE_WIRE_HEADER_BYTES> controlResponse{};
  check(ztools::macnative::encodeFrameHeaderV1(frame(ZT_MAC_FRAME_RESPONSE, 17, 4), controlResponse.data(),
                                               controlResponse.size()),
        "CONTROL_RESPONSE_WITHOUT_TASK_ID_REJECTED");
  check(ztools::macnative::decodeFrameHeaderV1(controlResponse.data(), controlResponse.size(), &decoded) ==
            WireError::None && decoded.taskId == 0,
        "CONTROL_RESPONSE_HEADER_INVALID");
  check(ztools::macnative::decodeFrameHeaderV1(nullptr, bytes.size(), &decoded) == WireError::NullBuffer,
        "NULL_FRAME_ACCEPTED");
  check(ztools::macnative::decodeFrameHeaderV1(bytes.data(), bytes.size(), nullptr) == WireError::NullBuffer,
        "NULL_FRAME_OUTPUT_ACCEPTED");
  check(ztools::macnative::decodeFrameHeaderV1(bytes.data(), ZT_MAC_NATIVE_WIRE_HEADER_BYTES - 1, &decoded) ==
            WireError::Truncated,
        "TRUNCATED_FRAME_ACCEPTED");

  auto malformed = bytes;
  malformed[0] = 'X';
  check(ztools::macnative::decodeFrameHeaderV1(malformed.data(), malformed.size(), &decoded) == WireError::MagicMismatch,
        "BAD_MAGIC_ACCEPTED");
  malformed = bytes;
  malformed[4] = 2;
  check(ztools::macnative::decodeFrameHeaderV1(malformed.data(), malformed.size(), &decoded) == WireError::UnknownVersion,
        "UNKNOWN_WIRE_VERSION_ACCEPTED");
  malformed = bytes;
  malformed[6] = 0x20;
  malformed[7] = 0;
  check(ztools::macnative::decodeFrameHeaderV1(malformed.data(), malformed.size(), &decoded) == WireError::UnknownType,
        "UNKNOWN_FRAME_TYPE_ACCEPTED");
  malformed = bytes;
  malformed[8] = 1;
  malformed[9] = 0;
  malformed[10] = 16;
  malformed[11] = 0;
  check(ztools::macnative::decodeFrameHeaderV1(malformed.data(), malformed.size(), &decoded) ==
            WireError::PayloadTooLarge,
        "OVERSIZED_FRAME_ACCEPTED");
  malformed = bytes;
  malformed[8] = 2;
  check(ztools::macnative::decodeFrameHeaderV1(malformed.data(), malformed.size(), &decoded) == WireError::LengthMismatch,
        "FRAME_LENGTH_MISMATCH_ACCEPTED");
  malformed = bytes;
  std::memset(malformed.data() + 12, 0, 8);
  check(ztools::macnative::decodeFrameHeaderV1(malformed.data(), malformed.size(), &decoded) == WireError::MissingIdentity,
        "MISSING_OWNER_ACCEPTED");
  malformed = bytes;
  std::memset(malformed.data() + 28, 0, 8);
  check(ztools::macnative::decodeFrameHeaderV1(malformed.data(), malformed.size(), &decoded) == WireError::InvalidTaskId,
        "TASK_WITHOUT_ID_ACCEPTED");
  FrameHeaderV1 invalid = frame(0x4321, 17, 4);
  check(!ztools::macnative::encodeFrameHeaderV1(invalid, bytes.data(), bytes.size()), "UNKNOWN_TYPE_ENCODED");
  invalid = frame(ZT_MAC_FRAME_CALL, 17, 4, 8);
  invalid.payloadLength = ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES + 1;
  check(!ztools::macnative::encodeFrameHeaderV1(invalid, bytes.data(), bytes.size()), "OVERSIZED_LENGTH_ENCODED");
}

void makeReady(WorkerSessionV1& session, uint64_t owner, uint64_t generation) {
  check(session.beginStart(), "SESSION_START_FAILED");
  check(!session.beginStart(), "DUPLICATE_START_ACCEPTED");
  check(session.beginHandshake(), "HANDSHAKE_START_FAILED");
  check(session.acceptHandshake(frame(ZT_MAC_FRAME_HANDSHAKE, owner, generation), ZT_MAC_NATIVE_ABI_V1, 0),
        "VALID_HANDSHAKE_REJECTED");
  check(session.state() == WorkerState::Ready, "HANDSHAKE_STATE_MISMATCH");
}

void testOwnerGenerationAndTasks() {
  check(ztools::macnative::isAllowedNativeRoleV1(false), "ORDINARY_NATIVE_REJECTED");
  check(!ztools::macnative::isAllowedNativeRoleV1(true), "ADMIN_NATIVE_ALLOWED");
  check(ztools::macnative::isNextGenerationV1(4, 5), "NEXT_GENERATION_REJECTED");
  check(!ztools::macnative::isNextGenerationV1(0, 1), "ZERO_GENERATION_ACCEPTED");
  check(!ztools::macnative::isNextGenerationV1(4, 6), "SKIPPED_GENERATION_ACCEPTED");
  check(!ztools::macnative::isNextGenerationV1(std::numeric_limits<uint64_t>::max(), 0),
        "GENERATION_WRAP_ACCEPTED");

  WorkerSessionV1 invalidOwner(0, 1);
  check(invalidOwner.state() == WorkerState::Failed, "ZERO_OWNER_SESSION_CREATED");
  WorkerSessionV1 session(17, 4);
  check(session.state() == WorkerState::Created && !session.beginTask(1), "UNSTARTED_SESSION_ACCEPTED_TASK");
  makeReady(session, 17, 4);
  check(!session.beginTask(0), "ZERO_TASK_ID_ACCEPTED");
  check(session.beginTask(10), "TASK_START_FAILED");
  check(!session.beginTask(11), "PARALLEL_TASK_ACCEPTED");
  check(!session.beginTask(10), "REUSED_TASK_ID_ACCEPTED");

  check(session.acceptWorkerFrame(frame(ZT_MAC_FRAME_CALLBACK, 17, 3, 10)) ==
            FrameDisposition::DroppedStaleGeneration,
        "STALE_GENERATION_CALLBACK_NOT_DROPPED");
  check(session.acceptWorkerFrame(frame(ZT_MAC_FRAME_PROGRESS, 17, 4, 10)) == FrameDisposition::Accepted,
        "PROGRESS_FRAME_REJECTED");
  check(session.acceptWorkerFrame(frame(ZT_MAC_FRAME_CALLBACK, 17, 4, 10)) == FrameDisposition::Accepted,
        "CALLBACK_FRAME_REJECTED");
  TaskSnapshot snapshot{};
  check(session.queryTask(10, &snapshot) && snapshot.state == TaskState::Running &&
            snapshot.progressEvents == 1 && snapshot.callbackEvents == 1,
        "TASK_EVENT_STATE_MISMATCH");
  check(session.acceptWorkerFrame(frame(ZT_MAC_FRAME_RESPONSE, 17, 4, 10)) == FrameDisposition::Accepted,
        "TASK_RESPONSE_REJECTED");
  check(session.state() == WorkerState::Ready && session.queryTask(10, &snapshot) &&
            snapshot.state == TaskState::Completed,
        "COMPLETED_TASK_STATE_MISMATCH");
  check(session.acceptWorkerFrame(frame(ZT_MAC_FRAME_RESPONSE, 17, 4, 10)) ==
            FrameDisposition::DroppedCompletedTask,
        "DUPLICATE_RESPONSE_NOT_DROPPED");
  check(session.clearTask(10), "TERMINAL_TASK_CLEAR_FAILED");
  check(!session.queryTask(10, &snapshot), "CLEARED_TASK_STILL_QUERYABLE");
  check(session.acceptWorkerFrame(frame(ZT_MAC_FRAME_RESPONSE, 17, 4, 10)) ==
            FrameDisposition::DroppedCompletedTask,
        "CLEARED_TASK_LATE_RESPONSE_NOT_DROPPED");
  check(session.state() == WorkerState::Ready, "LATE_CLEARED_TASK_FRAME_BROKE_SESSION");
}

void testCancelTimeoutAndCrash() {
  WorkerSessionV1 cancelled(21, 1);
  makeReady(cancelled, 21, 1);
  check(cancelled.beginTask(1), "CANCEL_TASK_START_FAILED");
  check(cancelled.requestCancel(1), "CANCEL_REQUEST_FAILED");
  check(cancelled.state() == WorkerState::Cancelling, "CANCEL_STATE_MISMATCH");
  check(!cancelled.requestCancel(1), "DUPLICATE_CANCEL_ACCEPTED");
  check(cancelled.acceptWorkerFrame(frame(ZT_MAC_FRAME_CALLBACK, 21, 1, 1)) ==
            FrameDisposition::DroppedCancelledTask,
        "CANCELLED_CALLBACK_DELIVERED");
  check(cancelled.acceptWorkerFrame(frame(ZT_MAC_FRAME_RESPONSE, 21, 1, 1)) ==
            FrameDisposition::DroppedCancelledTask,
        "CANCEL_RACE_RESPONSE_DELIVERED");
  check(cancelled.acceptWorkerFrame(frame(ZT_MAC_FRAME_CANCELLED, 21, 1, 1)) == FrameDisposition::Accepted,
        "CANCEL_ACK_REJECTED");
  TaskSnapshot snapshot{};
  check(cancelled.state() == WorkerState::Ready && cancelled.queryTask(1, &snapshot) &&
            snapshot.state == TaskState::Cancelled,
        "CANCELLED_TASK_STATE_MISMATCH");
  check(cancelled.clearTask(1), "CANCELLED_TASK_CLEAR_FAILED");

  WorkerSessionV1 cancelRunning(24, 1);
  makeReady(cancelRunning, 24, 1);
  check(cancelRunning.beginTask(1), "RUNNING_CANCEL_TASK_START_FAILED");
  check(cancelRunning.acceptWorkerFrame(frame(ZT_MAC_FRAME_PROGRESS, 24, 1, 1)) == FrameDisposition::Accepted,
        "RUNNING_CANCEL_PROGRESS_REJECTED");
  check(cancelRunning.requestCancel(1), "RUNNING_TASK_CANCEL_REJECTED");
  check(cancelRunning.acceptWorkerFrame(frame(ZT_MAC_FRAME_CANCELLED, 24, 1, 1)) == FrameDisposition::Accepted,
        "RUNNING_TASK_CANCEL_ACK_REJECTED");

  WorkerSessionV1 timedOut(22, 2);
  makeReady(timedOut, 22, 2);
  check(timedOut.beginTask(1), "TIMEOUT_TASK_START_FAILED");
  check(timedOut.timeOutTask(1), "TASK_TIMEOUT_FAILED");
  check(timedOut.state() == WorkerState::Stopping && timedOut.queryTask(1, &snapshot) &&
            snapshot.state == TaskState::TimedOut,
        "TIMEOUT_STATE_MISMATCH");
  check(!timedOut.beginTask(2), "TASK_ACCEPTED_AFTER_TIMEOUT");
  timedOut.onWorkerExit(9);
  check(timedOut.state() == WorkerState::Stopped, "TIMED_OUT_WORKER_NOT_STOPPED");
  timedOut.beginStop();
  check(timedOut.state() == WorkerState::Stopped, "STOP_NOT_IDEMPOTENT");

  WorkerSessionV1 crashed(23, 3);
  makeReady(crashed, 23, 3);
  check(crashed.beginTask(1), "CRASH_TASK_START_FAILED");
  crashed.onWorkerExit(7);
  check(crashed.state() == WorkerState::Failed && crashed.queryTask(1, &snapshot) &&
            snapshot.state == TaskState::Failed,
        "CRASH_NOT_SCOPED_TO_SESSION");
}

void testHandshakeAndIdentityRejection() {
  WorkerSessionV1 wrongAbi(31, 1);
  check(wrongAbi.beginStart() && wrongAbi.beginHandshake(), "WRONG_ABI_HANDSHAKE_SETUP_FAILED");
  check(!wrongAbi.acceptHandshake(frame(ZT_MAC_FRAME_HANDSHAKE, 31, 1), 99, 0), "UNKNOWN_ABI_ACCEPTED");
  check(wrongAbi.state() == WorkerState::Failed, "UNKNOWN_ABI_NOT_TERMINAL");

  WorkerSessionV1 wrongOwner(32, 1);
  makeReady(wrongOwner, 32, 1);
  check(wrongOwner.beginTask(1), "OWNER_TASK_START_FAILED");
  check(wrongOwner.acceptWorkerFrame(frame(ZT_MAC_FRAME_PROGRESS, 99, 1, 1)) == FrameDisposition::Rejected,
        "FOREIGN_OWNER_FRAME_ACCEPTED");
  check(wrongOwner.state() == WorkerState::Failed, "FOREIGN_OWNER_DID_NOT_FAIL_SESSION");

  WorkerSessionV1 futureGeneration(33, 4);
  makeReady(futureGeneration, 33, 4);
  check(futureGeneration.beginTask(1), "GENERATION_TASK_START_FAILED");
  check(futureGeneration.acceptWorkerFrame(frame(ZT_MAC_FRAME_CALLBACK, 33, 5, 1)) == FrameDisposition::Rejected,
        "FUTURE_GENERATION_CALLBACK_ACCEPTED");
  check(futureGeneration.state() == WorkerState::Failed, "FUTURE_GENERATION_DID_NOT_FAIL_SESSION");
}

}  // namespace

int main() {
  try {
    testWireFrames();
    testOwnerGenerationAndTasks();
    testCancelTimeoutAndCrash();
    testHandshakeAndIdentityRejection();
    std::cout << "{\"status\":\"PASS\",\"scope\":\"mac-native-worker-wire-and-session-state\",\"checks\":"
              << g_checks << "}\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  } catch (...) {
    std::cerr << "WORKER_SESSION_TEST_UNCLASSIFIED_FAILURE\n";
    return 1;
  }
}

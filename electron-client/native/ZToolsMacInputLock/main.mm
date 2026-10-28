#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#include <mach/mach_time.h>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>
#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
#include "lock_policy.hpp"

static volatile sig_atomic_t stopping = 0;
static void stopSignal(int) { stopping = 1; }
static uint64_t nowMs() {
  static mach_timebase_info_data_t timebase = [] { mach_timebase_info_data_t t; mach_timebase_info(&t); return t; }();
  return static_cast<uint64_t>(static_cast<__uint128_t>(mach_continuous_time()) * timebase.numer / timebase.denom / 1000000);
}
static bool output(const char* text) {
  const size_t length = std::strlen(text);
  return write(STDOUT_FILENO, text, length) == static_cast<ssize_t>(length);
}
static int fail(const char* code) {
  char message[256]; std::snprintf(message, sizeof(message), "{\"version\":1,\"event\":\"error\",\"code\":\"%s\"}\n", code);
  output(message); return 1;
}
static CGEventRef intercept(CGEventTapProxy, CGEventType type, CGEventRef event, void* context) {
  auto* policy = static_cast<LockPolicy*>(context);
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    policy->reason = "tap_disabled"; return event;
  }
  if (policy->reason) return event;
  if (type == kCGEventKeyDown) {
    const auto flags = CGEventGetFlags(event);
    policy->key(CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode) == kVK_ANSI_U &&
      (flags & (kCGEventFlagMaskControl | kCGEventFlagMaskCommand)));
  } else if (type != kCGEventKeyUp && type != kCGEventFlagsChanged) ++policy->blocked;
  return nullptr;
}
static void publish(LockPolicy& policy, const char* event) {
  char message[384];
  std::snprintf(message, sizeof(message), "{\"version\":1,\"event\":\"%s\",\"remainingSeconds\":%u,\"blockedEvents\":%llu,\"reason\":\"%s\"}\n",
    event, policy.remaining(nowMs()), static_cast<unsigned long long>(policy.blocked), policy.reason ? policy.reason : "");
  if (!output(message)) policy.reason = "connection_lost";
}
int main(int argc, char** argv) {
  signal(SIGPIPE, SIG_IGN); signal(SIGTERM, stopSignal); signal(SIGINT, stopSignal);
  if (fcntl(STDOUT_FILENO, F_SETFL, O_NONBLOCK) == -1) return 1;
  if (argc == 2 && std::strcmp(argv[1], "--probe") == 0) {
    char message[128]; std::snprintf(message, sizeof(message), "{\"version\":1,\"accessibility\":%s,\"secureInput\":%s}\n",
      AXIsProcessTrusted() ? "true" : "false", IsSecureEventInputEnabled() ? "true" : "false");
    return output(message) ? 0 : 1;
  }
  if (argc != 4 || std::strcmp(argv[1], "--lock") || (std::strcmp(argv[3], "0") && std::strcmp(argv[3], "1"))) return fail("INVALID_REQUEST");
  char* end = nullptr; const long duration = std::strtol(argv[2], &end, 10);
  if (!end || *end || duration < 5 || duration > 300) return fail("INVALID_DURATION");
  struct stat input{};
  if (fstat(STDIN_FILENO, &input) != 0 || (!S_ISFIFO(input.st_mode) && !S_ISSOCK(input.st_mode)) ||
      fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK) == -1) return fail("OWNER_PIPE_REQUIRED");
  if (!AXIsProcessTrusted()) return fail("ACCESSIBILITY_REQUIRED");
  if (IsSecureEventInputEnabled()) return fail("SECURE_INPUT_ACTIVE");
  LockPolicy policy; policy.start(static_cast<int>(duration), nowMs());
  CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) | CGEventMaskBit(kCGEventFlagsChanged);
  if (std::strcmp(argv[3], "1") == 0) {
    for (CGEventType type : {kCGEventLeftMouseDown, kCGEventLeftMouseUp, kCGEventRightMouseDown, kCGEventRightMouseUp,
      kCGEventOtherMouseDown, kCGEventOtherMouseUp, kCGEventMouseMoved, kCGEventLeftMouseDragged,
      kCGEventRightMouseDragged, kCGEventOtherMouseDragged, kCGEventScrollWheel}) mask |= CGEventMaskBit(type);
  }
  // 应用接收之前统一拦截，涵盖硬件输入及注入到较后事件通道的软件输入。
  CFMachPortRef tap = CGEventTapCreate(kCGAnnotatedSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, mask, intercept, &policy);
  if (!tap) return fail("INPUT_FILTER_UNAVAILABLE");
  CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
  if (!source) { CFMachPortInvalidate(tap); CFRelease(tap); return fail("INPUT_FILTER_UNAVAILABLE"); }
  CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
  CGEventTapEnable(tap, true);
  if (!CGEventTapIsEnabled(tap)) policy.reason = "tap_disabled";
  else publish(policy, "locked");
  const pid_t parent = getppid(); uint64_t lastReport = nowMs();
  char pending[32]{}; size_t used = 0;
  while (!policy.reason) {
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, false);
    const auto now = nowMs();
    if (stopping) policy.reason = "manual";
    else if (getppid() != parent || parent <= 1) policy.reason = "connection_lost";
    else if (IsSecureEventInputEnabled()) policy.reason = "secure_input";
    else if (!CGEventTapIsEnabled(tap)) policy.reason = "tap_disabled";
    policy.tick(now);
    char bytes[32]; const ssize_t count = read(STDIN_FILENO, bytes, sizeof(bytes));
    if (count == 0) policy.reason = "connection_lost";
    else if (count < 0 && errno != EAGAIN && errno != EINTR) policy.reason = "connection_lost";
    for (ssize_t i = 0; i < count && !policy.reason; ++i) {
      if (bytes[i] == '\n') {
        if (used == 1 && pending[0] == 'H') policy.heartbeat = now;
        else if (used == 1 && pending[0] == 'U') policy.reason = "manual";
        else policy.reason = "invalid_command";
        used = 0;
      } else if (used < sizeof(pending)) pending[used++] = bytes[i];
      else policy.reason = "invalid_command";
    }
    if (!policy.reason && now - lastReport >= 250) { publish(policy, "status"); lastReport = now; }
  }
  CGEventTapEnable(tap, false); CFMachPortInvalidate(tap);
  CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
  CFRelease(source); CFRelease(tap);
  publish(policy, "unlocked");
  return 0;
}

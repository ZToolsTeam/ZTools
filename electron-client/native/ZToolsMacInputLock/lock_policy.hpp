#pragma once
#include <cstdint>

// 不保存按键内容。独立进程持续确认租约，宿主或插件停止响应时自动解除。
struct LockPolicy {
  uint64_t deadline = 0;
  uint64_t heartbeat = 0;
  uint64_t blocked = 0;
  const char* reason = nullptr;
  bool start(int seconds, uint64_t now) {
    if (seconds < 5 || seconds > 300 || deadline) return false;
    deadline = now + static_cast<uint64_t>(seconds) * 1000;
    heartbeat = now;
    return true;
  }
  void tick(uint64_t now) {
    if (reason) return;
    if (now >= deadline) reason = "timer";
    else if (now - heartbeat >= 2000) reason = "connection_lost";
  }
  void key(bool emergency) {
    if (emergency) reason = "emergency";
    else ++blocked;
  }
  unsigned remaining(uint64_t now) const {
    return reason || now >= deadline ? 0 : static_cast<unsigned>((deadline - now + 999) / 1000);
  }
};

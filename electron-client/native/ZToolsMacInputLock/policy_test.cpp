#include "lock_policy.hpp"
#include <cassert>
#include <initializer_list>
int main() {
  for (int seconds : {0, -1, 4, 301}) { LockPolicy p; assert(!p.start(seconds, 100)); }
  LockPolicy timeout; assert(timeout.start(5, 100)); assert(!timeout.start(5, 100));
  timeout.heartbeat = 5000; timeout.tick(5100); assert(timeout.reason); assert(timeout.remaining(5100) == 0);
  LockPolicy lost; lost.start(300, 100); lost.tick(2099); assert(!lost.reason); lost.tick(2100); assert(lost.reason);
  LockPolicy keys; keys.start(30, 100); keys.key(false); assert(keys.blocked == 1); keys.key(true); assert(keys.reason);
  LockPolicy sleep; sleep.start(30, 100); sleep.tick(100000); assert(sleep.reason);
  return 0;
}

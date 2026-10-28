#import <Foundation/Foundation.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <fcntl.h>
#include <unistd.h>
#include <copyfile.h>
#include <atomic>
#include <csignal>
#include <thread>
#include <chrono>
#include <stdexcept>
#include <string>

namespace {
constexpr size_t limit = 1024 * 1024;
std::atomic<int> phase{0};
static_assert(std::atomic<int>::is_always_lock_free);
void cancel(int) { int expected = 0; if (phase.compare_exchange_strong(expected, 2)) _exit(3); }
struct FD {
  int value;
  explicit FD(int value): value(value) { if (value < 0) throw std::runtime_error("OPEN_FAILED"); }
  ~FD() { close(value); }
  FD(const FD&) = delete;
};
void require(bool ok, const char* code) { if (!ok) throw std::runtime_error(code); }
struct stat regular(int fd, size_t max = limit) {
  struct stat st{};
  require(fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_nlink == 1 && st.st_size >= 0 && static_cast<size_t>(st.st_size) <= max, "UNSAFE_FILE");
  return st;
}
std::string read(int fd, size_t max = limit) {
  regular(fd, max); require(lseek(fd, 0, SEEK_SET) >= 0, "SEEK_FAILED");
  std::string result; char buffer[8192]; ssize_t count;
  while ((count = ::read(fd, buffer, sizeof buffer)) > 0) {
    result.append(buffer, count); require(result.size() <= max, "FILE_TOO_LARGE");
  }
  require(count == 0, "READ_FAILED"); return result;
}
void write(int fd, const std::string& bytes) {
  size_t offset = 0;
  while (offset < bytes.size()) { const auto count = ::write(fd, bytes.data() + offset, bytes.size() - offset); require(count > 0, "WRITE_FAILED"); offset += count; }
  require(fsync(fd) == 0 && read(fd) == bytes, "WRITE_VERIFY_FAILED");
}
bool same(const struct stat& a, const struct stat& b) { return a.st_dev == b.st_dev && a.st_ino == b.st_ino; }
bool unchanged(int parent, const char* name, const struct stat& original) {
  struct stat current{}; return fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) == 0 && same(current, original);
}
std::string text(id value) {
  require([value isKindOfClass:NSString.class], "INVALID_CONTENT");
  NSData* bytes = [value dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
  require(bytes && bytes.length <= limit, "INVALID_CONTENT");
  std::string result(static_cast<const char*>(bytes.bytes), bytes.length);
  require(result.find('\0') == std::string::npos, "INVALID_CONTENT"); return result;
}
#ifdef ZTOOLS_HOSTS_FIXTURE
void fixturePause(const std::string& directory, const char* stage) {
  const char* requested = getenv("ZTOOLS_HOSTS_FIXTURE_PAUSE");
  if (!requested || std::string(requested).find(stage) == std::string::npos) return;
  FD marker(open((directory + "/" + stage + ".ready").c_str(), O_WRONLY | O_CREAT | O_EXCL, 0600));
  for (int i = 0; i < 100; ++i) {
    if (access((directory + "/" + stage + ".continue").c_str(), F_OK) == 0) return;
    usleep(20000);
  }
  throw std::runtime_error("FIXTURE_WAIT_TIMEOUT");
}
#endif
int respond(bool success, NSString* code, NSString* backup) {
  NSData* data = [NSJSONSerialization dataWithJSONObject:@{@"version": @1, @"success": @(success), @"code": code, @"recoveryPath": backup ?: @""} options:0 error:nil];
  return data && fwrite(data.bytes, 1, data.length, stdout) == data.length && fputc('\n', stdout) != EOF ? 0 : 1;
}
}
int main(int argc, char** argv) {
  std::signal(SIGTERM, cancel); std::signal(SIGINT, cancel);
  std::thread([] { std::this_thread::sleep_for(std::chrono::seconds(85)); cancel(0); std::this_thread::sleep_for(std::chrono::seconds(15)); _exit(2); }).detach();
  @autoreleasepool {
    NSString* recovery = @"";
    try {
      std::string directory = "/private/etc";
#ifdef ZTOOLS_HOSTS_FIXTURE
      require(argc == 5 && geteuid() != 0, "FIXTURE_REQUIRES_UNPRIVILEGED_USER"); directory = argv[4];
#else
      require(argc == 4 && geteuid() == 0, "ADMIN_PERMISSION_REQUIRED");
#endif
      require(!strcmp(argv[1], "--apply"), "INVALID_REQUEST");
      char* end = nullptr; const auto uid = strtoul(argv[3], &end, 10);
      require(end && *end == '\0' && uid > 0 && uid < UINT32_MAX, "INVALID_USER");
      NSString* requestPath = [NSString stringWithUTF8String:argv[2]];
      require(requestPath.isAbsolutePath && [requestPath.lastPathComponent isEqual:@"request.json"], "INVALID_REQUEST_PATH");
      FD requestDirectory(open(requestPath.stringByDeletingLastPathComponent.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW));
      struct stat dirStat{};
      require(fstat(requestDirectory.value, &dirStat) == 0 && dirStat.st_uid == uid && !(dirStat.st_mode & 0077), "UNSAFE_REQUEST_DIRECTORY");
      FD request(openat(requestDirectory.value, "request.json", O_RDONLY | O_NOFOLLOW | O_NONBLOCK));
      const auto reqStat = regular(request.value, 4 * limit);
      require(reqStat.st_uid == uid && !(reqStat.st_mode & 0077), "UNSAFE_REQUEST");
      const auto requestBytes = read(request.value, 4 * limit);
      NSData* data = [NSData dataWithBytes:requestBytes.data() length:requestBytes.size()];
      id body = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
      require([body isKindOfClass:NSDictionary.class] && [body[@"version"] isEqual:@1] && [body[@"deadline"] isKindOfClass:NSNumber.class], "INVALID_REQUEST");
      const auto expected = text(body[@"expected"]), next = text(body[@"content"]);
      auto allowed = [&] {
        struct stat cancelled{};
        const int status = fstatat(requestDirectory.value, "cancel", &cancelled, AT_SYMLINK_NOFOLLOW);
        const bool notCancelled = status == -1 && errno == ENOENT;
        struct stat liveRequest{}, liveDirectory{};
        const bool requestExists = fstat(requestDirectory.value, &liveDirectory) == 0 && liveDirectory.st_nlink > 0 &&
          fstatat(requestDirectory.value, "request.json", &liveRequest, AT_SYMLINK_NOFOLLOW) == 0 && same(liveRequest, reqStat);
        const double remaining = [body[@"deadline"] doubleValue] - NSDate.date.timeIntervalSince1970 * 1000;
        return notCancelled && requestExists && remaining > 0 && remaining <= 90000 && phase.load() == 0;
      };
      require(allowed(), "REQUEST_CANCELLED_OR_EXPIRED");
      FD parent(open(directory.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW));
      struct stat parentStat{}; require(fstat(parent.value, &parentStat) == 0 && parentStat.st_uid == geteuid() && !(parentStat.st_mode & 0022), "UNSAFE_HOSTS_DIRECTORY");
      FD lock(openat(parent.value, ".ztools-hosts.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0600));
      const auto lockStat = regular(lock.value); require(lockStat.st_uid == geteuid() && !(lockStat.st_mode & 0077) && flock(lock.value, LOCK_EX | LOCK_NB) == 0, "HOSTS_BUSY_OR_UNSAFE_LOCK");
      FD original(openat(parent.value, "hosts", O_RDONLY | O_NOFOLLOW | O_NONBLOCK));
      const auto originalStat = regular(original.value);
      require(originalStat.st_uid == geteuid() && !(originalStat.st_mode & 0022) && !originalStat.st_flags, "UNSAFE_HOSTS_PERMISSIONS");
      NSString* identity = [NSString stringWithFormat:@"%llu:%llu", static_cast<unsigned long long>(originalStat.st_dev), originalStat.st_ino];
      require([body[@"identity"] isEqual:identity] && read(original.value) == expected, "HOSTS_CHANGED");
      if (expected == next) return respond(true, @"UNCHANGED", recovery);
      const std::string backupName = ".ztools-hosts-" + std::string(NSUUID.UUID.UUIDString.UTF8String);
      require(mkdirat(parent.value, backupName.c_str(), 0700) == 0, "BACKUP_DIRECTORY_FAILED");
      recovery = [NSString stringWithFormat:@"%s/%s", directory.c_str(), backupName.c_str()];
      FD backup(openat(parent.value, backupName.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW));
      FD before(openat(backup.value, "original.before", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0600));
      write(before.value, expected);
      FD prepared(openat(backup.value, "previous", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0600));
      write(prepared.value, next);
      require(fcopyfile(original.value, prepared.value, nullptr, COPYFILE_METADATA) == 0 && fsync(prepared.value) == 0 && fsync(backup.value) == 0 && fsync(parent.value) == 0, "METADATA_OR_BACKUP_SYNC_FAILED");
      const auto preparedStat = regular(prepared.value);
      require(unchanged(parent.value, "hosts", originalStat) && read(original.value) == expected, "HOSTS_CHANGED");
      require(allowed(), "REQUEST_CANCELLED_OR_EXPIRED");
      int preparing = 0; require(phase.compare_exchange_strong(preparing, 1), "REQUEST_CANCELLED");
      // 原子交换不会留下 hosts 缺失窗口；实际被替换的对象永久保留在 previous。
      require(renameatx_np(backup.value, "previous", parent.value, "hosts", RENAME_SWAP) == 0, "ATOMIC_SWAP_FAILED");
#ifdef ZTOOLS_HOSTS_FIXTURE
      fixturePause(directory, "before-verify");
#endif
      bool verified = false;
      try {
        FD previous(openat(backup.value, "previous", O_RDONLY | O_NOFOLLOW | O_NONBLOCK));
        FD current(openat(parent.value, "hosts", O_RDONLY | O_NOFOLLOW | O_NONBLOCK));
        verified = same(regular(previous.value), originalStat) && read(previous.value) == expected && same(regular(current.value), preparedStat) && read(current.value) == next;
      } catch (const std::exception&) { verified = false; }
      if (!verified) {
        // 仅当目标仍是本次新对象时尝试交换恢复；不覆盖之后出现的对象。
        if (unchanged(parent.value, "hosts", preparedStat)) {
          FD retained(openat(backup.value, "previous", O_RDONLY | O_NOFOLLOW | O_NONBLOCK));
          const auto retainedStat = regular(retained.value); const auto retainedContent = read(retained.value);
          if (renameatx_np(backup.value, "previous", parent.value, "hosts", RENAME_SWAP) == 0) {
            require(fsync(parent.value) == 0 && fsync(backup.value) == 0, "ROLLBACK_SYNC_UNKNOWN");
#ifdef ZTOOLS_HOSTS_FIXTURE
            fixturePause(directory, "before-rollback-verify");
#endif
            FD restored(openat(parent.value, "hosts", O_RDONLY | O_NOFOLLOW | O_NONBLOCK));
            require(same(regular(restored.value), retainedStat) && read(restored.value) == retainedContent, "ROLLBACK_VERIFY_UNKNOWN");
            return respond(false, @"CONCURRENT_CHANGE_RESTORED", recovery);
          }
        }
        return respond(false, @"WRITE_OUTCOME_UNKNOWN", recovery);
      }
      require(fsync(parent.value) == 0 && fsync(backup.value) == 0, "WRITE_SYNC_UNKNOWN");
      return respond(true, @"APPLIED", recovery);
    } catch (const std::exception& error) { return respond(false, [NSString stringWithUTF8String:error.what()], recovery); }
  }
}

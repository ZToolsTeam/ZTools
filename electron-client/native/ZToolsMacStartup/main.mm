#import <Foundation/Foundation.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <pwd.h>
#include <unistd.h>
#include <atomic>
#include <csignal>
#include <thread>
#include <chrono>
#include <stdexcept>
#include <string>
#include <memory>
#include <mutex>
#include <vector>
#include <spawn.h>

namespace {
constexpr size_t limit = 1024 * 1024;
std::atomic<int> phase{0};
std::mutex childMutex;
pid_t managedChild = 0;
void cancelled(int) { int expected = 0; phase.compare_exchange_strong(expected, 2); }
void stopChild() {
  std::lock_guard<std::mutex> lock(childMutex);
  if (managedChild <= 0) return;
  kill(managedChild, SIGKILL);
  int status; while (waitpid(managedChild, &status, 0) < 0 && errno == EINTR) {}
  managedChild = 0;
}
void check(bool value, const char* error) { if (!value) throw std::runtime_error(error); }
struct File {
  int fd;
  explicit File(int fd): fd(fd) { check(fd >= 0, "OPEN_FAILED"); }
  ~File() { close(fd); }
  File(const File&) = delete;
};
struct stat info(int fd, size_t maximum = limit) {
  struct stat s{};
  check(fstat(fd, &s) == 0 && S_ISREG(s.st_mode) && s.st_nlink == 1 && s.st_size >= 0 && static_cast<size_t>(s.st_size) <= maximum, "UNSAFE_FILE");
  return s;
}
bool identity(const struct stat& a, const struct stat& b) { return a.st_dev == b.st_dev && a.st_ino == b.st_ino; }
NSData* readFile(int fd, size_t maximum = limit) {
  info(fd, maximum); check(lseek(fd, 0, SEEK_SET) >= 0, "SEEK_FAILED");
  NSMutableData* data = [NSMutableData data]; char buffer[8192]; ssize_t n;
  while ((n = read(fd, buffer, sizeof buffer)) > 0) { check(data.length + n <= maximum, "FILE_TOO_LARGE"); [data appendBytes:buffer length:n]; }
  check(n == 0, "READ_FAILED"); return data;
}
void writeFile(int fd, NSData* data) {
  size_t offset = 0;
  while (offset < data.length) { const auto n = write(fd, static_cast<const char*>(data.bytes) + offset, data.length - offset); check(n > 0, "WRITE_FAILED"); offset += n; }
  check(fsync(fd) == 0 && [readFile(fd) isEqual:data], "BACKUP_VERIFY_FAILED");
}
void directory(int fd, uid_t owner, bool privateDirectory = false) {
  struct stat s{};
  check(fstat(fd, &s) == 0 && S_ISDIR(s.st_mode) && s.st_uid == owner && !(s.st_mode & (privateDirectory ? 0077 : 0022)), "UNSAFE_DIRECTORY");
}
bool boolean(id value) { return value && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID(); }
NSString* string(id value, NSUInteger maximum = 16384) {
  check([value isKindOfClass:NSString.class] && [value length] > 0 && [value length] <= maximum && [value rangeOfString:@"\0"].location == NSNotFound, "INVALID_STRING");
  return value;
}
bool matches(NSString* text, NSString* pattern) { return [text rangeOfString:pattern options:NSRegularExpressionSearch].location != NSNotFound; }
void unchanged(int parent, NSString* name, const struct stat& expected, NSData* original) {
  File current(openat(parent, name.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_NONBLOCK));
  const auto s = info(current.fd);
  check(identity(s, expected) && [readFile(current.fd) isEqual:original], "CONFIGURATION_CHANGED");
}

NSString* command(const char* executable, NSArray<NSString*>* arguments) {
  check(phase.load() != 2, "CANCELLED_OR_EXPIRED");
  int pipes[2]; check(pipe(pipes) == 0, "COMMAND_PIPE_FAILED");
  File input(pipes[0]), output(pipes[1]);
  check(fcntl(input.fd, F_SETFL, O_NONBLOCK) == 0, "COMMAND_PIPE_FAILED");
  posix_spawn_file_actions_t actions; posix_spawnattr_t attrs;
  check(posix_spawn_file_actions_init(&actions) == 0, "COMMAND_ACTIONS_FAILED");
  struct Actions { posix_spawn_file_actions_t* p; ~Actions() { posix_spawn_file_actions_destroy(p); } } actionsOwner{&actions};
  check(posix_spawnattr_init(&attrs) == 0, "COMMAND_ATTRIBUTES_FAILED");
  struct Attributes { posix_spawnattr_t* p; ~Attributes() { posix_spawnattr_destroy(p); } } attrsOwner{&attrs};
  check(posix_spawnattr_setflags(&attrs, POSIX_SPAWN_CLOEXEC_DEFAULT) == 0 &&
    posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) == 0 &&
    posix_spawn_file_actions_adddup2(&actions, output.fd, STDOUT_FILENO) == 0 &&
    posix_spawn_file_actions_adddup2(&actions, output.fd, STDERR_FILENO) == 0, "COMMAND_ATTRIBUTES_FAILED");
  std::vector<char*> argv{const_cast<char*>(executable)};
  for (NSString* argument in arguments) argv.push_back(const_cast<char*>(argument.UTF8String)); argv.push_back(nullptr);
  char lang[] = "LANG=C", locale[] = "LC_ALL=C", search[] = "PATH=/usr/bin:/bin:/usr/sbin:/sbin";
  char* environment[] = {lang, locale, search, nullptr};
  {
    std::lock_guard<std::mutex> lock(childMutex);
    check(phase.load() != 2, "CANCELLED_OR_EXPIRED");
    const int result = posix_spawn(&managedChild, executable, &actions, &attrs, argv.data(), environment);
    if (result != 0) managedChild = 0;
    check(result == 0, "COMMAND_START_FAILED");
  }
  close(output.fd); output.fd = -1;
  struct ChildGuard { ~ChildGuard() { stopChild(); } } guard;
  NSMutableData* data = [NSMutableData data]; const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  bool exited = false, eof = false; int status = 0;
  while (!exited || !eof) {
    check(phase.load() != 2, "CANCELLED_OR_EXPIRED");
    check(std::chrono::steady_clock::now() < end, "COMMAND_TIMEOUT");
    if (!eof) {
      char buffer[8192]; const auto n = read(input.fd, buffer, sizeof buffer);
      if (n > 0) { check(data.length + n <= 2 * limit, "COMMAND_OUTPUT_TOO_LARGE"); [data appendBytes:buffer length:n]; }
      else if (n == 0) eof = true;
      else check(errno == EAGAIN || errno == EINTR, "COMMAND_READ_FAILED");
    }
    if (!exited) {
      std::lock_guard<std::mutex> lock(childMutex);
      const auto result = waitpid(managedChild, &status, WNOHANG);
      check(result >= 0 || errno == EINTR, "COMMAND_WAIT_FAILED");
      if (result > 0) { managedChild = 0; exited = true; }
    }
    if (!exited || !eof) usleep(1000);
  }
  check(WIFEXITED(status) && WEXITSTATUS(status) == 0, "LAUNCHCTL_FAILED");
  NSString* text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]; check(text != nil, "INVALID_LAUNCHCTL_OUTPUT"); return text;
}
NSString* launchctl(NSArray<NSString*>* arguments) { return command("/bin/launchctl", arguments); }

#ifdef ZTOOLS_STARTUP_FIXTURE
NSString* fixtureRoot;
#endif
id overrideFor(NSString* domain, NSString* label) {
#ifdef ZTOOLS_STARTUP_FIXTURE
  NSData* data = [NSData dataWithContentsOfFile:[fixtureRoot stringByAppendingPathComponent:@"overrides.json"]];
  id values = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : @{};
  check([values isKindOfClass:NSDictionary.class], "FIXTURE_STATE_INVALID");
  id value = values[[domain stringByAppendingFormat:@"/%@", label]]; check(!value || boolean(value), "FIXTURE_STATE_INVALID"); return value ?: NSNull.null;
#else
  NSString* text = launchctl(@[@"print-disabled", domain]);
  check([text containsString:@"disabled services = {"] && [[text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] hasSuffix:@"}"], "INVALID_OVERRIDE_STATE");
  id result = NSNull.null;
  for (NSString* line in [text componentsSeparatedByString:@"\n"]) {
    NSArray* parts = [line componentsSeparatedByString:@"=>"]; if (parts.count != 2) continue;
    NSString* key = [parts[0] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    if (![key isEqual:[NSString stringWithFormat:@"\"%@\"", label]]) continue;
    check(result == NSNull.null, "DUPLICATE_OVERRIDE");
    NSString* value = [parts[1] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    check([@[@"true", @"false", @"enabled", @"disabled"] containsObject:value], "INVALID_OVERRIDE_STATE");
    result = @([value isEqual:@"true"] || [value isEqual:@"disabled"]);
  }
  return result;
#endif
}
void setEnabled(NSString* domain, NSString* label, bool enabled) {
#ifdef ZTOOLS_STARTUP_FIXTURE
  NSString* file = [fixtureRoot stringByAppendingPathComponent:@"overrides.json"];
  NSData* data = [NSData dataWithContentsOfFile:file];
  NSMutableDictionary* values = data ? [[NSJSONSerialization JSONObjectWithData:data options:0 error:nil] mutableCopy] : [NSMutableDictionary dictionary];
  check(values != nil, "FIXTURE_STATE_INVALID"); values[[domain stringByAppendingFormat:@"/%@", label]] = @(!enabled);
  check([[NSJSONSerialization dataWithJSONObject:values options:0 error:nil] writeToFile:file atomically:YES], "FIXTURE_WRITE_FAILED");
#else
  launchctl(@[enabled ? @"enable" : @"disable", [domain stringByAppendingFormat:@"/%@", label]]);
#endif
  check([overrideFor(domain, label) isEqual:@(!enabled)], "OVERRIDE_VERIFY_FAILED");
}

int reply(bool success, NSString* code, NSString* recovery) {
  NSData* result = [NSJSONSerialization dataWithJSONObject:@{@"version": @1, @"success": @(success), @"code": code, @"recoveryPath": recovery ?: @""} options:0 error:nil];
  return result && fwrite(result.bytes, 1, result.length, stdout) == result.length && fputc('\n', stdout) != EOF ? 0 : 1;
}
}

int main(int argc, char** argv) {
  std::signal(SIGTERM, cancelled); std::signal(SIGINT, cancelled);
  std::thread([] { std::this_thread::sleep_for(std::chrono::seconds(85)); cancelled(0); std::this_thread::sleep_for(std::chrono::seconds(10)); stopChild(); _exit(2); }).detach();
  @autoreleasepool {
    NSString* recovery = @"";
    try {
#ifdef ZTOOLS_STARTUP_FIXTURE
      if (argc == 4 && !strcmp(argv[1], "--child-fixture")) {
        check(geteuid() != 0, "FIXTURE_REQUIRES_UNPRIVILEGED_USER");
        NSString* mode = [NSString stringWithUTF8String:argv[2]];
        check([@[@"eof", @"cancel"] containsObject:mode], "INVALID_FIXTURE");
        NSString* script = [mode isEqual:@"eof"] ? @"printf '%s' \"$$\" > \"$1\"; exec 1>&- 2>&-; exec /bin/sleep 30" : @"printf '%s' \"$$\" > \"$1\"; exec /bin/sleep 30";
        command("/bin/sh", @[@"-c", script, @"startup-fixture", [NSString stringWithUTF8String:argv[3]]]);
        return reply(true, @"FIXTURE_EXITED", @"");
      }
      check(argc == 5 && geteuid() != 0, "FIXTURE_REQUIRES_UNPRIVILEGED_USER"); fixtureRoot = [NSString stringWithUTF8String:argv[4]];
#else
      check(argc == 4, "INVALID_REQUEST");
#endif
      check(!strcmp(argv[1], "--apply"), "INVALID_REQUEST");
      char* last = nullptr; const unsigned long uidValue = strtoul(argv[3], &last, 10);
      check(last && *last == '\0' && uidValue > 0 && uidValue < UINT32_MAX, "INVALID_USER");
      const uid_t uid = static_cast<uid_t>(uidValue); check(geteuid() == 0 || geteuid() == uid, "INVALID_AUTHORITY");
      const passwd* user = getpwuid(uid); check(user != nullptr, "USER_NOT_FOUND");
      NSString* requestPath = [NSString stringWithUTF8String:argv[2]];
      check(requestPath.isAbsolutePath && [requestPath.lastPathComponent isEqual:@"request.json"], "INVALID_REQUEST_PATH");
      File requests(open(requestPath.stringByDeletingLastPathComponent.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW));
      directory(requests.fd, uid); struct stat requestDir{}; check(fstat(requests.fd, &requestDir) == 0 && !(requestDir.st_mode & 0077), "REQUEST_NOT_PRIVATE");
      File request(openat(requests.fd, "request.json", O_RDONLY | O_NOFOLLOW | O_NONBLOCK));
      const auto requestInfo = info(request.fd, 2 * limit); check(requestInfo.st_uid == uid && !(requestInfo.st_mode & 0077), "REQUEST_NOT_PRIVATE");
      id body = [NSJSONSerialization JSONObjectWithData:readFile(request.fd, 2 * limit) options:0 error:nil];
      check([body isKindOfClass:NSDictionary.class] && [body[@"version"] isEqual:@1], "INVALID_REQUEST");
      NSString* action = string(body[@"action"], 20), *scope = string(body[@"scope"], 20), *name = string(body[@"filename"], 255), *label = string(body[@"label"], 255);
      check([@[@"toggle", @"remove", @"restore"] containsObject:action] && [@[@"user-agent", @"system-agent", @"daemon"] containsObject:scope], "INVALID_ACTION");
      check([name.lastPathComponent isEqual:name] && ![name isEqual:@".."] && [name hasSuffix:@".plist"] && ![name containsString:@"/"], "INVALID_FILENAME");
      check(matches(label, @"^[A-Za-z0-9_.-]{1,255}$") && ![label hasPrefix:@"com.apple."], "PROTECTED_LABEL");
      const bool userScope = [scope isEqual:@"user-agent"];
#ifndef ZTOOLS_STARTUP_FIXTURE
      check(userScope ? geteuid() == uid : geteuid() == 0, "ADMIN_PERMISSION_REQUIRED");
#endif
      NSString* root = userScope ? [[NSString stringWithUTF8String:user->pw_dir] stringByAppendingPathComponent:@"Library/LaunchAgents"] : [scope isEqual:@"daemon"] ? @"/Library/LaunchDaemons" : @"/Library/LaunchAgents";
      uid_t owner = userScope ? uid : 0;
#ifdef ZTOOLS_STARTUP_FIXTURE
      root = [fixtureRoot stringByAppendingPathComponent:userScope ? @"Library/LaunchAgents" : scope]; owner = uid;
#endif
      NSString* domain = [scope isEqual:@"daemon"] ? @"system" : [NSString stringWithFormat:@"gui/%u", uid];
      NSData* expected = [[NSData alloc] initWithBase64EncodedString:string(body[@"original"], 2 * limit) options:0];
      check(expected && expected.length <= limit, "INVALID_ORIGINAL");
      id expectedOverride = body[@"override"]; check(expectedOverride == NSNull.null || boolean(expectedOverride), "INVALID_OVERRIDE");
      NSString* idText = string(body[@"identity"], 100), *backupId = string(body[@"backupId"], 36);
      check(matches(backupId, @"^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$"), "INVALID_BACKUP_ID");
      auto allowed = [&] {
        struct stat marker{}, live{};
        const bool noCancel = fstatat(requests.fd, "cancel", &marker, AT_SYMLINK_NOFOLLOW) == -1 && errno == ENOENT;
        const double remaining = [body[@"deadline"] isKindOfClass:NSNumber.class] ? [body[@"deadline"] doubleValue] - NSDate.date.timeIntervalSince1970 * 1000 : 0;
        return noCancel && remaining > 0 && remaining <= 90000 && phase.load() == 0 &&
          fstatat(requests.fd, "request.json", &live, AT_SYMLINK_NOFOLLOW) == 0 && identity(live, requestInfo);
      };
      check(allowed(), "CANCELLED_OR_EXPIRED");
      File parent(open(root.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)); directory(parent.fd, owner);
      File lock(openat(parent.fd, ".ztools-startup.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0600));
      const auto lockInfo = info(lock.fd); check(lockInfo.st_uid == geteuid() && !(lockInfo.st_mode & 0077) && flock(lock.fd, LOCK_EX | LOCK_NB) == 0, "CONFIGURATION_BUSY");
      check([overrideFor(domain, label) isEqual:expectedOverride], "OVERRIDE_CHANGED");
      const bool restore = [action isEqual:@"restore"];
      int originalParent = parent.fd; NSString* originalName = name;
      std::unique_ptr<File> archiveRoot, archive;
      if (![action isEqual:@"toggle"]) {
        check(mkdirat(parent.fd, ".ztools-startup-recovery", 0700) == 0 || errno == EEXIST, "RECOVERY_DIRECTORY_FAILED");
        archiveRoot = std::make_unique<File>(openat(parent.fd, ".ztools-startup-recovery", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)); directory(archiveRoot->fd, owner, true);
        if (!restore) check(mkdirat(archiveRoot->fd, backupId.UTF8String, 0700) == 0, "RECOVERY_EXISTS");
        archive = std::make_unique<File>(openat(archiveRoot->fd, backupId.UTF8String, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)); directory(archive->fd, owner, true);
        recovery = [[root stringByAppendingPathComponent:@".ztools-startup-recovery"] stringByAppendingPathComponent:backupId];
        if (restore) { originalParent = archive->fd; originalName = @"original.plist"; }
      }
      File original(openat(originalParent, originalName.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_NONBLOCK));
      const auto originalInfo = info(original.fd);
      check(originalInfo.st_uid == owner && !(originalInfo.st_mode & 0022) && !originalInfo.st_flags, "UNSAFE_CONFIGURATION");
      check([[NSString stringWithFormat:@"%llu:%llu", static_cast<unsigned long long>(originalInfo.st_dev), originalInfo.st_ino] isEqual:idText] && [readFile(original.fd) isEqual:expected], "CONFIGURATION_CHANGED");
      id plist = [NSPropertyListSerialization propertyListWithData:expected options:NSPropertyListImmutable format:nullptr error:nil];
      check([plist isKindOfClass:NSDictionary.class] && [plist[@"Label"] isEqual:label], "LABEL_CHANGED");
      if ([action isEqual:@"remove"]) {
        id args = plist[@"ProgramArguments"];
        NSString* program = string(plist[@"Program"] ?: ([args isKindOfClass:NSArray.class] && [args count] ? args[0] : nil));
        check(program.isAbsolutePath, "PROGRAM_CANNOT_BE_VERIFIED");
        struct stat executable{}; check(stat(program.fileSystemRepresentation, &executable) == -1 && (errno == ENOENT || errno == ENOTDIR), "PROGRAM_NOT_MISSING");
        File copy(openat(archive->fd, "original.copy", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0600)); writeFile(copy.fd, expected);
        NSDictionary* receipt = @{@"filename": name, @"label": label, @"scope": scope, @"identity": idText, @"override": expectedOverride};
        File metadata(openat(archive->fd, "receipt.json", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0600));
        writeFile(metadata.fd, [NSJSONSerialization dataWithJSONObject:receipt options:0 error:nil]);
        check(fsync(archive->fd) == 0 && fsync(archiveRoot->fd) == 0 && fsync(parent.fd) == 0, "BACKUP_SYNC_FAILED");
      }
      if (restore) {
        File receiptFile(openat(archive->fd, "receipt.json", O_RDONLY | O_NOFOLLOW | O_NONBLOCK));
        const auto receiptInfo = info(receiptFile.fd); check(receiptInfo.st_uid == owner && !(receiptInfo.st_mode & 0077), "UNSAFE_RECEIPT");
        id receipt = [NSJSONSerialization JSONObjectWithData:readFile(receiptFile.fd) options:0 error:nil];
        check([receipt isKindOfClass:NSDictionary.class] && [receipt isEqual:@{@"filename": name, @"label": label, @"scope": scope, @"identity": idText, @"override": expectedOverride}], "RECOVERY_BINDING_CHANGED");
        File copy(openat(archive->fd, "original.copy", O_RDONLY | O_NOFOLLOW | O_NONBLOCK)); check([readFile(copy.fd) isEqual:expected], "RECOVERY_COPY_CHANGED");
      }
      unchanged(originalParent, originalName, originalInfo, expected);
      check([overrideFor(domain, label) isEqual:expectedOverride], "OVERRIDE_CHANGED");
      check(allowed(), "CANCELLED_OR_EXPIRED");
      int before = 0; check(phase.compare_exchange_strong(before, 1), "CANCELLED_OR_EXPIRED");
      if ([action isEqual:@"toggle"]) {
        check(boolean(body[@"enabled"]), "INVALID_ENABLED"); setEnabled(domain, label, [body[@"enabled"] boolValue]);
      } else {
        const int targetParent = restore ? parent.fd : archive->fd;
        NSString* targetName = restore ? name : @"original.plist";
        check(renameatx_np(originalParent, originalName.fileSystemRepresentation, targetParent, targetName.fileSystemRepresentation, RENAME_EXCL) == 0, "MOVE_REFUSED_TARGET_EXISTS_OR_CHANGED");
        unchanged(targetParent, targetName, originalInfo, expected);
        check(fsync(parent.fd) == 0 && fsync(archive->fd) == 0, "MOVE_SYNC_UNKNOWN");
      }
      return reply(true, @"APPLIED", recovery);
    } catch (const std::exception& error) { return reply(false, [NSString stringWithUTF8String:error.what()], recovery); }
  }
}

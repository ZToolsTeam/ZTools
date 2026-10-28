#import <Foundation/Foundation.h>
#import <SystemConfiguration/SystemConfiguration.h>
#import <Security/Authorization.h>
#include <arpa/inet.h>
#include <cstdio>
#include <cstring>
#include <thread>
#include <chrono>
#include <unistd.h>
#include <atomic>
#include <csignal>

// 0：授权/预提交，可立即取消；1：提交及恢复，必须完成；2：已取消。
static std::atomic<int> phase{0};
static_assert(std::atomic<int>::is_always_lock_free);
static void cancelBeforeCommit(int) {
  int preparing = 0;
  if (phase.compare_exchange_strong(preparing, 2)) _exit(3);
}

template<class T> struct OwnedCF {
  T value;
  explicit OwnedCF(T v): value(v) {}
  ~OwnedCF() { if (value) CFRelease(value); }
  OwnedCF(const OwnedCF&) = delete;
  OwnedCF& operator=(const OwnedCF&) = delete;
};
struct PreferencesSession {
  AuthorizationRef authorization = nullptr;
  SCPreferencesRef preferences = nullptr;
  bool locked = false;
  ~PreferencesSession() {
    if (locked) SCPreferencesUnlock(preferences);
    if (preferences) CFRelease(preferences);
    if (authorization) AuthorizationFree(authorization, kAuthorizationFlagDefaults);
  }
};
static bool validServers(id value) {
  if (![value isKindOfClass:[NSArray class]] || [value count] > 8) return false;
  for (id item in value) {
    if (![item isKindOfClass:[NSString class]] || [item length] > 128) return false;
    NSArray<NSString*>* parts = [item componentsSeparatedByString:@"%"];
    if (parts.count > 2 || (parts.count == 2 && (parts[1].length == 0 || parts[1].length > 64 ||
      [parts[1] rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-"] invertedSet]].location != NSNotFound))) return false;
    unsigned char address[16];
    const char* ip = [parts[0] UTF8String];
    if (!ip || (inet_pton(AF_INET6, ip, address) != 1 && (parts.count != 1 || inet_pton(AF_INET, ip, address) != 1))) return false;
  }
  return [NSSet setWithArray:value].count == [value count];
}
static int respond(bool success, NSString* code, bool restored = false) {
  NSDictionary* reply = @{ @"version": @1, @"success": @(success), @"code": code, @"restored": @(restored) };
  NSError* error = nil;
  NSData* json = [NSJSONSerialization dataWithJSONObject:reply options:0 error:&error];
  if (!json || error) return 1;
  return std::fwrite(json.bytes, 1, json.length, stdout) == json.length && std::fputc('\n', stdout) != EOF ? 0 : 1;
}
static bool authorize(PreferencesSession& session, bool interactive) {
  if (AuthorizationCreate(nullptr, kAuthorizationEmptyEnvironment, kAuthorizationFlagDefaults, &session.authorization) != errAuthorizationSuccess) return false;
  // SCPreferences 写入检查此权限；system.preferences.network 是设置界面的另一项权限。
  AuthorizationItem item = { "system.services.systemconfiguration.network", 0, nullptr, 0 };
  AuthorizationRights rights = { 1, &item };
  // 只有用户发起的写入允许显示系统授权；探测不显示授权框。
  const auto flags = kAuthorizationFlagExtendRights | (interactive ? kAuthorizationFlagInteractionAllowed : 0);
  return AuthorizationCopyRights(session.authorization, &rights, kAuthorizationEmptyEnvironment, flags, nullptr) == errAuthorizationSuccess;
}
static int apply(int argc, char** argv) {
  if ((argc != 6 && argc != 7) || std::strcmp(argv[1], "--apply") || (argc == 7 && std::strcmp(argv[6], "--authorize"))) return respond(false, @"INVALID_REQUEST");
  for (int i = 2; i < argc; ++i) if (std::strlen(argv[i]) > 4096) return respond(false, @"INVALID_REQUEST");
  NSString* name = [NSString stringWithUTF8String:argv[2]], *device = [NSString stringWithUTF8String:argv[3]];
  if (!name.length || name.length > 256 || !device.length || device.length > 64) return respond(false, @"INVALID_REQUEST");
  NSError* parseError = nil;
  NSData* expectedData = [[NSString stringWithUTF8String:argv[4]] dataUsingEncoding:NSUTF8StringEncoding];
  NSData* requestedData = [[NSString stringWithUTF8String:argv[5]] dataUsingEncoding:NSUTF8StringEncoding];
  if (!expectedData || !requestedData) return respond(false, @"INVALID_REQUEST");
  id expected = [NSJSONSerialization JSONObjectWithData:expectedData options:0 error:&parseError];
  if (parseError || !validServers(expected)) return respond(false, @"INVALID_EXPECTED_DNS");
  id requested = [NSJSONSerialization JSONObjectWithData:requestedData options:0 error:&parseError];
  if (parseError || !validServers(requested)) return respond(false, @"INVALID_TARGET_DNS");
  PreferencesSession session;
  if (!authorize(session, argc == 7)) return respond(false, @"ADMIN_PERMISSION_REQUIRED");
  session.preferences = SCPreferencesCreateWithAuthorization(nullptr, CFSTR("ZTools DNS"), nullptr, session.authorization);
  if (!session.preferences) return respond(false, @"PREFERENCES_UNAVAILABLE");
  if (!SCPreferencesLock(session.preferences, false)) return respond(false, SCError() == kSCStatusPrefsBusy ? @"CONFIGURATION_BUSY" : @"CONFIGURATION_LOCK_FAILED");
  session.locked = true;
  SCPreferencesSynchronize(session.preferences);
  OwnedCF<SCNetworkSetRef> set(SCNetworkSetCopyCurrent(session.preferences));
  if (!set.value) return respond(false, @"NETWORK_SET_UNAVAILABLE");
  OwnedCF<CFArrayRef> services(SCNetworkSetCopyServices(set.value));
  if (!services.value) return respond(false, @"NETWORK_SERVICES_UNAVAILABLE");
  SCNetworkServiceRef selected = nullptr;
  for (CFIndex i = 0; i < CFArrayGetCount(services.value); ++i) {
    auto service = static_cast<SCNetworkServiceRef>(CFArrayGetValueAtIndex(services.value, i));
    if (SCNetworkServiceGetName(service) && CFEqual(SCNetworkServiceGetName(service), (__bridge CFStringRef)name)) {
      if (selected) return respond(false, @"AMBIGUOUS_SERVICE");
      selected = service;
    }
  }
  if (!selected || !SCNetworkServiceGetEnabled(selected)) return respond(false, @"NETWORK_SERVICE_UNAVAILABLE");
  SCNetworkInterfaceRef interface = SCNetworkServiceGetInterface(selected);
  CFStringRef bsd = interface ? SCNetworkInterfaceGetBSDName(interface) : nullptr;
  if (!bsd || !CFEqual(bsd, (__bridge CFStringRef)device)) return respond(false, @"NETWORK_DEVICE_CHANGED");
  OwnedCF<SCNetworkProtocolRef> protocol(SCNetworkServiceCopyProtocol(selected, kSCNetworkProtocolTypeDNS));
  if (!protocol.value) return respond(false, @"DNS_PROTOCOL_UNAVAILABLE");
  NSDictionary* original = [(__bridge NSDictionary*)SCNetworkProtocolGetConfiguration(protocol.value) copy];
  id current = original[(__bridge NSString*)kSCPropNetDNSServerAddresses] ?: @[];
  if (!validServers(current)) return respond(false, @"INVALID_EXISTING_DNS");
  if (![current isEqual:expected]) return respond(false, @"DNS_CONFIGURATION_CHANGED");
  if ([current isEqual:requested]) return respond(true, @"UNCHANGED");
  NSMutableDictionary* next = original ? [original mutableCopy] : [NSMutableDictionary dictionary];
  if ([requested count]) next[(__bridge NSString*)kSCPropNetDNSServerAddresses] = requested;
  else [next removeObjectForKey:(__bridge NSString*)kSCPropNetDNSServerAddresses];
  if (!SCNetworkProtocolSetConfiguration(protocol.value, (__bridge CFDictionaryRef)next)) return respond(false, @"DNS_CONFIGURATION_REJECTED");
  int preparing = 0;
  if (!phase.compare_exchange_strong(preparing, 1) || getppid() <= 1) return respond(false, @"REQUEST_CANCELLED");
  if (!SCPreferencesCommitChanges(session.preferences)) return respond(false, @"DNS_COMMIT_FAILED");
  if (!SCPreferencesApplyChanges(session.preferences)) {
    const bool restored = SCNetworkProtocolSetConfiguration(protocol.value, (__bridge CFDictionaryRef)original) &&
      SCPreferencesCommitChanges(session.preferences) && SCPreferencesApplyChanges(session.preferences);
    return respond(false, @"DNS_APPLY_FAILED", restored);
  }
  return respond(true, @"APPLIED");
}
int main(int argc, char** argv) {
  const pid_t parent = getppid();
  if (parent <= 1) return respond(false, @"PARENT_UNAVAILABLE");
  std::signal(SIGTERM, cancelBeforeCommit);
  std::signal(SIGINT, cancelBeforeCommit);
  std::thread([parent] {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(85);
    while (getppid() == parent && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(std::chrono::milliseconds(250));
    cancelBeforeCommit(0);
    // 已进入事务先留时间完成恢复；系统调用卡死时以“状态未确认”退出，磁盘备份仍保留。
    std::this_thread::sleep_for(std::chrono::seconds(10));
    _exit(2);
  }).detach();
  @autoreleasepool { return apply(argc, argv); }
}

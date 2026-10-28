#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <IOKit/IOKitLib.h>
extern "C" {
#import <IOKit/i2c/IOI2CInterface.h>
}
#include <dlfcn.h>
#include <unistd.h>
#include <memory>
#include <set>
#include "ddc_packet.hpp"
#include "change_policy.hpp"

namespace {
using display_change::require;
struct APIs {
  void* display = dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_LAZY | RTLD_LOCAL);
  void* core = dlopen("/System/Library/Frameworks/CoreDisplay.framework/CoreDisplay", RTLD_LAZY | RTLD_LOCAL);
  void* io = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_LAZY | RTLD_LOCAL);
  int (*getBrightness)(CGDirectDisplayID, float*) = display ? reinterpret_cast<decltype(getBrightness)>(dlsym(display, "DisplayServicesGetBrightness")) : nullptr;
  int (*setBrightness)(CGDirectDisplayID, float) = display ? reinterpret_cast<decltype(setBrightness)>(dlsym(display, "DisplayServicesSetBrightness")) : nullptr;
  CFDictionaryRef (*info)(CGDirectDisplayID) = core ? reinterpret_cast<decltype(info)>(dlsym(core, "CoreDisplay_DisplayCreateInfoDictionary")) : nullptr;
  CFTypeRef (*createAV)(CFAllocatorRef, io_service_t) = io ? reinterpret_cast<decltype(createAV)>(dlsym(io, "IOAVServiceCreateWithService")) : nullptr;
  IOReturn (*readAV)(CFTypeRef, uint32_t, uint32_t, void*, uint32_t) = io ? reinterpret_cast<decltype(readAV)>(dlsym(io, "IOAVServiceReadI2C")) : nullptr;
  IOReturn (*writeAV)(CFTypeRef, uint32_t, uint32_t, void*, uint32_t) = io ? reinterpret_cast<decltype(writeAV)>(dlsym(io, "IOAVServiceWriteI2C")) : nullptr;
} api;
NSString* identifier(CGDirectDisplayID id) {
  CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(id);
  require(uuid != nullptr, "DISPLAY_ID_MISSING");
  NSString* text = CFBridgingRelease(CFUUIDCreateString(kCFAllocatorDefault, uuid));
  CFRelease(uuid); return [@"mac:" stringByAppendingString:text];
}
struct Ddc {
  CFTypeRef av = nullptr; io_service_t framebuffer = 0; uint32_t chip = 0x37; bool ambiguous = false;
  ~Ddc() { if (av) CFRelease(av); if (framebuffer) IOObjectRelease(framebuffer); }
  Ddc(const Ddc&) = delete; Ddc& operator=(const Ddc&) = delete;
  explicit Ddc(CGDirectDisplayID id) {
    if (CGDisplayIsBuiltin(id)) return;
#if defined(__arm64__)
    if (!api.info || !api.createAV || !api.readAV || !api.writeAV) return;
    NSDictionary* info = CFBridgingRelease(api.info(id));
    NSString* location = info[@"IODisplayLocation"];
    if (![location isKindOfClass:NSString.class]) return;
    io_service_t adapter = IORegistryEntryCopyFromPath(kIOMainPortDefault, (__bridge CFStringRef)location);
    uint64_t adapterID = 0;
    if (!adapter) return;
    auto status = IORegistryEntryGetRegistryEntryID(adapter, &adapterID); IOObjectRelease(adapter);
    if (status != KERN_SUCCESS) return;
    io_registry_entry_t root = IORegistryGetRootEntry(kIOMainPortDefault); io_iterator_t iterator = 0;
    status = IORegistryEntryCreateIterator(root, kIOServicePlane, kIORegistryIterateRecursively, &iterator); IOObjectRelease(root);
    if (status != KERN_SUCCESS) return;
    io_service_t service = 0; size_t count = 0; size_t candidates = 0;
    // 根据实际 framebuffer registry ID 关联，不能按显示器数组顺序猜测 DDC 通道。
    while (++count <= 32768 && (service = IOIteratorNext(iterator))) {
      io_name_t name{}; IORegistryEntryGetName(service, name);
      if (strcmp(name, "DCPAVServiceProxy") == 0 && belongsTo(service, adapterID)) {
        NSObject* where = CFBridgingRelease(IORegistryEntrySearchCFProperty(service, kIOServicePlane, CFSTR("Location"), kCFAllocatorDefault, kIORegistryIterateRecursively));
        if ([where isKindOfClass:NSString.class] && [where isEqual:@"External"]) {
          CFTypeRef candidate = api.createAV(kCFAllocatorDefault, service);
          if (candidate) {
            ++candidates;
            if (candidates == 1) av = candidate;
            else { CFRelease(candidate); if (av) CFRelease(av); av = nullptr; ambiguous = true; }
          }
          io_registry_entry_t parent = 0;
          if (IORegistryEntryGetParentEntry(service, kIOServicePlane, &parent) == KERN_SUCCESS) {
            NSObject* provider = CFBridgingRelease(IORegistryEntryCreateCFProperty(parent, CFSTR("EPICProviderClass"), kCFAllocatorDefault, 0));
            if ([provider isKindOfClass:NSString.class] && [provider isEqual:@"AppleDCPMCDP29XX"]) chip = 0xb7;
            IOObjectRelease(parent);
          }
        }
      }
      IOObjectRelease(service);
    }
    // 扫描被截断时，后续仍可能有第二个通道；不能把已找到的首项当作唯一目标。
    if (count > 32768) { if (av) CFRelease(av); av = nullptr; ambiguous = true; }
    IOObjectRelease(iterator);
#elif defined(__x86_64__)
    auto get = reinterpret_cast<CGError(*)(CGDirectDisplayID, io_service_t*)>(dlsym(RTLD_DEFAULT, "CGSServiceForDisplayNumber"));
    if (get && get(id, &framebuffer) != kCGErrorSuccess) framebuffer = 0;
#endif
  }
  static bool belongsTo(io_service_t entry, uint64_t ancestorID) {
    IOObjectRetain(entry);
    for (int depth = 0; depth < 128; ++depth) {
      uint64_t value = 0;
      if (IORegistryEntryGetRegistryEntryID(entry, &value) == KERN_SUCCESS && value == ancestorID) { IOObjectRelease(entry); return true; }
      io_registry_entry_t parent = 0; const auto status = IORegistryEntryGetParentEntry(entry, kIOServicePlane, &parent); IOObjectRelease(entry);
      if (status != KERN_SUCCESS) return false;
      entry = parent;
    }
    IOObjectRelease(entry); return false;
  }
  bool exchange(std::vector<uint8_t> bytes, std::array<uint8_t, 11>* reply) {
#if defined(__arm64__)
    if (!av) return false;
    for (int retry = 0; retry < 2; ++retry) {
      usleep(10000);
      if (api.writeAV(av, chip, 0x51, bytes.data(), static_cast<uint32_t>(bytes.size())) != KERN_SUCCESS) continue;
      if (!reply) return true;
      usleep(50000); reply->fill(0);
      if (api.readAV(av, chip, 0, reply->data(), static_cast<uint32_t>(reply->size())) == KERN_SUCCESS) return true;
    }
#elif defined(__x86_64__)
    if (!framebuffer) return false;
    IOItemCount buses = 0;
    if (IOFBGetI2CInterfaceCount(framebuffer, &buses) != KERN_SUCCESS || buses > 32) return false;
    for (IOOptionBits bus = 0; bus < buses; ++bus) {
      io_service_t interface = 0;
      if (IOFBCopyI2CInterfaceForBus(framebuffer, bus, &interface) != KERN_SUCCESS) continue;
      IOI2CConnectRef connection = nullptr;
      auto status = IOI2CInterfaceOpen(interface, 0, &connection); IOObjectRelease(interface);
      if (status != KERN_SUCCESS) continue;
      IOI2CRequest request{}; request.sendAddress = 0x6e; request.sendTransactionType = kIOI2CSimpleTransactionType;
      request.sendBuffer = reinterpret_cast<vm_address_t>(bytes.data()); request.sendBytes = static_cast<uint32_t>(bytes.size());
      request.replyTransactionType = reply ? kIOI2CDDCciReplyTransactionType : kIOI2CNoTransactionType;
      if (reply) { reply->fill(0); request.replyAddress = 0x6f; request.replySubAddress = 0x51; request.replyBuffer = reinterpret_cast<vm_address_t>(reply->data()); request.replyBytes = static_cast<uint32_t>(reply->size()); request.minReplyDelay = 50000000; }
      status = IOI2CSendRequest(connection, 0, &request); IOI2CInterfaceClose(connection, 0);
      if (status == KERN_SUCCESS && request.result == KERN_SUCCESS) return true;
    }
#endif
    return false;
  }
  std::optional<display_ddc::Value> read(uint8_t code) {
    std::array<uint8_t, 11> bytes{};
    return exchange(display_ddc::packet(code, std::nullopt, arm64()), &bytes) ? display_ddc::reply(bytes, code) : std::nullopt;
  }
  bool write(uint8_t code, uint16_t value) { return exchange(display_ddc::packet(code, value, arm64()), nullptr); }
  static bool arm64() {
#if defined(__arm64__)
    return true;
#else
    return false;
#endif
  }
};
struct Display {
  CGDirectDisplayID id; NSString* uid; NSString* name; bool apple = false; std::unique_ptr<Ddc> ddc;
  explicit Display(CGDirectDisplayID value): id(value), uid(identifier(value)), name([NSString stringWithFormat:@"显示器 %u", value]) {
    float level = 0; apple = api.getBrightness && api.setBrightness && api.getBrightness(id, &level) == 0 && std::isfinite(level) && level >= 0 && level <= 1;
    if (!apple) ddc = std::make_unique<Ddc>(id);
    for (NSScreen* screen in NSScreen.screens) if ([screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue] == id) name = screen.localizedName;
  }
  void connected() { require(CGDisplayIsOnline(id) && [identifier(id) isEqual:uid], "DISPLAY_DISCONNECTED"); }
  std::optional<display_ddc::Value> raw(uint8_t code) {
    connected();
    if (apple && code == 0x10) { float value = 0; if (api.getBrightness(id, &value) == 0 && std::isfinite(value) && value >= 0 && value <= 1) return display_ddc::Value{static_cast<uint16_t>(std::lround(value * 10000)), 10000}; }
    return ddc ? ddc->read(code) : std::nullopt;
  }
  double read(uint8_t code) {
    connected();
    if (apple && code == 0x10) { float value = 0; require(api.getBrightness(id, &value) == 0 && std::isfinite(value) && value >= 0 && value <= 1, "DISPLAY_READ_FAILED"); return static_cast<double>(value) * 100; }
    auto value = raw(code); require(value.has_value(), "DISPLAY_READ_FAILED"); return 100.0 * value->current / value->maximum;
  }
  void write(uint8_t code, double percent) {
    connected();
    require(!CGDisplayIsInMirrorSet(id), "DISPLAY_MIRROR_UNSUPPORTED");
    if (apple && code == 0x10) require(api.setBrightness(id, static_cast<float>(percent / 100)) == 0, "DISPLAY_WRITE_FAILED");
    else { auto value = raw(code); require(value.has_value() && ddc != nullptr, "DISPLAY_CONTROL_UNAVAILABLE"); require(ddc->write(code, static_cast<uint16_t>(std::lround(percent * value->maximum / 100))), "DISPLAY_WRITE_FAILED"); }
    usleep(80000);
  }
  NSDictionary* describe() {
    auto brightness = raw(0x10), contrast = raw(0x12); CGDisplayModeRef mode = CGDisplayCopyDisplayMode(id);
    require(mode != nullptr, "DISPLAY_READ_FAILED");
    const size_t width = CGDisplayModeGetPixelWidth(mode), height = CGDisplayModeGetPixelHeight(mode); CGDisplayModeRelease(mode);
    const bool mirror = CGDisplayIsInMirrorSet(id);
    NSMutableDictionary* result = [@{@"id":uid,@"name":name,@"isPrimary":@(id == CGMainDisplayID()),@"builtIn":@(CGDisplayIsBuiltin(id) != 0),@"width":@(width),@"height":@(height),@"protocol":apple?@"apple":(brightness || contrast)?@"ddcci":@"unsupported",@"canBrightness":@(brightness.has_value() && !mirror),@"canContrast":@(contrast.has_value() && !mirror)} mutableCopy];
    if (brightness) result[@"brightness"] = @(apple ? read(0x10) : 100.0 * brightness->current / brightness->maximum);
    if (contrast) result[@"contrast"] = @(100.0 * contrast->current / contrast->maximum);
    if (!brightness) result[@"reason"] = @"未能读取硬件亮度；设备、转接线或当前显示模式可能不支持控制";
    if (mirror) result[@"reason"] = @"镜像模式下无法确认独立控制目标，请退出镜像后重新扫描";
    if (ddc && ddc->ambiguous) result[@"reason"] = @"无法唯一确认显示器硬件控制通道，已停止调节";
    return result;
  }
};
std::vector<std::unique_ptr<Display>> displays() {
  CGDirectDisplayID ids[32]; uint32_t count = 0;
  require(CGGetOnlineDisplayList(32, ids, &count) == kCGErrorSuccess && count < 32, "DISPLAY_LIST_FAILED");
  std::vector<std::unique_ptr<Display>> result; std::set<std::string> seen;
  for (uint32_t i = 0; i < count; ++i) { auto item = std::make_unique<Display>(ids[i]); require(seen.insert(item->uid.UTF8String).second, "DISPLAY_ID_AMBIGUOUS"); result.push_back(std::move(item)); }
  return result;
}
NSString* topology() {
  CGDirectDisplayID ids[32]; uint32_t count = 0;
  require(CGGetOnlineDisplayList(32, ids, &count) == kCGErrorSuccess && count < 32, "DISPLAY_LIST_FAILED");
  NSMutableArray* keys = [NSMutableArray array];
  for (uint32_t i = 0; i < count; ++i) [keys addObject:[NSString stringWithFormat:@"%@/%u/%u", identifier(ids[i]), ids[i], CGDisplayMirrorsDisplay(ids[i])]];
  return [[keys sortedArrayUsingSelector:@selector(compare:)] componentsJoinedByString:@"|"];
}
bool numeric(id value) { return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() && std::isfinite([value doubleValue]); }
NSDictionary* execute(NSDictionary* request) {
  require([request isKindOfClass:NSDictionary.class] && numeric(request[@"version"]) && [request[@"version"] doubleValue] == 1, "DISPLAY_REQUEST_INVALID");
  NSString* action = request[@"action"]; require([action isKindOfClass:NSString.class], "DISPLAY_REQUEST_INVALID");
  const bool list = [action isEqual:@"list"];
  require((list && request.count == 2) || ([action isEqual:@"set"] && request.count == 4 && [request[@"topology"] isKindOfClass:NSString.class]), "DISPLAY_REQUEST_INVALID");
  NSString* currentTopology = topology();
  if (!list) require([currentTopology isEqual:request[@"topology"]], "DISPLAY_STATE_CHANGED");
  auto items = displays(); NSMutableArray* result = [NSMutableArray array];
  if (list) { for (auto& item : items) [result addObject:item->describe()]; require([currentTopology isEqual:topology()], "DISPLAY_STATE_CHANGED"); return @{@"version":@1,@"success":@YES,@"displays":result,@"topology":currentTopology}; }
  NSArray* input = request[@"changes"];
  require([input isKindOfClass:NSArray.class] && input.count >= 1 && input.count <= 16, "DISPLAY_REQUEST_INVALID");
  std::vector<display_change::Change> changes; std::vector<uint16_t> maxima; std::vector<std::pair<Display*, uint8_t>> targets; std::set<std::string> seen;
  for (NSDictionary* change in input) {
    require([change isKindOfClass:NSDictionary.class] && change.count == 4 && [change[@"id"] isKindOfClass:NSString.class] && [change[@"control"] isKindOfClass:NSString.class] && numeric(change[@"value"]) && numeric(change[@"expected"]), "DISPLAY_REQUEST_INVALID");
    NSString* control = change[@"control"]; const uint8_t code = [control isEqual:@"brightness"] ? 0x10 : [control isEqual:@"contrast"] ? 0x12 : 0;
    require(code && seen.insert([[NSString stringWithFormat:@"%@:%@", change[@"id"], control] UTF8String]).second, "DISPLAY_REQUEST_INVALID");
    Display* target = nullptr; for (auto& item : items) if ([item->uid isEqual:change[@"id"]]) target = item.get();
    require(target != nullptr, "DISPLAY_DISCONNECTED"); auto current = target->raw(code); require(current.has_value(), "DISPLAY_CONTROL_UNAVAILABLE");
    const double tolerance = target->apple ? 0.0001 : std::min(2.0, 10.0 / current->maximum);
    const double wanted = [change[@"value"] doubleValue];
    require(wanted >= 0 && wanted <= 100, "DISPLAY_REQUEST_INVALID");
    const double quantized = target->apple ? static_cast<double>(static_cast<float>(wanted / 100)) * 100 : std::round(wanted * current->maximum / 100) * 100 / current->maximum;
    changes.push_back({[change[@"expected"] doubleValue], quantized, tolerance}); maxima.push_back(target->apple ? 0 : current->maximum); targets.push_back({target, code});
  }
  const auto values = display_change::apply(changes, [&](size_t i) { require([currentTopology isEqual:topology()], "DISPLAY_STATE_CHANGED"); return targets[i].first->read(targets[i].second); }, [&](size_t i, double value) { require([currentTopology isEqual:topology()], "DISPLAY_STATE_CHANGED"); targets[i].first->write(targets[i].second, value); });
  for (size_t i = 0; i < targets.size(); ++i) [result addObject:@{@"id":targets[i].first->uid,@"control":input[i][@"control"],@"value":@(values[i]),@"maximum":@(maxima[i])}];
  return @{@"version":@1,@"success":@YES,@"changed":result};
}
}
int main() { @autoreleasepool {
  NSDictionary* response; int status = 0;
  try {
    char buffer[16385]; const size_t count = fread(buffer, 1, sizeof(buffer), stdin);
    require(count > 0 && count < sizeof(buffer) && !ferror(stdin), "DISPLAY_REQUEST_INVALID");
    id request = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:buffer length:count] options:0 error:nil];
    response = execute(request);
  } catch (const std::exception& error) { status = 1; response = @{@"version":@1,@"success":@NO,@"code":[NSString stringWithUTF8String:error.what()]}; }
  NSData* data = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
  if (!data || fwrite(data.bytes, 1, data.length, stdout) != data.length) return 2;
  fputc('\n', stdout); return status;
} }

#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#include <cmath>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>
#include <thread>
#include <chrono>

namespace {
using Address = AudioObjectPropertyAddress;
Address address(AudioObjectPropertySelector selector, AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal, UInt32 element = kAudioObjectPropertyElementMain) {
  return {selector, scope, element};
}
void require(bool valid, const char* message) { if (!valid) throw std::runtime_error(message); }
template <class T> std::optional<T> read(AudioObjectID object, Address property) {
  if (!AudioObjectHasProperty(object, &property)) return std::nullopt;
  T value{}; UInt32 size = sizeof(value);
  require(AudioObjectGetPropertyData(object, &property, 0, nullptr, &size, &value) == noErr && size == sizeof(value), "AUDIO_READ_FAILED");
  return value;
}
bool writable(AudioObjectID object, Address property) {
  Boolean result = false;
  return AudioObjectHasProperty(object, &property) && AudioObjectIsPropertySettable(object, &property, &result) == noErr && result;
}
template <class T> void write(AudioObjectID object, Address property, T value) {
  require(writable(object, property), "AUDIO_CONTROL_UNSUPPORTED");
  require(AudioObjectSetPropertyData(object, &property, 0, nullptr, sizeof(value), &value) == noErr, "AUDIO_WRITE_FAILED");
}
NSString* textProperty(AudioObjectID object, AudioObjectPropertySelector selector) {
  const auto value = read<CFStringRef>(object, address(selector));
  require(value && *value, "AUDIO_METADATA_MISSING");
  return CFBridgingRelease(*value);
}
std::vector<AudioDeviceID> deviceIds() {
  Address property = address(kAudioHardwarePropertyDevices); UInt32 size = 0;
  require(AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &property, 0, nullptr, &size) == noErr && size <= 1024 * sizeof(AudioDeviceID) && size % sizeof(AudioDeviceID) == 0, "AUDIO_LIST_FAILED");
  std::vector<AudioDeviceID> ids(size / sizeof(AudioDeviceID));
  if (size) require(AudioObjectGetPropertyData(kAudioObjectSystemObject, &property, 0, nullptr, &size, ids.data()) == noErr, "AUDIO_LIST_FAILED");
  ids.resize(size / sizeof(AudioDeviceID)); return ids;
}
UInt32 channels(AudioDeviceID id, AudioObjectPropertyScope scope) {
  Address property = address(kAudioDevicePropertyStreamConfiguration, scope); UInt32 size = 0;
  require(AudioObjectGetPropertyDataSize(id, &property, 0, nullptr, &size) == noErr && size >= offsetof(AudioBufferList, mBuffers) && size <= 65536, "AUDIO_CHANNELS_FAILED");
  std::vector<unsigned char> bytes(size);
  require(AudioObjectGetPropertyData(id, &property, 0, nullptr, &size, bytes.data()) == noErr, "AUDIO_CHANNELS_FAILED");
  auto* buffers = reinterpret_cast<AudioBufferList*>(bytes.data());
  require(buffers->mNumberBuffers <= (size - offsetof(AudioBufferList, mBuffers)) / sizeof(AudioBuffer), "AUDIO_CHANNELS_FAILED");
  UInt32 count = 0;
  for (UInt32 i = 0; i < buffers->mNumberBuffers; ++i) count += buffers->mBuffers[i].mNumberChannels;
  require(count <= 256, "AUDIO_CHANNELS_FAILED"); return count;
}
Address defaultProperty(AudioObjectPropertyScope scope) {
  return address(scope == kAudioObjectPropertyScopeInput ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice);
}
NSString* transportName(UInt32 value) {
  switch (value) {
    case kAudioDeviceTransportTypeBuiltIn: return @"builtin";
    case kAudioDeviceTransportTypeUSB: return @"usb";
    case kAudioDeviceTransportTypeBluetooth: return @"bluetooth";
    case kAudioDeviceTransportTypeBluetoothLE: return @"bluetoothle";
    case kAudioDeviceTransportTypeHDMI: return @"hdmi";
    case kAudioDeviceTransportTypeDisplayPort: return @"displayport";
    case kAudioDeviceTransportTypeAirPlay: return @"airplay";
    case kAudioDeviceTransportTypeVirtual: return @"virtual";
    case kAudioDeviceTransportTypeAggregate: return @"aggregate";
    default: return @"unknown";
  }
}
// 写入优先选可写总控，再选完整可写的声道集合；只有只读控制时仍保留真实状态展示。
std::vector<Address> controls(AudioDeviceID id, AudioObjectPropertyScope scope, UInt32 count, AudioObjectPropertySelector selector) {
  Address master = address(selector, scope);
  const bool hasMaster = AudioObjectHasProperty(id, &master);
  if (hasMaster && writable(id, master)) return {master};
  std::vector<Address> result;
  bool channelsWritable = true;
  for (UInt32 channel = 1; channel <= count; ++channel) {
    auto property = address(selector, scope, channel);
    if (!AudioObjectHasProperty(id, &property)) return hasMaster ? std::vector<Address>{master} : std::vector<Address>{};
    channelsWritable = channelsWritable && writable(id, property);
    result.push_back(property);
  }
  return hasMaster && !channelsWritable ? std::vector<Address>{master} : result;
}
bool allWritable(AudioDeviceID id, const std::vector<Address>& values) {
  if (values.empty()) return false;
  for (const auto& property : values) if (!writable(id, property)) return false;
  return true;
}
NSDictionary* describe(AudioDeviceID id, AudioObjectPropertyScope scope, UInt32 count) {
  NSString* type = scope == kAudioObjectPropertyScopeInput ? @"input" : @"output";
  NSString* uid = textProperty(id, kAudioDevicePropertyDeviceUID);
  const auto current = read<AudioDeviceID>(kAudioObjectSystemObject, defaultProperty(scope));
  const auto volumeControls = controls(id, scope, count, kAudioDevicePropertyVolumeScalar);
  const auto muteControls = controls(id, scope, count, kAudioDevicePropertyMute);
  NSMutableDictionary* result = [@{@"id": [NSString stringWithFormat:@"%@:%@", type, uid], @"uid": uid,
    @"name": textProperty(id, kAudioObjectPropertyName), @"type": type, @"channels": @(count),
    @"isDefault": @(current && *current == id),
    @"canSetDefault": @(read<UInt32>(id, address(kAudioDevicePropertyDeviceCanBeDefaultDevice, scope)).value_or(0) != 0),
    @"canSetVolume": @(allWritable(id, volumeControls)), @"canMute": @(allWritable(id, muteControls))} mutableCopy];
  const auto transport = read<UInt32>(id, address(kAudioDevicePropertyTransportType));
  if (transport) result[@"transport"] = transportName(*transport);
  const auto rate = read<Float64>(id, address(kAudioDevicePropertyNominalSampleRate));
  if (rate && std::isfinite(*rate) && *rate > 0) result[@"sampleRate"] = @(*rate);
  if (!volumeControls.empty()) {
    float total = 0;
    for (const auto& property : volumeControls) {
      const auto value = read<Float32>(id, property);
      require(value && std::isfinite(*value) && *value >= 0 && *value <= 1, "AUDIO_VOLUME_INVALID"); total += *value;
    }
    result[@"volume"] = @(std::round(total * 100 / volumeControls.size()));
  }
  if (!muteControls.empty()) {
    bool muted = true;
    for (const auto& property : muteControls) { const auto value = read<UInt32>(id, property); require(value.has_value(), "AUDIO_MUTE_INVALID"); muted = muted && *value != 0; }
    result[@"muted"] = @(muted);
  }
  return result;
}
NSArray* listDevices() {
  NSMutableArray* results = [NSMutableArray array];
  for (const auto id : deviceIds()) {
    if (read<UInt32>(id, address(kAudioDevicePropertyDeviceIsAlive)).value_or(0) == 0) continue;
    for (const auto scope : {kAudioObjectPropertyScopeOutput, kAudioObjectPropertyScopeInput}) {
      const auto count = channels(id, scope);
      if (count) [results addObject:describe(id, scope, count)];
    }
  }
  return results;
}
AudioDeviceID resolve(NSString* identity, AudioObjectPropertyScope scope) {
  if (!identity) {
    const auto current = read<AudioDeviceID>(kAudioObjectSystemObject, defaultProperty(scope));
    require(current && *current != kAudioObjectUnknown, "AUDIO_DEFAULT_MISSING"); return *current;
  }
  AudioDeviceID found = kAudioObjectUnknown;
  for (const auto id : deviceIds()) {
    if (read<UInt32>(id, address(kAudioDevicePropertyDeviceIsAlive)).value_or(0) == 0 || channels(id, scope) == 0) continue;
    NSDictionary* info = describe(id, scope, channels(id, scope));
    if ([identity isEqual:info[@"id"]] || [identity isEqual:info[@"uid"]] || [identity isEqual:info[@"name"]]) {
      require(found == kAudioObjectUnknown, "AUDIO_DEVICE_AMBIGUOUS"); found = id;
    }
  }
  require(found != kAudioObjectUnknown, "AUDIO_DEVICE_MISSING"); return found;
}
template <class T> bool controlsMatch(AudioDeviceID id, const std::vector<Address>& properties, const std::vector<T>& targets, double tolerance) {
  for (size_t i = 0; i < properties.size(); ++i) {
    const auto current = read<T>(id, properties[i]);
    if (!current || !std::isfinite(static_cast<double>(*current)) || std::abs(static_cast<double>(*current) - static_cast<double>(targets[i])) > tolerance) return false;
  }
  return true;
}
// 多声道写入失败时尽力恢复已修改的声道；恢复失败必须明确报告，不能假称没有改变。
template <class T> void setControls(AudioDeviceID id, const std::vector<Address>& values, T target) {
  require(allWritable(id, values), "AUDIO_CONTROL_UNSUPPORTED");
  std::vector<T> previous;
  for (const auto& property : values) { auto value = read<T>(id, property); require(value.has_value(), "AUDIO_READ_FAILED"); previous.push_back(*value); }
  size_t applied = 0;
  try {
    for (const auto& property : values) { write(id, property, target); ++applied; }
  } catch (...) {
    bool restored = true;
    for (size_t i = 0; i < applied; ++i) { try { write(id, values[i], previous[i]); } catch (...) { restored = false; } }
    if (restored) {
      restored = false;
      for (int attempt = 0; attempt < 20; ++attempt) {
        try { if (controlsMatch(id, values, previous, 0.0001)) { restored = true; break; } } catch (...) { break; }
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
      }
    }
    require(restored, "AUDIO_PARTIAL_CHANGE"); throw;
  }
}
bool isNumber(id value) { return [value isKindOfClass:[NSNumber class]] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID(); }
NSDictionary* handle(NSDictionary* request) {
  require([request isKindOfClass:[NSDictionary class]], "INVALID_REQUEST");
  NSSet* allowed = [NSSet setWithArray:@[@"version", @"operation", @"type", @"id", @"volume", @"muted"]];
  for (id key in request) require([allowed containsObject:key], "INVALID_REQUEST");
  require(isNumber(request[@"version"]) && [request[@"version"] doubleValue] == 1, "INVALID_REQUEST");
  NSString* operation = request[@"operation"];
  require([operation isKindOfClass:[NSString class]], "INVALID_REQUEST");
  if ([operation isEqual:@"list"]) { require(request.count == 2, "INVALID_REQUEST"); return @{@"version": @1, @"success": @YES, @"devices": listDevices()}; }
  require([@[@"default", @"volume", @"mute"] containsObject:operation], "INVALID_REQUEST");
  NSString* type = request[@"type"];
  require([type isEqual:@"input"] || [type isEqual:@"output"], "INVALID_REQUEST");
  NSString* identity = request[@"id"];
  require(!identity || ([identity isKindOfClass:[NSString class]] && identity.length > 0 && identity.length <= 1024), "INVALID_REQUEST");
  auto scope = [type isEqual:@"input"] ? kAudioObjectPropertyScopeInput : kAudioObjectPropertyScopeOutput;
  if ([operation isEqual:@"default"]) require(identity && !request[@"volume"] && !request[@"muted"], "INVALID_REQUEST");
  if ([operation isEqual:@"volume"]) require(isNumber(request[@"volume"]) && std::isfinite([request[@"volume"] doubleValue]) && [request[@"volume"] doubleValue] >= 0 && [request[@"volume"] doubleValue] <= 100 && !request[@"muted"], "INVALID_REQUEST");
  if ([operation isEqual:@"mute"]) require(!request[@"volume"] && (!request[@"muted"] || CFGetTypeID((__bridge CFTypeRef)request[@"muted"]) == CFBooleanGetTypeID()), "INVALID_REQUEST");
  const auto id = resolve(identity, scope); const auto count = channels(id, scope); require(count > 0, "AUDIO_DEVICE_MISSING");
  NSDictionary* before = describe(id, scope, count);
  bool targetMute = request[@"muted"] ? [request[@"muted"] boolValue] : ![before[@"muted"] boolValue];
  if ([operation isEqual:@"default"]) {
    require([before[@"canSetDefault"] boolValue], "AUDIO_CONTROL_UNSUPPORTED"); write(kAudioObjectSystemObject, defaultProperty(scope), id);
  } else if ([operation isEqual:@"volume"]) setControls<Float32>(id, controls(id, scope, count, kAudioDevicePropertyVolumeScalar), [request[@"volume"] floatValue] / 100);
  else setControls<UInt32>(id, controls(id, scope, count, kAudioDevicePropertyMute), targetMute ? 1 : 0);
  // HAL 通知异步到达；读回设备本身确认后再向界面报告成功。
  for (int attempt = 0; attempt < 40; ++attempt) {
    NSDictionary* current = describe(id, scope, count);
    require([current[@"uid"] isEqual:before[@"uid"]], "AUDIO_DEVICE_CHANGED");
    bool matches = false;
    if ([operation isEqual:@"default"]) matches = [current[@"isDefault"] boolValue];
    else if ([operation isEqual:@"volume"]) {
      auto properties = controls(id, scope, count, kAudioDevicePropertyVolumeScalar);
      matches = !properties.empty() && controlsMatch<Float32>(id, properties, std::vector<Float32>(properties.size(), [request[@"volume"] floatValue] / 100), 0.01);
    } else {
      auto properties = controls(id, scope, count, kAudioDevicePropertyMute);
      matches = !properties.empty() && controlsMatch<UInt32>(id, properties, std::vector<UInt32>(properties.size(), targetMute ? 1 : 0), 0);
    }
    if (matches) return @{@"version": @1, @"success": @YES, @"device": current};
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
  }
  throw std::runtime_error("AUDIO_READBACK_MISMATCH");
}
}
int main() {
  @autoreleasepool {
    NSDictionary* response; int result = 0;
    try {
      // 只接受一个有界 JSON 请求；没有路径、脚本或任意命令入口。
      char bytes[65537]; size_t size = fread(bytes, 1, sizeof(bytes), stdin);
      require(size > 0 && size < sizeof(bytes), "INVALID_REQUEST");
      NSData* data = [NSData dataWithBytes:bytes length:size];
      response = handle([NSJSONSerialization JSONObjectWithData:data options:0 error:nil]);
    } catch (const std::exception& error) {
      response = @{@"version": @1, @"success": @NO, @"code": [NSString stringWithUTF8String:error.what()]}; result = 1;
    }
    NSData* output = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
    fwrite(output.bytes, 1, output.length, stdout); fputc('\n', stdout); return result;
  }
}

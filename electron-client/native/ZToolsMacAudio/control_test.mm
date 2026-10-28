#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#include <map>
#include <set>
#include <cassert>
#include <cstring>
#include <cmath>

namespace fixture {
std::map<UInt32, double> values;
std::set<UInt32> readOnly;
bool mute = false, failSecond = false, ignoreRollback = false;
unsigned writes = 0;
void reset(bool isMute = false) { values = {{1, 0.2}, {2, 0.8}}; readOnly.clear(); mute = isMute; failSecond = false; ignoreRollback = false; writes = 0; }
Boolean has(AudioObjectID, const AudioObjectPropertyAddress* property) { return values.count(property->mElement) > 0; }
OSStatus settable(AudioObjectID, const AudioObjectPropertyAddress* property, Boolean* result) { *result = has(0, property) && !readOnly.count(property->mElement); return noErr; }
OSStatus get(AudioObjectID, const AudioObjectPropertyAddress* property, UInt32, const void*, UInt32* size, void* data) {
  if (!has(0, property)) return kAudioHardwareUnknownPropertyError;
  if (mute) { UInt32 value = values[property->mElement]; std::memcpy(data, &value, sizeof(value)); *size = sizeof(value); }
  else { Float32 value = values[property->mElement]; std::memcpy(data, &value, sizeof(value)); *size = sizeof(value); }
  return noErr;
}
OSStatus set(AudioObjectID, const AudioObjectPropertyAddress* property, UInt32, const void*, UInt32, const void* data) {
  ++writes;
  if (failSecond && writes == 2) return kAudioHardwareUnspecifiedError;
  if (ignoreRollback && writes > 2) return noErr;
  values[property->mElement] = mute ? *static_cast<const UInt32*>(data) : *static_cast<const Float32*>(data);
  return noErr;
}
}
#define AudioObjectHasProperty fixture::has
#define AudioObjectIsPropertySettable fixture::settable
#define AudioObjectGetPropertyData fixture::get
#define AudioObjectSetPropertyData fixture::set
#define main audio_helper_main
#include "main.mm"
#undef main
#undef AudioObjectHasProperty
#undef AudioObjectIsPropertySettable
#undef AudioObjectGetPropertyData
#undef AudioObjectSetPropertyData

int main() {
  @autoreleasepool {
    const std::vector<Address> volume = {address(kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeOutput, 1), address(kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeOutput, 2)};
    fixture::reset();
    assert(!controlsMatch<Float32>(1, volume, {0.5f, 0.5f}, 0.01)); // 均值相同也不能假成功。
    setControls<Float32>(1, volume, 0.6f);
    assert(controlsMatch<Float32>(1, volume, {0.6f, 0.6f}, 0.01));
    fixture::reset(); fixture::failSecond = true;
    bool failed = false;
    try { setControls<Float32>(1, volume, 0.6f); } catch (const std::exception& error) { failed = std::string(error.what()) == "AUDIO_WRITE_FAILED"; }
    assert(failed && controlsMatch<Float32>(1, volume, {0.2f, 0.8f}, 0.0001));
    fixture::reset(); fixture::failSecond = true; fixture::ignoreRollback = true; failed = false;
    try { setControls<Float32>(1, volume, 0.6f); } catch (const std::exception& error) { failed = std::string(error.what()) == "AUDIO_PARTIAL_CHANGE"; }
    assert(failed && !controlsMatch<Float32>(1, volume, {0.2f, 0.8f}, 0.0001));
    fixture::reset(true); fixture::values = {{1, 0}, {2, 1}};
    const std::vector<Address> mutes = {address(kAudioDevicePropertyMute, kAudioObjectPropertyScopeInput, 1), address(kAudioDevicePropertyMute, kAudioObjectPropertyScopeInput, 2)};
    assert(!controlsMatch<UInt32>(1, mutes, {0, 0}, 0));
    setControls<UInt32>(1, mutes, 0); assert(controlsMatch<UInt32>(1, mutes, {0, 0}, 0));
    fixture::reset(); fixture::values.erase(2); failed = false;
    try { setControls<Float32>(1, volume, 0.3f); } catch (const std::exception& error) { failed = std::string(error.what()) == "AUDIO_CONTROL_UNSUPPORTED"; }
    assert(failed && fixture::writes == 0);
    fixture::reset(); fixture::values[1] = NAN;
    assert(!controlsMatch<Float32>(1, volume, {0.2f, 0.8f}, 0.0001));
    fixture::reset(); fixture::values[0] = 0.7; fixture::readOnly.insert(0);
    auto selected = controls(1, kAudioObjectPropertyScopeOutput, 2, kAudioDevicePropertyVolumeScalar);
    assert(selected.size() == 2 && allWritable(1, selected));
    setControls<Float32>(1, selected, 0.4f);
    assert(controlsMatch<Float32>(1, volume, {0.4f, 0.4f}, 0.01) && fixture::values[0] == 0.7);
    fixture::values.erase(2);
    selected = controls(1, kAudioObjectPropertyScopeOutput, 2, kAudioDevicePropertyVolumeScalar);
    assert(selected.size() == 1 && selected[0].mElement == 0 && !allWritable(1, selected));
    fixture::reset(); fixture::values[0] = 0.7;
    selected = controls(1, kAudioObjectPropertyScopeOutput, 2, kAudioDevicePropertyVolumeScalar);
    assert(selected.size() == 1 && selected[0].mElement == 0 && allWritable(1, selected));
    puts("音频逐声道读回、回滚与控制能力选择 10 项验证通过");
  }
}

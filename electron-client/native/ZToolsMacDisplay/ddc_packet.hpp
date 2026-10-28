#pragma once
#include <array>
#include <cstdint>
#include <optional>
#include <vector>

namespace display_ddc {
struct Value { uint16_t current; uint16_t maximum; };
inline bool control(uint8_t code) { return code == 0x10 || code == 0x12; }
inline std::vector<uint8_t> packet(uint8_t code, std::optional<uint16_t> value, bool appleSilicon) {
  if (!control(code)) return {};
  std::vector<uint8_t> bytes{0x51, static_cast<uint8_t>(value ? 0x84 : 0x82), static_cast<uint8_t>(value ? 0x03 : 0x01), code};
  if (value) { bytes.push_back(*value >> 8); bytes.push_back(*value & 255); }
  uint8_t checksum = 0x6e;
  // Apple Silicon 的读请求由 IOAV 层提供数据地址，读包校验不再计入 0x51。
  for (size_t i = appleSilicon && !value ? 1 : 0; i < bytes.size(); ++i) checksum ^= bytes[i];
  bytes.push_back(checksum);
  if (appleSilicon) bytes.erase(bytes.begin());
  return bytes;
}
inline std::optional<Value> reply(const std::array<uint8_t, 11>& bytes, uint8_t code) {
  uint8_t checksum = 0x50;
  for (size_t i = 0; i < bytes.size() - 1; ++i) checksum ^= bytes[i];
  if (!control(code) || bytes[0] != 0x6e || bytes[1] != 0x88 || bytes[2] != 0x02 || bytes[3] != 0 || bytes[4] != code || bytes[5] != 0 || checksum != bytes.back()) return std::nullopt;
  Value value{static_cast<uint16_t>(bytes[8] * 256 + bytes[9]), static_cast<uint16_t>(bytes[6] * 256 + bytes[7])};
  if (!value.maximum || value.current > value.maximum) return std::nullopt;
  return value;
}
}

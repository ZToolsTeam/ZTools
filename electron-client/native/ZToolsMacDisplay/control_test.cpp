#include "ddc_packet.hpp"
#include "change_policy.hpp"
#include <cassert>
#include <iostream>
#include <string>

int main() {
  using namespace display_change;
  assert(display_ddc::packet(0x10, std::nullopt, true) == std::vector<uint8_t>({0x82, 1, 0x10, 0xfd}));
  assert(display_ddc::packet(0x10, 50, false) == std::vector<uint8_t>({0x51, 0x84, 3, 0x10, 0, 50, 0x9a}));
  assert(display_ddc::packet(0x60, 1, true).empty());
  std::array<uint8_t, 11> bytes{0x6e, 0x88, 2, 0, 0x10, 0, 1, 0, 0, 128, 0};
  const auto checksum = [&] { uint8_t value = 0x50; for (size_t i = 0; i < 10; ++i) value ^= bytes[i]; bytes[10] = value; };
  checksum(); auto parsed = display_ddc::reply(bytes, 0x10); assert(parsed && parsed->current == 128 && parsed->maximum == 256);
  bytes[10] ^= 1; assert(!display_ddc::reply(bytes, 0x10)); checksum(); assert(!display_ddc::reply(bytes, 0x12));
  bytes[3] = 1; checksum(); assert(!display_ddc::reply(bytes, 0x10)); bytes[3] = 0; bytes[6] = 0; checksum(); assert(!display_ddc::reply(bytes, 0x10));
  std::vector<double> values{45.458230376, 49}; int writes = 0;
  auto read = [&](size_t i) { return values[i]; };
  auto write = [&](size_t i, double value) { ++writes; values[i] = value; };
  auto expectError = [&](const char* code, const std::function<void()>& fn) { bool rejected = false; try { fn(); } catch (const std::runtime_error& e) { rejected = std::string(e.what()) == code; } assert(rejected); };
  auto changed = apply({{values[0], 46, 0.0001}, {49, 50, 0.1}}, read, write); assert(changed[0] == 46 && changed[1] == 50);
  values = {45.458230376, 49}; writes = 0;
  expectError("DISPLAY_STATE_CHANGED", [&] { apply({{44, 46, 0.0001}}, read, write); }); assert(writes == 0);
  expectError("DISPLAY_WRITE_FAILED_RESTORED", [&] { apply({{values[0], 46, 0.0001}}, read, [&](size_t, double) { ++writes; }); }); assert(values[0] == 45.458230376);
  expectError("DISPLAY_WRITE_FAILED_RESTORED", [&] { apply({{49, 50, 0.1}}, [&](size_t) { return values[1]; }, [&](size_t, double) { ++writes; }); }); assert(values[1] == 49);
  expectError("DISPLAY_WRITE_FAILED_RESTORED", [&] { apply({{values[0], 55, 0.0001}, {49, 60, 0.1}}, read, [&](size_t i, double value) { write(i, value); if (i == 1 && value == 60) throw std::runtime_error("partial"); }); });
  assert(values[0] == 45.458230376 && values[1] == 49);
  expectError("DISPLAY_WRITE_OUTCOME_UNKNOWN", [&] { apply({{values[0], 55, 0.0001}, {49, 60, 0.1}}, read, [&](size_t i, double value) { if (i == 1) { values[0] = 72; throw std::runtime_error("external-change"); } write(i, value); }); });
  assert(values[0] == 72 && values[1] == 49);
  expectError("DISPLAY_REQUEST_INVALID", [&] { apply({{72, -1, 0.1}}, read, write); });
  std::cout << "显示器 DDC 帧校验、真实档位判定、无效参数、批量恢复和外部变更保护全部通过\n";
}

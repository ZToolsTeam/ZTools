#include "ztools_mac_native_abi.h"

#include <cstdlib>
#include <cstring>
#include <mutex>
#include <new>
#include <string>
#include <unordered_map>

#ifndef ZT_MAC_FIXTURE_ABI_VERSION
#define ZT_MAC_FIXTURE_ABI_VERSION ZT_MAC_NATIVE_ABI_V1
#endif

namespace {

std::mutex g_mutex;
bool g_initialized = false;
bool g_destroyed = false;
uint32_t g_api_v1_request_count = 0;
uint32_t g_allocation_count = 0;
uint32_t g_free_count = 0;
std::unordered_map<uint8_t*, uint32_t> g_allocations;

bool validUtf8(const uint8_t* data, uint32_t length) noexcept {
  if (data == nullptr && length != 0) return false;
  uint32_t index = 0;
  while (index < length) {
    const uint8_t first = data[index++];
    if (first <= 0x7f) continue;
    uint32_t codePoint = 0;
    uint32_t continuationCount = 0;
    uint32_t minimum = 0;
    if (first >= 0xc2 && first <= 0xdf) {
      codePoint = first & 0x1f;
      continuationCount = 1;
      minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      codePoint = first & 0x0f;
      continuationCount = 2;
      minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      codePoint = first & 0x07;
      continuationCount = 3;
      minimum = 0x10000;
    } else {
      return false;
    }
    if (length - index < continuationCount) return false;
    for (uint32_t offset = 0; offset < continuationCount; ++offset) {
      const uint8_t next = data[index++];
      if ((next & 0xc0) != 0x80) return false;
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (codePoint < minimum || codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return false;
    }
  }
  return true;
}

zt_mac_native_status validateInput(zt_mac_native_input_v1 input) noexcept {
  if (input.data == nullptr && input.length != 0) return ZT_MAC_NATIVE_INVALID_ARGUMENT;
  if (input.length > ZT_MAC_NATIVE_MAX_JSON_BYTES) return ZT_MAC_NATIVE_SIZE_LIMIT;
  if (input.length == 0) return ZT_MAC_NATIVE_INVALID_JSON;
  if (!validUtf8(input.data, input.length)) return ZT_MAC_NATIVE_INVALID_UTF8;
  if (input.data[0] != '{' || input.data[input.length - 1] != '}') return ZT_MAC_NATIVE_INVALID_JSON;
  return ZT_MAC_NATIVE_OK;
}

zt_mac_native_status allocateOutput(const uint8_t* data, uint32_t length,
                                    zt_mac_native_output_v1* output) noexcept {
  if (output == nullptr) return ZT_MAC_NATIVE_INVALID_ARGUMENT;
  output->data = nullptr;
  output->length = 0;
  if (length == 0 || length > ZT_MAC_NATIVE_MAX_JSON_BYTES) return ZT_MAC_NATIVE_SIZE_LIMIT;
  uint8_t* memory = static_cast<uint8_t*>(std::malloc(length));
  if (memory == nullptr) return ZT_MAC_NATIVE_OUT_OF_MEMORY;
  std::memcpy(memory, data, length);
  try {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_allocations.emplace(memory, length);
    ++g_allocation_count;
  } catch (...) {
    std::free(memory);
    return ZT_MAC_NATIVE_OUT_OF_MEMORY;
  }
  output->data = memory;
  output->length = length;
  return ZT_MAC_NATIVE_OK;
}

zt_mac_native_status init(zt_mac_native_input_v1 config) noexcept {
  try {
    const zt_mac_native_status validation = validateInput(config);
    if (validation != ZT_MAC_NATIVE_OK) return validation;
    static const char expected[] = "{\"mode\":\"fixture\"}";
    if (config.length != sizeof(expected) - 1 ||
        std::memcmp(config.data, expected, sizeof(expected) - 1) != 0) {
      return ZT_MAC_NATIVE_INVALID_JSON;
    }
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_initialized && !g_destroyed) return ZT_MAC_NATIVE_INVALID_STATE;
    if (!g_allocations.empty()) return ZT_MAC_NATIVE_BUSY;
    g_initialized = true;
    g_destroyed = false;
    return ZT_MAC_NATIVE_OK;
  } catch (...) {
    return ZT_MAC_NATIVE_OUT_OF_MEMORY;
  }
}

zt_mac_native_status getInfo(zt_mac_native_output_v1* output) noexcept {
  try {
    {
      std::lock_guard<std::mutex> lock(g_mutex);
      if (!g_initialized || g_destroyed) {
        if (output != nullptr) *output = {nullptr, 0};
        return ZT_MAC_NATIVE_INVALID_STATE;
      }
    }
    static const uint8_t info[] = "{\"id\":\"abi-fixture\",\"abiVersion\":1}";
    return allocateOutput(info, static_cast<uint32_t>(sizeof(info) - 1), output);
  } catch (...) {
    if (output != nullptr) *output = {nullptr, 0};
    return ZT_MAC_NATIVE_OUT_OF_MEMORY;
  }
}

zt_mac_native_status call(zt_mac_native_input_v1 request, zt_mac_native_output_v1* output) noexcept {
  try {
    if (output == nullptr) return ZT_MAC_NATIVE_INVALID_ARGUMENT;
    *output = {nullptr, 0};
    {
      std::lock_guard<std::mutex> lock(g_mutex);
      if (!g_initialized || g_destroyed) return ZT_MAC_NATIVE_INVALID_STATE;
    }
    const zt_mac_native_status validation = validateInput(request);
    if (validation != ZT_MAC_NATIVE_OK) return validation;
    return allocateOutput(request.data, request.length, output);
  } catch (...) {
    if (output != nullptr) *output = {nullptr, 0};
    return ZT_MAC_NATIVE_OUT_OF_MEMORY;
  }
}

zt_mac_native_status destroy() noexcept {
  try {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!g_initialized || g_destroyed) return ZT_MAC_NATIVE_INVALID_STATE;
    if (!g_allocations.empty()) return ZT_MAC_NATIVE_BUSY;
    g_destroyed = true;
    return ZT_MAC_NATIVE_OK;
  } catch (...) {
    return ZT_MAC_NATIVE_INVALID_STATE;
  }
}

zt_mac_native_status freeBuffer(uint8_t* data, uint32_t length) noexcept {
  try {
    if (data == nullptr || length == 0) return ZT_MAC_NATIVE_INVALID_ARGUMENT;
    std::lock_guard<std::mutex> lock(g_mutex);
    const auto found = g_allocations.find(data);
    if (found == g_allocations.end() || found->second != length) return ZT_MAC_NATIVE_INVALID_ARGUMENT;
    g_allocations.erase(found);
    std::free(data);
    ++g_free_count;
    return ZT_MAC_NATIVE_OK;
  } catch (...) {
    return ZT_MAC_NATIVE_INVALID_ARGUMENT;
  }
}

const zt_mac_native_api_v1 g_api = {
    ZT_MAC_NATIVE_ABI_V1,
    static_cast<uint32_t>(sizeof(zt_mac_native_api_v1)),
    0,
    &init,
    &getInfo,
    &call,
    &destroy,
    &freeBuffer,
};

}  // namespace

ZT_MAC_NATIVE_EXPORT uint32_t ZT_MAC_NATIVE_CALL zt_mac_get_abi_version(void) {
  return ZT_MAC_FIXTURE_ABI_VERSION;
}

ZT_MAC_NATIVE_EXPORT const zt_mac_native_api_v1* ZT_MAC_NATIVE_CALL zt_mac_get_api_v1(void) {
  std::lock_guard<std::mutex> lock(g_mutex);
  ++g_api_v1_request_count;
  return ZT_MAC_FIXTURE_ABI_VERSION == ZT_MAC_NATIVE_ABI_V1 ? &g_api : nullptr;
}

ZT_MAC_NATIVE_EXPORT uint32_t ZT_MAC_NATIVE_CALL zt_mac_fixture_get_api_v1_request_count(void) {
  std::lock_guard<std::mutex> lock(g_mutex);
  return g_api_v1_request_count;
}

ZT_MAC_NATIVE_EXPORT uint32_t ZT_MAC_NATIVE_CALL zt_mac_fixture_get_allocation_count(void) {
  std::lock_guard<std::mutex> lock(g_mutex);
  return g_allocation_count;
}

ZT_MAC_NATIVE_EXPORT uint32_t ZT_MAC_NATIVE_CALL zt_mac_fixture_get_free_count(void) {
  std::lock_guard<std::mutex> lock(g_mutex);
  return g_free_count;
}

ZT_MAC_NATIVE_EXPORT uint32_t ZT_MAC_NATIVE_CALL zt_mac_fixture_get_outstanding_count(void) {
  std::lock_guard<std::mutex> lock(g_mutex);
  return static_cast<uint32_t>(g_allocations.size());
}

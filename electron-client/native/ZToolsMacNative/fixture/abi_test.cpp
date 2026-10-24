#include "ztools_mac_native_abi.h"

#include <cstdint>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace {

uint32_t g_checks = 0;

void require(bool condition, const char* code) {
  if (!condition) throw std::runtime_error(code);
  ++g_checks;
}

class DynamicLibrary final {
 public:
  explicit DynamicLibrary(const char* path) {
#if defined(_WIN32)
    handle_ = LoadLibraryA(path);
#else
    handle_ = dlopen(path, RTLD_NOW | RTLD_LOCAL);
#endif
    require(handle_ != nullptr, "DYNAMIC_LOAD_FAILED");
  }

  ~DynamicLibrary() {
    if (handle_ == nullptr) return;
#if defined(_WIN32)
    FreeLibrary(static_cast<HMODULE>(handle_));
#else
    dlclose(handle_);
#endif
  }

  template <typename Function>
  Function symbol(const char* name) const {
#if defined(_WIN32)
    const FARPROC address = GetProcAddress(static_cast<HMODULE>(handle_), name);
    require(address != nullptr, "REQUIRED_SYMBOL_MISSING");
    return reinterpret_cast<Function>(address);
#else
    void* address = dlsym(handle_, name);
    require(address != nullptr, "REQUIRED_SYMBOL_MISSING");
    static_assert(sizeof(Function) == sizeof(address), "FUNCTION_POINTER_SIZE_MISMATCH");
    Function function = nullptr;
    std::memcpy(&function, &address, sizeof(function));
    return function;
#endif
  }

 private:
#if defined(_WIN32)
  HMODULE handle_ = nullptr;
#else
  void* handle_ = nullptr;
#endif
};

using FixtureCounter = uint32_t(ZT_MAC_NATIVE_CALL*)(void);

void testUnsupportedVersion(const char* path) {
  DynamicLibrary library(path);
  const auto getAbiVersion = library.symbol<zt_mac_native_get_abi_version_fn>("zt_mac_get_abi_version");
  const uint32_t abiVersion = getAbiVersion();
  require(abiVersion == 99, "UNSUPPORTED_FIXTURE_VERSION_MISMATCH");
  require(abiVersion != ZT_MAC_NATIVE_ABI_V1, "UNSUPPORTED_VERSION_ACCEPTED");

  const auto apiRequestCount = library.symbol<FixtureCounter>("zt_mac_fixture_get_api_v1_request_count");
  require(apiRequestCount() == 0, "V1_TABLE_REQUESTED_BEFORE_VERSION_MATCH");
}

void requireError(zt_mac_native_status actual, zt_mac_native_status expected, const char* code) {
  require(actual == expected, code);
}

void testSupportedFixture(const char* path) {
  DynamicLibrary library(path);

  // The version export is the only ABI-specific symbol called before negotiation succeeds.
  const auto getAbiVersion = library.symbol<zt_mac_native_get_abi_version_fn>("zt_mac_get_abi_version");
  require(getAbiVersion() == ZT_MAC_NATIVE_ABI_V1, "ABI_VERSION_MISMATCH");
  const auto getApiV1 = library.symbol<zt_mac_native_get_api_v1_fn>("zt_mac_get_api_v1");
  const zt_mac_native_api_v1* api = getApiV1();
  require(api != nullptr, "ABI_TABLE_MISSING");
  require(api->abi_version == ZT_MAC_NATIVE_ABI_V1, "ABI_TABLE_VERSION_MISMATCH");
  require(api->struct_size == sizeof(zt_mac_native_api_v1), "ABI_TABLE_SIZE_MISMATCH");
  require(api->capabilities == 0, "UNKNOWN_CAPABILITY_ADVERTISED");
  require(api->init != nullptr && api->get_info != nullptr && api->call != nullptr &&
              api->destroy != nullptr && api->free_buffer != nullptr,
          "REQUIRED_ABI_FUNCTION_MISSING");

  const auto allocationCount = library.symbol<FixtureCounter>("zt_mac_fixture_get_allocation_count");
  const auto freeCount = library.symbol<FixtureCounter>("zt_mac_fixture_get_free_count");
  const auto outstandingCount = library.symbol<FixtureCounter>("zt_mac_fixture_get_outstanding_count");

  zt_mac_native_output_v1 output{nullptr, 0};
  requireError(api->get_info(&output), ZT_MAC_NATIVE_INVALID_STATE, "INFO_BEFORE_INIT_ACCEPTED");
  require(output.data == nullptr && output.length == 0, "FAILED_INFO_LEFT_OUTPUT_SET");
  requireError(api->call({nullptr, 1}, &output), ZT_MAC_NATIVE_INVALID_STATE, "CALL_BEFORE_INIT_ACCEPTED");
  require(output.data == nullptr && output.length == 0, "FAILED_CALL_LEFT_OUTPUT_SET");

  static const uint8_t config[] = "{\"mode\":\"fixture\"}";
  requireError(api->init({config, static_cast<uint32_t>(sizeof(config) - 1)}), ZT_MAC_NATIVE_OK,
               "VALID_INIT_REJECTED");
  requireError(api->init({config, static_cast<uint32_t>(sizeof(config) - 1)}), ZT_MAC_NATIVE_INVALID_STATE,
               "DUPLICATE_INIT_ACCEPTED");
  requireError(api->get_info(nullptr), ZT_MAC_NATIVE_INVALID_ARGUMENT, "NULL_INFO_OUTPUT_ACCEPTED");

  requireError(api->get_info(&output), ZT_MAC_NATIVE_OK, "INFO_CALL_FAILED");
  static const char info[] = "{\"id\":\"abi-fixture\",\"abiVersion\":1}";
  require(output.length == sizeof(info) - 1, "INFO_LENGTH_MISMATCH");
  require(std::memcmp(output.data, info, sizeof(info) - 1) == 0, "INFO_CONTENT_MISMATCH");
  require(allocationCount() == 1 && outstandingCount() == 1, "INFO_ALLOCATION_NOT_TRACKED");
  requireError(api->free_buffer(output.data, output.length - 1), ZT_MAC_NATIVE_INVALID_ARGUMENT,
               "WRONG_FREE_LENGTH_ACCEPTED");
  require(outstandingCount() == 1, "WRONG_FREE_LENGTH_DROPPED_ALLOCATION");
  requireError(api->free_buffer(output.data, output.length), ZT_MAC_NATIVE_OK, "INFO_FREE_FAILED");
  requireError(api->free_buffer(output.data, output.length), ZT_MAC_NATIVE_INVALID_ARGUMENT,
               "DOUBLE_FREE_ACCEPTED");
  require(freeCount() == 1 && outstandingCount() == 0, "INFO_FREE_NOT_TRACKED");

  // Input is deliberately not NUL-terminated; bytes beyond length are ignored.
  const uint8_t callStorage[] = {'{', '\"', 'x', '\"', ':', '1', '}', 'x'};
  const zt_mac_native_input_v1 request{callStorage, 7};
  requireError(api->call(request, &output), ZT_MAC_NATIVE_OK, "VALID_CALL_REJECTED");
  require(output.length == request.length, "CALL_LENGTH_MISMATCH");
  require(std::memcmp(output.data, request.data, request.length) == 0, "CALL_CONTENT_MISMATCH");
  requireError(api->destroy(), ZT_MAC_NATIVE_BUSY, "DESTROY_WITH_LIVE_OUTPUT_ACCEPTED");
  requireError(api->free_buffer(output.data, output.length), ZT_MAC_NATIVE_OK, "CALL_FREE_FAILED");
  require(freeCount() == 2 && outstandingCount() == 0, "CALL_FREE_NOT_TRACKED");

  const uint8_t invalidUtf8[] = {'{', 0xff, '}'};
  output = {reinterpret_cast<uint8_t*>(static_cast<uintptr_t>(1)), 9};
  requireError(api->call({invalidUtf8, static_cast<uint32_t>(sizeof(invalidUtf8))}, &output),
               ZT_MAC_NATIVE_INVALID_UTF8, "INVALID_UTF8_ACCEPTED");
  require(output.data == nullptr && output.length == 0, "FAILED_UTF8_CALL_LEFT_OUTPUT_SET");

  const uint8_t invalidJson[] = {'[', '1', ']'};
  requireError(api->call({invalidJson, static_cast<uint32_t>(sizeof(invalidJson))}, &output),
               ZT_MAC_NATIVE_INVALID_JSON, "NON_OBJECT_JSON_ACCEPTED");
  require(output.data == nullptr && output.length == 0, "FAILED_JSON_CALL_LEFT_OUTPUT_SET");

  requireError(api->call({nullptr, 1}, &output), ZT_MAC_NATIVE_INVALID_ARGUMENT, "NULL_NONEMPTY_INPUT_ACCEPTED");
  require(output.data == nullptr && output.length == 0, "FAILED_POINTER_CALL_LEFT_OUTPUT_SET");
  requireError(api->call({callStorage, 0}, &output), ZT_MAC_NATIVE_INVALID_JSON, "EMPTY_JSON_ACCEPTED");
  require(output.data == nullptr && output.length == 0, "FAILED_EMPTY_CALL_LEFT_OUTPUT_SET");

  std::vector<uint8_t> oversized(static_cast<size_t>(ZT_MAC_NATIVE_MAX_JSON_BYTES) + 1, 'a');
  requireError(api->call({oversized.data(), static_cast<uint32_t>(oversized.size())}, &output),
               ZT_MAC_NATIVE_SIZE_LIMIT, "OVERSIZED_JSON_ACCEPTED");
  require(output.data == nullptr && output.length == 0, "FAILED_SIZE_CALL_LEFT_OUTPUT_SET");

  uint8_t unownedBuffer = 0;
  requireError(api->free_buffer(&unownedBuffer, 1), ZT_MAC_NATIVE_INVALID_ARGUMENT,
               "UNOWNED_FREE_ACCEPTED");
  requireError(api->destroy(), ZT_MAC_NATIVE_OK, "DESTROY_FAILED");
  requireError(api->destroy(), ZT_MAC_NATIVE_INVALID_STATE, "DOUBLE_DESTROY_ACCEPTED");
  requireError(api->call(request, &output), ZT_MAC_NATIVE_INVALID_STATE, "CALL_AFTER_DESTROY_ACCEPTED");
  require(output.data == nullptr && output.length == 0, "POST_DESTROY_CALL_LEFT_OUTPUT_SET");
  require(allocationCount() == freeCount() && outstandingCount() == 0, "ALLOCATOR_BALANCE_MISMATCH");
}

}  // namespace

int main(int argc, char** argv) {
  try {
    require(argc == 3, "ABI_TEST_USAGE");
    testUnsupportedVersion(argv[2]);
    testSupportedFixture(argv[1]);
    std::cout << "{\"status\":\"PASS\",\"scope\":\"portable-mac-native-abi-synthetic-fixture\",\"checks\":"
              << g_checks << "}\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  } catch (...) {
    std::cerr << "ABI_TEST_UNCLASSIFIED_FAILURE\n";
    return 1;
  }
}

#include <iostream>

#if defined(_WIN32)
#include "ztools_mac_native_abi.h"
#include "worker_session_v1.h"
#include "ztools_mac_native_wire_v1.h"

#include <cstdint>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <utility>
#include <vector>

#include <fcntl.h>
#include <io.h>
#include <stdio.h>
#include <windows.h>

namespace {

using ztools::macnative::FrameHeaderV1;
using ztools::macnative::WireError;
using ztools::macnative::decodeFrameHeaderV1;
using ztools::macnative::encodeFrameHeaderV1;

struct NativeApi {
#if defined(_WIN32)
  HMODULE library = nullptr;
#else
  void* library = nullptr;
#endif
  const zt_mac_native_api_v1* table = nullptr;
  uint32_t abiVersion = 0;
  bool initialized = false;
  bool destroyed = false;

  ~NativeApi() {
    if (table != nullptr && initialized && !destroyed) (void)table->destroy();
#if defined(_WIN32)
    if (library != nullptr) FreeLibrary(library);
#else
    if (library != nullptr) dlclose(library);
#endif
  }

  bool loadTestFixture(const char* path) {
#if defined(_WIN32)
    library = LoadLibraryA(path);
    if (library == nullptr) return false;
    auto getVersion = reinterpret_cast<zt_mac_native_get_abi_version_fn>(
        GetProcAddress(library, "zt_mac_get_abi_version"));
    if (getVersion == nullptr) return false;
    abiVersion = getVersion();
    if (abiVersion != ZT_MAC_NATIVE_ABI_V1) return true;
    auto getApi = reinterpret_cast<zt_mac_native_get_api_v1_fn>(GetProcAddress(library, "zt_mac_get_api_v1"));
#else
    library = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (library == nullptr) return false;
    void* versionSymbol = dlsym(library, "zt_mac_get_abi_version");
    if (versionSymbol == nullptr) return false;
    zt_mac_native_get_abi_version_fn getVersion = nullptr;
    static_assert(sizeof(getVersion) == sizeof(versionSymbol), "FUNCTION_POINTER_SIZE_MISMATCH");
    __builtin_memcpy(&getVersion, &versionSymbol, sizeof(getVersion));
    abiVersion = getVersion();
    if (abiVersion != ZT_MAC_NATIVE_ABI_V1) return true;
    void* apiSymbol = dlsym(library, "zt_mac_get_api_v1");
    zt_mac_native_get_api_v1_fn getApi = nullptr;
    static_assert(sizeof(getApi) == sizeof(apiSymbol), "FUNCTION_POINTER_SIZE_MISMATCH");
    __builtin_memcpy(&getApi, &apiSymbol, sizeof(getApi));
#endif
    if (getApi == nullptr) return false;
    table = getApi();
    return table != nullptr && table->abi_version == ZT_MAC_NATIVE_ABI_V1 &&
           table->struct_size >= sizeof(zt_mac_native_api_v1) && table->capabilities == 0 && table->init != nullptr &&
           table->get_info != nullptr && table->call != nullptr && table->destroy != nullptr &&
           table->free_buffer != nullptr;
  }
};

struct InputFrame {
  FrameHeaderV1 header;
  std::vector<uint8_t> bytes;
  const uint8_t* payload() const noexcept { return bytes.data() + ZT_MAC_NATIVE_WIRE_HEADER_BYTES; }
};

enum class ReadResult : uint8_t { Complete, CleanEof, Invalid };

ReadResult readFrame(InputFrame* output) {
  if (output == nullptr) return ReadResult::Invalid;
  std::vector<uint8_t> bytes(ZT_MAC_NATIVE_WIRE_HEADER_BYTES);
  std::cin.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  const std::streamsize headerRead = std::cin.gcount();
  if (headerRead == 0 && std::cin.eof()) return ReadResult::CleanEof;
  if (headerRead != static_cast<std::streamsize>(ZT_MAC_NATIVE_WIRE_HEADER_BYTES)) return ReadResult::Invalid;
  const uint32_t payloadLength = static_cast<uint32_t>(bytes[8]) |
                                 (static_cast<uint32_t>(bytes[9]) << 8) |
                                 (static_cast<uint32_t>(bytes[10]) << 16) |
                                 (static_cast<uint32_t>(bytes[11]) << 24);
  if (payloadLength > ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES) return ReadResult::Invalid;
  bytes.resize(ZT_MAC_NATIVE_WIRE_HEADER_BYTES + payloadLength);
  if (payloadLength != 0) {
    std::cin.read(reinterpret_cast<char*>(bytes.data() + ZT_MAC_NATIVE_WIRE_HEADER_BYTES),
                  static_cast<std::streamsize>(payloadLength));
    if (std::cin.gcount() != static_cast<std::streamsize>(payloadLength)) return ReadResult::Invalid;
  }
  FrameHeaderV1 header{};
  const WireError error = decodeFrameHeaderV1(bytes.data(), bytes.size(), &header);
  if (error != WireError::None) return ReadResult::Invalid;
  output->header = header;
  output->bytes = std::move(bytes);
  return ReadResult::Complete;
}

bool sendFrame(uint16_t type, uint64_t owner, uint64_t generation, uint64_t taskId,
               const uint8_t* payload, uint32_t payloadLength) {
  if (payloadLength > ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES || (payload == nullptr && payloadLength != 0)) return false;
  FrameHeaderV1 header{ZT_MAC_NATIVE_WIRE_V1, type, payloadLength, owner, generation, taskId};
  uint8_t encoded[ZT_MAC_NATIVE_WIRE_HEADER_BYTES]{};
  if (!encodeFrameHeaderV1(header, encoded, sizeof(encoded))) return false;
  std::cout.write(reinterpret_cast<const char*>(encoded), sizeof(encoded));
  if (payloadLength != 0) std::cout.write(reinterpret_cast<const char*>(payload), payloadLength);
  std::cout.flush();
  return std::cout.good();
}

bool sendText(zt_mac_native_frame_type_v1 type, uint64_t owner, uint64_t generation, uint64_t taskId,
              const std::string& value) {
  if (value.size() > ZT_MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES) return false;
  return sendFrame(static_cast<uint16_t>(type), owner, generation, taskId, reinterpret_cast<const uint8_t*>(value.data()),
                   static_cast<uint32_t>(value.size()));
}

void writeStatus(int32_t status, std::string* output) {
  if (output == nullptr) return;
  *output = "{\"status\":" + std::to_string(status) + "}";
}

bool copyAndFreeOutput(const zt_mac_native_api_v1* api, zt_mac_native_output_v1* nativeOutput,
                       std::string* copy) {
  if (api == nullptr || nativeOutput == nullptr || copy == nullptr) return false;
  if (nativeOutput->data == nullptr || nativeOutput->length == 0 ||
      nativeOutput->length > ZT_MAC_NATIVE_MAX_JSON_BYTES) {
    return false;
  }
  bool copied = false;
  try {
    copy->assign(reinterpret_cast<const char*>(nativeOutput->data), nativeOutput->length);
    copied = true;
  } catch (...) {
    copied = false;
  }
  const zt_mac_native_status freeStatus = api->free_buffer(nativeOutput->data, nativeOutput->length);
  *nativeOutput = {nullptr, 0};
  return copied && freeStatus == ZT_MAC_NATIVE_OK;
}

bool parseDecimal(const char* text, uint64_t* value) {
  if (text == nullptr || value == nullptr || text[0] == '\0' || text[0] == '-') return false;
  try {
    size_t parsed = 0;
    const unsigned long long candidate = std::stoull(text, &parsed, 10);
    if (text[parsed] != '\0' || candidate == 0) return false;
    *value = static_cast<uint64_t>(candidate);
    return true;
  } catch (...) {
    return false;
  }
}

int runFixtureWorker(const char* componentPath, uint64_t owner, uint64_t generation) {
  NativeApi native;
  const bool loaded = native.loadTestFixture(componentPath);
  if (!loaded && native.abiVersion == 0) return 70;

  InputFrame request;
  const ReadResult firstRead = readFrame(&request);
  if (firstRead != ReadResult::Complete || request.header.type != ZT_MAC_FRAME_HANDSHAKE ||
      request.header.owner != owner || request.header.generation != generation ||
      request.header.payloadLength != 0) {
    return 71;
  }

  const bool validApi = loaded && native.abiVersion == ZT_MAC_NATIVE_ABI_V1 && native.table != nullptr;
  const std::string handshake = validApi
      ? "{\"wireVersion\":1,\"abiVersion\":1,\"capabilities\":0,\"status\":\"ready\"}"
      : "{\"wireVersion\":1,\"abiVersion\":" + std::to_string(native.abiVersion) +
            ",\"capabilities\":0,\"status\":\"rejected\"}";
  if (!sendText(ZT_MAC_FRAME_HANDSHAKE, owner, generation, 0, handshake)) return 72;
  if (!validApi) return 73;

  std::map<uint64_t, std::string> tasks;
  while (true) {
    const ReadResult readResult = readFrame(&request);
    if (readResult == ReadResult::CleanEof) return 0;
    if (readResult != ReadResult::Complete || request.header.owner != owner ||
        request.header.generation != generation) {
      return 74;
    }
    const uint8_t* payload = request.payload();
    const uint32_t payloadLength = request.header.payloadLength;
    std::string response;
    int32_t status = ZT_MAC_NATIVE_INVALID_ARGUMENT;
    switch (request.header.type) {
      case ZT_MAC_FRAME_INIT:
        if (!native.initialized && !native.destroyed) {
          status = native.table->init({payload, payloadLength});
          native.initialized = status == ZT_MAC_NATIVE_OK;
        } else {
          status = ZT_MAC_NATIVE_INVALID_STATE;
        }
        writeStatus(status, &response);
        if (!sendText(status == ZT_MAC_NATIVE_OK ? ZT_MAC_FRAME_RESPONSE : ZT_MAC_FRAME_ERROR,
                      owner, generation, 0, response)) return 75;
        break;
      case ZT_MAC_FRAME_INFO: {
        zt_mac_native_output_v1 output{nullptr, 0};
        status = native.initialized && !native.destroyed ? native.table->get_info(&output) : ZT_MAC_NATIVE_INVALID_STATE;
        if (status == ZT_MAC_NATIVE_OK && copyAndFreeOutput(native.table, &output, &response)) {
          if (!sendText(ZT_MAC_FRAME_RESPONSE, owner, generation, 0, response)) return 76;
        } else {
          if (output.data != nullptr) (void)native.table->free_buffer(output.data, output.length);
          writeStatus(status == ZT_MAC_NATIVE_OK ? ZT_MAC_NATIVE_OUT_OF_MEMORY : status, &response);
          if (!sendText(ZT_MAC_FRAME_ERROR, owner, generation, 0, response)) return 77;
        }
        break;
      }
      case ZT_MAC_FRAME_CALL: {
        if (!native.initialized || native.destroyed || tasks.find(request.header.taskId) != tasks.end()) {
          writeStatus(ZT_MAC_NATIVE_INVALID_STATE, &response);
          if (!sendText(ZT_MAC_FRAME_ERROR, owner, generation, request.header.taskId, response)) return 78;
          break;
        }
        tasks.emplace(request.header.taskId, "running");
        if (payloadLength == 16 && std::memcmp(payload, "{\"test\":\"crash\"}", 16) == 0) std::abort();
        if (payloadLength == 15 && std::memcmp(payload, "{\"test\":\"hang\"}", 15) == 0) {
#if defined(_WIN32)
          Sleep(60000);
#else
          std::this_thread::sleep_for(std::chrono::seconds(60));
#endif
        }
        if (!sendText(ZT_MAC_FRAME_PROGRESS, owner, generation, request.header.taskId, "{\"phase\":\"call\"}")) {
          return 79;
        }
        zt_mac_native_output_v1 output{nullptr, 0};
        status = native.table->call({payload, payloadLength}, &output);
        if (status == ZT_MAC_NATIVE_OK && copyAndFreeOutput(native.table, &output, &response)) {
          tasks[request.header.taskId] = "completed";
          if (!sendText(ZT_MAC_FRAME_RESPONSE, owner, generation, request.header.taskId, response)) return 80;
        } else {
          if (output.data != nullptr) (void)native.table->free_buffer(output.data, output.length);
          tasks[request.header.taskId] = "failed";
          writeStatus(status == ZT_MAC_NATIVE_OK ? ZT_MAC_NATIVE_OUT_OF_MEMORY : status, &response);
          if (!sendText(ZT_MAC_FRAME_ERROR, owner, generation, request.header.taskId, response)) return 81;
        }
        break;
      }
      case ZT_MAC_FRAME_QUERY: {
        const auto found = tasks.find(request.header.taskId);
        if (found == tasks.end()) {
          if (!sendText(ZT_MAC_FRAME_ERROR, owner, generation, request.header.taskId,
                        "{\"status\":1,\"reason\":\"unknown-task\"}")) return 82;
        } else if (!sendText(ZT_MAC_FRAME_RESPONSE, owner, generation, request.header.taskId,
                             "{\"state\":\"" + found->second + "\"}")) {
          return 83;
        }
        break;
      }
      case ZT_MAC_FRAME_CLEAR: {
        const auto found = tasks.find(request.header.taskId);
        if (found == tasks.end() || found->second == "running") {
          if (!sendText(ZT_MAC_FRAME_ERROR, owner, generation, request.header.taskId,
                        "{\"status\":1,\"reason\":\"task-not-clearable\"}")) return 84;
        } else {
          tasks.erase(found);
          if (!sendText(ZT_MAC_FRAME_RESPONSE, owner, generation, request.header.taskId,
                        "{\"cleared\":true}")) return 85;
        }
        break;
      }
      case ZT_MAC_FRAME_CANCEL:
        if (!sendText(ZT_MAC_FRAME_ERROR, owner, generation, request.header.taskId,
                      "{\"status\":1,\"reason\":\"worker-call-is-synchronous\"}")) return 86;
        break;
      case ZT_MAC_FRAME_DESTROY:
        status = native.initialized && !native.destroyed ? native.table->destroy() : ZT_MAC_NATIVE_INVALID_STATE;
        native.destroyed = status == ZT_MAC_NATIVE_OK;
        writeStatus(status, &response);
        if (!sendText(status == ZT_MAC_NATIVE_OK ? ZT_MAC_FRAME_RESPONSE : ZT_MAC_FRAME_ERROR,
                      owner, generation, 0, response)) return 87;
        break;
      case ZT_MAC_FRAME_SHUTDOWN:
        status = !native.initialized || native.destroyed ? ZT_MAC_NATIVE_OK : native.table->destroy();
        if (status != ZT_MAC_NATIVE_OK) {
          writeStatus(status, &response);
          if (!sendText(ZT_MAC_FRAME_ERROR, owner, generation, 0, response)) return 88;
          return 89;
        }
        native.destroyed = native.initialized;
        if (!sendText(ZT_MAC_FRAME_RESPONSE, owner, generation, 0, "{\"stopped\":true}")) return 90;
        return 0;
      default:
        return 91;
    }
  }
}

}  // namespace

int main(int argc, char** argv) {
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  if (argc != 7 || std::string(argv[1]) != "--test-fixture" || std::string(argv[3]) != "--owner" ||
      std::string(argv[5]) != "--generation") {
    std::cerr << "TEST_WORKER_USAGE\n";
    return 64;
  }
  uint64_t owner = 0;
  uint64_t generation = 0;
  if (!parseDecimal(argv[4], &owner) || !parseDecimal(argv[6], &generation)) return 65;
  return runFixtureWorker(argv[2], owner, generation);
}
#else
int main(int argc, char** argv) {
  (void)argc;
  (void)argv;
  std::cerr << "DARWIN_TRUST_GATE_NOT_READY_FAIL_CLOSED\n";
  return 78;
}
#endif

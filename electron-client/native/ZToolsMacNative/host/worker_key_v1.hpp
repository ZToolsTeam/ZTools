#ifndef ZTOOLS_MAC_NATIVE_WORKER_KEY_V1_HPP
#define ZTOOLS_MAC_NATIVE_WORKER_KEY_V1_HPP

#include <cstdint>
#include <string>
#include <tuple>

namespace ztools::macnative {

struct WorkerKeyV1 {
  std::string pluginId;
  uint64_t owner = 0;
  uint64_t generation = 0;
  std::string pluginInstanceId;

  bool operator<(const WorkerKeyV1& other) const noexcept {
    return std::tie(pluginId, owner, generation, pluginInstanceId) <
        std::tie(other.pluginId, other.owner, other.generation, other.pluginInstanceId);
  }

  bool matchesOwner(uint64_t expectedOwner, uint64_t expectedGeneration,
                    const std::string& expectedPluginInstanceId) const noexcept {
    return owner == expectedOwner && generation == expectedGeneration &&
        pluginInstanceId == expectedPluginInstanceId;
  }

  bool matchesPlugin(const std::string& expectedPluginId) const noexcept {
    return pluginId == expectedPluginId;
  }
};

}  // namespace ztools::macnative

#endif

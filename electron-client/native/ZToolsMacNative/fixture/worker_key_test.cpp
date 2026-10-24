#include "worker_key_v1.hpp"

#include <iostream>
#include <map>

namespace {

int checks = 0;

bool expect(bool condition, const char* code) {
  if (!condition) {
    std::cerr << code << '\n';
    return false;
  }
  ++checks;
  return true;
}

}  // namespace

int main() {
  using ztools::macnative::WorkerKeyV1;
  std::map<WorkerKeyV1, int> workers;
  workers.emplace(WorkerKeyV1{"plugin.alpha", 7, 2, "main:41"}, 1);
  workers.emplace(WorkerKeyV1{"plugin.beta", 7, 2, "main:41"}, 2);
  workers.emplace(WorkerKeyV1{"plugin.alpha", 7, 2, "plugin-instance-2"}, 3);
  workers.emplace(WorkerKeyV1{"plugin.alpha", 7, 3, "main:41"}, 4);
  workers.emplace(WorkerKeyV1{"plugin.beta", 8, 1, "main:52"}, 5);
  if (!expect(workers.size() == 5, "WORKER_KEY_COLLAPSED_PLUGIN_OR_INSTANCE") ||
      !expect(workers.at(WorkerKeyV1{"plugin.alpha", 7, 2, "main:41"}) == 1,
              "WORKER_KEY_LOOKUP_CROSSED_PLUGIN") ||
      !expect(workers.at(WorkerKeyV1{"plugin.beta", 7, 2, "main:41"}) == 2,
              "WORKER_KEY_SECOND_PLUGIN_MISSING")) {
    std::cout << "{\"status\":\"FAIL\",\"scope\":\"mac-native-worker-key-plugin-owner-instance\"}\n";
    return 1;
  }

  size_t ownerContextWorkers = 0;
  size_t pluginWorkers = 0;
  for (const auto& entry : workers) {
    if (entry.first.matchesOwner(7, 2, "main:41")) ++ownerContextWorkers;
    if (entry.first.matchesPlugin("plugin.alpha")) ++pluginWorkers;
  }
  if (!expect(ownerContextWorkers == 2, "OWNER_RELEASE_SCOPE_NOT_ALL_PLUGINS") ||
      !expect(pluginWorkers == 3, "PLUGIN_MAINTENANCE_SCOPE_INCOMPLETE")) {
    std::cout << "{\"status\":\"FAIL\",\"scope\":\"mac-native-worker-key-plugin-owner-instance\"}\n";
    return 1;
  }
  for (auto iterator = workers.begin(); iterator != workers.end();) {
    if (iterator->first.matchesOwner(7, 2, "main:41")) iterator = workers.erase(iterator);
    else ++iterator;
  }
  if (!expect(workers.size() == 3, "OWNER_RELEASE_DID_NOT_REMOVE_ALL_PLUGIN_WORKERS") ||
      !expect(workers.count(WorkerKeyV1{"plugin.alpha", 7, 2, "plugin-instance-2"}) == 1,
              "OWNER_RELEASE_REMOVED_OTHER_INSTANCE") ||
      !expect(workers.count(WorkerKeyV1{"plugin.alpha", 7, 3, "main:41"}) == 1,
              "OWNER_RELEASE_REMOVED_OTHER_GENERATION") ||
      !expect(workers.count(WorkerKeyV1{"plugin.beta", 8, 1, "main:52"}) == 1,
              "OWNER_RELEASE_REMOVED_OTHER_OWNER")) {
    std::cout << "{\"status\":\"FAIL\",\"scope\":\"mac-native-worker-key-plugin-owner-instance\"}\n";
    return 1;
  }
  for (auto iterator = workers.begin(); iterator != workers.end();) {
    if (iterator->first.matchesPlugin("plugin.alpha")) iterator = workers.erase(iterator);
    else ++iterator;
  }
  if (!expect(workers.size() == 1 && workers.begin()->first.pluginId == "plugin.beta",
              "PLUGIN_MAINTENANCE_REMOVED_OTHER_PLUGIN")) {
    std::cout << "{\"status\":\"FAIL\",\"scope\":\"mac-native-worker-key-plugin-owner-instance\"}\n";
    return 1;
  }
  std::cout << "{\"status\":\"PASS\",\"scope\":\"mac-native-worker-key-plugin-owner-instance\",\"checks\":"
            << checks << "}\n";
  return 0;
}

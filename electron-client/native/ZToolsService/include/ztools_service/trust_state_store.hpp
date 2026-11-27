#pragma once

#include <mutex>
#include <optional>
#include <string>

namespace ztools::service {

// 特权插件单调高水位存储：生产环境使用显式 64 位注册表视图（KEY_WOW64_64KEY）
// 读写独立根键 HKLM\SOFTWARE\ZToolsService\NativeTrust\HighWater\<pluginId>；
// 测试构建可切换为本地文件，避免污染宿主机注册表。
class TrustStateStore final {
 public:
  explicit TrustStateStore(std::wstring test_state_file = {});

  std::optional<std::string> ReadHighWater(const std::string& plugin_id) const;
  bool UpdateHighWater(const std::string& plugin_id, const std::string& version) const;

 private:
  std::wstring test_state_file_;
  mutable std::mutex mutex_;
};

}  // namespace ztools::service

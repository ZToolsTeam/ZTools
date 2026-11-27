#pragma once

#include "../../shared/native_trust_verifier.hpp"

#include <Windows.h>

#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace ztools::service {

struct SnapshotMaterializeResult {
  bool success = false;
  std::string code;
  std::string message;
  std::wstring snapshot_dir;
  std::wstring main_snapshot_path;
  std::vector<HANDLE> locked_handles;

  SnapshotMaterializeResult() = default;
  ~SnapshotMaterializeResult();
  SnapshotMaterializeResult(const SnapshotMaterializeResult&) = delete;
  SnapshotMaterializeResult& operator=(const SnapshotMaterializeResult&) = delete;
  SnapshotMaterializeResult(SnapshotMaterializeResult&& other) noexcept;
  SnapshotMaterializeResult& operator=(SnapshotMaterializeResult&& other) noexcept;
};

// 独立 ACL 严格复核函数（与安装器 IsServiceOnlyDirectorySecurityDescriptorSafe 规则对齐，便于单测直接验证）
bool IsServiceOnlyDirectorySecurityDescriptorSafe(PSECURITY_DESCRIPTOR sd) noexcept;
bool IsServiceOnlyDirectoryAclSafe(const std::wstring& path) noexcept;
bool IsGlobalProtectedParentAclSafe(const std::wstring& path) noexcept;

// SYSTEM 独占特权执行快照管理器（§3.6）：
// 生产目录为 %ProgramData%\ZTools\Service\TrustedSnapshots（通过 SHGetKnownFolderPath 获取）；
// 所有快照创建、复核、重建与 GC 均由内部互斥锁串行保护。
class TrustedSnapshotManager final {
 public:
  explicit TrustedSnapshotManager(std::wstring test_snapshot_root = {}, bool eager_init = true);

  // 校验（或在缺失时创建）受保护快照根目录；若目录已存在但 ACL/重解析点不合规，直接拒绝且不做隔离修复
  bool EnsureRootReady() const;
  bool root_ready() const noexcept;
  const std::wstring& snapshot_root() const noexcept { return snapshot_root_; }

  // 暴露静态 ACL 严格复核入口，供外部模块与单元测试直接调用
  static bool IsServiceOnlyDirectorySecurityDescriptorSafe(PSECURITY_DESCRIPTOR sd) noexcept;
  static bool IsServiceOnlyDirectoryAclSafe(const std::wstring& path) noexcept;

  // 从已锁定的源文件句柄物化（或校验复用）执行快照，并返回锁定后的快照句柄
  SnapshotMaterializeResult PrepareSnapshot(
    const native_trust::VerifyResult& verified) const;

  // 在互斥锁保护下清理旧快照，保留当前快照、上一个快照以及所有活跃会话正在引用的快照目录
  void GarbageCollect(
    const std::string& plugin_id,
    const std::wstring& current_snapshot_dir,
    const std::set<std::wstring>& active_snapshot_dirs) const;

  // 启动期全插件快照 GC：遍历 snapshot_root_ 下所有插件目录（跳过重解析点），每插件保留最新 2 个快照
  void GarbageCollectAllOnStartup() const;

 private:
  bool ResolveAndVerifyRootLocked() const;

  std::wstring test_snapshot_root_;
  mutable std::mutex mutex_;
  mutable std::wstring snapshot_root_;
  mutable bool root_ready_ = false;
};

}  // namespace ztools::service

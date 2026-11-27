#pragma once

#include "../../shared/native_trust_verifier.hpp"
#include "ztools_service/trust_state_store.hpp"
#include "ztools_service/trusted_snapshot.hpp"

#include <Windows.h>

#include <optional>
#include <set>
#include <string>
#include <vector>

namespace ztools::service {

struct PrivilegedDllPathConfig {
  std::wstring data_root;
  std::wstring snapshot_root_override;
  std::wstring trust_state_file_override;
  ztools::native_trust::TestTrustOverrides test_overrides;
};

struct PrivilegedDllCheckResult {
  bool success = false;
  std::string code;
  std::string message;
};

struct PrivilegedDllResolveResult {
  bool success = false;
  std::string code;
  std::string message;
  std::string plugin_id;
  std::string plugin_version;
  std::wstring snapshot_dir;
  // 快照内的主 DLL 绝对路径（由 SYSTEM 从受保护快照目录加载）
  std::wstring path;
  std::set<std::string> allowed_functions;
  // 快照内全部已锁定文件句柄（main / dependency / helper），将在加载成功后转移给 PrivilegedDllSession
  std::vector<HANDLE> locked_handles;

  PrivilegedDllResolveResult() = default;
  ~PrivilegedDllResolveResult();
  PrivilegedDllResolveResult(const PrivilegedDllResolveResult&) = delete;
  PrivilegedDllResolveResult& operator=(const PrivilegedDllResolveResult&) = delete;
  PrivilegedDllResolveResult(PrivilegedDllResolveResult&& other) noexcept;
  PrivilegedDllResolveResult& operator=(PrivilegedDllResolveResult&& other) noexcept;
};

bool ReadInstalledPrivilegedDllPathConfig(
  const std::wstring& data_root,
  PrivilegedDllPathConfig* config,
  DWORD* error) noexcept;

class PrivilegedDllResolver final {
 public:
  explicit PrivilegedDllResolver(PrivilegedDllPathConfig config);
  ~PrivilegedDllResolver();

  PrivilegedDllResolver(const PrivilegedDllResolver&) = delete;
  PrivilegedDllResolver& operator=(const PrivilegedDllResolver&) = delete;

  // data_root 合法 && (存在特权公钥 || 允许旧版未签名特权插件兼容) && 快照根目录复核通过
  bool trusted() const noexcept;
  const std::wstring& snapshot_root() const noexcept;

  PrivilegedDllCheckResult Check(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::string& function_name) const;
  PrivilegedDllResolveResult Resolve(
    const std::string& plugin_id,
    const std::string& dll_id,
    const std::optional<std::string>& function_name) const;

  // 加载成功后更新特权高水位并对历史快照执行 GC（避让当前活跃会话）
  void CommitSuccessfulLoad(
    const std::string& plugin_id,
    const std::string& plugin_version,
    const std::wstring& current_snapshot_dir,
    const std::set<std::wstring>& active_snapshot_dirs) const;

 private:
  PrivilegedDllPathConfig config_;
  ztools::native_trust::TrustBundle bundle_;
  TrustedSnapshotManager snapshot_manager_;
  TrustStateStore state_store_;
  bool data_root_valid_ = false;
  bool has_privileged_key_ = false;
  bool allow_legacy_ = true;
};

}  // namespace ztools::service

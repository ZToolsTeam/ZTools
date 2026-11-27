#pragma once

#include <algorithm>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace ztools::native_trust {

struct SemVer {
  std::uint64_t major = 0;
  std::uint64_t minor = 0;
  std::uint64_t patch = 0;
  std::vector<std::string> prerelease;
};

namespace detail {

inline bool ParseNonNegativeSemVerPart(std::string_view segment, std::uint64_t& value) noexcept {
  if (segment.empty() || segment.size() > 16) return false;
  if (segment.size() > 1 && segment[0] == '0') return false;
  std::uint64_t acc = 0;
  for (const char ch : segment) {
    if (ch < '0' || ch > '9') return false;
    acc = acc * 10ULL + static_cast<std::uint64_t>(ch - '0');
  }
  value = acc;
  return true;
}

inline bool IsAllDigits(std::string_view segment) noexcept {
  if (segment.empty()) return false;
  for (const char ch : segment) {
    if (ch < '0' || ch > '9') return false;
  }
  return true;
}

}  // namespace detail

inline bool ParseSemVer(std::string_view text, SemVer& out) {
  out = SemVer{};
  if (text.empty() || text.size() > 128) return false;
  const std::size_t dash = text.find('-');
  const std::string_view core = dash == std::string_view::npos ? text : text.substr(0, dash);
  const std::size_t dot1 = core.find('.');
  if (dot1 == std::string_view::npos) return false;
  const std::size_t dot2 = core.find('.', dot1 + 1);
  if (dot2 == std::string_view::npos) return false;
  if (core.find('.', dot2 + 1) != std::string_view::npos) return false;

  if (!detail::ParseNonNegativeSemVerPart(core.substr(0, dot1), out.major) ||
      !detail::ParseNonNegativeSemVerPart(core.substr(dot1 + 1, dot2 - dot1 - 1), out.minor) ||
      !detail::ParseNonNegativeSemVerPart(core.substr(dot2 + 1), out.patch)) {
    return false;
  }

  if (dash != std::string_view::npos) {
    const std::string_view pre = text.substr(dash + 1);
    if (pre.empty()) return false;
    std::size_t offset = 0;
    while (offset <= pre.size()) {
      const std::size_t dot = pre.find('.', offset);
      const std::string_view part = pre.substr(
        offset, dot == std::string_view::npos ? std::string_view::npos : dot - offset);
      if (part.empty()) return false;
      for (const char ch : part) {
        const bool ok = (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') ||
          (ch >= 'a' && ch <= 'z') || ch == '-';
        if (!ok) return false;
      }
      if (detail::IsAllDigits(part) && part.size() > 1 && part[0] == '0') return false;
      out.prerelease.emplace_back(part);
      if (dot == std::string_view::npos) break;
      offset = dot + 1;
    }
  }
  return true;
}

inline int CompareSemVer(const SemVer& left, const SemVer& right) noexcept {
  if (left.major != right.major) return left.major < right.major ? -1 : 1;
  if (left.minor != right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch != right.patch) return left.patch < right.patch ? -1 : 1;
  if (left.prerelease.empty() && right.prerelease.empty()) return 0;
  if (left.prerelease.empty()) return 1;
  if (right.prerelease.empty()) return -1;
  const std::size_t count = std::max(left.prerelease.size(), right.prerelease.size());
  for (std::size_t i = 0; i < count; ++i) {
    if (i >= left.prerelease.size()) return -1;
    if (i >= right.prerelease.size()) return 1;
    const std::string& a = left.prerelease[i];
    const std::string& b = right.prerelease[i];
    if (a == b) continue;
    const bool a_num = detail::IsAllDigits(a);
    const bool b_num = detail::IsAllDigits(b);
    if (a_num && b_num) {
      std::uint64_t va = 0;
      std::uint64_t vb = 0;
      if (detail::ParseNonNegativeSemVerPart(a, va) &&
          detail::ParseNonNegativeSemVerPart(b, vb)) {
        return va < vb ? -1 : 1;
      }
    }
    if (a_num != b_num) return a_num ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

}  // namespace ztools::native_trust

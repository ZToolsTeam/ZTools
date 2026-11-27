#pragma once

#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <ctime>
#include <string>
#include <string_view>
#include <vector>

namespace ztools::indexer {

// Engine-level content-type bitmask aligned with ZTools file categories
enum ContentTypeMask : uint16_t {
  kContentTypeAll      = 0,
  kContentTypeFolder   = 1u << 0, // 1
  kContentTypeDocument = 1u << 1, // 2
  kContentTypeImage    = 1u << 2, // 4
  kContentTypeVideo    = 1u << 3, // 8
  kContentTypeAudio    = 1u << 4, // 16
  kContentTypeArchive  = 1u << 5, // 32
  kContentTypeCode     = 1u << 6, // 64
  kContentTypeApp      = 1u << 7, // 128
  kContentTypeOther    = 1u << 8, // 256
  kContentTypeMedia    = kContentTypeVideo | kContentTypeAudio
};

enum class SearchKind : uint8_t {
  All = 0,
  File = 1,
  Directory = 2
};

enum class SearchSortBy : uint8_t {
  Relevance = 0,
  NameAsc = 1,
  NameDesc = 2,
  SizeDesc = 3,
  SizeAsc = 4,
  MtimeDesc = 5,
  MtimeAsc = 6
};

struct SearchOptions {
  size_t limit = 50;
  size_t offset = 0;
  uint16_t content_type_mask = kContentTypeAll;
  SearchKind kind = SearchKind::All;
  SearchSortBy sort_by = SearchSortBy::Relevance;
  bool include_hidden = true;
  std::string path_prefix;
};

inline uint16_t ClassifyContentType(std::string_view ext_lower, bool is_dir) noexcept {
  if (is_dir) return kContentTypeFolder;
  if (ext_lower.empty()) return kContentTypeOther;

  auto is_one_of = [&](std::initializer_list<const char*> list) {
    for (const char* item : list) {
      if (ext_lower == item) return true;
    }
    return false;
  };

  if (is_one_of({"doc", "docx", "pdf", "txt", "md", "markdown", "xls", "xlsx", "ppt", "pptx", "csv", "rtf", "odt", "ods", "pages", "numbers", "key"})) {
    return kContentTypeDocument;
  }
  if (is_one_of({"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tif", "tiff", "psd", "raw", "heic", "heif", "avif"})) {
    return kContentTypeImage;
  }
  if (is_one_of({"mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "rmvb"})) {
    return kContentTypeVideo;
  }
  if (is_one_of({"mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "ape"})) {
    return kContentTypeAudio;
  }
  if (is_one_of({"zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "cab", "dmg", "tgz"})) {
    return kContentTypeArchive;
  }
  if (is_one_of({
        "js", "ts", "tsx", "jsx", "mjs", "cjs", "vue", "html", "htm", "css", "scss", "less", "json",
        "py", "rs", "cpp", "cc", "cxx", "c", "h", "hpp", "go", "java", "kt", "swift", "sql",
        "sh", "bash", "zsh", "ps1", "bat", "cmd", "yaml", "yml", "xml", "toml", "ini", "conf", "log"
      })) {
    return kContentTypeCode;
  }
  if (is_one_of({"exe", "msi", "appx", "msix", "pkg", "apk", "lnk", "app"})) {
    return kContentTypeApp;
  }
  return kContentTypeOther;
}

inline uint16_t ParseContentTypeMaskString(std::string_view s) noexcept {
  if (s.empty() || s == "all") return kContentTypeAll;
  if (s == "folder" || s == "directory") return kContentTypeFolder;
  if (s == "document") return kContentTypeDocument;
  if (s == "image") return kContentTypeImage;
  if (s == "video") return kContentTypeVideo;
  if (s == "audio") return kContentTypeAudio;
  if (s == "media") return kContentTypeMedia;
  if (s == "archive") return kContentTypeArchive;
  if (s == "code") return kContentTypeCode;
  if (s == "app") return kContentTypeApp;
  if (s == "other") return kContentTypeOther;
  return kContentTypeAll;
}

inline SearchKind ParseSearchKind(std::string_view s) noexcept {
  if (s == "file") return SearchKind::File;
  if (s == "directory" || s == "folder") return SearchKind::Directory;
  return SearchKind::All;
}

inline SearchSortBy ParseSearchSortBy(std::string_view s) noexcept {
  if (s == "name-asc" || s == "name") return SearchSortBy::NameAsc;
  if (s == "name-desc") return SearchSortBy::NameDesc;
  if (s == "size-desc") return SearchSortBy::SizeDesc;
  if (s == "size-asc") return SearchSortBy::SizeAsc;
  if (s == "mtime-desc" || s == "modifiedDate") return SearchSortBy::MtimeDesc;
  if (s == "mtime-asc") return SearchSortBy::MtimeAsc;
  return SearchSortBy::Relevance;
}

// Convert Windows FILETIME (100ns since 1601) or Unix seconds/ms to Unix milliseconds
inline uint64_t NormalizeMtimeToUnixMs(uint64_t raw) noexcept {
  if (raw == 0) return 0;
  if (raw >= 1000000000000000ULL) {
    // Windows FILETIME
    const uint64_t ms = raw / 10000ULL;
    constexpr uint64_t kEpochDiffMs = 11644473600000ULL;
    return (ms > kEpochDiffMs) ? (ms - kEpochDiffMs) : 0;
  }
  if (raw < 100000000000ULL) {
    return raw * 1000ULL;
  }
  return raw;
}

// -----------------------------------------------------------------------------
// Standard O(N+M) iterative Glob matcher supporting '*' and '?'
// -----------------------------------------------------------------------------
inline bool MatchGlob(std::string_view pattern, std::string_view text) noexcept {
  size_t p = 0;
  size_t t = 0;
  size_t star_p = std::string_view::npos;
  size_t star_t = 0;

  while (t < text.size()) {
    if (p < pattern.size() && (pattern[p] == '?' || pattern[p] == text[t])) {
      ++p;
      ++t;
    } else if (p < pattern.size() && pattern[p] == '*') {
      star_p = p++;
      star_t = t;
    } else if (star_p != std::string_view::npos) {
      p = star_p + 1;
      t = ++star_t;
    } else {
      return false;
    }
  }
  while (p < pattern.size() && pattern[p] == '*') {
    ++p;
  }
  return p == pattern.size();
}

// -----------------------------------------------------------------------------
// Mature fzf v2 (Modified Smith-Waterman) Fuzzy Matcher (MIT-licensed algorithm)
// Ref: junegunn/fzf src/algo/algo.go (FuzzyMatchV2)
// Fast linear subsequence pre-check rejects non-matches in O(N) before DP.
// -----------------------------------------------------------------------------
namespace fzf_v2 {

constexpr int kScoreMatch = 16;
constexpr int kScoreGapStart = -3;
constexpr int kScoreGapExtension = -1;
constexpr int kBonusBoundary = kScoreMatch / 2;              // 8
constexpr int kBonusNonWord = kScoreMatch / 2;               // 8
constexpr int kBonusCamel123 = kBonusBoundary + kScoreGapExtension; // 7
constexpr int kBonusConsecutive = -(kScoreGapStart + kScoreGapExtension); // 4
constexpr int kBonusFirstCharMultiplier = 2;
constexpr int kBonusBoundaryWhite = kBonusBoundary + 2;      // 10
constexpr int kBonusBoundaryDelimiter = kBonusBoundary + 1;  // 9

enum CharClass : uint8_t {
  kCharWhite = 0,
  kCharNonWord = 1,
  kCharDelimiter = 2,
  kCharLower = 3,
  kCharUpper = 4,
  kCharDigit = 5
};

inline CharClass ClassifyChar(unsigned char c) noexcept {
  if (c >= 'a' && c <= 'z') return kCharLower;
  if (c >= 'A' && c <= 'Z') return kCharUpper;
  if (c >= '0' && c <= '9') return kCharDigit;
  if (c == ' ' || c == '\t' || c == '\n' || c == '\r') return kCharWhite;
  if (c == '/' || c == '\\' || c == ':' || c == ';' || c == '|' || c == ',' || c == '-' || c == '_' || c == '.') {
    return kCharDelimiter;
  }
  return kCharNonWord;
}

inline int BonusFor(CharClass prev, CharClass curr) noexcept {
  if (curr > kCharNonWord) {
    if (prev == kCharWhite) return kBonusBoundaryWhite;
    if (prev == kCharDelimiter) return kBonusBoundaryDelimiter;
    if (prev == kCharNonWord) return kBonusBoundary;
  }
  if ((prev == kCharLower && curr == kCharUpper) ||
      (prev != kCharDigit && curr == kCharDigit)) {
    return kBonusCamel123;
  }
  if (curr == kCharNonWord) return kBonusNonWord;
  if (curr == kCharWhite) return kBonusBoundaryWhite;
  return 0;
}

// Fast O(N) subsequence check + tighter [start, end] span for DP
inline bool FindSubsequenceBounds(
  std::string_view text_lower,
  std::string_view pattern_lower,
  size_t& out_first,
  size_t& out_last
) noexcept {
  const size_t n = text_lower.size();
  const size_t m = pattern_lower.size();
  if (m == 0 || m > n) return false;

  size_t pidx = 0;
  size_t first = 0;
  for (size_t i = 0; i < n; ++i) {
    if (text_lower[i] == pattern_lower[pidx]) {
      if (pidx == 0) first = i;
      ++pidx;
      if (pidx == m) {
        out_first = first;
        out_last = i + 1;
        return true;
      }
    }
  }
  return false;
}

// Returns score > 0 if fuzzy-matched, 0 otherwise.
// original_text is used for camelCase bonus (if same byte length as text_lower); falls back cleanly.
inline int FuzzyMatchScore(
  std::string_view original_text,
  std::string_view text_lower,
  std::string_view pattern_lower
) noexcept {
  const size_t m = pattern_lower.size();
  const size_t n = text_lower.size();
  if (m == 0 || m > n) return 0;

  size_t first_idx = 0;
  size_t last_idx = 0;
  if (!FindSubsequenceBounds(text_lower, pattern_lower, first_idx, last_idx)) {
    return 0;
  }

  // Cap DP window for ultra-long paths/patterns to guarantee sub-microsecond worst-case latency
  const size_t span = n - first_idx;
  if (m > 64 || span > 256) {
    // Fast greedy boundary-aware fallback for extreme lengths
    int score = static_cast<int>(m) * kScoreMatch;
    const size_t gap = (last_idx > first_idx + m) ? (last_idx - first_idx - m) : 0;
    score -= static_cast<int>(gap);
    return (score > 1) ? score : 1;
  }

  const bool use_orig = (original_text.size() == n);
  int16_t bonuses[256];
  int16_t prev_H[256];
  int16_t prev_C[256];
  int16_t curr_H[256];
  int16_t curr_C[256];

  CharClass prev_class = (first_idx == 0)
    ? kCharDelimiter
    : ClassifyChar(static_cast<unsigned char>(use_orig ? original_text[first_idx - 1] : text_lower[first_idx - 1]));

  for (size_t j = 0; j < span; ++j) {
    const unsigned char ch = static_cast<unsigned char>(use_orig ? original_text[first_idx + j] : text_lower[first_idx + j]);
    const CharClass curr_class = ClassifyChar(ch);
    bonuses[j] = static_cast<int16_t>(BonusFor(prev_class, curr_class));
    prev_class = curr_class;
  }

  // Rolling 2-row Smith-Waterman DP (stack-only, zero heap allocations, only touches [0..span))
  int max_score = 0;
  for (size_t i = 0; i < m; ++i) {
    const char pc = pattern_lower[i];
    int16_t row_max = 0;
    bool in_gap = false;

    for (size_t j = 0; j < span; ++j) {
      int16_t s1 = 0;
      int16_t consec = 0;

      if (text_lower[first_idx + j] == pc) {
        if (i == 0) {
          s1 = static_cast<int16_t>(kScoreMatch + bonuses[j] * kBonusFirstCharMultiplier);
          consec = 1;
        } else if (j > 0 && prev_H[j - 1] > 0) {
          int16_t diag = prev_H[j - 1];
          int16_t b = bonuses[j];
          if (prev_C[j - 1] > 0) {
            consec = static_cast<int16_t>(prev_C[j - 1] + 1);
            b = (std::max)(b, static_cast<int16_t>(kBonusConsecutive));
          } else {
            consec = 1;
          }
          s1 = static_cast<int16_t>(diag + kScoreMatch + b);
        }
      }

      int16_t s2 = 0;
      if (j > 0 && curr_H[j - 1] > 0) {
        s2 = static_cast<int16_t>(curr_H[j - 1] + (in_gap ? kScoreGapExtension : kScoreGapStart));
      }

      if (s1 > s2 && s1 > 0) {
        curr_H[j] = s1;
        curr_C[j] = consec;
        in_gap = false;
      } else if (s2 > 0) {
        curr_H[j] = s2;
        curr_C[j] = 0;
        in_gap = true;
      } else {
        curr_H[j] = 0;
        curr_C[j] = 0;
        in_gap = false;
      }

      if (curr_H[j] > row_max) row_max = curr_H[j];
    }

    if (row_max <= 0) return 0;
    if (i + 1 == m) max_score = row_max;
    std::memcpy(prev_H, curr_H, span * sizeof(int16_t));
    std::memcpy(prev_C, curr_C, span * sizeof(int16_t));
  }

  return max_score;
}

} // namespace fzf_v2

// -----------------------------------------------------------------------------
// Structured Query AST (Everything + fzf extended search syntax)
// -----------------------------------------------------------------------------
enum class ClauseKind : uint8_t {
  SmartTerm,    // plain term: exact/prefix/substring/pinyin/fuzzy + path fallback
  ExactSubstr,  // 'term or "quoted phrase"
  Prefix,       // ^term
  Suffix,       // term$
  Glob,         // contains * or ?
  PathMatch,    // contains / or \, or path:/in:
  ExtFilter,    // ext:pdf or ext:jpg;png
  KindFilter,   // file: or folder:
  SizeFilter,   // size:>10mb, size:<500k, size:1m..50m
  MtimeFilter   // dm:today, dm:7d, dm:2026-11
};

struct QueryClause {
  ClauseKind kind = ClauseKind::SmartTerm;
  bool negated = false;
  bool match_full_path = false;
  std::string value;            // normalized lowercase value (slashes unified to '/' for path)
  std::vector<std::string> exts;
  SearchKind kind_filter = SearchKind::All;
  uint64_t min_u64 = 0;
  uint64_t max_u64 = UINT64_MAX;
  uint32_t ascii_mask = 0;      // 32-bit ASCII bloom mask for fast O(1) rejection
  uint32_t cjk_mask = 0;        // 32-bit non-ASCII UTF-8 bloom mask for O(1) Chinese query rejection
  bool is_pure_ascii = true;
};

struct QueryBranch {
  std::vector<QueryClause> clauses;
};

struct ParsedQuery {
  std::vector<QueryBranch> or_branches; // Match if ANY branch succeeds (all clauses inside a branch are AND)
  std::string raw_lower;
  bool is_empty = true;
  bool has_positive_term = false;
};

inline std::string ToLowerAsciiAndSlashes(std::string_view s, bool unify_slashes = false) {
  std::string out;
  out.reserve(s.size());
  for (char c : s) {
    if (unify_slashes && c == '\\') {
      out.push_back('/');
    } else if (c >= 'A' && c <= 'Z') {
      out.push_back(static_cast<char>(c + ('a' - 'A')));
    } else {
      out.push_back(c);
    }
  }
  return out;
}

inline bool IsPureAsciiLower(std::string_view s) noexcept {
  for (unsigned char c : s) {
    if (c >= 0x80) return false;
  }
  return true;
}

inline bool ParseSizeSpec(std::string_view raw, uint64_t& out_bytes) noexcept {
  if (raw.empty()) return false;
  size_t pos = 0;
  double num = 0.0;
  double frac = 0.1;
  bool has_digit = false;
  bool seen_dot = false;
  while (pos < raw.size()) {
    const char c = raw[pos];
    if (c >= '0' && c <= '9') {
      has_digit = true;
      if (!seen_dot) {
        num = num * 10.0 + static_cast<double>(c - '0');
      } else {
        num += static_cast<double>(c - '0') * frac;
        frac *= 0.1;
      }
      ++pos;
    } else if (c == '.' && !seen_dot) {
      seen_dot = true;
      ++pos;
    } else {
      break;
    }
  }
  if (!has_digit) return false;
  std::string_view unit = raw.substr(pos);
  uint64_t mult = 1;
  if (unit.empty() || unit == "b") mult = 1ULL;
  else if (unit == "k" || unit == "kb") mult = 1024ULL;
  else if (unit == "m" || unit == "mb") mult = 1024ULL * 1024ULL;
  else if (unit == "g" || unit == "gb") mult = 1024ULL * 1024ULL * 1024ULL;
  else if (unit == "t" || unit == "tb") mult = 1024ULL * 1024ULL * 1024ULL * 1024ULL;
  else return false;

  const double total = num * static_cast<double>(mult);
  if (total < 0.0) return false;
  out_bytes = static_cast<uint64_t>(total);
  return true;
}

inline bool ParseSizeClause(std::string_view spec, uint64_t& out_min, uint64_t& out_max) noexcept {
  out_min = 0;
  out_max = UINT64_MAX;
  if (spec.empty()) return false;

  const size_t dots = spec.find("..");
  if (dots != std::string_view::npos) {
    std::string_view left = spec.substr(0, dots);
    std::string_view right = spec.substr(dots + 2);
    if (!left.empty() && !ParseSizeSpec(left, out_min)) return false;
    if (!right.empty() && !ParseSizeSpec(right, out_max)) return false;
    return !left.empty() || !right.empty();
  }
  if (spec.starts_with(">=")) {
    return ParseSizeSpec(spec.substr(2), out_min);
  }
  if (spec.starts_with("<=")) {
    return ParseSizeSpec(spec.substr(2), out_max);
  }
  if (spec.starts_with(">")) {
    uint64_t v = 0;
    if (!ParseSizeSpec(spec.substr(1), v)) return false;
    out_min = (v < UINT64_MAX) ? (v + 1) : UINT64_MAX;
    return true;
  }
  if (spec.starts_with("<")) {
    uint64_t v = 0;
    if (!ParseSizeSpec(spec.substr(1), v)) return false;
    out_max = (v > 0) ? (v - 1) : 0;
    return true;
  }
  uint64_t exact = 0;
  if (!ParseSizeSpec(spec, exact)) return false;
  out_min = exact;
  out_max = exact;
  return true;
}

inline uint64_t NowUnixMs() noexcept {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(now).count());
}

inline bool ParseIsoDatePrefix(std::string_view s, uint64_t& start_ms, uint64_t& end_ms) noexcept {
  // Supports YYYY, YYYY-MM, YYYY-MM-DD
  int y = 0, m = 1, d = 1;
  int parts = 0;
  auto read_int = [&](size_t off, size_t len, int& out) -> bool {
    if (off + len > s.size()) return false;
    int v = 0;
    for (size_t i = 0; i < len; ++i) {
      const char c = s[off + i];
      if (c < '0' || c > '9') return false;
      v = v * 10 + (c - '0');
    }
    out = v;
    return true;
  };
  if (s.size() == 4 && read_int(0, 4, y)) {
    parts = 1;
  } else if (s.size() == 7 && s[4] == '-' && read_int(0, 4, y) && read_int(5, 2, m)) {
    parts = 2;
  } else if (s.size() == 10 && s[4] == '-' && s[7] == '-' && read_int(0, 4, y) && read_int(5, 2, m) && read_int(8, 2, d)) {
    parts = 3;
  } else {
    return false;
  }
  if (y < 1970 || m < 1 || m > 12 || d < 1 || d > 31) return false;

  std::tm tm_start{};
  tm_start.tm_year = y - 1900;
  tm_start.tm_mon = m - 1;
  tm_start.tm_mday = d;
  tm_start.tm_isdst = -1;
  const std::time_t t_start = std::mktime(&tm_start);
  if (t_start < 0) return false;

  std::tm tm_end = tm_start;
  if (parts == 1) tm_end.tm_year += 1;
  else if (parts == 2) tm_end.tm_mon += 1;
  else tm_end.tm_mday += 1;
  tm_end.tm_isdst = -1;
  const std::time_t t_end = std::mktime(&tm_end);
  if (t_end < 0) return false;

  start_ms = static_cast<uint64_t>(t_start) * 1000ULL;
  end_ms = static_cast<uint64_t>(t_end) * 1000ULL;
  return true;
}

inline bool ParseMtimeClause(std::string_view spec, uint64_t now_ms, uint64_t& out_min, uint64_t& out_max) noexcept {
  out_min = 0;
  out_max = UINT64_MAX;
  if (spec.empty()) return false;

  constexpr uint64_t kHourMs = 3600ULL * 1000ULL;
  constexpr uint64_t kDayMs = 24ULL * kHourMs;

  if (spec == "today") {
    const std::time_t t = static_cast<std::time_t>(now_ms / 1000ULL);
    std::tm local_tm{};
#ifdef _WIN32
    localtime_s(&local_tm, &t);
#else
    localtime_r(&t, &local_tm);
#endif
    local_tm.tm_hour = 0;
    local_tm.tm_min = 0;
    local_tm.tm_sec = 0;
    const std::time_t start = std::mktime(&local_tm);
    if (start < 0) return false;
    out_min = static_cast<uint64_t>(start) * 1000ULL;
    return true;
  }
  if (spec == "yesterday") {
    const std::time_t t = static_cast<std::time_t>(now_ms / 1000ULL);
    std::tm local_tm{};
#ifdef _WIN32
    localtime_s(&local_tm, &t);
#else
    localtime_r(&t, &local_tm);
#endif
    local_tm.tm_hour = 0;
    local_tm.tm_min = 0;
    local_tm.tm_sec = 0;
    const std::time_t today_start = std::mktime(&local_tm);
    if (today_start < 0) return false;
    const uint64_t today_ms = static_cast<uint64_t>(today_start) * 1000ULL;
    out_min = (today_ms > kDayMs) ? (today_ms - kDayMs) : 0;
    out_max = today_ms;
    return true;
  }
  if (spec == "week" || spec == "7d") {
    out_min = (now_ms > 7ULL * kDayMs) ? (now_ms - 7ULL * kDayMs) : 0;
    return true;
  }
  if (spec == "month" || spec == "30d") {
    out_min = (now_ms > 30ULL * kDayMs) ? (now_ms - 30ULL * kDayMs) : 0;
    return true;
  }

  // Relative durations: e.g. 24h, 3d, 2w
  if (spec.size() >= 2) {
    const char unit = spec.back();
    if (unit == 'h' || unit == 'd' || unit == 'w') {
      uint64_t n = 0;
      bool ok = true;
      for (size_t i = 0; i + 1 < spec.size(); ++i) {
        if (spec[i] < '0' || spec[i] > '9') { ok = false; break; }
        n = n * 10 + static_cast<uint64_t>(spec[i] - '0');
      }
      if (ok && n > 0) {
        const uint64_t delta = (unit == 'h') ? (n * kHourMs) : (unit == 'd') ? (n * kDayMs) : (n * 7ULL * kDayMs);
        out_min = (now_ms > delta) ? (now_ms - delta) : 0;
        return true;
      }
    }
  }

  if (spec.starts_with(">=")) {
    uint64_t s = 0, e = 0;
    if (!ParseIsoDatePrefix(spec.substr(2), s, e)) return false;
    out_min = s;
    return true;
  }
  if (spec.starts_with(">")) {
    uint64_t s = 0, e = 0;
    if (!ParseIsoDatePrefix(spec.substr(1), s, e)) return false;
    out_min = e;
    return true;
  }
  if (spec.starts_with("<=")) {
    uint64_t s = 0, e = 0;
    if (!ParseIsoDatePrefix(spec.substr(2), s, e)) return false;
    out_max = e;
    return true;
  }
  if (spec.starts_with("<")) {
    uint64_t s = 0, e = 0;
    if (!ParseIsoDatePrefix(spec.substr(1), s, e)) return false;
    out_max = s;
    return true;
  }
  uint64_t s = 0, e = 0;
  if (ParseIsoDatePrefix(spec, s, e)) {
    out_min = s;
    out_max = e;
    return true;
  }
  return false;
}

inline ParsedQuery ParseSearchQuery(std::string_view raw_query, uint64_t now_ms = 0) {
  ParsedQuery parsed;
  if (now_ms == 0) now_ms = NowUnixMs();

  // Trim whitespace
  while (!raw_query.empty() && std::isspace(static_cast<unsigned char>(raw_query.front()))) raw_query.remove_prefix(1);
  while (!raw_query.empty() && std::isspace(static_cast<unsigned char>(raw_query.back()))) raw_query.remove_suffix(1);
  if (raw_query.empty()) {
    return parsed;
  }

  parsed.is_empty = false;
  parsed.raw_lower = ToLowerAsciiAndSlashes(raw_query, false);

  struct RawToken {
    std::string text;
    bool quoted = false;
  };
  std::vector<RawToken> tokens;
  size_t i = 0;
  while (i < raw_query.size()) {
    while (i < raw_query.size() && std::isspace(static_cast<unsigned char>(raw_query[i]))) ++i;
    if (i >= raw_query.size()) break;

    if (raw_query[i] == '|') {
      tokens.push_back({"|", false});
      ++i;
      continue;
    }

    if (raw_query[i] == '"') {
      ++i;
      std::string tok;
      while (i < raw_query.size() && raw_query[i] != '"') {
        tok.push_back(raw_query[i++]);
      }
      if (i < raw_query.size() && raw_query[i] == '"') ++i;
      if (!tok.empty()) tokens.push_back({std::move(tok), true});
      continue;
    }

    // Handle negated quoted phrase like !"foo bar" or -"foo bar"
    if ((raw_query[i] == '!' || raw_query[i] == '-') && i + 1 < raw_query.size() && raw_query[i + 1] == '"') {
      const char prefix = raw_query[i];
      i += 2;
      std::string tok;
      tok.push_back(prefix);
      while (i < raw_query.size() && raw_query[i] != '"') {
        tok.push_back(raw_query[i++]);
      }
      if (i < raw_query.size() && raw_query[i] == '"') ++i;
      if (tok.size() > 1) tokens.push_back({std::move(tok), true});
      continue;
    }

    std::string tok;
    while (i < raw_query.size() && !std::isspace(static_cast<unsigned char>(raw_query[i]))) {
      if (raw_query[i] == '|' && !tok.empty()) break;
      tok.push_back(raw_query[i++]);
    }
    if (!tok.empty()) tokens.push_back({std::move(tok), false});
  }

  QueryBranch current_branch;
  for (const auto& rtok : tokens) {
    if (!rtok.quoted && rtok.text == "|") {
      if (!current_branch.clauses.empty()) {
        parsed.or_branches.push_back(std::move(current_branch));
        current_branch = QueryBranch{};
      }
      continue;
    }

    QueryClause clause;
    std::string_view sv = rtok.text;

    if (rtok.quoted) {
      if ((sv.starts_with("!") || sv.starts_with("-")) && sv.size() > 1) {
        clause.negated = true;
        sv.remove_prefix(1);
      }
      clause.kind = ClauseKind::ExactSubstr;
      clause.value = ToLowerAsciiAndSlashes(sv, false);
      clause.match_full_path = (clause.value.find('/') != std::string::npos || clause.value.find('\\') != std::string::npos);
      if (clause.match_full_path) {
        clause.value = ToLowerAsciiAndSlashes(sv, true);
      }
      clause.is_pure_ascii = IsPureAsciiLower(clause.value);
      clause.ascii_mask = PinyinEngine::ComputeAsciiBitmask(clause.value);
      clause.cjk_mask = clause.is_pure_ascii ? 0u : PinyinEngine::ComputeCjkBitmask(clause.value);
      if (!clause.value.empty()) {
        if (!clause.negated) parsed.has_positive_term = true;
        current_branch.clauses.push_back(std::move(clause));
      }
      continue;
    }

    // Negation: !term or -term (only when length > 1, so lone "-" searches literal "-")
    if ((sv.starts_with("!") || sv.starts_with("-")) && sv.size() > 1) {
      clause.negated = true;
      sv.remove_prefix(1);
    }

    const std::string lower = ToLowerAsciiAndSlashes(sv, false);
    if (lower.empty()) continue;

    // Structured filters
    if (lower == "file:" || lower == "type:file") {
      clause.kind = ClauseKind::KindFilter;
      clause.kind_filter = SearchKind::File;
      current_branch.clauses.push_back(std::move(clause));
      continue;
    }
    if (lower == "folder:" || lower == "dir:" || lower == "type:folder" || lower == "type:dir") {
      clause.kind = ClauseKind::KindFilter;
      clause.kind_filter = SearchKind::Directory;
      current_branch.clauses.push_back(std::move(clause));
      continue;
    }
    if (lower.starts_with("ext:") && lower.size() > 4) {
      clause.kind = ClauseKind::ExtFilter;
      std::string_view rest = std::string_view(lower).substr(4);
      size_t start = 0;
      while (start < rest.size()) {
        size_t sep = rest.find_first_of(";,", start);
        std::string_view part = (sep == std::string_view::npos) ? rest.substr(start) : rest.substr(start, sep - start);
        while (!part.empty() && part.front() == '.') part.remove_prefix(1);
        if (!part.empty()) clause.exts.emplace_back(part);
        if (sep == std::string_view::npos) break;
        start = sep + 1;
      }
      if (!clause.exts.empty()) {
        if (!clause.negated) parsed.has_positive_term = true;
        current_branch.clauses.push_back(std::move(clause));
      }
      continue;
    }
    if ((lower.starts_with("path:") && lower.size() > 5) || (lower.starts_with("in:") && lower.size() > 3)) {
      const size_t prefix_len = lower.starts_with("path:") ? 5 : 3;
      clause.kind = ClauseKind::PathMatch;
      clause.match_full_path = true;
      clause.value = ToLowerAsciiAndSlashes(sv.substr(prefix_len), true);
      clause.is_pure_ascii = IsPureAsciiLower(clause.value);
      clause.ascii_mask = PinyinEngine::ComputeAsciiBitmask(clause.value);
      clause.cjk_mask = clause.is_pure_ascii ? 0u : PinyinEngine::ComputeCjkBitmask(clause.value);
      if (!clause.negated) parsed.has_positive_term = true;
      current_branch.clauses.push_back(std::move(clause));
      continue;
    }
    if (lower.starts_with("size:") && lower.size() > 5) {
      uint64_t mn = 0, mx = UINT64_MAX;
      if (ParseSizeClause(std::string_view(lower).substr(5), mn, mx)) {
        clause.kind = ClauseKind::SizeFilter;
        clause.min_u64 = mn;
        clause.max_u64 = mx;
        if (!clause.negated) parsed.has_positive_term = true;
        current_branch.clauses.push_back(std::move(clause));
        continue;
      }
    }
    if ((lower.starts_with("dm:") && lower.size() > 3) || (lower.starts_with("modified:") && lower.size() > 9)) {
      const size_t prefix_len = lower.starts_with("dm:") ? 3 : 9;
      uint64_t mn = 0, mx = UINT64_MAX;
      if (ParseMtimeClause(std::string_view(lower).substr(prefix_len), now_ms, mn, mx)) {
        clause.kind = ClauseKind::MtimeFilter;
        clause.min_u64 = mn;
        clause.max_u64 = mx;
        if (!clause.negated) parsed.has_positive_term = true;
        current_branch.clauses.push_back(std::move(clause));
        continue;
      }
    }

    // fzf-style exact / prefix / suffix markers
    if (lower.starts_with("'") && lower.size() > 1) {
      clause.kind = ClauseKind::ExactSubstr;
      clause.value = lower.substr(1);
    } else if (lower.starts_with("^") && lower.size() > 1) {
      clause.kind = ClauseKind::Prefix;
      clause.value = lower.substr(1);
    } else if (lower.ends_with("$") && lower.size() > 1) {
      clause.kind = ClauseKind::Suffix;
      clause.value = lower.substr(0, lower.size() - 1);
    } else if (lower.find('*') != std::string::npos || lower.find('?') != std::string::npos) {
      clause.kind = ClauseKind::Glob;
      clause.match_full_path = (lower.find('/') != std::string::npos || lower.find('\\') != std::string::npos);
      clause.value = clause.match_full_path ? ToLowerAsciiAndSlashes(sv, true) : lower;
    } else if (lower.find('/') != std::string::npos || lower.find('\\') != std::string::npos ||
               (lower.size() >= 2 && lower[1] == ':' && lower[0] >= 'a' && lower[0] <= 'z')) {
      clause.kind = ClauseKind::PathMatch;
      clause.match_full_path = true;
      clause.value = ToLowerAsciiAndSlashes(sv, true);
    } else {
      clause.kind = ClauseKind::SmartTerm;
      clause.value = lower;
    }

    clause.is_pure_ascii = IsPureAsciiLower(clause.value);
    // For Glob, only non-wildcard characters belong in the bloom bitmask!
    if (clause.kind == ClauseKind::Glob) {
      std::string lit;
      lit.reserve(clause.value.size());
      for (char c : clause.value) {
        if (c != '*' && c != '?') lit.push_back(c);
      }
      clause.ascii_mask = PinyinEngine::ComputeAsciiBitmask(lit);
      clause.cjk_mask = clause.is_pure_ascii ? 0u : PinyinEngine::ComputeCjkBitmask(lit);
    } else {
      clause.ascii_mask = PinyinEngine::ComputeAsciiBitmask(clause.value);
      clause.cjk_mask = clause.is_pure_ascii ? 0u : PinyinEngine::ComputeCjkBitmask(clause.value);
    }

    if (!clause.negated) parsed.has_positive_term = true;
    current_branch.clauses.push_back(std::move(clause));
  }

  if (!current_branch.clauses.empty()) {
    parsed.or_branches.push_back(std::move(current_branch));
  }
  if (parsed.or_branches.empty()) {
    parsed.is_empty = true;
  }
  return parsed;
}

// Per-thread scratch memo for adjacent entries sharing the same parent directory (100% exact, zero approximation)
struct DirMatchMemo {
  std::string_view last_dir;
  int last_clause_idx = -1;
  bool last_hit = false;
  int last_score = 0;
};

// Evaluates a single entry against a ParsedQuery; returns true if matched and writes relevance score.
template <typename EntryT>
inline bool EvaluateEntryAgainstQuery(
  const EntryT& e,
  const ParsedQuery& pq,
  int& out_score,
  DirMatchMemo* dir_memo = nullptr
) noexcept {
  if (pq.is_empty) {
    out_score = 0;
    return true;
  }

  // Extract parent directory slice from path_lower (excludes filename)
  const size_t dir_len = (e.path_lower.size() > e.name_lower.size())
    ? (e.path_lower.size() - e.name_lower.size())
    : 0;
  const std::string_view dir_view(e.path_lower.data(), dir_len);

  auto eval_clause = [&](const QueryClause& c, int clause_uid, int& clause_score) -> bool {
    clause_score = 0;
    switch (c.kind) {
      case ClauseKind::KindFilter:
        if (c.kind_filter == SearchKind::Directory) return e.is_dir;
        if (c.kind_filter == SearchKind::File) return !e.is_dir;
        return true;

      case ClauseKind::ExtFilter:
        if (e.is_dir || e.ext_lower.empty()) return false;
        for (const auto& ext : c.exts) {
          if (e.ext_lower == ext) {
            clause_score = 450;
            return true;
          }
        }
        return false;

      case ClauseKind::SizeFilter:
        if (e.is_dir) return false;
        if (e.size >= c.min_u64 && e.size <= c.max_u64) {
          clause_score = 200;
          return true;
        }
        return false;

      case ClauseKind::MtimeFilter: {
        const uint64_t ms = e.mtime_ms;
        if (ms > 0 && ms >= c.min_u64 && ms <= c.max_u64) {
          clause_score = 200;
          return true;
        }
        return false;
      }

      case ClauseKind::ExactSubstr: {
        const std::string& hay = c.match_full_path ? e.path_lower : e.name_lower;
        const uint32_t hay_mask = c.match_full_path ? e.path_mask : e.name_mask;
        if ((hay_mask & c.ascii_mask) != c.ascii_mask) return false;
        const size_t pos = hay.find(c.value);
        if (pos == std::string::npos) return false;
        clause_score = (pos == 0) ? 900 : 600;
        return true;
      }

      case ClauseKind::Prefix: {
        if ((e.name_mask & c.ascii_mask) != c.ascii_mask) return false;
        if (e.name_lower.size() < c.value.size()) return false;
        if (e.name_lower.compare(0, c.value.size(), c.value) == 0) {
          clause_score = (e.name_lower.size() == c.value.size()) ? 1200 : 850;
          return true;
        }
        return false;
      }

      case ClauseKind::Suffix: {
        if ((e.name_mask & c.ascii_mask) != c.ascii_mask) return false;
        if (e.name_lower.size() < c.value.size()) return false;
        if (e.name_lower.compare(e.name_lower.size() - c.value.size(), c.value.size(), c.value) == 0) {
          clause_score = 750;
          return true;
        }
        return false;
      }

      case ClauseKind::Glob: {
        const std::string& hay = c.match_full_path ? e.path_lower : e.name_lower;
        const uint32_t hay_mask = c.match_full_path ? e.path_mask : e.name_mask;
        if ((hay_mask & c.ascii_mask) != c.ascii_mask) return false;
        if (MatchGlob(c.value, hay)) {
          clause_score = 700;
          return true;
        }
        return false;
      }

      case ClauseKind::PathMatch: {
        if ((e.path_mask & c.ascii_mask) != c.ascii_mask) return false;
        if (c.value.find('*') != std::string::npos || c.value.find('?') != std::string::npos) {
          if (MatchGlob(c.value, e.path_lower)) {
            clause_score = 650;
            return true;
          }
          return false;
        }
        const size_t pos = e.path_lower.find(c.value);
        if (pos != std::string::npos) {
          // Boost if matching near end (filename / parent folder)
          const size_t dist_from_end = e.path_lower.size() - (pos + c.value.size());
          clause_score = (dist_from_end == 0) ? 950 : 650;
          return true;
        }
        return false;
      }

      case ClauseKind::SmartTerm: {
        // Ultra-fast single-instruction bloom rejection across ASCII + CJK/Unicode
        if ((e.combined_mask & c.ascii_mask) != c.ascii_mask) {
          return false;
        }
        if (c.cjk_mask != 0 && ((e.name_cjk_mask | e.path_cjk_mask) & c.cjk_mask) != c.cjk_mask) {
          return false;
        }

        // 1. Exact filename match (with or without extension)
        if (e.name_lower == c.value) {
          clause_score = 1500;
          return true;
        }
        if (!e.ext_lower.empty() && e.name_lower.size() == c.value.size() + 1 + e.ext_lower.size() &&
            e.name_lower[c.value.size()] == '.' &&
            e.name_lower.compare(0, c.value.size(), c.value) == 0) {
          clause_score = 1350;
          return true;
        }

        // 1b. Exact extension match (e.g. "fsearch ts" strongly favors *.ts over tsconfig*.json)
        if (!e.ext_lower.empty() && e.ext_lower == c.value) {
          clause_score = 980;
          return true;
        }

        // 2. Prefix / substring on filename
        if ((e.name_mask & c.ascii_mask) == c.ascii_mask) {
          const size_t pos = e.name_lower.find(c.value);
          if (pos != std::string::npos) {
            if (pos == 0) {
              clause_score = 1000;
            } else {
              const char prev = e.name_lower[pos - 1];
              const bool at_boundary = (prev == ' ' || prev == '_' || prev == '-' || prev == '.');
              clause_score = at_boundary ? 820 : 700;
            }
            return true;
          }
        }

        // 3. Pinyin & acronym match (for ASCII queries against Chinese/camelCase filenames)
        if (c.is_pure_ascii && (e.pinyin_mask & c.ascii_mask) == c.ascii_mask) {
          if (e.acronym == c.value) {
            clause_score = (c.value.size() >= 3) ? 920 : 760;
            return true;
          }
          if (e.pinyin_full == c.value) {
            clause_score = 940;
            return true;
          }
          if (e.acronym.size() >= c.value.size() && e.acronym.compare(0, c.value.size(), c.value) == 0) {
            clause_score = 720;
            return true;
          }
          if (e.pinyin_full.size() >= c.value.size() && e.pinyin_full.compare(0, c.value.size(), c.value) == 0) {
            clause_score = 680;
            return true;
          }
          if (e.pinyin_full.find(c.value) != std::string::npos || e.acronym.find(c.value) != std::string::npos) {
            clause_score = 520;
            return true;
          }
        }

        // 4. fzf v2 Modified Smith-Waterman fuzzy match on filename (for >= 2 char terms)
        if (c.value.size() >= 2 && (e.name_mask & c.ascii_mask) == c.ascii_mask) {
          const int fzf_score = fzf_v2::FuzzyMatchScore(e.name, e.name_lower, c.value);
          // Reject ultra-sparse accidental scattered matches on >= 4-char patterns (e.g. random letters across 30+ chars)
          const int min_quality = (c.value.size() >= 4) ? static_cast<int>(c.value.size()) * 14 : 1;
          if (fzf_score >= min_quality) {
            clause_score = 260 + (std::min)(460, fzf_score * 2);
            return true;
          }
        }

        // 5. Parent directory substring match (memoized across adjacent entries in the same directory)
        if (dir_len >= c.value.size() && (e.path_mask & c.ascii_mask) == c.ascii_mask) {
          if (dir_memo && dir_memo->last_clause_idx == clause_uid && dir_memo->last_dir == dir_view) {
            if (dir_memo->last_hit) {
              clause_score = dir_memo->last_score;
              return true;
            }
            return false;
          }
          const size_t pos = dir_view.find(c.value);
          const bool matched_dir = (pos != std::string_view::npos);
          const int dscore = matched_dir ? ((pos == 0 || dir_view[pos - 1] == '/') ? 360 : 240) : 0;
          if (dir_memo) {
            dir_memo->last_dir = dir_view;
            dir_memo->last_clause_idx = clause_uid;
            dir_memo->last_hit = matched_dir;
            dir_memo->last_score = dscore;
          }
          if (matched_dir) {
            clause_score = dscore;
            return true;
          }
        }
        return false;
      }
    }
    return false;
  };

  int best_branch_score = -1000000;
  bool any_branch_matched = false;
  int clause_uid = 0;

  for (const auto& branch : pq.or_branches) {
    int branch_score = 0;
    bool ok = true;
    for (const auto& clause : branch.clauses) {
      int cscore = 0;
      const bool hit = eval_clause(clause, clause_uid++, cscore);
      if (clause.negated) {
        if (hit) {
          ok = false;
          break;
        }
      } else {
        if (!hit) {
          ok = false;
          break;
        }
        branch_score += cscore;
      }
    }
    if (ok) {
      any_branch_matched = true;
      if (branch_score > best_branch_score) {
        best_branch_score = branch_score;
      }
    }
  }

  if (!any_branch_matched) return false;

  // Compact filename & shallower path preference
  const int name_penalty = static_cast<int>((std::min)(e.name.size(), size_t(100)));
  const int path_penalty = static_cast<int>((std::min)(e.path.size(), size_t(240)) / 8);
  const int dir_bonus = e.is_dir ? 25 : 0;

  out_score = best_branch_score + dir_bonus - name_penalty - path_penalty;
  return true;
}

} // namespace ztools::indexer

#pragma once

#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <queue>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "file_scanner.hpp"
#include "query_engine.hpp"

namespace ztools::indexer {

struct SearchResult {
  const FileEntry* entry = nullptr;
  int score = 0; // Higher is better
};

struct SearchResponse {
  std::vector<FileEntry> files;
  size_t total_matches = 0;
  size_t offset = 0;
  bool has_more = false;
  uint64_t elapsed_us = 0;
  double elapsed_ms = 0.0;
};

// Reusable ThreadPool to eliminate OS thread creation latency
class IndexerThreadPool {
public:
  IndexerThreadPool(size_t threads = 0) {
    if (threads == 0) threads = std::thread::hardware_concurrency();
    if (threads == 0) threads = 4;
    workers_.reserve(threads);
    for (size_t i = 0; i < threads; ++i) {
      workers_.emplace_back([this]() {
        while (true) {
          std::function<void()> task;
          {
            std::unique_lock<std::mutex> lock(mutex_);
            cv_.wait(lock, [this]() { return stop_ || !tasks_.empty(); });
            if (stop_ && tasks_.empty()) return;
            task = std::move(tasks_.front());
            tasks_.pop();
          }
          task();
        }
      });
    }
  }

  ~IndexerThreadPool() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stop_ = true;
    }
    cv_.notify_all();
    for (auto& w : workers_) {
      if (w.joinable()) w.join();
    }
  }

  size_t ThreadCount() const { return workers_.size(); }

  void ParallelFor(size_t total_items, std::function<void(size_t start, size_t end)> fn) {
    if (total_items == 0) return;
    size_t count = workers_.size();
    if (count == 0) count = 1;
    size_t chunk = (total_items + count - 1) / count;

    size_t remaining = 0;
    std::mutex done_mutex;
    std::condition_variable done_cv;

    for (size_t i = 0; i < count; ++i) {
      size_t s = i * chunk;
      size_t e = (s + chunk < total_items) ? (s + chunk) : total_items;
      if (s >= total_items) break;

      {
        std::lock_guard<std::mutex> lock(done_mutex);
        ++remaining;
      }
      {
        std::lock_guard<std::mutex> lock(mutex_);
        tasks_.push([s, e, &fn, &remaining, &done_mutex, &done_cv]() {
          fn(s, e);
          // 完成计数与等待谓词共用锁，避免最后一次通知落在检查与睡眠之间。
          std::lock_guard<std::mutex> done_lock(done_mutex);
          if (--remaining == 0) {
            done_cv.notify_all();
          }
        });
      }
      cv_.notify_one();
    }

    std::unique_lock<std::mutex> lock(done_mutex);
    done_cv.wait(lock, [&remaining]() { return remaining == 0; });
  }

private:
  std::vector<std::thread> workers_;
  std::queue<std::function<void()>> tasks_;
  std::mutex mutex_;
  std::condition_variable cv_;
  bool stop_ = false;
};

// High-throughput parallel full-corpus search index with 32-bit ASCII bloom pruning,
// fzf v2 fuzzy scoring, Everything extended query syntax, bitmask content-type filtering,
// engine-level sorting, and real offset/limit pagination.
class FlatTrieIndex {
public:
  explicit FlatTrieIndex(bool create_pool = true)
    : pool_(create_pool ? std::make_unique<IndexerThreadPool>() : nullptr) {
    Clear();
  }

  void Clear() {
    entries_.clear();
    hot_.clear();
    unique_dirs_.clear();
  }

  void SwapData(FlatTrieIndex& other) noexcept {
    entries_.swap(other.entries_);
    hot_.swap(other.hot_);
    unique_dirs_.swap(other.unique_dirs_);
  }

  void Build(std::vector<FileEntry>&& entries) {
    entries_ = std::move(entries);
    hot_.clear();
    hot_.reserve(entries_.size());
    unique_dirs_.clear();
    std::unordered_map<std::string_view, uint32_t> dir_lookup;
    dir_lookup.reserve((std::min)(entries_.size() / 4 + 16, size_t(65536)));

    // Ensure precomputed fields are populated even for entries constructed directly in tests
    for (auto& e : entries_) {
      if (e.path_lower.empty() && !e.path.empty()) {
        FinalizeFileEntryMetadata(e);
      } else if (e.combined_mask == 0 && (!e.name_lower.empty() || !e.path_lower.empty())) {
        e.ext_lower = PinyinEngine::ExtractExtLower(e.name_lower, e.is_dir);
        e.content_type = ClassifyContentType(e.ext_lower, e.is_dir);
        e.mtime_ms = NormalizeMtimeToUnixMs(e.mtime);
        e.name_mask = PinyinEngine::ComputeAsciiBitmask(e.name_lower);
        e.path_mask = PinyinEngine::ComputeAsciiBitmask(e.path_lower);
        e.pinyin_mask = PinyinEngine::ComputeAsciiBitmask(e.pinyin_full) | PinyinEngine::ComputeAsciiBitmask(e.acronym);
        e.combined_mask = e.name_mask | e.path_mask | e.pinyin_mask;
        e.name_cjk_mask = PinyinEngine::ComputeCjkBitmask(e.name_lower);
        e.path_cjk_mask = PinyinEngine::ComputeCjkBitmask(e.path_lower);
      }

      const size_t dir_len = (e.path_lower.size() > e.name_lower.size())
        ? (e.path_lower.size() - e.name_lower.size())
        : 0;
      const std::string_view dir_sv(e.path_lower.data(), dir_len);
      uint32_t dir_id = 0;
      auto it = dir_lookup.find(dir_sv);
      if (it != dir_lookup.end()) {
        dir_id = it->second;
      } else {
        dir_id = static_cast<uint32_t>(unique_dirs_.size());
        UniqueDir ud;
        ud.dir_lower.assign(dir_sv.data(), dir_sv.size());
        ud.ascii_mask = PinyinEngine::ComputeAsciiBitmask(ud.dir_lower);
        ud.cjk_mask = PinyinEngine::ComputeCjkBitmask(ud.dir_lower);
        unique_dirs_.push_back(std::move(ud));
        dir_lookup.emplace(dir_sv, dir_id);
      }

      HotFilter hf{};
      hf.name_pinyin_mask = e.name_mask | e.pinyin_mask;
      hf.name_cjk_mask = e.name_cjk_mask;
      hf.dir_id = dir_id;
      hf.content_type = e.content_type;
      hf.flags = static_cast<uint8_t>((e.is_dir ? 1u : 0u) | (e.is_hidden ? 2u : 0u));
      hot_.push_back(hf);
    }
  }

  size_t Size() const {
    return entries_.size();
  }

  const std::vector<FileEntry>& GetEntries() const {
    return entries_;
  }

  // Backward-compatible overload
  SearchResponse Search(std::string_view query, size_t limit = 50) const {
    SearchOptions opts;
    opts.limit = (limit == 0) ? 50 : limit;
    return Search(query, opts);
  }

  SearchResponse Search(std::string_view query, const SearchOptions& opts) const {
    auto start_time = std::chrono::high_resolution_clock::now();

    SearchResponse resp;
    resp.offset = opts.offset;
    if (entries_.empty()) {
      return resp;
    }

    const ParsedQuery pq = ParseSearchQuery(query);
    const std::string norm_prefix = NormalizePathPrefixFilter(opts.path_prefix);

    // Keep legacy empty-query contract when no filter or path scope is active
    if (pq.is_empty &&
        opts.content_type_mask == kContentTypeAll &&
        opts.kind == SearchKind::All &&
        norm_prefix.empty()) {
      return resp;
    }

    const size_t safe_limit = (opts.limit == 0) ? 50 : (std::min)(opts.limit, size_t(500));
    const size_t safe_offset = (std::min)(opts.offset, size_t(4500));
    const size_t top_k = safe_offset + safe_limit;

    // Comparator: returns true if `a` should rank BEFORE `b`
    auto is_better = [sort_by = opts.sort_by](const SearchResult& a, const SearchResult& b) noexcept -> bool {
      const FileEntry& ea = *a.entry;
      const FileEntry& eb = *b.entry;
      switch (sort_by) {
        case SearchSortBy::NameAsc:
          if (ea.name_lower != eb.name_lower) return ea.name_lower < eb.name_lower;
          return ea.path_lower < eb.path_lower;
        case SearchSortBy::NameDesc:
          if (ea.name_lower != eb.name_lower) return ea.name_lower > eb.name_lower;
          return ea.path_lower > eb.path_lower;
        case SearchSortBy::SizeDesc:
          if (ea.size != eb.size) return ea.size > eb.size;
          return ea.name_lower < eb.name_lower;
        case SearchSortBy::SizeAsc:
          if (ea.size != eb.size) return ea.size < eb.size;
          return ea.name_lower < eb.name_lower;
        case SearchSortBy::MtimeDesc:
          if (ea.mtime_ms != eb.mtime_ms) return ea.mtime_ms > eb.mtime_ms;
          return ea.name_lower < eb.name_lower;
        case SearchSortBy::MtimeAsc:
          if (ea.mtime_ms != eb.mtime_ms) return ea.mtime_ms < eb.mtime_ms;
          return ea.name_lower < eb.name_lower;
        case SearchSortBy::Relevance:
        default:
          if (a.score != b.score) return a.score > b.score;
          if (ea.mtime_ms != eb.mtime_ms) return ea.mtime_ms > eb.mtime_ms;
          if (ea.path.size() != eb.path.size()) return ea.path.size() < eb.path.size();
          return ea.name_lower < eb.name_lower;
      }
    };

    // Precompute query-level required masks & per-unique-directory flags for single-branch queries
    // For single positive SmartTerm (the hottest 90% case), precompute which unique directories actually
    // contain the term so non-matching directories only check name_pinyin_mask in the 16-byte L3 hot array!
    uint32_t name_only_ascii_mask = 0;
    uint32_t name_only_cjk_mask = 0;
    uint32_t single_term_ascii_mask = 0;
    uint32_t single_term_cjk_mask = 0;
    bool use_dir_fast_prune = false;
    std::vector<uint8_t> dir_can_satisfy_term;
    if (pq.or_branches.size() == 1) {
      for (const auto& c : pq.or_branches[0].clauses) {
        if (c.negated) continue;
        if (!c.match_full_path &&
            (c.kind == ClauseKind::Glob || c.kind == ClauseKind::Prefix ||
             c.kind == ClauseKind::Suffix || c.kind == ClauseKind::ExactSubstr)) {
          name_only_ascii_mask |= c.ascii_mask;
          name_only_cjk_mask |= c.cjk_mask;
        } else if (c.kind == ClauseKind::SmartTerm && !use_dir_fast_prune) {
          single_term_ascii_mask = c.ascii_mask;
          single_term_cjk_mask = c.cjk_mask;
          use_dir_fast_prune = (single_term_ascii_mask != 0 || single_term_cjk_mask != 0);
          if (use_dir_fast_prune) {
            dir_can_satisfy_term.resize(unique_dirs_.size(), 0);
            for (size_t d = 0; d < unique_dirs_.size(); ++d) {
              const auto& ud = unique_dirs_[d];
              if ((ud.ascii_mask & single_term_ascii_mask) == single_term_ascii_mask &&
                  (ud.cjk_mask & single_term_cjk_mask) == single_term_cjk_mask &&
                  ud.dir_lower.find(c.value) != std::string::npos) {
                dir_can_satisfy_term[d] = 1;
              }
            }
          }
        }
      }
    }

    auto scan_range = [&](size_t start_idx, size_t end_idx, std::vector<SearchResult>& out_top, size_t& out_matches) {
      out_matches = 0;
      out_top.clear();
      DirMatchMemo dir_memo{};
      // Heap where top() is the WORST element among the current top_k best candidates
      std::priority_queue<SearchResult, std::vector<SearchResult>, decltype(is_better)> heap(is_better);

      for (size_t i = start_idx; i < end_idx; ++i) {
        // Ultra-fast 16-byte SoA hot filter (stays in L3 cache, avoids 280B FileEntry cache misses)
        const HotFilter& hf = hot_[i];
        if (!opts.include_hidden && (hf.flags & 2u) != 0) continue;
        if (opts.kind == SearchKind::File && (hf.flags & 1u) != 0) continue;
        if (opts.kind == SearchKind::Directory && (hf.flags & 1u) == 0) continue;
        if (opts.content_type_mask != kContentTypeAll && (hf.content_type & opts.content_type_mask) == 0) continue;
        if (name_only_ascii_mask != 0 && (hf.name_pinyin_mask & name_only_ascii_mask) != name_only_ascii_mask) continue;
        if (name_only_cjk_mask != 0 && (hf.name_cjk_mask & name_only_cjk_mask) != name_only_cjk_mask) continue;
        if (use_dir_fast_prune && !dir_can_satisfy_term[hf.dir_id]) {
          if (single_term_ascii_mask != 0 && (hf.name_pinyin_mask & single_term_ascii_mask) != single_term_ascii_mask) continue;
          if (single_term_cjk_mask != 0 && (hf.name_cjk_mask & single_term_cjk_mask) != single_term_cjk_mask) continue;
        }

        const FileEntry& e = entries_[i];
        if (!norm_prefix.empty() && !MatchesPathPrefix(e.path_lower, norm_prefix)) continue;

        int score = 0;
        if (!EvaluateEntryAgainstQuery(e, pq, score, &dir_memo)) continue;

        ++out_matches;
        const SearchResult cand{ &e, score };
        if (heap.size() < top_k) {
          heap.push(cand);
        } else if (is_better(cand, heap.top())) {
          heap.pop();
          heap.push(cand);
        }
      }

      out_top.reserve(heap.size());
      while (!heap.empty()) {
        out_top.push_back(heap.top());
        heap.pop();
      }
    };

    std::vector<SearchResult> merged;
    size_t total_matches = 0;

    // Avoid thread-pool dispatch overhead on small datasets (< 4096 entries)
    if (!pool_ || entries_.size() < 4096) {
      scan_range(0, entries_.size(), merged, total_matches);
    } else {
      std::mutex merge_mutex;
      pool_->ParallelFor(entries_.size(), [&](size_t start_idx, size_t end_idx) {
        std::vector<SearchResult> local_top;
        size_t local_matches = 0;
        scan_range(start_idx, end_idx, local_top, local_matches);
        std::lock_guard<std::mutex> lk(merge_mutex);
        total_matches += local_matches;
        merged.insert(merged.end(), local_top.begin(), local_top.end());
      });
    }

    if (merged.size() > top_k) {
      std::partial_sort(merged.begin(), merged.begin() + static_cast<std::ptrdiff_t>(top_k), merged.end(), is_better);
      merged.resize(top_k);
    } else {
      std::sort(merged.begin(), merged.end(), is_better);
    }

    if (safe_offset < merged.size()) {
      const size_t avail = merged.size() - safe_offset;
      const size_t result_count = (std::min)(avail, safe_limit);
      resp.files.reserve(result_count);
      for (size_t i = 0; i < result_count; ++i) {
        resp.files.push_back(*(merged[safe_offset + i].entry));
      }
    }

    resp.total_matches = total_matches;
    resp.offset = safe_offset;
    resp.has_more = (safe_offset + resp.files.size()) < total_matches;

    auto end_time = std::chrono::high_resolution_clock::now();
    resp.elapsed_us = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(end_time - start_time).count());
    resp.elapsed_ms = static_cast<double>(resp.elapsed_us) / 1000.0;

    return resp;
  }

private:
  static std::string NormalizePathPrefixFilter(std::string_view raw) {
    while (!raw.empty() && std::isspace(static_cast<unsigned char>(raw.front()))) raw.remove_prefix(1);
    while (!raw.empty() && std::isspace(static_cast<unsigned char>(raw.back()))) raw.remove_suffix(1);
    if (raw.empty()) return {};
    std::string out = ToLowerAsciiAndSlashes(raw, true);
    while (out.size() > 1 && out.back() == '/') {
      if (out.size() == 3 && out[1] == ':') break;
      out.pop_back();
    }
    return out;
  }

  static bool MatchesPathPrefix(std::string_view path_lower, std::string_view norm_prefix) noexcept {
    if (path_lower.size() < norm_prefix.size()) return false;
    if (path_lower.compare(0, norm_prefix.size(), norm_prefix) != 0) return false;
    if (path_lower.size() == norm_prefix.size()) return false; // Exclude the directory itself when browsing inside it
    if (norm_prefix.back() == '/') return true;
    return path_lower[norm_prefix.size()] == '/';
  }

  struct UniqueDir {
    std::string dir_lower;
    uint32_t ascii_mask = 0;
    uint32_t cjk_mask = 0;
  };

  struct HotFilter {
    uint32_t name_pinyin_mask = 0;
    uint32_t name_cjk_mask = 0;
    uint32_t dir_id = 0;
    uint16_t content_type = 0;
    uint8_t flags = 0; // bit 0: is_dir, bit 1: is_hidden
    uint8_t reserved = 0;
  };

  std::vector<FileEntry> entries_;
  std::vector<UniqueDir> unique_dirs_;
  std::vector<HotFilter> hot_;
  std::unique_ptr<IndexerThreadPool> pool_;
};

} // namespace ztools::indexer

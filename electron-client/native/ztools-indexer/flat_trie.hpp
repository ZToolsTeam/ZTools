#pragma once

#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <vector>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <algorithm>
#include <chrono>
#include <future>
#include <thread>
#include <iostream>

#include "file_scanner.hpp"

namespace ztools::indexer {

struct SearchResult {
  const FileEntry* entry = nullptr;
  int score = 0; // Higher is better
};

struct SearchResponse {
  std::vector<FileEntry> files;
  size_t total_matches = 0;
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

    std::atomic<size_t> remaining(0);
    std::mutex done_mutex;
    std::condition_variable done_cv;

    for (size_t i = 0; i < count; ++i) {
      size_t s = i * chunk;
      size_t e = (s + chunk < total_items) ? (s + chunk) : total_items;
      if (s >= total_items) break;

      remaining++;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        tasks_.push([s, e, &fn, &remaining, &done_cv]() {
          fn(s, e);
          if (--remaining == 0) {
            done_cv.notify_all();
          }
        });
      }
      cv_.notify_one();
    }

    std::unique_lock<std::mutex> lock(done_mutex);
    done_cv.wait(lock, [&remaining]() { return remaining.load() == 0; });
  }

private:
  std::vector<std::thread> workers_;
  std::queue<std::function<void()>> tasks_;
  std::mutex mutex_;
  std::condition_variable cv_;
  bool stop_ = false;
};

// Flat array-backed Trie Node
struct FlatTrieNode {
  char ch = 0;
  uint32_t first_child = 0;
  uint32_t next_sibling = 0;
  std::vector<uint32_t> file_ids; // matching file indices
};

class FlatTrieIndex {
public:
  FlatTrieIndex() : pool_(std::make_unique<IndexerThreadPool>()) {
    Clear();
  }

  void Clear() {
    entries_.clear();
    nodes_.clear();
    nodes_.emplace_back(); // Root node at index 0
    acronym_buckets_.clear();
  }

  void Build(std::vector<FileEntry>&& entries) {
    Clear();
    entries_ = std::move(entries);

    // Reserve nodes to avoid frequent reallocations
    size_t cap = entries_.size() * 3 + 16;
    if (cap > 5000000) cap = 5000000;
    nodes_.reserve(cap);

    // Build flat trie and acronym index
    for (uint32_t id = 0; id < static_cast<uint32_t>(entries_.size()); ++id) {
      const auto& e = entries_[id];

      // 1. Index prefix of filename in flat trie
      if (!e.name_lower.empty()) {
        InsertTrie(e.name_lower, id, 16); // up to 16 chars prefix
      }

      // 2. Index acronym prefixes (up to 4 chars)
      if (!e.acronym.empty()) {
        std::string ac_prefix;
        size_t max_len = (e.acronym.size() < 4) ? e.acronym.size() : 4;
        for (size_t len = 1; len <= max_len; ++len) {
          ac_prefix = e.acronym.substr(0, len);
          acronym_buckets_[ac_prefix].push_back(id);
        }
      }
    }
  }

  size_t Size() const {
    return entries_.size();
  }

  const std::vector<FileEntry>& GetEntries() const {
    return entries_;
  }

  SearchResponse Search(std::string_view query, size_t limit = 50) const {
    auto start_time = std::chrono::high_resolution_clock::now();

    SearchResponse resp;
    if (query.empty() || entries_.empty()) {
      return resp;
    }

    std::string query_lower;
    query_lower.reserve(query.size());
    for (char c : query) query_lower.push_back(static_cast<char>(::tolower(c)));

    std::unordered_set<uint32_t> candidate_set;
    candidate_set.reserve(limit * 4);

    // Phase 1: Acronym match (Instant O(1) bucket lookup)
    auto ac_it = acronym_buckets_.find(query_lower);
    if (ac_it != acronym_buckets_.end()) {
      for (uint32_t id : ac_it->second) {
        candidate_set.insert(id);
        if (candidate_set.size() >= limit * 2) break;
      }
    }

    // Phase 2: Prefix lookup in Flat Trie
    if (candidate_set.size() < limit) {
      std::vector<uint32_t> trie_ids;
      FindPrefixTrie(query_lower, trie_ids, limit);
      for (uint32_t id : trie_ids) {
        candidate_set.insert(id);
        if (candidate_set.size() >= limit * 2) break;
      }
    }

    // Phase 3: Parallel Substring and Pinyin search if more results needed
    if (candidate_set.size() < limit && entries_.size() > 0 && pool_) {
      std::mutex cand_mutex;
      std::atomic<bool> early_stop(false);
      pool_->ParallelFor(entries_.size(), [&](size_t start_idx, size_t end_idx) {
        std::vector<uint32_t> local_matches;
        local_matches.reserve(limit);
        for (size_t i = start_idx; i < end_idx; ++i) {
          if (early_stop.load(std::memory_order_relaxed)) break;
          const auto& e = entries_[i];
          if (e.name_lower.find(query_lower) != std::string::npos ||
              e.pinyin_full.find(query_lower) != std::string::npos ||
              e.acronym.find(query_lower) != std::string::npos) {
            local_matches.push_back(static_cast<uint32_t>(i));
            if (local_matches.size() >= limit) break;
          }
        }
        if (!local_matches.empty()) {
          std::lock_guard<std::mutex> lk(cand_mutex);
          for (uint32_t id : local_matches) {
            candidate_set.insert(id);
            if (candidate_set.size() >= limit * 2) {
              early_stop.store(true, std::memory_order_relaxed);
              break;
            }
          }
        }
      });
    }

    // Rank candidate matches
    std::vector<SearchResult> ranked;
    ranked.reserve(candidate_set.size());

    for (uint32_t id : candidate_set) {
      if (id >= entries_.size()) continue;
      const auto& e = entries_[id];
      int score = 0;

      // Exact name match
      if (e.name_lower == query_lower) {
        score += 1000;
      }
      // Exact acronym match
      else if (e.acronym == query_lower) {
        score += 800;
      }
      // Prefix name match
      else if (e.name_lower.rfind(query_lower, 0) == 0) {
        score += 500;
      }
      // Prefix acronym match
      else if (e.acronym.rfind(query_lower, 0) == 0) {
        score += 400;
      }
      // Substring match
      else if (e.name_lower.find(query_lower) != std::string::npos) {
        score += 200;
      }
      // Pinyin substring match
      else if (e.pinyin_full.find(query_lower) != std::string::npos) {
        score += 100;
      }

      // Shorter names rank higher
      size_t name_penalty = (e.name.size() < 100) ? e.name.size() : 100;
      score -= static_cast<int>(name_penalty);

      ranked.push_back({ &e, score });
    }

    std::sort(ranked.begin(), ranked.end(), [](const SearchResult& a, const SearchResult& b) {
      return a.score > b.score;
    });

    size_t result_count = (std::min)(ranked.size(), limit);
    resp.files.reserve(result_count);
    for (size_t i = 0; i < result_count; ++i) {
      resp.files.push_back(*(ranked[i].entry));
    }
    resp.total_matches = ranked.size();

    auto end_time = std::chrono::high_resolution_clock::now();
    resp.elapsed_us = std::chrono::duration_cast<std::chrono::microseconds>(end_time - start_time).count();
    resp.elapsed_ms = resp.elapsed_us / 1000.0;

    return resp;
  }

private:
  void InsertTrie(std::string_view word, uint32_t file_id, size_t max_depth) {
    uint32_t curr = 0; // Root node
    size_t depth = 0;

    for (char c : word) {
      if (depth++ >= max_depth) break;

      uint32_t child = nodes_[curr].first_child;
      uint32_t prev = 0;
      bool found = false;

      while (child != 0) {
        if (nodes_[child].ch == c) {
          found = true;
          curr = child;
          break;
        }
        prev = child;
        child = nodes_[child].next_sibling;
      }

      if (!found) {
        uint32_t new_node_id = static_cast<uint32_t>(nodes_.size());
        nodes_.emplace_back();
        nodes_[new_node_id].ch = c;

        if (prev == 0) {
          nodes_[curr].first_child = new_node_id;
        } else {
          nodes_[prev].next_sibling = new_node_id;
        }
        curr = new_node_id;
      }

      if (nodes_[curr].file_ids.size() < 128) {
        nodes_[curr].file_ids.push_back(file_id);
      }
    }
  }

  void FindPrefixTrie(std::string_view prefix, std::vector<uint32_t>& out_ids, size_t limit) const {
    uint32_t curr = 0;
    for (char c : prefix) {
      uint32_t child = nodes_[curr].first_child;
      bool found = false;
      while (child != 0) {
        if (nodes_[child].ch == c) {
          curr = child;
          found = true;
          break;
        }
        child = nodes_[child].next_sibling;
      }
      if (!found) return; // Prefix not found in trie
    }

    // Found prefix node!
    const auto& fids = nodes_[curr].file_ids;
    for (uint32_t id : fids) {
      out_ids.push_back(id);
      if (out_ids.size() >= limit) break;
    }
  }

  std::vector<FileEntry> entries_;
  std::vector<FlatTrieNode> nodes_;
  std::unordered_map<std::string, std::vector<uint32_t>> acronym_buckets_;
  std::unique_ptr<IndexerThreadPool> pool_;
};

} // namespace ztools::indexer

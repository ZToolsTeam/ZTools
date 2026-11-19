#include <atomic>
#include <condition_variable>
#include <functional>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <queue>
#include <stdexcept>
#include <thread>
#include <vector>

#include "flat_trie.hpp"

namespace {

void CheckCompletions(ztools::indexer::IndexerThreadPool& pool, const size_t items) {
  std::vector<std::atomic<unsigned>> visits(items);
  for (size_t round = 0; round < 1000; ++round) {
    for (auto& visit : visits) visit.store(0);
    std::atomic<size_t> callbacks{0};
    std::atomic<bool> invalid_range{false};
    pool.ParallelFor(items, [&](const size_t start, const size_t end) {
      callbacks.fetch_add(1);
      if (start >= end || end > items) {
        invalid_range.store(true);
        return;
      }
      for (size_t index = start; index < end; ++index) visits[index].fetch_add(1);
    });
    if (invalid_range.load() || (items == 0 && callbacks.load() != 0) ||
        (items > 0 && (callbacks.load() == 0 || callbacks.load() > pool.ThreadCount()))) {
      throw std::runtime_error("ParallelFor emitted an invalid range or callback count");
    }
    for (const auto& visit : visits) {
      if (visit.load() != 1) {
        throw std::runtime_error("ParallelFor returned before each item completed exactly once");
      }
    }
  }
}

}  // namespace

int main() {
  try {
    for (const size_t workers : {1U, 2U, 8U, 32U}) {
      {
        ztools::indexer::IndexerThreadPool pool(workers);
        for (const size_t items : {0U, 1U, 2U, 7U, 24U, 33U}) CheckCompletions(pool, items);
      }
      std::cout << "PASS workers=" << workers << " items=0,1,2,7,24,33 rounds=1000 shutdown=joined\n";
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}

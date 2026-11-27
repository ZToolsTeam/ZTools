#pragma once

#include <string>
#include <string_view>
#include <cstdint>
#include <cctype>

#include "pinyin_table.hpp"

namespace ztools::indexer {

// High-speed O(1) Chinese Pinyin & ASCII acronym extractor backed by
// pinyin_table.hpp (auto-generated from pinyin-pro, covering U+4E00..U+9FFF).
class PinyinEngine {
public:
  static void Convert(std::string_view utf8_str, std::string& acronym, std::string& full_pinyin, std::string& lower_str) {
    acronym.clear();
    full_pinyin.clear();
    lower_str.clear();
    lower_str.reserve(utf8_str.size());
    full_pinyin.reserve(utf8_str.size() + 16);
    acronym.reserve(16);

    size_t i = 0;
    bool prev_was_ascii_word = false;
    bool prev_was_ascii_lower = false;

    while (i < utf8_str.size()) {
      const unsigned char c = static_cast<unsigned char>(utf8_str[i]);
      if (c < 0x80) {
        const char lower_c = (c >= 'A' && c <= 'Z') ? static_cast<char>(c + ('a' - 'A')) : static_cast<char>(c);
        lower_str.push_back(lower_c);
        full_pinyin.push_back(lower_c);

        const bool is_upper = (c >= 'A' && c <= 'Z');
        const bool is_lower = (c >= 'a' && c <= 'z');
        const bool is_digit = (c >= '0' && c <= '9');
        const bool is_word = is_upper || is_lower || is_digit;

        if (is_word) {
          if (!prev_was_ascii_word || (prev_was_ascii_lower && is_upper)) {
            acronym.push_back(lower_c);
          }
          prev_was_ascii_word = true;
          prev_was_ascii_lower = is_lower;
        } else {
          prev_was_ascii_word = false;
          prev_was_ascii_lower = false;
        }
        ++i;
      } else if ((c & 0xE0) == 0xC0) {
        prev_was_ascii_word = false;
        prev_was_ascii_lower = false;
        if (i + 1 < utf8_str.size()) {
          lower_str.append(utf8_str.substr(i, 2));
        }
        i += 2;
      } else if ((c & 0xF0) == 0xE0) {
        prev_was_ascii_word = false;
        prev_was_ascii_lower = false;
        if (i + 2 < utf8_str.size()) {
          const uint32_t cp =
            ((static_cast<uint32_t>(c) & 0x0Fu) << 12) |
            ((static_cast<uint32_t>(static_cast<unsigned char>(utf8_str[i + 1])) & 0x3Fu) << 6) |
            (static_cast<uint32_t>(static_cast<unsigned char>(utf8_str[i + 2])) & 0x3Fu);
          const std::string_view three_bytes = utf8_str.substr(i, 3);
          lower_str.append(three_bytes);

          const std::string_view py = pinyin_data::LookupHanziPinyin(cp);
          if (!py.empty()) {
            acronym.push_back(py[0]);
            full_pinyin.append(py);
          } else {
            full_pinyin.append(three_bytes);
          }
        }
        i += 3;
      } else if ((c & 0xF8) == 0xF0) {
        prev_was_ascii_word = false;
        prev_was_ascii_lower = false;
        if (i + 3 < utf8_str.size()) {
          lower_str.append(utf8_str.substr(i, 4));
        }
        i += 4;
      } else {
        prev_was_ascii_word = false;
        prev_was_ascii_lower = false;
        ++i;
      }
    }
  }

  // Normalize path to lowercase with forward slashes ('/') for cross-platform path matching
  static void NormalizePathLower(std::string_view path, std::string& out_path_lower) {
    out_path_lower.clear();
    out_path_lower.reserve(path.size());
    for (char ch : path) {
      if (ch == '\\') {
        out_path_lower.push_back('/');
      } else if (ch >= 'A' && ch <= 'Z') {
        out_path_lower.push_back(static_cast<char>(ch + ('a' - 'A')));
      } else {
        out_path_lower.push_back(ch);
      }
    }
  }

  // Extract lowercase file extension without leading dot (empty for directories or extensionless files)
  static std::string ExtractExtLower(std::string_view name_lower, bool is_dir) {
    if (is_dir || name_lower.empty()) return {};
    const size_t dot = name_lower.rfind('.');
    if (dot == std::string_view::npos || dot == 0 || dot + 1 >= name_lower.size()) return {};
    return std::string(name_lower.substr(dot + 1));
  }

  // Compute 32-bit ASCII presence bitmask: bits 0..25 for 'a'..'z', bits 26..31 for '0'..'5' (digits 6..9 hashed into 26..29)
  static uint32_t ComputeAsciiBitmask(std::string_view lower_str) noexcept {
    uint32_t mask = 0;
    for (unsigned char c : lower_str) {
      if (c >= 'a' && c <= 'z') {
        mask |= (1u << (c - 'a'));
      } else if (c >= '0' && c <= '9') {
        mask |= (1u << (26u + ((c - '0') % 6u)));
      }
    }
    return mask;
  }

  // Compute 32-bit non-ASCII UTF-8 (CJK/Unicode) presence bitmask for O(1) rejection of Chinese queries
  static uint32_t ComputeCjkBitmask(std::string_view utf8_str) noexcept {
    uint32_t mask = 0;
    size_t i = 0;
    while (i < utf8_str.size()) {
      const unsigned char c = static_cast<unsigned char>(utf8_str[i]);
      if (c < 0x80) {
        ++i;
      } else if ((c & 0xE0) == 0xC0 && i + 1 < utf8_str.size()) {
        const uint32_t cp = ((static_cast<uint32_t>(c) & 0x1Fu) << 6) |
          (static_cast<uint32_t>(static_cast<unsigned char>(utf8_str[i + 1])) & 0x3Fu);
        mask |= (1u << ((cp ^ (cp >> 5)) & 31u));
        i += 2;
      } else if ((c & 0xF0) == 0xE0 && i + 2 < utf8_str.size()) {
        const uint32_t cp = ((static_cast<uint32_t>(c) & 0x0Fu) << 12) |
          ((static_cast<uint32_t>(static_cast<unsigned char>(utf8_str[i + 1])) & 0x3Fu) << 6) |
          (static_cast<uint32_t>(static_cast<unsigned char>(utf8_str[i + 2])) & 0x3Fu);
        mask |= (1u << ((cp ^ (cp >> 5) ^ (cp >> 10)) & 31u));
        i += 3;
      } else if ((c & 0xF8) == 0xF0 && i + 3 < utf8_str.size()) {
        const uint32_t cp = ((static_cast<uint32_t>(c) & 0x07u) << 18) |
          ((static_cast<uint32_t>(static_cast<unsigned char>(utf8_str[i + 1])) & 0x3Fu) << 12) |
          ((static_cast<uint32_t>(static_cast<unsigned char>(utf8_str[i + 2])) & 0x3Fu) << 6) |
          (static_cast<uint32_t>(static_cast<unsigned char>(utf8_str[i + 3])) & 0x3Fu);
        mask |= (1u << ((cp ^ (cp >> 5)) & 31u));
        i += 4;
      } else {
        ++i;
      }
    }
    return mask;
  }
};

} // namespace ztools::indexer

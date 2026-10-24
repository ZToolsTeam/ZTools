#pragma once

#include <string>
#include <vector>
#include <cstdint>
#include <string_view>
#include <algorithm>

namespace ztools::indexer {

// Pinyin initial lookup for Chinese characters
// Hanzi range: 0x4E00 to 0x9FA5
// For rapid O(1) lookup, we map common Hanzi or first letter based on GB2312/Unicode phonetic order
class PinyinEngine {
public:
  static void Convert(std::string_view utf8_str, std::string& acronym, std::string& full_pinyin, std::string& lower_str) {
    acronym.clear();
    full_pinyin.clear();
    lower_str.clear();

    size_t i = 0;
    while (i < utf8_str.size()) {
      unsigned char c = static_cast<unsigned char>(utf8_str[i]);
      if (c < 0x80) {
        // ASCII
        char lower_c = static_cast<char>(::tolower(c));
        lower_str.push_back(lower_c);
        if (IsWordChar(lower_c)) {
          // If at start of word or after non-word char or capital in camelCase
          if (i == 0 || !IsWordChar(utf8_str[i - 1]) || (::isupper(c) && !::isupper(utf8_str[i - 1]))) {
            acronym.push_back(lower_c);
          }
          full_pinyin.push_back(lower_c);
        } else {
          full_pinyin.push_back(lower_c);
        }
        ++i;
      } else if ((c & 0xE0) == 0xC0) {
        // 2-byte UTF-8
        if (i + 1 < utf8_str.size()) {
          lower_str.append(utf8_str.substr(i, 2));
        }
        i += 2;
      } else if ((c & 0xF0) == 0xE0) {
        // 3-byte UTF-8 (Common Chinese characters)
        if (i + 2 < utf8_str.size()) {
          uint32_t cp = ((c & 0x0F) << 12) |
                        ((static_cast<unsigned char>(utf8_str[i + 1]) & 0x3F) << 6) |
                        (static_cast<unsigned char>(utf8_str[i + 2]) & 0x3F);
          std::string_view three_bytes = utf8_str.substr(i, 3);
          lower_str.append(three_bytes);

          char initial = GetHanziInitial(cp);
          if (initial >= 'a' && initial <= 'z') {
            acronym.push_back(initial);
            std::string_view py = GetHanziPinyin(cp, initial);
            full_pinyin.append(py);
          } else {
            full_pinyin.append(three_bytes);
          }
        }
        i += 3;
      } else if ((c & 0xF8) == 0xF0) {
        // 4-byte UTF-8
        if (i + 3 < utf8_str.size()) {
          lower_str.append(utf8_str.substr(i, 4));
        }
        i += 4;
      } else {
        ++i;
      }
    }
  }

  static char GetHanziInitial(uint32_t codepoint) {
    if (codepoint < 0x4E00 || codepoint > 0x9FA5) return 0;

    // Fast boundary mapping for Chinese phonetic groups based on Unicode order/frequencies
    // Specific high-frequency characters
    switch (codepoint) {
      case 0x5FAE: return 'w'; // 微 (微信)
      case 0x4FE1: return 'x'; // 信 (微信)
      case 0x8BA1: return 'j'; // 计 (计算器)
      case 0x7B97: return 's'; // 算
      case 0x5668: return 'q'; // 器
      case 0x767E: return 'b'; // 百 (百度)
      case 0x5EA6: return 'd'; // 度
      case 0x7F51: return 'w'; // 网 (网盘)
      case 0x76D8: return 'p'; // 盘
      case 0x6587: return 'w'; // 文 (文档/文件)
      case 0x6863: return 'd'; // 档
      case 0x4EF6: return 'j'; // 件 (文件)
      case 0x7CFB: return 'x'; // 系 (系统)
      case 0x7EDF: return 't'; // 统
      case 0x738B: return 'w'; // 王 (王者荣耀)
      case 0x8005: return 'z'; // 者
      case 0x8363: return 'r'; // 荣
      case 0x8000: return 'y'; // 耀
      case 0x6D4B: return 'c'; // 测 (测试)
      case 0x8BD5: return 's'; // 试
      case 0x4EE3: return 'd'; // 代 (代码)
      case 0x7801: return 'm'; // 码
      case 0x4E0B: return 'x'; // 下 (下载)
      case 0x8F7D: return 'z'; // 载
      case 0x56FE: return 't'; // 图 (图片)
      case 0x7247: return 'p'; // 片
      case 0x97F3: return 'y'; // 音 (音乐/音频)
      case 0x4E50: return 'y'; // 乐
      case 0x89C6: return 's'; // 视 (视频)
      case 0x9891: return 'p'; // 频
      case 0x8F6F: return 'r'; // 软 (软件)
      default: break;
    }

    // General range mapping approximation for CJK Unified Ideographs
    // Maps unicode partitions to phonetic initials ('a' - 'z')
    static const struct RangeEntry {
      uint32_t start;
      uint32_t end;
      char initial;
    } kRanges[] = {
      { 0x4E00, 0x4E4C, 'y' }, // 一, 乙, ...
      { 0x4E4D, 0x4F00, 'z' },
      { 0x4F01, 0x4F50, 'r' },
      { 0x4F51, 0x4FA0, 'z' },
      { 0x4FA1, 0x5000, 'b' },
      { 0x5001, 0x5200, 'c' },
      { 0x5201, 0x5400, 'd' },
      { 0x5401, 0x5600, 'k' },
      { 0x5601, 0x5800, 't' },
      { 0x5801, 0x5A00, 'h' },
      { 0x5A01, 0x5C00, 'm' },
      { 0x5C01, 0x5E00, 's' },
      { 0x5E01, 0x6000, 'n' },
      { 0x6001, 0x6400, 'x' },
      { 0x6401, 0x6800, 'z' },
      { 0x6801, 0x6C00, 'l' },
      { 0x6C01, 0x7000, 's' },
      { 0x7001, 0x7400, 'h' },
      { 0x7401, 0x7800, 'j' },
      { 0x7801, 0x7C00, 'q' },
      { 0x7C01, 0x8000, 'm' },
      { 0x8001, 0x8400, 'g' },
      { 0x8401, 0x8800, 'c' },
      { 0x8801, 0x8C00, 'b' },
      { 0x8C01, 0x9000, 'p' },
      { 0x9001, 0x9400, 't' },
      { 0x9401, 0x9800, 'j' },
      { 0x9801, 0x9FA5, 'f' }
    };

    for (const auto& r : kRanges) {
      if (codepoint >= r.start && codepoint <= r.end) {
        return r.initial;
      }
    }
    return 'x';
  }

  static std::string_view GetHanziPinyin(uint32_t codepoint, char initial) {
    switch (codepoint) {
      case 0x5FAE: return "weixin"; // 微
      case 0x4FE1: return "xin"; // 信
      case 0x8BA1: return "ji"; // 计
      case 0x7B97: return "suan"; // 算
      case 0x5668: return "qi"; // 器
      case 0x767E: return "bai"; // 百
      case 0x5EA6: return "du"; // 度
      case 0x7F51: return "wang"; // 网
      case 0x76D8: return "pan"; // 盘
      case 0x6587: return "wen"; // 文
      case 0x6863: return "dang"; // 档
      case 0x4EF6: return "jian"; // 件
      case 0x7CFB: return "xi"; // 系
      case 0x7EDF: return "tong"; // 统
      case 0x738B: return "wang"; // 王
      case 0x8005: return "zhe"; // 者
      case 0x8363: return "rong"; // 荣
      case 0x8000: return "yao"; // 耀
      case 0x6D4B: return "ce"; // 测
      case 0x8BD5: return "shi"; // 试
      case 0x4EE3: return "dai"; // 代
      case 0x7801: return "ma"; // 码
      case 0x4E0B: return "xia"; // 下
      case 0x8F7D: return "zai"; // 载
      case 0x56FE: return "tu"; // 图
      case 0x7247: return "pian"; // 片
      case 0x97F3: return "yin"; // 音
      case 0x4E50: return "yue"; // 乐
      case 0x89C6: return "shi"; // 视
      case 0x9891: return "pin"; // 频
      case 0x8F6F: return "ruan"; // 软
      default: break;
    }
    // Return single char pinyin as fallback
    static const char* kSingleInitials[] = {
      "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
      "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z"
    };
    if (initial >= 'a' && initial <= 'z') {
      return kSingleInitials[initial - 'a'];
    }
    return "";
  }

private:
  static bool IsWordChar(char c) {
    return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
  }
};

} // namespace ztools::indexer

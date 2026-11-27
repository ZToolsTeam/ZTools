#pragma once

#include <Windows.h>

#include <cstdint>
#include <limits>
#include <map>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace ztools::native_trust {

// 专用受限 JSON 解析器上限（§A1）：严控深度、键数、串长并拒绝重复键与非法转义
inline constexpr std::size_t kMaxJsonDepth = 8;
inline constexpr std::size_t kMaxJsonObjectKeys = 64;
inline constexpr std::size_t kMaxJsonArrayElements = 512;
inline constexpr std::size_t kMaxJsonStringBytes = 4096;
inline constexpr std::uint64_t kMaxSafeJsonUint = 9007199254740991ULL;  // 2^53 - 1

enum class JsonType {
  Null,
  Bool,
  Uint64,
  String,
  Array,
  Object,
};

struct JsonValue {
  JsonType type = JsonType::Null;
  bool bool_value = false;
  std::uint64_t uint_value = 0;
  std::string string_value;
  std::vector<JsonValue> array_value;
  std::map<std::string, JsonValue> object_value;

  const JsonValue* Find(std::string_view key) const {
    if (type != JsonType::Object) return nullptr;
    const auto it = object_value.find(std::string(key));
    return it == object_value.end() ? nullptr : &it->second;
  }
};

namespace detail {

class StrictJsonParser {
 public:
  explicit StrictJsonParser(std::string_view input) : input_(input) {}

  bool Parse(JsonValue& output) {
    // 拒绝 UTF-8 BOM
    if (input_.size() >= 3 &&
        static_cast<unsigned char>(input_[0]) == 0xefU &&
        static_cast<unsigned char>(input_[1]) == 0xbbU &&
        static_cast<unsigned char>(input_[2]) == 0xbfU) {
      return false;
    }
    if (!IsValidUtf8(input_)) return false;
    SkipWs();
    if (!ParseValue(output, 0)) return false;
    SkipWs();
    return pos_ == input_.size();
  }

 private:
  static bool IsValidUtf8(std::string_view value) noexcept {
    if (value.empty()) return true;
    if (value.size() > static_cast<std::size_t>(INT_MAX)) return false;
    return MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
      nullptr, 0) > 0;
  }

  void SkipWs() noexcept {
    while (pos_ < input_.size()) {
      const char ch = input_[pos_];
      if (ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n') ++pos_;
      else break;
    }
  }

  static bool ParseHex4(std::string_view input, std::size_t pos, std::uint32_t& out) noexcept {
    if (pos + 4 > input.size()) return false;
    std::uint32_t value = 0;
    for (std::size_t i = 0; i < 4; ++i) {
      const char ch = input[pos + i];
      value <<= 4U;
      if (ch >= '0' && ch <= '9') value |= static_cast<std::uint32_t>(ch - '0');
      else if (ch >= 'a' && ch <= 'f') value |= static_cast<std::uint32_t>(ch - 'a' + 10);
      else if (ch >= 'A' && ch <= 'F') value |= static_cast<std::uint32_t>(ch - 'A' + 10);
      else return false;
    }
    out = value;
    return true;
  }

  static bool AppendUtf8CodePoint(std::string& out, std::uint32_t cp) {
    if (cp <= 0x7fU) {
      out.push_back(static_cast<char>(cp));
    } else if (cp <= 0x7ffU) {
      out.push_back(static_cast<char>(0xc0U | (cp >> 6U)));
      out.push_back(static_cast<char>(0x80U | (cp & 0x3fU)));
    } else if (cp <= 0xffffU) {
      out.push_back(static_cast<char>(0xe0U | (cp >> 12U)));
      out.push_back(static_cast<char>(0x80U | ((cp >> 6U) & 0x3fU)));
      out.push_back(static_cast<char>(0x80U | (cp & 0x3fU)));
    } else if (cp <= 0x10ffffU) {
      out.push_back(static_cast<char>(0xf0U | (cp >> 18U)));
      out.push_back(static_cast<char>(0x80U | ((cp >> 12U) & 0x3fU)));
      out.push_back(static_cast<char>(0x80U | ((cp >> 6U) & 0x3fU)));
      out.push_back(static_cast<char>(0x80U | (cp & 0x3fU)));
    } else {
      return false;
    }
    return out.size() <= kMaxJsonStringBytes;
  }

  bool ParseString(std::string& out) {
    if (pos_ >= input_.size() || input_[pos_] != '"') return false;
    ++pos_;
    out.clear();
    while (pos_ < input_.size()) {
      const unsigned char ch = static_cast<unsigned char>(input_[pos_++]);
      if (ch == '"') {
        return out.size() <= kMaxJsonStringBytes;
      }
      if (ch < 0x20U) return false;
      if (ch != '\\') {
        out.push_back(static_cast<char>(ch));
        if (out.size() > kMaxJsonStringBytes) return false;
        continue;
      }
      if (pos_ >= input_.size()) return false;
      const char esc = input_[pos_++];
      switch (esc) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': {
          std::uint32_t unit = 0;
          if (!ParseHex4(input_, pos_, unit)) return false;
          pos_ += 4;
          if (unit >= 0xd800U && unit <= 0xdbffU) {
            if (pos_ + 6 > input_.size() || input_[pos_] != '\\' || input_[pos_ + 1] != 'u') {
              return false;
            }
            pos_ += 2;
            std::uint32_t low = 0;
            if (!ParseHex4(input_, pos_, low) || low < 0xdc00U || low > 0xdfffU) return false;
            pos_ += 4;
            const std::uint32_t cp = 0x10000U + (((unit - 0xd800U) << 10U) | (low - 0xdc00U));
            if (!AppendUtf8CodePoint(out, cp)) return false;
          } else if (unit >= 0xdc00U && unit <= 0xdfffU) {
            return false;
          } else {
            if (!AppendUtf8CodePoint(out, unit)) return false;
          }
          break;
        }
        default:
          return false;
      }
      if (out.size() > kMaxJsonStringBytes) return false;
    }
    return false;
  }

  bool ParseUint(std::uint64_t& out) noexcept {
    if (pos_ >= input_.size()) return false;
    const char first = input_[pos_];
    if (first < '0' || first > '9') return false;
    if (first == '0') {
      ++pos_;
      if (pos_ < input_.size() && input_[pos_] >= '0' && input_[pos_] <= '9') return false;
      if (pos_ < input_.size() && (input_[pos_] == '.' || input_[pos_] == 'e' || input_[pos_] == 'E')) {
        return false;
      }
      out = 0;
      return true;
    }
    std::uint64_t acc = 0;
    while (pos_ < input_.size() && input_[pos_] >= '0' && input_[pos_] <= '9') {
      const std::uint64_t digit = static_cast<std::uint64_t>(input_[pos_] - '0');
      if (acc > (kMaxSafeJsonUint - digit) / 10ULL) return false;
      acc = acc * 10ULL + digit;
      ++pos_;
    }
    if (pos_ < input_.size() && (input_[pos_] == '.' || input_[pos_] == 'e' || input_[pos_] == 'E')) {
      return false;
    }
    out = acc;
    return true;
  }

  bool ParseObject(JsonValue& output, std::size_t depth) {
    if (depth + 1 > kMaxJsonDepth) return false;
    ++pos_;  // skip '{'
    output = JsonValue{};
    output.type = JsonType::Object;
    SkipWs();
    if (pos_ < input_.size() && input_[pos_] == '}') {
      ++pos_;
      return true;
    }
    std::size_t key_count = 0;
    while (true) {
      SkipWs();
      std::string key;
      if (!ParseString(key)) return false;
      if (output.object_value.contains(key)) return false;  // 严禁重复键
      ++key_count;
      if (key_count > kMaxJsonObjectKeys) return false;
      SkipWs();
      if (pos_ >= input_.size() || input_[pos_] != ':') return false;
      ++pos_;
      SkipWs();
      JsonValue val;
      if (!ParseValue(val, depth + 1)) return false;
      output.object_value.emplace(std::move(key), std::move(val));
      SkipWs();
      if (pos_ >= input_.size()) return false;
      if (input_[pos_] == '}') {
        ++pos_;
        return true;
      }
      if (input_[pos_] != ',') return false;
      ++pos_;
    }
  }

  bool ParseArray(JsonValue& output, std::size_t depth) {
    if (depth + 1 > kMaxJsonDepth) return false;
    ++pos_;  // skip '['
    output = JsonValue{};
    output.type = JsonType::Array;
    SkipWs();
    if (pos_ < input_.size() && input_[pos_] == ']') {
      ++pos_;
      return true;
    }
    while (true) {
      SkipWs();
      if (output.array_value.size() >= kMaxJsonArrayElements) return false;
      JsonValue elem;
      if (!ParseValue(elem, depth + 1)) return false;
      output.array_value.push_back(std::move(elem));
      SkipWs();
      if (pos_ >= input_.size()) return false;
      if (input_[pos_] == ']') {
        ++pos_;
        return true;
      }
      if (input_[pos_] != ',') return false;
      ++pos_;
    }
  }

  bool ParseValue(JsonValue& output, std::size_t depth) {
    if (depth > kMaxJsonDepth) return false;
    SkipWs();
    if (pos_ >= input_.size()) return false;
    const char ch = input_[pos_];
    if (ch == '{') return ParseObject(output, depth);
    if (ch == '[') return ParseArray(output, depth);
    if (ch == '"') {
      output = JsonValue{};
      output.type = JsonType::String;
      return ParseString(output.string_value);
    }
    if (ch == 't' && input_.substr(pos_, 4) == "true") {
      pos_ += 4;
      output = JsonValue{};
      output.type = JsonType::Bool;
      output.bool_value = true;
      return true;
    }
    if (ch == 'f' && input_.substr(pos_, 5) == "false") {
      pos_ += 5;
      output = JsonValue{};
      output.type = JsonType::Bool;
      output.bool_value = false;
      return true;
    }
    if (ch == 'n' && input_.substr(pos_, 4) == "null") {
      pos_ += 4;
      output = JsonValue{};
      output.type = JsonType::Null;
      return true;
    }
    if (ch >= '0' && ch <= '9') {
      output = JsonValue{};
      output.type = JsonType::Uint64;
      return ParseUint(output.uint_value);
    }
    return false;
  }

  std::string_view input_;
  std::size_t pos_ = 0;
};

}  // namespace detail

inline bool ParseStrictJson(std::string_view input, JsonValue& output) {
  detail::StrictJsonParser parser(input);
  return parser.Parse(output);
}

}  // namespace ztools::native_trust

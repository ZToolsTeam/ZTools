#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>
#include <map>
#include <sstream>
#include <iostream>
#include <functional>
#include <algorithm>
#include <stdexcept>
#include <charconv>

namespace ztools::sidecar {

enum class JsonType {
  Null,
  Bool,
  Number,
  String,
  Array,
  Object
};

class JsonValue {
public:
  JsonType type = JsonType::Null;
  bool bool_val = false;
  double num_val = 0.0;
  int64_t int_val = 0;
  bool is_integer = true;
  std::string str_val;
  std::vector<JsonValue> arr_val;
  std::map<std::string, JsonValue> obj_val;

  JsonValue() : type(JsonType::Null) {}
  JsonValue(std::nullptr_t) : type(JsonType::Null) {}
  JsonValue(bool b) : type(JsonType::Bool), bool_val(b) {}
  JsonValue(int i) : type(JsonType::Number), num_val(i), int_val(i), is_integer(true) {}
  JsonValue(unsigned int u) : type(JsonType::Number), num_val(static_cast<double>(u)), int_val(static_cast<int64_t>(u)), is_integer(true) {}
  JsonValue(long l) : type(JsonType::Number), num_val(static_cast<double>(l)), int_val(static_cast<int64_t>(l)), is_integer(true) {}
  JsonValue(unsigned long ul) : type(JsonType::Number), num_val(static_cast<double>(ul)), int_val(static_cast<int64_t>(ul)), is_integer(true) {}
  JsonValue(int64_t i) : type(JsonType::Number), num_val(static_cast<double>(i)), int_val(i), is_integer(true) {}
  JsonValue(uint64_t u) : type(JsonType::Number), num_val(static_cast<double>(u)), int_val(static_cast<int64_t>(u)), is_integer(true) {}
  JsonValue(double d) : type(JsonType::Number), num_val(d), int_val(static_cast<int64_t>(d)), is_integer(false) {}
  JsonValue(const char* s) : type(JsonType::String), str_val(s ? s : "") {}
  JsonValue(const std::string& s) : type(JsonType::String), str_val(s) {}
  JsonValue(std::string_view s) : type(JsonType::String), str_val(s) {}

  static JsonValue Array() {
    JsonValue v;
    v.type = JsonType::Array;
    return v;
  }

  static JsonValue Object() {
    JsonValue v;
    v.type = JsonType::Object;
    return v;
  }

  bool is_null() const { return type == JsonType::Null; }
  bool is_bool() const { return type == JsonType::Bool; }
  bool is_number() const { return type == JsonType::Number; }
  bool is_string() const { return type == JsonType::String; }
  bool is_array() const { return type == JsonType::Array; }
  bool is_object() const { return type == JsonType::Object; }

  const JsonValue* find(const std::string& key) const {
    if (type != JsonType::Object) return nullptr;
    auto it = obj_val.find(key);
    return (it != obj_val.end()) ? &it->second : nullptr;
  }

  std::string get_string(const std::string& key, const std::string& def = "") const {
    const auto* p = find(key);
    return (p && p->is_string()) ? p->str_val : def;
  }

  int64_t get_int(const std::string& key, int64_t def = 0) const {
    const auto* p = find(key);
    return (p && p->is_number()) ? p->int_val : def;
  }

  bool get_bool(const std::string& key, bool def = false) const {
    const auto* p = find(key);
    return (p && p->is_bool()) ? p->bool_val : def;
  }

  void push_back(const JsonValue& v) {
    if (type != JsonType::Array) type = JsonType::Array;
    arr_val.push_back(v);
  }

  void set(const std::string& k, const JsonValue& v) {
    if (type != JsonType::Object) type = JsonType::Object;
    obj_val[k] = v;
  }

  static std::string EscapeString(std::string_view s) {
    std::string out;
    out.reserve(s.size() + 16);
    out.push_back('"');
    for (char c : s) {
      switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
          if (static_cast<unsigned char>(c) < 0x20) {
            char buf[8];
            snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned char>(c));
            out += buf;
          } else {
            out.push_back(c);
          }
          break;
      }
    }
    out.push_back('"');
    return out;
  }

  std::string serialize() const {
    std::string out;
    serialize_to(out);
    return out;
  }

  void serialize_to(std::string& out) const {
    switch (type) {
      case JsonType::Null:
        out += "null";
        break;
      case JsonType::Bool:
        out += bool_val ? "true" : "false";
        break;
      case JsonType::Number:
        if (is_integer) {
          out += std::to_string(int_val);
        } else {
          char buf[64];
          snprintf(buf, sizeof(buf), "%.10g", num_val);
          out += buf;
        }
        break;
      case JsonType::String:
        out += EscapeString(str_val);
        break;
      case JsonType::Array: {
        out.push_back('[');
        for (size_t i = 0; i < arr_val.size(); ++i) {
          if (i > 0) out.push_back(',');
          arr_val[i].serialize_to(out);
        }
        out.push_back(']');
        break;
      }
      case JsonType::Object: {
        out.push_back('{');
        bool first = true;
        for (const auto& [k, v] : obj_val) {
          if (!first) out.push_back(',');
          first = false;
          out += EscapeString(k);
          out.push_back(':');
          v.serialize_to(out);
        }
        out.push_back('}');
        break;
      }
    }
  }

  static bool Parse(std::string_view s, JsonValue& out, std::string& err) {
    size_t pos = 0;
    skip_whitespace(s, pos);
    if (!parse_value(s, pos, out, err)) return false;
    skip_whitespace(s, pos);
    if (pos < s.size()) {
      err = "Unexpected trailing characters";
      return false;
    }
    return true;
  }

private:
  static void skip_whitespace(std::string_view s, size_t& pos) {
    while (pos < s.size() && (s[pos] == ' ' || s[pos] == '\t' || s[pos] == '\r' || s[pos] == '\n')) {
      ++pos;
    }
  }

  static bool parse_value(std::string_view s, size_t& pos, JsonValue& out, std::string& err) {
    skip_whitespace(s, pos);
    if (pos >= s.size()) {
      err = "Unexpected end of input";
      return false;
    }
    char c = s[pos];
    if (c == 'n') return parse_null(s, pos, out, err);
    if (c == 't' || c == 'f') return parse_bool(s, pos, out, err);
    if (c == '"') return parse_string(s, pos, out, err);
    if (c == '[') return parse_array(s, pos, out, err);
    if (c == '{') return parse_object(s, pos, out, err);
    if (c == '-' || (c >= '0' && c <= '9')) return parse_number(s, pos, out, err);
    err = std::string("Unexpected character: ") + c;
    return false;
  }

  static bool parse_null(std::string_view s, size_t& pos, JsonValue& out, std::string& err) {
    if (s.substr(pos, 4) == "null") {
      pos += 4;
      out = JsonValue();
      return true;
    }
    err = "Invalid literal, expected null";
    return false;
  }

  static bool parse_bool(std::string_view s, size_t& pos, JsonValue& out, std::string& err) {
    if (s.substr(pos, 4) == "true") {
      pos += 4;
      out = JsonValue(true);
      return true;
    }
    if (s.substr(pos, 5) == "false") {
      pos += 5;
      out = JsonValue(false);
      return true;
    }
    err = "Invalid boolean literal";
    return false;
  }

  static bool parse_string(std::string_view s, size_t& pos, JsonValue& out, std::string& err) {
    ++pos; // skip '"'
    std::string res;
    while (pos < s.size()) {
      char c = s[pos++];
      if (c == '"') {
        out = JsonValue(res);
        return true;
      }
      if (c == '\\') {
        if (pos >= s.size()) {
          err = "Unterminated escape sequence";
          return false;
        }
        char esc = s[pos++];
        switch (esc) {
          case '"': res.push_back('"'); break;
          case '\\': res.push_back('\\'); break;
          case '/': res.push_back('/'); break;
          case 'b': res.push_back('\b'); break;
          case 'f': res.push_back('\f'); break;
          case 'n': res.push_back('\n'); break;
          case 'r': res.push_back('\r'); break;
          case 't': res.push_back('\t'); break;
          case 'u': {
            if (pos + 4 > s.size()) {
              err = "Incomplete unicode escape";
              return false;
            }
            uint32_t codepoint = 0;
            for (int i = 0; i < 4; ++i) {
              char h = s[pos++];
              codepoint <<= 4;
              if (h >= '0' && h <= '9') codepoint |= (h - '0');
              else if (h >= 'a' && h <= 'f') codepoint |= (h - 'a' + 10);
              else if (h >= 'A' && h <= 'F') codepoint |= (h - 'A' + 10);
              else { err = "Invalid hex in unicode escape"; return false; }
            }
            // Encode to UTF-8
            if (codepoint < 0x80) {
              res.push_back(static_cast<char>(codepoint));
            } else if (codepoint < 0x800) {
              res.push_back(static_cast<char>(0xC0 | (codepoint >> 6)));
              res.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
            } else {
              res.push_back(static_cast<char>(0xE0 | (codepoint >> 12)));
              res.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
              res.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
            }
            break;
          }
          default:
            res.push_back(esc);
            break;
        }
      } else {
        res.push_back(c);
      }
    }
    err = "Unterminated string";
    return false;
  }

  static bool parse_number(std::string_view s, size_t& pos, JsonValue& out, std::string& err) {
    size_t start = pos;
    if (s[pos] == '-') ++pos;
    bool has_dot = false;
    bool has_exp = false;
    while (pos < s.size()) {
      char c = s[pos];
      if (c >= '0' && c <= '9') {
        ++pos;
      } else if (c == '.' && !has_dot && !has_exp) {
        has_dot = true;
        ++pos;
      } else if ((c == 'e' || c == 'E') && !has_exp) {
        has_exp = true;
        ++pos;
        if (pos < s.size() && (s[pos] == '+' || s[pos] == '-')) ++pos;
      } else {
        break;
      }
    }
    std::string num_str(s.substr(start, pos - start));
    if (has_dot || has_exp) {
      try {
        double d = std::stod(num_str);
        out = JsonValue(d);
        return true;
      } catch (...) {
        err = "Malformed floating point number: " + num_str;
        return false;
      }
    } else {
      try {
        int64_t i = std::stoll(num_str);
        out = JsonValue(i);
        return true;
      } catch (...) {
        err = "Malformed integer number: " + num_str;
        return false;
      }
    }
  }

  static bool parse_array(std::string_view s, size_t& pos, JsonValue& out, std::string& err) {
    ++pos; // skip '['
    JsonValue arr = JsonValue::Array();
    skip_whitespace(s, pos);
    if (pos < s.size() && s[pos] == ']') {
      ++pos;
      out = arr;
      return true;
    }
    while (pos < s.size()) {
      JsonValue item;
      if (!parse_value(s, pos, item, err)) return false;
      arr.push_back(item);
      skip_whitespace(s, pos);
      if (pos >= s.size()) break;
      if (s[pos] == ']') {
        ++pos;
        out = arr;
        return true;
      }
      if (s[pos] == ',') {
        ++pos;
        skip_whitespace(s, pos);
      } else {
        err = "Expected ',' or ']' in array";
        return false;
      }
    }
    err = "Unterminated array";
    return false;
  }

  static bool parse_object(std::string_view s, size_t& pos, JsonValue& out, std::string& err) {
    ++pos; // skip '{'
    JsonValue obj = JsonValue::Object();
    skip_whitespace(s, pos);
    if (pos < s.size() && s[pos] == '}') {
      ++pos;
      out = obj;
      return true;
    }
    while (pos < s.size()) {
      skip_whitespace(s, pos);
      if (pos >= s.size() || s[pos] != '"') {
        err = "Expected key string in object";
        return false;
      }
      JsonValue key_val;
      if (!parse_string(s, pos, key_val, err)) return false;
      skip_whitespace(s, pos);
      if (pos >= s.size() || s[pos] != ':') {
        err = "Expected ':' after key in object";
        return false;
      }
      ++pos; // skip ':'
      JsonValue val;
      if (!parse_value(s, pos, val, err)) return false;
      obj.set(key_val.str_val, val);
      skip_whitespace(s, pos);
      if (pos >= s.size()) break;
      if (s[pos] == '}') {
        ++pos;
        out = obj;
        return true;
      }
      if (s[pos] == ',') {
        ++pos;
      } else {
        err = "Expected ',' or '}' in object";
        return false;
      }
    }
    err = "Unterminated object";
    return false;
  }
};

struct JsonRpcRequest {
  JsonValue id;
  std::string method;
  JsonValue params;
  bool is_notification = false;
};

struct JsonRpcResponse {
  JsonValue id;
  JsonValue result;
  bool has_error = false;
  int error_code = 0;
  std::string error_message;
  JsonValue error_data;

  std::string serialize() const {
    JsonValue resp = JsonValue::Object();
    resp.set("jsonrpc", JsonValue("2.0"));
    resp.set("id", id);
    if (has_error) {
      JsonValue err = JsonValue::Object();
      err.set("code", JsonValue(error_code));
      err.set("message", JsonValue(error_message));
      if (!error_data.is_null()) err.set("data", error_data);
      resp.set("error", err);
    } else {
      resp.set("result", result);
    }
    return resp.serialize();
  }

  static JsonRpcResponse Success(const JsonValue& id, const JsonValue& res) {
    JsonRpcResponse r;
    r.id = id;
    r.result = res;
    return r;
  }

  static JsonRpcResponse Error(const JsonValue& id, int code, const std::string& msg, const JsonValue& data = JsonValue()) {
    JsonRpcResponse r;
    r.id = id;
    r.has_error = true;
    r.error_code = code;
    r.error_message = msg;
    r.error_data = data;
    return r;
  }
};

inline bool ParseJsonRpcRequest(const std::string& line, JsonRpcRequest& req, std::string& err) {
  JsonValue doc;
  if (!JsonValue::Parse(line, doc, err)) return false;
  if (!doc.is_object()) {
    err = "JSON-RPC request must be an object";
    return false;
  }
  const auto* method_node = doc.find("method");
  if (!method_node || !method_node->is_string()) {
    err = "Missing or invalid 'method'";
    return false;
  }
  req.method = method_node->str_val;
  const auto* id_node = doc.find("id");
  if (id_node) {
    req.id = *id_node;
    req.is_notification = false;
  } else {
    req.id = JsonValue();
    req.is_notification = true;
  }
  const auto* params_node = doc.find("params");
  req.params = params_node ? *params_node : JsonValue::Object();
  return true;
}

class SidecarSecurityGuard {
public:
  static SidecarSecurityGuard& Instance() {
    static SidecarSecurityGuard guard;
    return guard;
  }

  bool IsAuthRequired() const {
    return require_auth_;
  }

  bool IsAuthenticated() const {
    return authenticated_;
  }

  bool Authenticate(const std::string& token) {
    if (!require_auth_) return true;
    if (token.empty() || token != expected_token_) {
      return false;
    }
    authenticated_ = true;
    return true;
  }

  bool CheckAccess(const std::string& method) const {
    if (!require_auth_ || authenticated_) return true;
    return (method == "ping" || method == "handshake");
  }

  void Reset(const std::string& new_token = "") {
    if (!new_token.empty()) {
      expected_token_ = new_token;
      require_auth_ = true;
      authenticated_ = false;
    } else {
#if defined(_WIN32)
      char env_buf[512] = {0};
      DWORD len = GetEnvironmentVariableA("ZTOOLS_SIDECAR_TOKEN", env_buf, sizeof(env_buf));
      if (len > 0 && len < sizeof(env_buf)) {
        expected_token_ = std::string(env_buf, len);
        require_auth_ = true;
        authenticated_ = false;
      } else {
        expected_token_ = "";
        require_auth_ = false;
        authenticated_ = true;
      }
#else
      const char* token = std::getenv("ZTOOLS_SIDECAR_TOKEN");
      if (token && token[0] != '\0') {
        expected_token_ = token;
        require_auth_ = true;
        authenticated_ = false;
      } else {
        expected_token_ = "";
        require_auth_ = false;
        authenticated_ = true;
      }
#endif
    }
  }

private:
  SidecarSecurityGuard() {
    Reset();
  }

  std::string expected_token_;
  bool require_auth_ = false;
  bool authenticated_ = false;
};

using RpcHandler = std::function<JsonRpcResponse(const JsonRpcRequest&)>;

inline bool DispatchRpcRequest(
  const JsonRpcRequest& req,
  RpcHandler handler,
  JsonRpcResponse& out_resp,
  bool& out_should_shutdown
) {
  out_should_shutdown = false;

  if (req.method == "shutdown") {
    if (!req.is_notification) {
      out_resp = JsonRpcResponse::Success(req.id, JsonValue("bye"));
    }
    out_should_shutdown = true;
    return true;
  }

  if (req.method == "handshake") {
    std::string token = req.params.get_string("token");
    if (SidecarSecurityGuard::Instance().Authenticate(token)) {
      JsonValue auth_res = JsonValue::Object();
      auth_res.set("authenticated", JsonValue(true));
      auth_res.set("protocol", JsonValue("ztools-sidecar-v1"));
      out_resp = JsonRpcResponse::Success(req.id, auth_res);
    } else {
      out_resp = JsonRpcResponse::Error(req.id, -32002, "Invalid handshake token");
    }
    return true;
  }

  if (!SidecarSecurityGuard::Instance().CheckAccess(req.method)) {
    out_resp = JsonRpcResponse::Error(req.id, -32001, "Access denied: Sidecar authentication required");
    return true;
  }

  out_resp = handler(req);
  return true;
}

inline void RunLineRpcLoop(std::istream& input, std::ostream& output, RpcHandler handler) {
  std::string line;
  while (std::getline(input, line)) {
    if (line.empty() || line == "\r") continue;
    if (!line.empty() && line.back() == '\r') line.pop_back();

    JsonRpcRequest req;
    std::string err;
    if (!ParseJsonRpcRequest(line, req, err)) {
      JsonRpcResponse err_resp = JsonRpcResponse::Error(JsonValue(), -32700, "Parse error: " + err);
      output << err_resp.serialize() << "\n";
      output.flush();
      continue;
    }

    JsonRpcResponse resp;
    bool should_shutdown = false;
    DispatchRpcRequest(req, handler, resp, should_shutdown);

    if (!req.is_notification) {
      output << resp.serialize() << "\n";
      output.flush();
    }

    if (should_shutdown) {
      break;
    }
  }
}

} // namespace ztools::sidecar

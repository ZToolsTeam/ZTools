#pragma once
#include <string>
#include <array>
#include <cstddef>
#include <utility>

/**
 * @file obf_str.hpp
 * @brief ZTools 编译期字符串混淆宏 (Anti-REA / Anti-Static Analysis)
 * 
 * 原理：
 * 1. 利用 C++20 consteval 在编译期生成随机/伪随机 XOR 密钥；
 * 2. 编译产物中的 .rdata / .data 段只存在加密后的字节数组，使用 strings 或 IDA 静态扫描找不到明文字符串；
 * 3. 运行时调用瞬间在栈上即时解密，用完即随栈帧销毁。
 */

namespace ztools::security {

template <size_t N, uint8_t Key>
class ObfuscatedString {
public:
    consteval ObfuscatedString(const char(&str)[N]) {
        for (size_t i = 0; i < N; ++i) {
            data_[i] = static_cast<uint8_t>(str[i] ^ (Key + static_cast<uint8_t>(i * 7)));
        }
    }

    std::string decrypt() const {
        std::string result;
        result.resize(N - 1);
        for (size_t i = 0; i < N - 1; ++i) {
            result[i] = static_cast<char>(data_[i] ^ (Key + static_cast<uint8_t>(i * 7)));
        }
        return result;
    }

    consteval size_t size() const {
        return N - 1;
    }

private:
    std::array<uint8_t, N> data_{};
};

// 编译期生成伪随机种子 (基于 __TIME__ 与行号)
consteval uint8_t generate_compile_seed(int line) {
    uint8_t hash = 0x5A;
    const char time_str[] = __TIME__;
    for (char c : time_str) {
        hash = static_cast<uint8_t>((hash * 33) ^ static_cast<uint8_t>(c));
    }
    return static_cast<uint8_t>(hash ^ static_cast<uint8_t>(line));
}

} // namespace ztools::security

/**
 * @def OBF_STR(str)
 * 编译期混淆字符串宏，返回运行时解密后的 std::string
 */
#define OBF_STR(str) []() -> std::string { \
    constexpr uint8_t seed = ::ztools::security::generate_compile_seed(__LINE__); \
    constexpr ::ztools::security::ObfuscatedString<sizeof(str), seed> obf(str); \
    return obf.decrypt(); \
}()

#include "validation.hpp"
#include <iostream>
#include <limits>
#include <string>

int main() {
    using namespace ztools::clipboard;
    std::size_t cases = 0;
    auto check = [&](bool condition) { ++cases; return condition; };
    if (!check(valid_local_path("/tmp/space name%#.txt")) ||
        !check(valid_local_path(u8"/tmp/中文-é-😀.txt")) ||
        !check(valid_local_path("/")) ||
        !check(!valid_local_path("")) ||
        !check(!valid_local_path("relative")) ||
        !check(!valid_local_path("//remote/file")) ||
        !check(!valid_local_path("file:///tmp/file")) ||
        !check(!valid_local_path(std::string_view("/tmp/a\0b", 8))) ||
        !check(valid_local_path("/" + std::string(max_path_bytes - 1, 'x'))) ||
        !check(!valid_local_path("/" + std::string(max_path_bytes, 'x'))) ||
        !check(valid_count(0, false)) ||
        !check(!valid_count(0, true)) ||
        !check(valid_count(max_paths, true)) ||
        !check(!valid_count(max_paths + 1, false)) ||
        !check(valid_message_size(max_message_bytes - 1, 1)) ||
        !check(!valid_message_size(max_message_bytes, 1)) ||
        !check(!valid_message_size(std::numeric_limits<std::size_t>::max(), 1)) ||
        !check(!valid_message_size(1, std::numeric_limits<std::size_t>::max()))) return 1;
    std::cout << "{\"version\":1,\"status\":\"PASS\",\"scope\":\"portable-clipboard-validation-core\",\"cases\":" << cases << "}\n";
    return 0;
}

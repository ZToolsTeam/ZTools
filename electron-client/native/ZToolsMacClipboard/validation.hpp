#pragma once
#include <cstddef>
#include <string_view>

namespace ztools::clipboard {
inline constexpr std::size_t max_path_bytes = 4096;
inline constexpr std::size_t max_paths = 1024;
inline constexpr std::size_t max_message_bytes = 128 * 1024;

// NSString -> UTF-8 conversion belongs to the AppKit bridge; this core validates bytes.
inline bool valid_local_path(std::string_view value) noexcept {
    return !value.empty() && value.front() == '/' &&
        (value.size() < 2 || value[1] != '/') && value.size() <= max_path_bytes &&
        value.find('\0') == std::string_view::npos;
}
inline bool valid_count(std::size_t count, bool write) noexcept {
    return count <= max_paths && (!write || count != 0);
}
inline bool valid_message_size(std::size_t accumulated, std::size_t incoming) noexcept {
    // Subtraction after the first bound check avoids size_t addition overflow.
    return accumulated <= max_message_bytes && incoming <= max_message_bytes - accumulated;
}
}

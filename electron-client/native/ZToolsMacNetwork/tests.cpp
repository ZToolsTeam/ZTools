#include "neighbors.hpp"
#include <cassert>
#include <iostream>

static std::vector<unsigned char> record(unsigned int index = 7) {
    rt_msghdr header{};
    header.rtm_version = RTM_VERSION;
    header.rtm_index = index;
    header.rtm_flags = RTF_LLINFO;
    header.rtm_addrs = RTA_DST | RTA_GATEWAY;
    sockaddr_in ip{};
    ip.sin_len = sizeof(ip);
    ip.sin_family = AF_INET;
    inet_pton(AF_INET, "192.0.2.5", &ip.sin_addr);
    sockaddr_dl link{};
    link.sdl_len = sizeof(link);
    link.sdl_family = AF_LINK;
    link.sdl_index = index;
    link.sdl_nlen = 3;
    link.sdl_alen = 6;
    const unsigned char mac[] = {2, 1, 2, 3, 4, 5};
    std::memcpy(link.sdl_data, "en0", 3);
    std::memcpy(link.sdl_data + 3, mac, 6);
    header.rtm_msglen = sizeof(header) + sizeof(ip) + sizeof(link);
    std::vector<unsigned char> bytes(header.rtm_msglen);
    std::memcpy(bytes.data(), &header, sizeof(header));
    std::memcpy(bytes.data() + sizeof(header), &ip, sizeof(ip));
    std::memcpy(bytes.data() + sizeof(header) + sizeof(ip), &link, sizeof(link));
    return bytes;
}

int main() {
    const auto valid = record();
    const auto entries = ztools::parseNeighbors(valid, 7);
    assert(entries.size() == 1 && entries[0].ip == "192.0.2.5" && entries[0].mac == "02:01:02:03:04:05");
    assert(ztools::parseNeighbors(valid, 8).empty());
    assert(ztools::parseNeighbors({}, 7).empty());
    for (size_t length = 1; length < valid.size(); ++length) {
        bool rejected = false;
        try { ztools::parseNeighbors({valid.begin(), valid.begin() + length}, 7); }
        catch (const std::runtime_error&) { rejected = true; }
        assert(rejected);
    }
    const size_t gateway = sizeof(rt_msghdr) + sizeof(sockaddr_in);
    const size_t mac = gateway + offsetof(sockaddr_dl, sdl_data) + 3;
    for (const auto value : {0, 1, 255}) {
        auto bytes = valid;
        if (value == 0) std::memset(bytes.data() + mac, 0, 6);
        else bytes[mac] = value;
        assert(ztools::parseNeighbors(bytes, 7).empty());
    }
    auto redacted = valid;
    std::memset(redacted.data() + mac, 0, 6); redacted[mac] = 2;
    assert(ztools::parseNeighbors(redacted, 7).empty());
    for (const auto field : {offsetof(sockaddr_dl, sdl_alen), offsetof(sockaddr_dl, sdl_nlen)}) {
        auto bytes = valid; bytes[gateway + field] = 200;
        assert(ztools::parseNeighbors(bytes, 7).empty());
    }
    auto combined = valid;
    const auto other = record(8);
    combined.insert(combined.end(), other.begin(), other.end());
    assert(ztools::parseNeighbors(combined, 7).size() == 1);
    for (const size_t offset : {size_t(0), sizeof(rt_msghdr), gateway}) {
        auto bytes = valid; bytes[offset] = 255;
        bool rejected = false;
        try { ztools::parseNeighbors(bytes, 7); } catch (const std::runtime_error&) { rejected = true; }
        assert(rejected);
    }
    std::cout << "邻居表解析：有效、多网卡、逐字节截断、越界、无效及脱敏 MAC 测试通过\n";
}

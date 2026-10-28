#pragma once
#include <arpa/inet.h>
#include <net/if_dl.h>
#include <net/route.h>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace ztools {
struct Neighbor { std::string ip; std::string mac; };

// Darwin 路由消息内的 sockaddr 按 32 位边界排列；不要按当前 CPU 的指针宽度对齐。
inline std::vector<Neighbor> parseNeighbors(const std::vector<unsigned char>& bytes, unsigned int interfaceIndex) {
    std::vector<Neighbor> result;
    size_t position = 0;
    while (position < bytes.size()) {
        if (bytes.size() - position < sizeof(rt_msghdr)) throw std::runtime_error("INVALID_ROUTE_TABLE");
        rt_msghdr header{};
        std::memcpy(&header, bytes.data() + position, sizeof(header));
        if (header.rtm_msglen < sizeof(header) || header.rtm_msglen > bytes.size() - position || header.rtm_version != RTM_VERSION)
            throw std::runtime_error("INVALID_ROUTE_TABLE");
        const size_t end = position + header.rtm_msglen;
        size_t cursor = position + sizeof(header);
        const unsigned char* destination = nullptr;
        const unsigned char* gateway = nullptr;
        for (int slot = 0; slot < RTAX_MAX; ++slot) {
            if (!(header.rtm_addrs & (1 << slot))) continue;
            if (end - cursor < 2) throw std::runtime_error("INVALID_ROUTE_TABLE");
            const auto* address = bytes.data() + cursor;
            const size_t length = address[0];
            const size_t stride = length ? (length + 3) & ~size_t(3) : 4;
            if (stride > end - cursor) throw std::runtime_error("INVALID_ROUTE_TABLE");
            if (slot == RTAX_DST) destination = address;
            if (slot == RTAX_GATEWAY) gateway = address;
            cursor += stride;
        }
        position = end;
        if (!(header.rtm_flags & RTF_LLINFO) || header.rtm_index != interfaceIndex || !destination || !gateway) continue;
        if (destination[0] < sizeof(sockaddr_in) || destination[1] != AF_INET || gateway[0] < offsetof(sockaddr_dl, sdl_data) || gateway[1] != AF_LINK) continue;
        sockaddr_in ip{};
        std::memcpy(&ip, destination, sizeof(ip));
        unsigned short linkIndex = 0;
        std::memcpy(&linkIndex, gateway + offsetof(sockaddr_dl, sdl_index), sizeof(linkIndex));
        const size_t macOffset = offsetof(sockaddr_dl, sdl_data) + gateway[offsetof(sockaddr_dl, sdl_nlen)];
        if (linkIndex != interfaceIndex || gateway[offsetof(sockaddr_dl, sdl_alen)] != 6 || macOffset + 6 > gateway[0]) continue;
        const auto* mac = gateway + macOffset;
        const unsigned char zero[6] = {}, redacted[6] = {2, 0, 0, 0, 0, 0};
        if ((mac[0] & 1) || !std::memcmp(mac, zero, 6) || !std::memcmp(mac, redacted, 6)) continue;
        const auto host = ntohl(ip.sin_addr.s_addr);
        if (host == 0 || host >= 0xe0000000U) continue;
        char ipText[INET_ADDRSTRLEN]{}, macText[18]{};
        if (!inet_ntop(AF_INET, &ip.sin_addr, ipText, sizeof(ipText))) throw std::runtime_error("ADDRESS_FORMAT_FAILED");
        std::snprintf(macText, sizeof(macText), "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
        result.push_back({ipText, macText});
    }
    return result;
}
}

#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <Security/SecTask.h>
#include <sys/sysctl.h>
#include <net/if.h>
#include <cerrno>
#include "neighbors.hpp"

static bool topologyAuthorized() {
    SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
    if (!task) return false;
    CFTypeRef value = SecTaskCopyValueForEntitlement(task, CFSTR("com.apple.developer.networking.topology-observation"), nullptr);
    const bool allowed = value && CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue(static_cast<CFBooleanRef>(value));
    if (value) CFRelease(value);
    CFRelease(task);
    return allowed;
}

static std::vector<unsigned char> readNeighbors() {
    int mib[] = {CTL_NET, PF_ROUTE, 0, AF_INET, NET_RT_FLAGS, RTF_LLINFO};
    for (int attempt = 0; attempt < 3; ++attempt) {
        size_t length = 0;
        if (sysctl(mib, 6, nullptr, &length, nullptr, 0) != 0) throw std::runtime_error("ROUTE_READ_FAILED");
        if (length > 8 * 1024 * 1024) throw std::runtime_error("ROUTE_TABLE_TOO_LARGE");
        if (!length) return {};
        std::vector<unsigned char> bytes(length);
        if (sysctl(mib, 6, bytes.data(), &length, nullptr, 0) == 0) {
            if (length > bytes.size()) throw std::runtime_error("INVALID_ROUTE_TABLE");
            bytes.resize(length);
            return bytes;
        }
        if (errno != ENOMEM) throw std::runtime_error("ROUTE_READ_FAILED");
    }
    throw std::runtime_error("ROUTE_TABLE_CHANGED");
}

int main(int argc, const char* argv[]) {
    @autoreleasepool {
        NSDictionary* reply;
        try {
            if (argc != 2 || !argv[1][0] || std::strlen(argv[1]) >= IFNAMSIZ || std::strspn(argv[1], "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-") != std::strlen(argv[1]))
                throw std::runtime_error("INVALID_INTERFACE");
            const unsigned int index = if_nametoindex(argv[1]);
            if (!index) throw std::runtime_error("INTERFACE_UNAVAILABLE");
            // 缺少正式授权时明确拒绝，不借用终端或管理员上下文规避系统隐私规则。
            if (@available(macOS 27.0, *)) {
                if (!topologyAuthorized()) throw std::runtime_error("TOPOLOGY_PERMISSION_REQUIRED");
            }
            NSMutableArray* entries = [NSMutableArray array];
            for (const auto& item : ztools::parseNeighbors(readNeighbors(), index)) {
                [entries addObject:@{@"ip": @(item.ip.c_str()), @"mac": @(item.mac.c_str())}];
            }
            if (if_nametoindex(argv[1]) != index) throw std::runtime_error("INTERFACE_UNAVAILABLE");
            reply = @{@"version": @1, @"success": @YES, @"entries": entries};
        } catch (const std::exception& error) {
            reply = @{@"version": @1, @"success": @NO, @"code": @(error.what())};
        }
        NSError* error = nil;
        NSData* json = [NSJSONSerialization dataWithJSONObject:reply options:0 error:&error];
        if (!json || error) return 1;
        return std::fwrite(json.bytes, 1, json.length, stdout) == json.length ? 0 : 1;
    }
}

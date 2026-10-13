#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#include <unistd.h>
#include <cstring>
#include "validation.hpp"

static constexpr NSUInteger limit = ztools::clipboard::max_message_bytes;

static BOOL validPaths(id paths) {
    if (![paths isKindOfClass:[NSArray class]] || !ztools::clipboard::valid_count([paths count], false)) return NO;
    for (id item in paths) {
        if (![item isKindOfClass:[NSString class]]) return NO;
        NSData *bytes = [item dataUsingEncoding:NSUTF8StringEncoding allowLossyConversion:NO];
        if (!bytes || bytes.length == 0 || !ztools::clipboard::valid_local_path(std::string_view(static_cast<const char *>(bytes.bytes), bytes.length))) return NO;
    }
    return YES;
}

static int selfTest() {
    // No NSPasteboard access: these tests are safe in a build/test account.
    NSUInteger cases = 0;
    NSArray *accepted = @[@[], @[@"/tmp/空 格%#é.txt"], @[@"/tmp/e\u0301.txt"]];
    for (id item in accepted) { if (!validPaths(item)) return 4; ++cases; }
    NSString *nul = [NSString stringWithFormat:@"/tmp/%Cx", (unichar)0];
    NSArray *rejected = @[@"not-array", @[@"relative"], @[@"//server/x"], @[@"file:///tmp/x"],
        @[nul], @[[NSString stringWithFormat:@"/%@", [@"x" stringByPaddingToLength:4096 withString:@"x" startingAtIndex:0]]], @[@1]];
    for (id item in rejected) { if (validPaths(item)) return 4; ++cases; }
    NSMutableArray *many = [NSMutableArray array];
    for (NSUInteger i = 0; i < 1025; ++i) [many addObject:@"/x"];
    if (validPaths(many)) return 4;
    ++cases;
#if defined(__arm64__)
    NSString *arch = @"arm64";
#elif defined(__x86_64__)
    NSString *arch = @"x64";
#else
    return 4;
#endif
    NSData *output = [NSJSONSerialization dataWithJSONObject:@{@"version": @1, @"success": @YES,
        @"scope": @"clipboard-native-validation", @"architecture": arch, @"cases": @(cases)} options:0 error:nil];
    [[NSFileHandle fileHandleWithStandardOutput] writeData:output];
    return 0;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && std::strcmp(argv[1], "--self-test") == 0) return selfTest();
        if (argc != 1) return 2;
        NSMutableData *input = [NSMutableData data];
        unsigned char buffer[4096];
        ssize_t count;
        while ((count = read(STDIN_FILENO, buffer, sizeof(buffer))) > 0) {
            if (!ztools::clipboard::valid_message_size(input.length, (NSUInteger)count)) return 2;
            [input appendBytes:buffer length:(NSUInteger)count];
        }
        if (count < 0) return 2;
        id request = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
        if (![request isKindOfClass:[NSDictionary class]] || ![request[@"version"] isEqual:@1] ||
            CFGetTypeID((__bridge CFTypeRef)request[@"version"]) == CFBooleanGetTypeID()) return 2;
        NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
        NSDictionary *response;
        if ([request[@"mode"] isEqual:@"read"] && [request count] == 2) {
            NSArray *urls = [pasteboard readObjectsForClasses:@[[NSURL class]]
                options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
            if (!urls || !ztools::clipboard::valid_count(urls.count, false)) return 3;
            NSMutableArray *paths = [NSMutableArray array];
            for (NSURL *url in urls) {
                if (!url.isFileURL || (url.host.length && ![url.host isEqual:@"localhost"])) return 3;
                if (!url.path) return 3;
                [paths addObject:url.path];
            }
            if (!validPaths(paths)) return 3;
            response = @{@"version": @1, @"success": @YES, @"paths": paths};
        } else if ([request[@"mode"] isEqual:@"write"] && [request count] == 3 &&
                   validPaths(request[@"paths"]) && ztools::clipboard::valid_count([request[@"paths"] count], true)) {
            NSMutableArray *urls = [NSMutableArray array];
            for (NSString *item in request[@"paths"]) [urls addObject:[NSURL fileURLWithPath:item]];
            [pasteboard clearContents];
            if (![pasteboard writeObjects:urls]) return 3;
            response = @{@"version": @1, @"success": @YES};
        } else return 2;
        NSData *output = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
        if (!output || output.length > limit) return 3;
        [[NSFileHandle fileHandleWithStandardOutput] writeData:output];
        return 0;
    }
}

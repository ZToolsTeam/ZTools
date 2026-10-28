#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#include <unistd.h>
#include <signal.h>
#include <thread>
#include <string>
#include <atomic>
#include "paste_session.h"

// 此进程只保存应用身份与 AX 对象引用，从不读取输入内容或剪贴板内容。
@interface ZTPasteSession : NSObject {
@public
    std::atomic_bool disconnected;
    std::atomic_bool queued;
    AXObserverRef focusObserver;
}
@property pid_t ownerPid;
@property NSRunningApplication *previous;
@property id previousWindow;
@property id previousElement;
@property NSRunningApplication *observed;
@property NSUInteger generation;
@property NSUInteger focusGeneration;
@property NSString *observationError;
@property NSRunningApplication *target;
@property id targetWindow;
@property id targetElement;
@property NSInteger pasteboardCount;
@property NSInteger token;
@property NSTimeInterval deadline;
@property id observer;
- (void)start;
- (void)activated:(NSRunningApplication *)app;
- (void)focusChanged;
- (void)stopObserving;
- (void)observePrevious;
- (void)retry:(void (^)(void))operation;
- (void)settle:(NSRunningApplication *)app generation:(NSUInteger)generation focusGeneration:(NSUInteger)focusGeneration attempts:(NSUInteger)attempts deadline:(NSTimeInterval)deadline;
- (NSString *)validateTarget;
- (NSString *)dispatchPaste;
- (NSDictionary *)handle:(NSDictionary *)request;
@end

static void focusNotification(AXObserverRef observer, AXUIElementRef, CFStringRef, void *context) {
    ZTPasteSession *session = (__bridge ZTPasteSession *)context;
    if (observer == session->focusObserver) [session focusChanged];
}

static id focusedAttribute(NSRunningApplication *app, CFStringRef attribute) {
    if (!app || app.terminated) return nil;
    AXUIElementRef root = AXUIElementCreateApplication(app.processIdentifier);
    AXUIElementSetMessagingTimeout(root, 0.2f);
    CFTypeRef result = nullptr;
    AXError error = AXUIElementCopyAttributeValue(root, attribute, &result);
    CFRelease(root);
    if (error != kAXErrorSuccess || !result) return nil;
    if (CFGetTypeID(result) != AXUIElementGetTypeID()) { CFRelease(result); return nil; }
    return CFBridgingRelease(result);
}

static BOOL sameApp(NSRunningApplication *a, NSRunningApplication *b) {
    // NSRunningApplication 的相等比较同时区分同 PID 的不同进程实例。
    return a && b && !a.terminated && !b.terminated && [a isEqual:b];
}

static NSRunningApplication *activeApplication() {
    // AX 调用期间主 RunLoop 可能尚未分发切换通知，不依赖 NSWorkspace 的缓存。
    AXUIElementRef system = AXUIElementCreateSystemWide();
    AXUIElementSetMessagingTimeout(system, 0.2f);
    CFTypeRef focused = nullptr;
    AXError result = AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute, &focused);
    CFRelease(system);
    if (result != kAXErrorSuccess || !focused) return nil;
    pid_t pid = 0;
    if (CFGetTypeID(focused) == AXUIElementGetTypeID()) AXUIElementGetPid((AXUIElementRef)focused, &pid);
    CFRelease(focused);
    return pid > 0 ? [NSRunningApplication runningApplicationWithProcessIdentifier:pid] : nil;
}

static int pasteKey(const UCKeyboardLayout *layout) {
    if (!layout) return -1;
    // 使用 Command 下的实际字符映射，兼容 Dvorak 与 Dvorak-QWERTY Command。
    for (UInt16 code = 0; code < 128; ++code) {
        UInt32 dead = 0; UniChar text[4]; UniCharCount length = 0;
        OSStatus result = UCKeyTranslate(layout, code, kUCKeyActionDisplay, cmdKey >> 8,
            LMGetKbdType(), kUCKeyTranslateNoDeadKeysMask, &dead, 4, &length, text);
        if (result == noErr && length == 1 && (text[0] == 'v' || text[0] == 'V')) return code;
    }
    return -1;
}

static int currentPasteKey() {
    TISInputSourceRef source = TISCopyCurrentKeyboardLayoutInputSource();
    CFDataRef data = source ? (CFDataRef)TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) : nullptr;
    int key = pasteKey(data ? (const UCKeyboardLayout *)CFDataGetBytePtr(data) : nullptr);
    if (source) CFRelease(source);
    return key;
}

@implementation ZTPasteSession
- (void)clearTarget {
    self.token = 0; self.target = nil; self.targetWindow = nil; self.targetElement = nil;
}
- (void)start {
    disconnected.store(false); queued.store(false);
    NSWorkspace *workspace = [NSWorkspace sharedWorkspace];
    NSRunningApplication *front = workspace.frontmostApplication;
    __weak ZTPasteSession *weakSelf = self;
    self.observer = [workspace.notificationCenter addObserverForName:NSWorkspaceDidActivateApplicationNotification
        object:nil queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification *note) {
        ZTPasteSession *session = weakSelf;
        NSRunningApplication *app = note.userInfo[NSWorkspaceApplicationKey];
        [session activated:app];
    }];
    [self activated:front];
}
- (BOOL)trusted { return AXIsProcessTrusted(); }
- (BOOL)canPostEvents { return CGPreflightPostEventAccess(); }
- (BOOL)parentAlive { return getppid() == self.ownerPid; }
- (NSTimeInterval)uptime { return NSProcessInfo.processInfo.systemUptime; }
- (NSInteger)clipboardCount { return NSPasteboard.generalPasteboard.changeCount; }
- (NSRunningApplication *)activeApp { return activeApplication(); }
- (id)focusForApp:(NSRunningApplication *)app attribute:(CFStringRef)attribute { return focusedAttribute(app, attribute); }
- (id)focus:(CFStringRef)attribute { return [self focusForApp:self.target attribute:attribute]; }
- (void)stopObserving {
    if (focusObserver) {
        AXUIElementRef root = self.observed ? AXUIElementCreateApplication(self.observed.processIdentifier) : nullptr;
        if (root) {
            AXObserverRemoveNotification(focusObserver, root, kAXFocusedWindowChangedNotification);
            AXObserverRemoveNotification(focusObserver, root, kAXFocusedUIElementChangedNotification);
            CFRelease(root);
        }
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(focusObserver), kCFRunLoopCommonModes);
        CFRelease(focusObserver); focusObserver = nullptr;
    }
    self.observed = nil;
}
- (void)observePrevious {
    if (sameApp(self.observed, self.previous)) return;
    [self stopObserving]; self.observationError = nil;
    if (!self.previous || ![self trusted]) return;
    self.observed = self.previous;
    if (AXObserverCreate(self.previous.processIdentifier, focusNotification, &focusObserver) != kAXErrorSuccess) {
        focusObserver = nullptr; self.observed = nil;
        self.observationError = @"PASTE_FOCUS_OBSERVER_UNAVAILABLE"; return;
    }
    AXUIElementRef root = AXUIElementCreateApplication(self.previous.processIdentifier);
    AXUIElementSetMessagingTimeout(root, 0.2f);
    AXError window = AXObserverAddNotification(focusObserver, root, kAXFocusedWindowChangedNotification, (__bridge void *)self);
    AXError element = AXObserverAddNotification(focusObserver, root, kAXFocusedUIElementChangedNotification, (__bridge void *)self);
    CFRelease(root);
    if (window != kAXErrorSuccess || element != kAXErrorSuccess) {
        [self stopObserving]; self.observationError = @"PASTE_FOCUS_OBSERVER_UNAVAILABLE"; return;
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(focusObserver), kCFRunLoopCommonModes);
}
- (void)retry:(void (^)(void))operation {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 25 * NSEC_PER_MSEC), dispatch_get_main_queue(), operation);
}
- (void)focusChanged {
    if (!sameApp(self.observed, self.previous) || !sameApp([self activeApp], self.previous)) return;
    self.previousWindow = nil; self.previousElement = nil;
    // 焦点刷新只能废弃旧焦点查询，不能撤销尚在等待 AX 更新的宿主激活事件。
    [self settle:self.previous generation:self.generation focusGeneration:++self.focusGeneration attempts:6 deadline:[self uptime] + 1.0];
}
- (void)activated:(NSRunningApplication *)app {
    // 新激活代数废弃所有旧重试；返回冻结的目标时，许可仍交给发送前校验判断。
    if (!self.token || !sameApp(app, self.target)) [self clearTarget];
    if (app.processIdentifier != self.ownerPid) {
        [self stopObserving]; self.previous = nil; self.previousWindow = nil; self.previousElement = nil;
    }
    [self settle:app generation:++self.generation focusGeneration:++self.focusGeneration attempts:6 deadline:[self uptime] + 1.0];
}
- (void)settle:(NSRunningApplication *)app generation:(NSUInteger)generation focusGeneration:(NSUInteger)focusGeneration attempts:(NSUInteger)attempts deadline:(NSTimeInterval)deadline {
    if (generation != self.generation || disconnected.load() || ![self parentAlive] || [self uptime] > deadline) return;
    if (app.processIdentifier != self.ownerPid && focusGeneration != self.focusGeneration) return;
    BOOL current = sameApp(app, [self activeApp]);
    if (current && app.processIdentifier == self.ownerPid) {
        [self stopObserving];
        if (self.previous.terminated || ![self trusted]) return;
        self.target = self.previous;
        self.targetWindow = self.previousWindow; self.targetElement = self.previousElement;
        return;
    }
    if (current && app.activationPolicy == NSApplicationActivationPolicyRegular && [self trusted]) {
        self.previous = app; [self observePrevious];
        // 一次查询的两个引用同时成功才发布；查询期间切走、超时或退出都不能复用旧引用。
        self.previousWindow = nil; self.previousElement = nil;
        id window = [self focusForApp:app attribute:kAXFocusedWindowAttribute];
        id element = [self focusForApp:app attribute:kAXFocusedUIElementAttribute];
        if (generation != self.generation || focusGeneration != self.focusGeneration || disconnected.load() || ![self parentAlive] || [self uptime] > deadline || !sameApp(app, [self activeApp])) return;
        if (window && element) { self.previousWindow = window; self.previousElement = element; return; }
    }
    if (attempts <= 1) return;
    __weak ZTPasteSession *weakSelf = self;
    [self retry:^{ [weakSelf settle:app generation:generation focusGeneration:focusGeneration attempts:attempts - 1 deadline:deadline]; }];
}
- (NSString *)prepareFailure {
    if ([self activeApp].processIdentifier != self.ownerPid) return @"PASTE_HOST_NOT_ACTIVE";
    if (!self.target || self.target.terminated) return @"PASTE_TARGET_APP_UNAVAILABLE";
    if (!self.targetWindow) return self.observationError ?: @"PASTE_TARGET_WINDOW_UNAVAILABLE";
    if (!self.targetElement) return self.observationError ?: @"PASTE_TARGET_ELEMENT_UNAVAILABLE";
    return nil;
}
/* 发送前只使用冻结引用，不以最新观察结果替换用户当时选中的输入位置。 */
- (NSString *)validateTarget {
    if (![self trusted]) return @"ACCESSIBILITY_PERMISSION_DENIED";
    if (![self canPostEvents]) return @"PASTE_EVENT_PERMISSION_DENIED";
    if (!sameApp([self activeApp], self.target)) return @"PASTE_TARGET_CHANGED";
    id window = [self focus:kAXFocusedWindowAttribute], element = [self focus:kAXFocusedUIElementAttribute];
    if (!window || !element || !self.targetWindow || !self.targetElement ||
        !CFEqual((__bridge CFTypeRef)window, (__bridge CFTypeRef)self.targetWindow) ||
        !CFEqual((__bridge CFTypeRef)element, (__bridge CFTypeRef)self.targetElement)) return @"PASTE_TARGET_CHANGED";
    // AX 查询可能等待目标响应；结束后再次复核前台、剪贴板代次及取消状态。
    if (![self parentAlive] || !sameApp([self activeApp], self.target) ||
        [self clipboardCount] != self.pasteboardCount || [self uptime] > self.deadline) return @"PASTE_TARGET_CHANGED";
    if (![self canPostEvents]) return @"PASTE_EVENT_PERMISSION_DENIED";
    return disconnected.load() ? @"PASTE_SESSION_CLOSED" : nil;
}
- (NSString *)dispatchPaste {
    int key = currentPasteKey();
    if (key < 0) return @"PASTE_KEYBOARD_LAYOUT_UNSUPPORTED";
    CGEventRef down = CGEventCreateKeyboardEvent(nullptr, (CGKeyCode)key, true);
    CGEventRef up = CGEventCreateKeyboardEvent(nullptr, (CGKeyCode)key, false);
    NSString *error = (!down || !up) ? @"PASTE_EVENT_FAILED" : [self validateTarget];
    if (!error) {
        CGEventSetFlags(down, kCGEventFlagMaskCommand); CGEventSetFlags(up, kCGEventFlagMaskCommand);
        CGEventPostToPid(self.target.processIdentifier, down);
        CGEventPostToPid(self.target.processIdentifier, up);
    }
    if (down) CFRelease(down);
    if (up) CFRelease(up);
    return error;
}
- (NSDictionary *)handle:(NSDictionary *)request {
    NSString *mode = request[@"mode"];
    NSInteger identity = [request[@"id"] integerValue];
    NSString *error = disconnected.load() ? @"PASTE_SESSION_CLOSED" : nil;
    if (!error && ![self trusted]) error = @"ACCESSIBILITY_PERMISSION_DENIED";
    // 辅助功能查询和发键许可分别核验；只预检，不弹授权框或请求扩大权限。
    if (!error && ![self canPostEvents]) error = @"PASTE_EVENT_PERMISSION_DENIED";
    if ([mode isEqual:@"prepare"]) {
        self.token = 0;
        if (!error) error = [self prepareFailure];
        if (!error) {
            self.token = identity;
            self.deadline = [self uptime] + 3.0;
            self.pasteboardCount = [self clipboardCount];
        }
    } else if ([mode isEqual:@"paste"]) {
        NSInteger token = self.token;
        self.token = 0; // 无论成功失败，每个许可最多使用一次。
        if (!error && (token == 0 || token != [request[@"token"] integerValue])) error = @"PASTE_TARGET_CHANGED";
        if (!error) error = [self dispatchPaste];
    } else error = @"PASTE_PROTOCOL_ERROR";
    return error ? @{@"version": @1, @"id": @(identity), @"success": @NO, @"error": error}
        : @{@"version": @1, @"id": @(identity), @"success": @YES, @"state": [mode isEqual:@"prepare"] ? @"prepared" : @"dispatched"};
}
- (void)dealloc {
    [self stopObserving];
    if (_observer) [[NSWorkspace sharedWorkspace].notificationCenter removeObserver:_observer];
}
@end

static BOOL validInteger(id value) {
    return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() &&
        [value doubleValue] == [value longLongValue] && [value longLongValue] > 0 && [value longLongValue] <= 2147483647;
}
static void writeResponse(NSDictionary *response) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
    if (!data || data.length > 1024) exit(3);
    [[NSFileHandle fileHandleWithStandardOutput] writeData:data];
    [[NSFileHandle fileHandleWithStandardOutput] writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
}

int runPasteSession() {
    signal(SIGPIPE, SIG_IGN);
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    ZTPasteSession *session = [ZTPasteSession new];
    session.ownerPid = getppid();
    if (session.ownerPid <= 1) return 2;
    [session start];
    writeResponse(@{@"version": @1, @"ready": @YES});
    std::thread([session] {
        std::string pending;
        char chunk[512];
        ssize_t count;
        while ((count = read(STDIN_FILENO, chunk, sizeof(chunk))) > 0) {
            pending.append(chunk, static_cast<size_t>(count));
            if (pending.size() > 4096) exit(2);
            size_t newline;
            while ((newline = pending.find('\n')) != std::string::npos) {
                std::string line = pending.substr(0, newline); pending.erase(0, newline + 1);
                @autoreleasepool {
                    NSData *data = [NSData dataWithBytes:line.data() length:line.size()];
                    id request = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                    BOOL prepare = [request isKindOfClass:NSDictionary.class] && [request[@"mode"] isEqual:@"prepare"];
                    BOOL paste = [request isKindOfClass:NSDictionary.class] && [request[@"mode"] isEqual:@"paste"];
                    if ((!prepare && !paste) || !validInteger(request[@"version"]) || ![request[@"version"] isEqual:@1] ||
                        !validInteger(request[@"id"]) || [request count] != (prepare ? 3 : 4) || (paste && !validInteger(request[@"token"]))) exit(2);
                    if (session->queued.exchange(true)) exit(2);
                    dispatch_async(dispatch_get_main_queue(), ^{
                        if (session->disconnected.load() || getppid() != session.ownerPid) return;
                        NSDictionary *response = [session handle:request];
                        session->queued.store(false);
                        writeResponse(response);
                    });
                }
            }
        }
        session->disconnected.store(true);
        dispatch_async(dispatch_get_main_queue(), ^{ CFRunLoopStop(CFRunLoopGetMain()); });
    }).detach();
    CFRunLoopRun();
    return 0;
}

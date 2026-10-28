#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <cassert>

static NSMutableArray *postedEvents;
static void capturePasteEvent(pid_t pid, CGEventRef event) {
    [postedEvents addObject:@{@"pid": @(pid), @"type": @(CGEventGetType(event)),
        @"key": @(CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode)),
        @"flags": @(CGEventGetFlags(event))}];
}
// 保留生产事件构造与校验，只把最终投递换成内存记录，绝不发送真实按键。
#define CGEventPostToPid capturePasteEvent
#include "paste_session.mm"
#undef CGEventPostToPid

// 只读取已安装键盘布局的静态映射；不启动会话、不读取剪贴板、不发送事件。
static void checkLayout(NSString *identifier, int expected) {
    CFArrayRef list = TISCreateInputSourceList((__bridge CFDictionaryRef)@{(__bridge NSString *)kTISPropertyInputSourceID: identifier}, true);
    assert(list && CFArrayGetCount(list) == 1);
    TISInputSourceRef source = (TISInputSourceRef)CFArrayGetValueAtIndex(list, 0);
    CFDataRef data = (CFDataRef)TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
    assert(data);
    assert(pasteKey((const UCKeyboardLayout *)CFDataGetBytePtr(data)) == expected);
    CFRelease(list);
}
@interface FixtureApp : NSObject
@property pid_t processIdentifier;
@property(getter=isTerminated) BOOL terminated;
@end
@implementation FixtureApp
- (NSApplicationActivationPolicy)activationPolicy { return NSApplicationActivationPolicyRegular; }
@end
@interface FixtureSession : ZTPasteSession
@property NSRunningApplication *front;
@property id window;
@property id element;
@property BOOL permission;
@property BOOL postPermission;
@property BOOL revokePostOnFocus;
@property BOOL parent;
@property BOOL cancelOnFocus;
@property NSRunningApplication *switchOnFocus;
@property NSTimeInterval time;
@property NSInteger count;
@property NSInteger sent;
@property BOOL foregroundFocusOnly;
@property NSMutableArray *retries;
@end
@implementation FixtureSession
- (BOOL)trusted { return self.permission; }
- (BOOL)canPostEvents { return self.postPermission; }
- (BOOL)parentAlive { return self.parent; }
- (NSTimeInterval)uptime { return self.time; }
- (NSInteger)clipboardCount { return self.count; }
- (NSRunningApplication *)activeApp { return self.front; }
- (void)observePrevious { self.observed = self.previous; }
- (void)stopObserving { self.observed = nil; }
- (void)retry:(void (^)(void))operation {
    if (!self.retries) self.retries = [NSMutableArray array];
    [self.retries addObject:[operation copy]];
}
- (id)focusForApp:(NSRunningApplication *)app attribute:(CFStringRef)attribute {
    if (self.foregroundFocusOnly && !sameApp(app, self.front)) return nil;
    if (self.cancelOnFocus) disconnected.store(true);
    if (self.revokePostOnFocus) self.postPermission = NO;
    if (self.switchOnFocus) self.front = self.switchOnFocus;
    return CFEqual(attribute, kAXFocusedWindowAttribute) ? self.window : self.element;
}
- (NSString *)dispatchPaste {
    postedEvents = [NSMutableArray array];
    NSString *error = [super dispatchPaste];
    if (error) assert(postedEvents.count == 0);
    else {
        assert(postedEvents.count == 2);
        assert([postedEvents[0][@"type"] unsignedIntegerValue] == kCGEventKeyDown);
        assert([postedEvents[1][@"type"] unsignedIntegerValue] == kCGEventKeyUp);
        for (NSDictionary *event in postedEvents) {
            assert([event[@"pid"] intValue] == self.target.processIdentifier);
            assert([event[@"key"] intValue] == currentPasteKey());
            assert([event[@"flags"] unsignedIntegerValue] == kCGEventFlagMaskCommand);
        }
        self.sent++;
    }
    return error;
}
@end
static NSRunningApplication *fixtureApp(pid_t pid) {
    FixtureApp *app = [FixtureApp new]; app.processIdentifier = pid;
    return (NSRunningApplication *)app;
}
static FixtureSession *fixture() {
    FixtureSession *session = [FixtureSession new];
    session->disconnected.store(false); session->queued.store(false);
    session.ownerPid = 100; session.permission = YES; session.postPermission = YES; session.parent = YES;
    session.window = @"专用窗口"; session.element = @"专用输入框";
    session.time = 100; session.count = 5;
    session.front = fixtureApp(200); [session activated:session.front];
    session.front = fixtureApp(100); [session activated:session.front];
    return session;
}
static NSDictionary *prepare(FixtureSession *session) {
    return [session handle:@{@"mode": @"prepare", @"id": @1}];
}
static NSDictionary *paste(FixtureSession *session, NSInteger token = 1) {
    return [session handle:@{@"mode": @"paste", @"id": @2, @"token": @(token)}];
}
static NSUInteger drainRetries(FixtureSession *session) {
    NSUInteger count = 0;
    while (session.retries.count) {
        assert(++count <= 20);
        void (^operation)(void) = session.retries.firstObject;
        [session.retries removeObjectAtIndex:0]; operation();
    }
    return count;
}
static void stateMachineTests() {
    FixtureSession *success = fixture();
    assert([prepare(success)[@"success"] boolValue]);
    success.front = success.target;
    assert([paste(success)[@"state"] isEqual:@"dispatched"] && success.sent == 1);
    assert(![paste(success)[@"success"] boolValue] && success.sent == 1); // 许可不能重放。
    NSArray *changes = @[
        ^(FixtureSession *s){ s.front = fixtureApp(300); },
        ^(FixtureSession *s){ s.front = fixtureApp(200); }, // 同 PID 的新进程实例。
        ^(FixtureSession *s){ ((FixtureApp *)s.target).terminated = YES; },
        ^(FixtureSession *s){ s.window = @"另一个窗口"; },
        ^(FixtureSession *s){ s.element = @"另一个输入框"; },
        ^(FixtureSession *s){ s.element = nil; },
        ^(FixtureSession *s){ s.time = 104; },
        ^(FixtureSession *s){ s.count++; },
        ^(FixtureSession *s){ s.permission = NO; },
        ^(FixtureSession *s){ s.parent = NO; },
        ^(FixtureSession *s){ s->disconnected.store(true); },
        ^(FixtureSession *s){ s.cancelOnFocus = YES; },
        ^(FixtureSession *s){ s.switchOnFocus = fixtureApp(300); }
    ];
    for (void (^change)(FixtureSession *) in changes) {
        FixtureSession *session = fixture(); assert([prepare(session)[@"success"] boolValue]);
        session.front = session.target; change(session);
        assert(![paste(session)[@"success"] boolValue] && session.sent == 0);
    }
    FixtureSession *wrongToken = fixture(); prepare(wrongToken); wrongToken.front = wrongToken.target;
    assert(![paste(wrongToken, 3)[@"success"] boolValue] && wrongToken.sent == 0);
    FixtureSession *background = fixture(); background.front = background.target;
    assert(![prepare(background)[@"success"] boolValue] && background.sent == 0);
    FixtureSession *restart = fixture(); [restart clearTarget];
    assert(![prepare(restart)[@"success"] boolValue]);
    FixtureSession *late = fixture(); [late activated:fixtureApp(300)];
    assert(![prepare(late)[@"success"] boolValue]);
    FixtureSession *newActivation = fixture(); prepare(newActivation); [newActivation activated:newActivation.front];
    newActivation.front = newActivation.target;
    assert(![paste(newActivation)[@"success"] boolValue]);
    puts("paste-session: 状态边界与生产发键构造通过；只替换最终投递，不发送真实按键");
}
static void postPermissionRegression() {
    FixtureSession *denied = fixture(); denied.postPermission = NO;
    assert([prepare(denied)[@"error"] isEqual:@"PASTE_EVENT_PERMISSION_DENIED"]);
    assert(denied.token == 0 && denied.sent == 0);
    for (NSNumber *duringFocus in @[@NO, @YES]) {
        FixtureSession *revoked = fixture(); assert([prepare(revoked)[@"success"] boolValue]);
        revoked.front = revoked.target;
        if (duringFocus.boolValue) revoked.revokePostOnFocus = YES;
        else revoked.postPermission = NO;
        assert([paste(revoked)[@"error"] isEqual:@"PASTE_EVENT_PERMISSION_DENIED"]);
        assert(revoked.token == 0 && revoked.sent == 0);
    }
    puts("paste-session: 发键权限拒绝、prepare后撤销及焦点查询期间撤销均不发送");
}
static void foregroundSnapshotRegression() {
    FixtureSession *session = [FixtureSession new];
    session->disconnected.store(false); session->queued.store(false);
    session.ownerPid = 100; session.permission = YES; session.postPermission = YES; session.parent = YES;
    session.window = @"专用窗口"; session.element = @"专用输入框";
    session.foregroundFocusOnly = YES; session.time = 100; session.count = 5;
    session.front = fixtureApp(200); [session activated:session.front];
    session.front = fixtureApp(100); [session activated:session.front];
    assert([prepare(session)[@"success"] boolValue]);
    assert(session.sent == 0);

    FixtureSession *early = fixture();
    NSRunningApplication *external = fixtureApp(400), *owner = fixtureApp(100);
    early.front = external; [early activated:external];
    [early activated:owner]; early.front = owner;
    assert(drainRetries(early) == 1);
    assert([prepare(early)[@"success"] boolValue]);
    early.front = external;
    assert([paste(early)[@"success"] boolValue] && early.sent == 1);

    FixtureSession *interleaved = fixture();
    interleaved.front = external; [interleaved activated:external];
    [interleaved activated:owner];
    interleaved.element = @"切换前最后的输入框"; [interleaved focusChanged];
    interleaved.front = owner; drainRetries(interleaved);
    assert([prepare(interleaved)[@"success"] boolValue]);
    assert([interleaved.targetElement isEqual:@"切换前最后的输入框"]);
    interleaved.front = external;
    assert([paste(interleaved)[@"success"] boolValue] && interleaved.sent == 1);

    FixtureSession *lateFocus = fixture();
    lateFocus.window = nil; lateFocus.element = nil;
    lateFocus.front = external; [lateFocus activated:external];
    lateFocus.window = @"新窗口"; lateFocus.element = @"新输入框";
    assert(drainRetries(lateFocus) == 1);
    lateFocus.front = owner; [lateFocus activated:owner];
    assert([prepare(lateFocus)[@"success"] boolValue]);
    assert([lateFocus.targetWindow isEqual:@"新窗口"] && [lateFocus.targetElement isEqual:@"新输入框"]);

    FixtureSession *focusChanged = fixture();
    focusChanged.front = external; [focusChanged activated:external];
    focusChanged.element = @"另一个输入框"; [focusChanged focusChanged];
    focusChanged.front = owner; [focusChanged activated:owner];
    assert([focusChanged.targetElement isEqual:@"另一个输入框"]);
    assert([prepare(focusChanged)[@"success"] boolValue]);

    FixtureSession *stale = fixture();
    [stale activated:external];
    NSRunningApplication *third = fixtureApp(500);
    stale.front = third; [stale activated:third];
    stale.front = owner; [stale activated:owner];
    drainRetries(stale);
    assert(sameApp(stale.target, third) && [prepare(stale)[@"success"] boolValue]);

    FixtureSession *unready = fixture();
    unready.front = external; unready.window = nil; [unready activated:external];
    assert(drainRetries(unready) == 5);
    unready.front = owner; [unready activated:owner];
    assert([prepare(unready)[@"error"] isEqual:@"PASTE_TARGET_WINDOW_UNAVAILABLE"]);

    for (NSNumber *mode in @[@0, @1, @2]) {
        FixtureSession *cancelled = fixture();
        [cancelled activated:external]; cancelled.front = external;
        if (mode.intValue == 0) cancelled.time += 2;
        if (mode.intValue == 1) cancelled->disconnected.store(true);
        if (mode.intValue == 2) cancelled.parent = NO;
        drainRetries(cancelled);
        assert(!cancelled.previous && cancelled.sent == 0);
    }
    puts("paste-session: 前台快照、提前激活、焦点延迟、焦点更新、旧代数、有界重试与取消回归通过；不注册真实AX监听");
}
int main() {
    @autoreleasepool {
        stateMachineTests();
        postPermissionRegression();
        foregroundSnapshotRegression();
        checkLayout(@"com.apple.keylayout.US", kVK_ANSI_V);
        checkLayout(@"com.apple.keylayout.French", kVK_ANSI_V);
        checkLayout(@"com.apple.keylayout.Dvorak", kVK_ANSI_Period);
        checkLayout(@"com.apple.keylayout.DVORAK-QWERTYCMD", kVK_ANSI_V);
        assert(pasteKey(nullptr) == -1);
        assert(validInteger(@1) && validInteger(@2147483647));
        for (id value in @[@YES, @NO, @0, @-1, @1.5, @2147483648LL, @"1", NSNull.null]) assert(!validInteger(value));
        puts("paste-session: 4种布局、未知布局拒绝及协议整数边界通过；没有执行桌面操作");
    }
    return 0;
}

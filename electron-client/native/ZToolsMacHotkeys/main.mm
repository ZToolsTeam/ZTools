#import <Foundation/Foundation.h>
#import <Carbon/Carbon.h>

static void output(NSDictionary *value) {
  NSData *bytes = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  fwrite(bytes.bytes, 1, bytes.length, stdout); fputc('\n', stdout);
}
static NSDictionary *failure(NSString *code) { return @{ @"success": @NO, @"error": code }; }
static NSDictionary *namedKeys() {
  return @{ @"Space": @(kVK_Space), @"Tab": @(kVK_Tab), @"Return": @(kVK_Return), @"Escape": @(kVK_Escape),
    @"Backspace": @(kVK_Delete), @"Delete": @(kVK_ForwardDelete), @"Home": @(kVK_Home), @"End": @(kVK_End),
    @"PageUp": @(kVK_PageUp), @"PageDown": @(kVK_PageDown), @"Up": @(kVK_UpArrow), @"Down": @(kVK_DownArrow), @"Left": @(kVK_LeftArrow), @"Right": @(kVK_RightArrow),
    @"F1": @(kVK_F1), @"F2": @(kVK_F2), @"F3": @(kVK_F3), @"F4": @(kVK_F4), @"F5": @(kVK_F5), @"F6": @(kVK_F6), @"F7": @(kVK_F7), @"F8": @(kVK_F8), @"F9": @(kVK_F9), @"F10": @(kVK_F10),
    @"F11": @(kVK_F11), @"F12": @(kVK_F12), @"F13": @(kVK_F13), @"F14": @(kVK_F14), @"F15": @(kVK_F15), @"F16": @(kVK_F16), @"F17": @(kVK_F17), @"F18": @(kVK_F18), @"F19": @(kVK_F19), @"F20": @(kVK_F20) };
}
static NSString *keyboardCharacter(const UCKeyboardLayout *layout, UInt16 code, UInt32 modifiers) {
  UInt32 dead=0; UniChar chars[8]; UniCharCount count=0;
  OSStatus status=UCKeyTranslate(layout,code,kUCKeyActionDisplay,modifiers >> 8,LMGetKbdType(),kUCKeyTranslateNoDeadKeysMask,&dead,8,&count,chars);
  return status==noErr && count==1 ? [[NSString stringWithCharacters:chars length:count] lowercaseString] : nil;
}
static bool resolveKey(NSString *name, const UCKeyboardLayout *layout, UInt32 &key, UInt32 &mods) {
  NSNumber *named = namedKeys()[name]; if (named) { key = named.unsignedIntValue; return true; }
  NSString *wanted = [name isEqualToString:@"Plus"] ? @"+" : name.lowercaseString;
  if (wanted.length != 1 || !layout) return false;
  const UInt16 keypad[] = { kVK_ANSI_Keypad0, kVK_ANSI_Keypad1, kVK_ANSI_Keypad2, kVK_ANSI_Keypad3, kVK_ANSI_Keypad4, kVK_ANSI_Keypad5, kVK_ANSI_Keypad6, kVK_ANSI_Keypad7, kVK_ANSI_Keypad8, kVK_ANSI_Keypad9, kVK_ANSI_KeypadDecimal, kVK_ANSI_KeypadMultiply, kVK_ANSI_KeypadPlus, kVK_ANSI_KeypadClear, kVK_ANSI_KeypadDivide, kVK_ANSI_KeypadEnter, kVK_ANSI_KeypadMinus, kVK_ANSI_KeypadEquals };
  for (UInt32 fallback=0; fallback < ((mods & cmdKey) ? 2u : 1u); fallback++)
  for (UInt32 shift = 0; shift < 2; shift++) for (UInt16 code = 0; code < 128; code++) {
    bool isKeypad=false; for (UInt16 candidate : keypad) if (candidate == code) { isKeypad=true; break; }
    if (isKeypad) continue;
    // Command 可改变布局的物理键映射（如 Dvorak-QWERTY Command）；Control/Option 不参与字符查找。
    UInt32 layoutModifiers = (fallback ? 0 : (mods & cmdKey)) | (shift ? shiftKey : 0);
    if ([keyboardCharacter(layout,code,layoutModifiers) isEqualToString:wanted]) {
      // US 的 Command 翻译会折叠 Shift。仅在 Command 未改动此键基础字符时，接受原布局的 Shift 映射。
      if (fallback && ![keyboardCharacter(layout,code,0) isEqualToString:keyboardCharacter(layout,code,cmdKey)]) continue;
      key = code; if (shift) mods |= shiftKey; return true;
    }
  }
  return false;
}
int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc != 2 || strlen(argv[1]) > 8192) { output(failure(@"INVALID_REQUEST")); return 0; }
    id input = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:argv[1]] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    if (![input isKindOfClass:NSArray.class] || [input count] < 1 || [input count] > 32) { output(failure(@"INVALID_REQUEST")); return 0; }
    TISInputSourceRef source = TISCopyCurrentKeyboardLayoutInputSource();
    CFDataRef layoutData = source ? (CFDataRef)TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) : nullptr;
    const UCKeyboardLayout *layout = layoutData ? (const UCKeyboardLayout *)CFDataGetBytePtr(layoutData) : nullptr;
    NSMutableArray *requests = [NSMutableArray array];
    NSDictionary *modifierCodes = @{ @"Control": @(controlKey), @"Alt": @(optionKey), @"Shift": @(shiftKey), @"Command": @(cmdKey) };
    for (id combo in input) {
      if (![combo isKindOfClass:NSString.class] || [combo length] > 128) { if(source) CFRelease(source); output(failure(@"INVALID_COMBO")); return 0; }
      NSArray *parts = [combo componentsSeparatedByString:@"+"]; UInt32 mods = 0, key = 0; bool valid = true;
      for (NSUInteger i=0;i+1<parts.count;i++) { NSNumber *mask=modifierCodes[parts[i]]; if (!mask || (mods & mask.unsignedIntValue)) valid=false; else mods |= mask.unsignedIntValue; }
      if (!valid || !resolveKey(parts.lastObject, layout, key, mods) || (!mods && ![parts.lastObject hasPrefix:@"F"])) { if(source) CFRelease(source); output(failure(@"KEYBOARD_LAYOUT_UNSUPPORTED")); return 0; }
      [requests addObject:@{ @"combo": combo, @"key": @(key), @"mods": @(mods) }];
    }
    if(source) CFRelease(source);
    CFArrayRef symbolicRef = nullptr; OSStatus symbolicStatus = CopySymbolicHotKeys(&symbolicRef);
    if (symbolicStatus != noErr || !symbolicRef) { output(failure(@"SYSTEM_SHORTCUTS_UNAVAILABLE")); return 0; }
    NSArray *symbolic = CFBridgingRelease(symbolicRef); NSMutableArray *results = [NSMutableArray array]; UInt32 index=0;
    for (NSDictionary *request in requests) {
      UInt32 key=[request[@"key"] unsignedIntValue], mods=[request[@"mods"] unsignedIntValue]; NSString *status=nil;
      for (NSDictionary *entry in symbolic) {
        if ([entry[(__bridge NSString *)kHISymbolicHotKeyEnabled] boolValue] && [entry[(__bridge NSString *)kHISymbolicHotKeyCode] unsignedIntValue] == key && [entry[(__bridge NSString *)kHISymbolicHotKeyModifiers] unsignedIntValue] == mods) { status=@"system"; break; }
      }
      if (!status) {
        EventHotKeyRef ref=nullptr; EventHotKeyID id={'ZTHK',++index};
        OSStatus registered=RegisterEventHotKey(key,mods,id,GetApplicationEventTarget(),kEventHotKeyExclusive,&ref);
        if (ref && UnregisterEventHotKey(ref) != noErr) { output(failure(@"TEMPORARY_REGISTRATION_NOT_RELEASED")); return 0; }
        if (registered == noErr) status=@"registered";
        else if (registered == eventHotKeyExistsErr) status=@"occupied";
        else { output(failure([NSString stringWithFormat:@"REGISTER_FAILED_%d",int(registered)])); return 0; }
      }
      [results addObject:@{ @"combo": request[@"combo"], @"status": status }];
    }
    output(@{ @"success": @YES, @"results": results });
  }
  return 0;
}

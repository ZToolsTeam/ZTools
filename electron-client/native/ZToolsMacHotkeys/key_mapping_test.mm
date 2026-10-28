#define main hotkeyProgramMain
#include "main.mm"
#undef main
#include <assert.h>
static bool checkLayout(NSString *identifier, NSString *keyName, UInt32 expectedKey, bool needsShift, UInt32 inputModifiers=cmdKey) {
  CFArrayRef sources=TISCreateInputSourceList((__bridge CFDictionaryRef)@{(__bridge NSString *)kTISPropertyInputSourceID:identifier},true);
  if(!sources || CFArrayGetCount(sources)!=1) { if(sources)CFRelease(sources);return false; }
  TISInputSourceRef source=(TISInputSourceRef)CFArrayGetValueAtIndex(sources,0);
  CFDataRef data=(CFDataRef)TISGetInputSourceProperty(source,kTISPropertyUnicodeKeyLayoutData);
  if(!data) { CFRelease(sources);return false; }
  UInt32 key=999,mods=inputModifiers;
  bool ok=resolveKey(keyName,(const UCKeyboardLayout*)CFDataGetBytePtr(data),key,mods);
  if(!ok || key!=expectedKey || bool(mods & shiftKey)!=needsShift || (mods & inputModifiers)!=inputModifiers)
    fprintf(stderr,"%s %s resolved=%d key=%u modifiers=%u expectedKey=%u expectedShift=%d\n",identifier.UTF8String,keyName.UTF8String,ok,key,mods,expectedKey,needsShift);
  assert(ok && key==expectedKey && bool(mods & shiftKey)==needsShift && (mods & inputModifiers)==inputModifiers);
  printf("%s %s key=%u shift=%s passed\n",identifier.UTF8String,keyName.UTF8String,key,needsShift?"yes":"no");
  CFRelease(sources);return true;
}
int main() { @autoreleasepool {
  if(!checkLayout(@"com.apple.keylayout.US",@"Plus",kVK_ANSI_Equal,true)) return 1;
  if(!checkLayout(@"com.apple.keylayout.US",@"1",kVK_ANSI_1,false)) return 1;
  if(!checkLayout(@"com.apple.keylayout.French",@"1",kVK_ANSI_1,true)) return 1;
  if(!checkLayout(@"com.apple.keylayout.DVORAK-QWERTYCMD",@"Z",kVK_ANSI_Z,false)) return 1;
  if(!checkLayout(@"com.apple.keylayout.DVORAK-QWERTYCMD",@"Plus",kVK_ANSI_Equal,true)) return 1;
  if(!checkLayout(@"com.apple.keylayout.French",@"Plus",kVK_ANSI_Slash,true)) return 1;
  if(!checkLayout(@"com.apple.keylayout.DVORAK-QWERTYCMD",@"Z",kVK_ANSI_Slash,false,controlKey)) return 1;
  if(!checkLayout(@"com.apple.keylayout.Dvorak",@"Z",kVK_ANSI_Slash,false)) return 1;
  return 0;
} }

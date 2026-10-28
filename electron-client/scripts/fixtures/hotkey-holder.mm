#import <Carbon/Carbon.h>
#include <stdio.h>
#include <unistd.h>
int main() {
  EventHotKeyRef ref=nullptr; EventHotKeyID id={'ZTTF',1};
  OSStatus result=RegisterEventHotKey(kVK_F13,cmdKey|controlKey|optionKey|shiftKey,id,GetApplicationEventTarget(),kEventHotKeyExclusive,&ref);
  if(result!=noErr) return 1;
  puts("HOTKEY_HOLDER_READY");fflush(stdout);
  char byte;read(STDIN_FILENO,&byte,1);
  return UnregisterEventHotKey(ref)==noErr?0:1;
}

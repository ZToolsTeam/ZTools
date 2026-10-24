#include <Windows.h>
#include <objbase.h>
#include <cstring>
#include <string>

static int initialized = 0;
static int destroyed = 0;
static bool monitoring = false;
extern "C" int __cdecl DllPlugin_Init() { ++initialized; return 0; }
extern "C" void __cdecl DllPlugin_Destroy() { ++destroyed; }
extern "C" const void* __cdecl DllPlugin_GetInfo() { return &initialized; }
extern "C" int __cdecl DllPlugin_Call(const char* function, const char*, char** result) {
  if (std::strcmp(function, "StartMonitoring") == 0) monitoring = true;
  const std::string json = std::strcmp(function, "GetTrafficStats") == 0
      ? (monitoring ? "{\"isMonitoring\":true}" : "{\"isMonitoring\":false}")
      : "{\"initialized\":" + std::to_string(initialized) +
      ",\"destroyed\":" + std::to_string(destroyed) + "}";
  *result = static_cast<char*>(CoTaskMemAlloc(json.size() + 1));
  if (!*result) return -4;
  memcpy(*result, json.c_str(), json.size() + 1);
  return 0;
}
extern "C" int __cdecl DllPlugin_CallWithCallback(
    const char*, const char*, void(__cdecl*)(const char*, const char*)) { return 0; }

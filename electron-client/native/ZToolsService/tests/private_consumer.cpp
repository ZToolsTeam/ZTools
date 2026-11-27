extern "C" __declspec(dllimport) int PrivateDependencyProbe() noexcept;

static int g_private_consumer_initialized = 0;

extern "C" __declspec(dllexport) int __cdecl PrivateConsumerProbe() noexcept {
  return PrivateDependencyProbe() + 1;
}

extern "C" __declspec(dllexport) int __cdecl DllPlugin_Init() {
  g_private_consumer_initialized = PrivateDependencyProbe() + 1;
  return g_private_consumer_initialized > 0 ? 0 : -1;
}

extern "C" __declspec(dllexport) void __cdecl DllPlugin_Destroy() {
  g_private_consumer_initialized = 0;
}

extern "C" __declspec(dllexport) const void* __cdecl DllPlugin_GetInfo() {
  return &g_private_consumer_initialized;
}

extern "C" __declspec(dllexport) int __cdecl DllPlugin_Call(
    const char*,
    const char*,
    char** result) {
  if (result != nullptr) *result = nullptr;
  return PrivateDependencyProbe() >= 0 ? 0 : -1;
}

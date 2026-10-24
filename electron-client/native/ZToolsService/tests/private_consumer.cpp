extern "C" __declspec(dllimport) int PrivateDependencyProbe() noexcept;

extern "C" __declspec(dllexport) int PrivateConsumerProbe() noexcept {
  return PrivateDependencyProbe() + 1;
}

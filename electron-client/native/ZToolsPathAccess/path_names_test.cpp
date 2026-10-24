#include "path_access.hpp"
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using ztools::path_access::PinnedPath;
using ztools::path_access::Kind;
namespace {
unsigned checks = 0;
void Check(bool value) { if (!value) throw std::runtime_error("NAME_ASSERTION_FAILED"); ++checks; }
template<class F> void Denied(F action) {
  bool rejected = false;
  try { action(); } catch (const std::exception&) { rejected = true; }
  Check(rejected);
}
void Write(const fs::path& file, const char* data) {
  std::ofstream output(file, std::ios::binary); output << data;
  if (!output) throw std::runtime_error("NAME_FIXTURE_FAILED");
}
std::string Text(const std::vector<unsigned char>& data) { return {data.begin(), data.end()}; }
}

int main(int argc, char** argv) {
  try {
    if (argc != 2) throw std::runtime_error("FRESH_ABSOLUTE_DIRECTORY_REQUIRED");
    const auto root = fs::u8path(argv[1]);
    if (!root.is_absolute()) throw std::runtime_error("FRESH_ABSOLUTE_DIRECTORY_REQUIRED");
    Check(fs::create_directory(root)); // Refuse existing roots; retain every synthetic file for evidence.
    const auto scope = root / "names"; Check(fs::create_directory(scope));
    const std::string nfc = u8"é.txt", nfd = u8"e\u0301.txt";
    Write(scope / "MixedCase.txt", "original case"); Write(scope / fs::u8path(nfc), "original Unicode");
    auto directory = PinnedPath::Open(scope.u8string(), Kind::directory);
    Check(Text(directory.Read({"MixedCase.txt"}, 100)) == "original case");
    Check(Text(directory.Read({nfc}, 100)) == "original Unicode");
    auto selected = PinnedPath::Open((scope / fs::u8path(nfc)).u8string(), Kind::selected);
    Check(Text(selected.Read({}, 100)) == "original Unicode");
    const auto entries = directory.List({});
    Check(entries.size() == 2 && std::any_of(entries.begin(), entries.end(), [&](const auto& entry) { return entry.name == nfc; }));
    const bool case_alias = fs::exists(scope / "mixedcase.txt");
    const bool unicode_alias = fs::exists(scope / fs::u8path(nfd));
    auto destination = directory.SaveChild({"unused-destination.txt"});
    auto reject_alternate = [&](const std::string& name) {
      Denied([&] { directory.Read({name}, 100); });
      Denied([&] { directory.ReadRange({name}, 0, 1); });
      Denied([&] { directory.ReadChild({name}); });
      Denied([&] { directory.RemoveChild({name}, false); });
      Denied([&] { directory.MoveChild({name}, destination, false); });
      Denied([&] { PinnedPath::Open((scope / fs::u8path(name)).u8string(), Kind::file); });
      Denied([&] { PinnedPath::Open((scope / fs::u8path(name)).u8string(), Kind::selected); });
    };
    reject_alternate("mixedcase.txt"); reject_alternate(nfd);
    if (case_alias) {
      Denied([&] { directory.SaveChild({"mixedcase.txt"}); });
      Denied([&] { PinnedPath::Open((scope / "mixedcase.txt").u8string(), Kind::save); });
      Check(fs::equivalent(scope / "mixedcase.txt", scope / "MixedCase.txt"));
      Check(Text(directory.Read({"MixedCase.txt"}, 100)) == "original case");
    } else {
      Write(scope / "mixedcase.txt", "distinct case");
      Check(Text(directory.Read({"mixedcase.txt"}, 100)) == "distinct case");
      Check(Text(directory.Read({"MixedCase.txt"}, 100)) == "original case");
    }
    if (unicode_alias) {
      Denied([&] { directory.SaveChild({nfd}); });
      Denied([&] { PinnedPath::Open((scope / fs::u8path(nfd)).u8string(), Kind::save); });
      Check(fs::equivalent(scope / fs::u8path(nfd), scope / fs::u8path(nfc)));
      Check(Text(directory.Read({nfc}, 100)) == "original Unicode");
    } else {
      Write(scope / fs::u8path(nfd), "distinct Unicode");
      Check(Text(directory.Read({nfd}, 100)) == "distinct Unicode");
      Check(Text(directory.Read({nfc}, 100)) == "original Unicode");
    }
    Check(Text(directory.Read({"MixedCase.txt"}, 100)) == "original case");
    Check(Text(directory.Read({nfc}, 100)) == "original Unicode");
    std::cout << "{\"status\":\"PASS\",\"scope\":\"native-pinned-name-contract\",\"tests\":" << checks
      << ",\"caseSensitive\":" << (case_alias ? "false" : "true")
      << ",\"unicodeNormalizationAlias\":" << (unicode_alias ? "true" : "false") << "}\n";
    return 0;
  } catch (const std::exception&) {
    std::cerr << "{\"status\":\"FAIL\",\"code\":\"NATIVE_PATH_NAMES_TEST_FAILED\",\"completedChecks\":" << checks << "}\n";
    return 1;
  }
}

#include "path_access.hpp"
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <Windows.h>
#include <winioctl.h>
#endif
namespace fs = std::filesystem;
using ztools::path_access::PinnedPath;
using ztools::path_access::Kind;
int passed = 0;
void Check(bool valid) { if (!valid) throw std::runtime_error("ASSERTION_FAILED"); ++passed; }
template<class F> void Denied(F action) {
  bool rejected = false;
  try { action(); } catch (const std::exception&) { rejected = true; }
  Check(rejected);
}
void Write(const fs::path& path, const std::string& value) { std::ofstream file(path, std::ios::binary); file << value; if (!file) throw std::runtime_error("FIXTURE_FAILED"); }
std::string Text(const std::vector<unsigned char>& data) { return {data.begin(), data.end()}; }
void Junction(const fs::path& link, const fs::path& target) {
#ifdef _WIN32
  if (!fs::create_directory(link)) throw std::runtime_error("FIXTURE_FAILED");
  struct Data {
    DWORD tag;
    USHORT length, reserved, substitute_offset, substitute_length, print_offset, print_length;
    wchar_t names[4096];
  } data{};
  const auto plain = target.wstring(), substitute = L"\\??\\" + plain;
  if (substitute.size() + plain.size() + 2 > 4096) throw std::runtime_error("FIXTURE_FAILED");
  data.tag = IO_REPARSE_TAG_MOUNT_POINT;
  data.substitute_length = static_cast<USHORT>(substitute.size() * sizeof(wchar_t));
  data.print_offset = static_cast<USHORT>((substitute.size() + 1) * sizeof(wchar_t));
  data.print_length = static_cast<USHORT>(plain.size() * sizeof(wchar_t));
  data.length = static_cast<USHORT>(8 + data.print_offset + data.print_length + sizeof(wchar_t));
  std::copy(substitute.begin(), substitute.end(), data.names);
  std::copy(plain.begin(), plain.end(), data.names + substitute.size() + 1);
  const auto handle = CreateFileW(link.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (handle == INVALID_HANDLE_VALUE) throw std::runtime_error("FIXTURE_FAILED");
  DWORD returned = 0;
  const bool ok = DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, &data, 8UL + data.length, nullptr, 0, &returned, nullptr) != FALSE;
  CloseHandle(handle);
  if (!ok) throw std::runtime_error("JUNCTION_FIXTURE_FAILED");
#else
  fs::create_directory_symlink(target, link);
#endif
}
int main(int argc, char** argv) {
  try {
    if (argc != 2) throw std::runtime_error("EXPLICIT_FRESH_ROOT_REQUIRED");
    const auto root = fs::u8path(argv[1]);
    if (!root.is_absolute() || !fs::create_directory(root)) throw std::runtime_error("EXPLICIT_FRESH_ROOT_REQUIRED");
    const auto scope = root / "scope", outside = root / "outside";
    fs::create_directory(scope); fs::create_directory(outside);
    Write(scope / "normal.txt", "synthetic"); Write(outside / "sentinel.txt", "outside-unchanged");
    Write(scope / fs::u8path(u8"空 格é.txt"), "unicode"); Write(scope / "empty.txt", "");
    auto exact = PinnedPath::Open((scope / "normal.txt").u8string(), Kind::file);
    auto directory = PinnedPath::Open(scope.u8string(), Kind::directory);
    Check(Text(exact.Read({}, 1024)) == "synthetic");
    Check(Text(directory.Read({u8"空 格é.txt"}, 1024)) == "unicode");
    Check(directory.Read({"empty.txt"}, 0).empty());
    Check(Text(exact.ReadRange({}, 1, 3)) == "ynt");
    Check(Text(exact.ReadRange({}, 7, 50)) == "ic");
    Check(exact.ReadRange({}, 100, 50).empty());
    Check(exact.ReadRange({}, 4'294'967'297ULL, 1).empty());
    Check(exact.ReadRange({}, 0, 0).empty());
    Denied([&] { exact.ReadRange({}, 9'007'199'254'740'991ULL, 1); });
    Denied([&] { exact.ReadRange({}, 0, 16 * 1024 * 1024 + 1); });
    Denied([&] { exact.ReadRange({}, 0, 1, [] { return true; }); });
    const auto entries = directory.List({});
    Check(entries.size() == 3 && std::any_of(entries.begin(), entries.end(), [](const auto& entry) { return entry.name == u8"空 格é.txt" && !entry.directory && entry.size == 7; }));
    Denied([&] { exact.List({}); });
    const auto file_metadata = exact.Describe(), folder_metadata = directory.Describe();
    Check(!file_metadata.directory && file_metadata.size == 9 && file_metadata.modified_ms > 0);
    Check(folder_metadata.directory && folder_metadata.size == 0);
    auto selected_file = PinnedPath::Open((scope / "normal.txt").u8string(), Kind::selected);
    auto selected_directory = PinnedPath::Open(scope.u8string(), Kind::selected);
    Check(!selected_file.Describe().directory && selected_file.Describe().size == 9 && Text(selected_file.Read({}, 1024)) == "synthetic");
    Check(selected_directory.Describe().directory && selected_directory.List({}).size() == 3);
    Check(Text(selected_directory.Read({u8"空 格é.txt"}, 1024)) == "unicode");
    Denied([&] { selected_file.Read({"child"}, 1024); });
    Denied([&] { selected_file.Save({'x'}, false); });
    Denied([&] { PinnedPath::Open((scope / "missing-selected.txt").u8string(), Kind::selected); });
    {
      std::ofstream large(scope / "large.bin", std::ios::binary);
      large.seekp(16 * 1024 * 1024); large << "boundary";
      if (!large) throw std::runtime_error("FIXTURE_FAILED");
    }
    Check(Text(directory.ReadRange({"large.bin"}, 16 * 1024 * 1024, 8)) == "boundary");
    Check(directory.ReadRange({"large.bin"}, 16 * 1024 * 1024 - 1, 3) == std::vector<unsigned char>({0, 'b', 'o'}));
    Denied([&] { directory.Read({"large.bin"}, 16 * 1024 * 1024); });
#ifndef _WIN32
    Write(scope / "colon:back\\slash\nname", "POSIX-literal");
    Check(Text(directory.Read({"colon:back\\slash\nname"}, 1024)) == "POSIX-literal");
    const auto literal_entries = directory.List({});
    Check(std::any_of(literal_entries.begin(), literal_entries.end(), [](const auto& entry) { return entry.name == "colon:back\\slash\nname"; }));
#endif
    Denied([&] { exact.Read({"child"}, 1024); });
    Denied([&] { directory.Read({"..", "outside", "sentinel.txt"}, 1024); });
    Denied([&] { directory.Read({"normal.txt:stream"}, 1024); });
    Denied([&] { directory.Read({"normal.txt"}, 1); });
    Denied([&] { exact.Read({}, 1024, [] { return true; }); });
    fs::create_hard_link(outside / "sentinel.txt", scope / "hardlink.txt");
    Denied([&] { directory.Read({"hardlink.txt"}, 1024); });
    Denied([&] { PinnedPath::Open((scope / "hardlink.txt").u8string(), Kind::selected); });
    fs::create_directory(scope / "race-child");
    Write(scope / "race-child" / "original.txt", "inside");
    int checkpoints = 0;
    Denied([&] {
      directory.Read({"race-child", "sentinel.txt"}, 1024, [&] {
        if (++checkpoints == 2) {
          fs::rename(scope / "race-child", scope / "race-original");
          Junction(scope / "race-child", outside);
        }
        return false;
      });
    });
    Check(checkpoints >= 2);
    Denied([&] { directory.ReadRange({"race-child", "sentinel.txt"}, 0, 1024); });
    std::vector<std::thread> readers;
    bool first = false, second = false;
    readers.emplace_back([&] { first = Text(exact.Read({}, 1024)) == "synthetic"; });
    readers.emplace_back([&] { second = Text(exact.Read({}, 1024)) == "synthetic"; });
    for (auto& reader : readers) reader.join();
    Check(first && second);
    fs::rename(scope / "normal.txt", scope / "old.txt"); Write(scope / "normal.txt", "replacement");
    Denied([&] { exact.Read({}, 1024); });
    Denied([&] { exact.ReadRange({}, 0, 1024); });
    Junction(scope / "escape", outside);
    Denied([&] { PinnedPath::Open((scope / "escape").u8string(), Kind::selected); });
    Denied([&] { directory.Read({"escape", "sentinel.txt"}, 1024); });
    const auto safe_entries = directory.List({});
    Check(std::none_of(safe_entries.begin(), safe_entries.end(), [](const auto& entry) { return entry.name == "escape" || entry.name == "race-child"; }));
    Denied([&] { directory.List({"escape"}); });
    Denied([&] { directory.List({}, [] { return true; }); });
    const auto saved = scope / "saved.txt";
    auto save = PinnedPath::Open(saved.u8string(), Kind::save);
    Denied([&] { save.Read({}, 1024); });
    Denied([&] { save.List({}); });
    Denied([&] { save.Describe(); });
    Denied([&] { directory.Save({'x'}, false); });
    Denied([&] { PinnedPath::Open((scope / "missing-parent" / "new.txt").u8string(), Kind::save); });
    save.Save({'f', 'i', 'r', 's', 't'}, false);
    Check(Text(directory.Read({"saved.txt"}, 1024)) == "first");
    auto old_saved = PinnedPath::Open(saved.u8string(), Kind::file);
    Denied([&] { save.Save({'n', 'e', 'w'}, false); });
    Check(Text(directory.Read({"saved.txt"}, 1024)) == "first");
    save.Save({'n', 'e', 'w'}, true);
    Check(Text(directory.Read({"saved.txt"}, 1024)) == "new");
    Denied([&] { old_saved.Read({}, 1024); });
    save.Save({}, true);
    Check(directory.Read({"saved.txt"}, 0).empty());
    Denied([&] { save.Save({'x'}, true, [] { return true; }); });
    Check(directory.Read({"saved.txt"}, 0).empty());
    int save_checkpoints = 0;
    Denied([&] { save.Save({'x'}, true, [&] { return ++save_checkpoints == 3; }); });
    Check(save_checkpoints == 3 && directory.Read({"saved.txt"}, 0).empty());
    Denied([&] { save.Save(std::vector<unsigned char>(16 * 1024 * 1024 + 1), true); });
    Denied([&] { PinnedPath::Open((scope / "escape").u8string(), Kind::save); });
    auto derived = directory.SaveChild({"derived.txt"});
    derived.Save({'d'}, false);
    Check(Text(directory.Read({"derived.txt"}, 1)) == "d");
    Denied([&] { exact.SaveChild({"child.txt"}); });
    Denied([&] { directory.SaveChild({}); });
    Denied([&] { directory.SaveChild({"..", "outside.txt"}); });
    Denied([&] { directory.SaveChild({"escape", "outside.txt"}); });
    fs::create_directory(scope / "nested");
    auto nested = directory.SaveChild({"nested", "child.txt"}); nested.Save({'n'}, false);
    Check(Text(directory.Read({"nested", "child.txt"}, 1)) == "n");
    auto nested_read = directory.ReadChild({"nested", "child.txt"});
    Check(Text(nested_read.Read({}, 1)) == "n");
    Check(!nested_read.Describe().directory && nested_read.Describe().size == 1);
    Denied([&] { directory.ReadChild({"escape", "sentinel.txt"}); });
    Denied([&] { exact.ReadChild({"child"}); });
    Denied([&] { directory.ReadChild({}); });
    Denied([&] { directory.ReadChild({"hardlink.txt"}); });
    fs::rename(scope / "nested" / "child.txt", scope / "nested" / "old-child.txt");
    Write(scope / "nested" / "child.txt", "changed");
    Denied([&] { nested_read.Read({}, 1024); });
    Denied([&] { nested_read.Describe(); });
    auto copy_source = directory.ReadChild({"derived.txt"}), copy_target = directory.SaveChild({"copy.txt"});
    Check(copy_target.CopyFrom(copy_source, false) == 1 && Text(copy_source.Read({}, 1)) == "d" && Text(directory.Read({"copy.txt"}, 1)) == "d");
    Denied([&] { copy_target.CopyFrom(copy_source, false); });
    Check(Text(copy_source.Read({}, 1)) == "d" && Text(directory.Read({"copy.txt"}, 1)) == "d");
    copy_target.CopyFrom(copy_source, true);
    Check(directory.ReadChild({"copy.txt"}).Describe().size == 1);
    auto empty_source = directory.ReadChild({"empty.txt"});
    Check(copy_target.CopyFrom(empty_source, true) == 0 && directory.Read({"copy.txt"}, 0).empty());
    Denied([&] { copy_target.CopyFrom(directory, true); });
    Denied([&] { directory.CopyFrom(copy_source, false); });
    Denied([&] { copy_target.CopyFrom(copy_source, true, [] { return true; }); });
    Check(directory.Read({"copy.txt"}, 0).empty() && Text(copy_source.Read({}, 1)) == "d");
    int copy_checkpoints = 0;
    Denied([&] { copy_target.CopyFrom(copy_source, true, [&] { return ++copy_checkpoints == 4; }); });
    Check(directory.Read({"copy.txt"}, 0).empty() && copy_checkpoints == 4);
    auto large_source = directory.ReadChild({"large.bin"}), large_target = directory.SaveChild({"large-copy.bin"});
    Check(large_target.CopyFrom(large_source, false) == 16 * 1024 * 1024 + 8 && Text(directory.ReadRange({"large-copy.bin"}, 16 * 1024 * 1024, 8)) == "boundary");
    int mutation_checkpoints = 0;
    Denied([&] { copy_target.CopyFrom(copy_source, true, [&] {
      if (++mutation_checkpoints == 1) Write(scope / "derived.txt", "modified");
      return false;
    }); });
    Check(directory.Read({"copy.txt"}, 0).empty() && Text(copy_source.Read({}, 1024)) == "modified");
    Write(scope / "remove.txt", "owned");
    directory.RemoveChild({"remove.txt"}, false);
    Check(!fs::exists(scope / "remove.txt"));
    fs::create_directory(scope / "remove-empty");
    directory.RemoveChild({"remove-empty"}, true);
    Check(!fs::exists(scope / "remove-empty"));
    Denied([&] { directory.RemoveChild({}, false); });
    Denied([&] { exact.RemoveChild({"old.txt"}, false); });
    Denied([&] { save.RemoveChild({"saved.txt"}, false); });
    Denied([&] { directory.RemoveChild({"..", "outside", "sentinel.txt"}, false); });
    Denied([&] { directory.RemoveChild({"escape", "sentinel.txt"}, false); });
    Denied([&] { directory.RemoveChild({"escape"}, true); });
    Denied([&] { directory.RemoveChild({"hardlink.txt"}, false); });
    Denied([&] { directory.RemoveChild({"nested"}, true); });
    Denied([&] { directory.RemoveChild({"derived.txt"}, true); });
    Denied([&] { directory.RemoveChild({"nested"}, false); });
    Denied([&] { directory.RemoveChild({"derived.txt"}, false, [] { return true; }); });
    Check(Text(directory.Read({"derived.txt"}, 1024)) == "modified");
    Write(scope / "nested" / "remove.txt", "owned");
    directory.RemoveChild({"nested", "remove.txt"}, false);
    Check(!fs::exists(scope / "nested" / "remove.txt"));
    Write(scope / "move.txt", "move-input");
    auto move_target = directory.SaveChild({"moved.txt"});
    directory.MoveChild({"move.txt"}, move_target, false);
    Check(!fs::exists(scope / "move.txt") && Text(directory.Read({"moved.txt"}, 1024)) == "move-input");
    Write(scope / "move.txt", "replacement");
    Denied([&] { directory.MoveChild({"move.txt"}, move_target, false); });
    Check(Text(directory.Read({"move.txt"}, 1024)) == "replacement" && Text(directory.Read({"moved.txt"}, 1024)) == "move-input");
    directory.MoveChild({"move.txt"}, move_target, true);
    Check(!fs::exists(scope / "move.txt") && Text(directory.Read({"moved.txt"}, 1024)) == "replacement");
    Denied([&] { directory.MoveChild({"moved.txt"}, move_target, true); });
    Denied([&] { directory.MoveChild({}, move_target, false); });
    Denied([&] { directory.MoveChild({"..", "outside", "sentinel.txt"}, move_target, true); });
    Denied([&] { directory.MoveChild({"escape", "sentinel.txt"}, move_target, true); });
    Denied([&] { directory.MoveChild({"hardlink.txt"}, move_target, true); });
    Denied([&] { directory.MoveChild({"nested"}, move_target, true); });
    Denied([&] { exact.MoveChild({"moved.txt"}, move_target, true); });
    Denied([&] { directory.MoveChild({"moved.txt"}, directory, true); });
    Denied([&] { directory.MoveChild({"moved.txt"}, move_target, true, [] { return true; }); });
    Check(Text(directory.Read({"moved.txt"}, 1024)) == "replacement");
    auto nested_move = directory.SaveChild({"nested", "moved.txt"});
    directory.MoveChild({"moved.txt"}, nested_move, false);
    Check(!fs::exists(scope / "moved.txt") && Text(directory.Read({"nested", "moved.txt"}, 1024)) == "replacement");
    auto stream_target = directory.SaveChild({"stream.txt"});
    auto stream = stream_target.BeginWrite(3, false);
    const unsigned char stream_first[] = {'s'}, stream_rest[] = {'d', 'k'};
    stream.Append(stream_first, 1); stream.Append(stream_rest, 2);
    Check(stream.Commit() == 3 && Text(directory.Read({"stream.txt"}, 3)) == "sdk");
    Denied([&] { stream.Append(stream_first, 1); });
    Denied([&] { stream.Commit(); });
    auto incomplete = stream_target.BeginWrite(3, true); incomplete.Append(stream_first, 1);
    Denied([&] { incomplete.Commit(); });
    Check(Text(directory.Read({"stream.txt"}, 3)) == "sdk");
    auto overflow = stream_target.BeginWrite(1, true);
    Denied([&] { overflow.Append(stream_rest, 2); });
    Denied([&] { overflow.Commit(); });
    auto cancelled_stream = stream_target.BeginWrite(1, true);
    Denied([&] { cancelled_stream.Append(stream_first, 1, [] { return true; }); });
    Denied([&] { cancelled_stream.Commit(); });
    auto aborted_stream = stream_target.BeginWrite(1, true); aborted_stream.Abort(); aborted_stream.Abort();
    Denied([&] { aborted_stream.Append(stream_first, 1); });
    Denied([&] { aborted_stream.Commit(); });
    auto zero_stream = stream_target.BeginWrite(0, true);
    Check(zero_stream.Commit() == 0 && directory.Read({"stream.txt"}, 0).empty());
    Denied([&] { stream_target.BeginWrite(2ULL * 1024 * 1024 * 1024 + 1, true); });
    Denied([&] { directory.BeginWrite(0, false); });
    Denied([&] { stream_target.BeginWrite(0, true, [] { return true; }); });
    auto exclusive_stream = stream_target.BeginWrite(1, false); exclusive_stream.Append(stream_first, 1);
    Denied([&] { exclusive_stream.Commit(); });
    Check(directory.Read({"stream.txt"}, 0).empty());
    auto unknown_stream = stream_target.BeginWrite(std::numeric_limits<std::uint64_t>::max(), true);
    unknown_stream.Append(stream_first, 1); unknown_stream.Append(stream_rest, 2);
    Check(unknown_stream.Commit() == 3 && Text(directory.Read({"stream.txt"}, 3)) == "sdk");
    auto unknown_empty = stream_target.BeginWrite(std::numeric_limits<std::uint64_t>::max(), true);
    Check(unknown_empty.Commit() == 0 && directory.Read({"stream.txt"}, 0).empty());
    Check(directory.CreateDirectoryChild({"created-directory"}) && fs::is_directory(scope / "created-directory"));
    Check(!directory.CreateDirectoryChild({"created-directory"}));
    Check(directory.CreateDirectoryChild({"created-directory", "nested"}));
    Denied([&] { directory.CreateDirectoryChild({"derived.txt"}); });
    Denied([&] { directory.CreateDirectoryChild({}); });
    Denied([&] { exact.CreateDirectoryChild({"new"}); });
    Denied([&] { save.CreateDirectoryChild({"new"}); });
    Denied([&] { directory.CreateDirectoryChild({"escape", "new"}); });
    Denied([&] { directory.CreateDirectoryChild({"escape"}); });
    Denied([&] { directory.CreateDirectoryChild({"..", "outside", "new"}); });
    Denied([&] { directory.CreateDirectoryChild({"missing-parent", "new"}); });
    Denied([&] { directory.CreateDirectoryChild({"cancelled-directory"}, [] { return true; }); });
    Check(!fs::exists(scope / "cancelled-directory"));
    auto aborted_large_target = directory.SaveChild({"aborted-large.bin"});
    auto aborted_large = aborted_large_target.BeginWrite(65536, false);
    const std::vector<unsigned char> discarded(65536, 'x'); aborted_large.Append(discarded.data(), discarded.size()); aborted_large.Abort();
    Check(!fs::exists(scope / "aborted-large.bin"));
    std::size_t retained_count = 0; bool empty_staging = true;
    for (const auto& entry : fs::directory_iterator(scope)) {
      if (entry.path().filename().u8string().rfind(".ztools-save-", 0) == 0) { ++retained_count; empty_staging = empty_staging && fs::file_size(entry.path()) == 0; }
    }
    Check(retained_count > 0 && empty_staging);
    {
      auto retained_target = directory.SaveChild({"retained-commit.txt"});
      auto committed_stream = retained_target.BeginWrite(3, false);
      const unsigned char committed_bytes[] = {'s', 'd', 'k'}; committed_stream.Append(committed_bytes, 3);
      Check(committed_stream.Commit() == 3);
    }
    Check(Text(directory.Read({"retained-commit.txt"}, 3)) == "sdk");
    auto recovery_target = directory.SaveChild({"recovery.txt"});
    auto recovery_stream = recovery_target.BeginWrite(3, false);
    const auto recovery_proof = recovery_stream.RecoveryProof();
    Check(recovery_target.ObserveWrite(recovery_proof).state == ztools::path_access::WriteObservation::State::staging);
    recovery_stream.Append(stream_first, 1); recovery_stream.Append(stream_rest, 2);
    Check(recovery_target.ObserveWrite(recovery_proof).size == 3);
    Denied([&] { stream_target.ObserveWrite(recovery_proof); });
    Denied([&] { directory.ObserveWrite(recovery_proof); });
    auto corrupt_proof = recovery_proof; corrupt_proof[0] ^= 1;
    Denied([&] { recovery_target.ObserveWrite(corrupt_proof); });
    corrupt_proof = recovery_proof; corrupt_proof[6] ^= 1;
    Denied([&] { recovery_target.ObserveWrite(corrupt_proof); });
    corrupt_proof = recovery_proof; corrupt_proof.pop_back();
    Denied([&] { recovery_target.ObserveWrite(corrupt_proof); });
    corrupt_proof = recovery_proof; corrupt_proof.back() = '/';
    Denied([&] { recovery_target.ObserveWrite(corrupt_proof); });
    Check(recovery_stream.Commit() == 3);
    const auto committed_observation = recovery_target.ObserveWrite(recovery_proof);
    Check(committed_observation.state == ztools::path_access::WriteObservation::State::committed_object && committed_observation.size == 3);
    Denied([&] { recovery_stream.RecoveryProof(); });
    // Reopened parents after restart must carry the same IDs; recovered receipts never mutate output.
    auto reopened_recovery = PinnedPath::Open((scope / "recovery.txt").u8string(), Kind::save);
    Check(reopened_recovery.ObserveWrite(recovery_proof).state == ztools::path_access::WriteObservation::State::committed_object);
    Check(Text(directory.Read({"recovery.txt"}, 3)) == "sdk");
    fs::rename(scope / "recovery.txt", scope / "old-recovery.txt"); Write(scope / "recovery.txt", "foreign");
    Check(reopened_recovery.ObserveWrite(recovery_proof).state == ztools::path_access::WriteObservation::State::unresolved);
    Check(Text(directory.Read({"recovery.txt"}, 7)) == "foreign" && Text(directory.Read({"old-recovery.txt"}, 3)) == "sdk");
    auto abandoned = recovery_target.BeginWrite(1, true); const auto abandoned_proof = abandoned.RecoveryProof();
    abandoned.Append(stream_first, 1); abandoned.Abort();
    const auto abandoned_observation = recovery_target.ObserveWrite(abandoned_proof);
    Check(abandoned_observation.state == ztools::path_access::WriteObservation::State::staging && abandoned_observation.size == 0);
    auto unicode_recovery = directory.SaveChild({u8"恢复.txt"});
    auto unicode_stage = unicode_recovery.BeginWrite(0, false); const auto unicode_proof = unicode_stage.RecoveryProof();
    Check(unicode_recovery.ObserveWrite(unicode_proof).state == ztools::path_access::WriteObservation::State::staging);
    unicode_stage.Abort();
    auto child_directory = directory.DirectoryChild({"created-directory"});
    Check(child_directory.Describe().directory);
    Write(scope / "created-directory" / "nested" / "input.txt", "directory child");
    Check(Text(child_directory.Read({"nested", "input.txt"}, 1024)) == "directory child");
    Check(child_directory.List({}).size() == 1);
    auto child_output = child_directory.SaveChild({"nested", "output.txt"}); child_output.Save({'d'}, false);
    Check(Text(directory.Read({"created-directory", "nested", "output.txt"}, 1)) == "d");
    Denied([&] { exact.DirectoryChild({"child"}); });
    Denied([&] { directory.DirectoryChild({}); });
    Denied([&] { directory.DirectoryChild({"escape"}); });
    Denied([&] { directory.DirectoryChild({"normal.txt"}); });
    Denied([&] { directory.DirectoryChild({"..", "outside"}); });
    Write(scope / ".ztools-save-synthetic", "reserved"); Write(scope / ".ZTOOLS-SAVE-UPPER", "uppercase");
    fs::create_directory(scope / ".ztools-save-directory");
    const auto visible_entries = directory.List({});
    Check(std::none_of(visible_entries.begin(), visible_entries.end(), [](const auto& entry) {
      return entry.name.rfind(".ztools-save-", 0) == 0 || entry.name.rfind(".ZTOOLS-SAVE-", 0) == 0;
    }));
    Denied([&] { directory.Read({".ztools-save-synthetic"}, 1024); });
    Denied([&] { directory.Read({".ZTOOLS-SAVE-UPPER"}, 1024); });
    Denied([&] { directory.ReadRange({".ztools-save-synthetic"}, 0, 1); });
    Denied([&] { directory.ReadChild({".ztools-save-synthetic"}); });
    Denied([&] { directory.SaveChild({".ztools-save-new"}); });
    Denied([&] { directory.RemoveChild({".ztools-save-synthetic"}, false); });
    Denied([&] { directory.MoveChild({".ztools-save-synthetic"}, recovery_target, true); });
    Denied([&] { directory.CreateDirectoryChild({".ztools-save-new"}); });
    Denied([&] { directory.List({".ztools-save-directory"}); });
    Denied([&] { PinnedPath::Open((scope / ".ztools-save-synthetic").u8string(), Kind::file); });
    Denied([&] { PinnedPath::Open((scope / ".ztools-save-synthetic").u8string(), Kind::selected); });
    Denied([&] { PinnedPath::Open((scope / ".ztools-save-new").u8string(), Kind::save); });
    Denied([&] { PinnedPath::Open((scope / ".ztools-save-directory").u8string(), Kind::directory); });
    std::ifstream reserved_file(scope / ".ztools-save-synthetic", std::ios::binary);
    Check(std::string((std::istreambuf_iterator<char>(reserved_file)), {}) == "reserved");
    unsigned alias_checks = 0;
    auto check_alias = [&](const std::string& alias) {
      Denied([&] { directory.Read({alias}, 1024); });
      Denied([&] { directory.ReadRange({alias}, 0, 1); });
      Denied([&] { directory.ReadChild({alias}); });
      Denied([&] { directory.SaveChild({alias}); });
      Denied([&] { directory.RemoveChild({alias}, false); });
      Denied([&] { directory.MoveChild({alias}, recovery_target, true); });
      Denied([&] { PinnedPath::Open((scope / fs::u8path(alias)).u8string(), Kind::file); });
      Denied([&] { PinnedPath::Open((scope / fs::u8path(alias)).u8string(), Kind::selected); });
      alias_checks += 8;
    };
    bool short_alias = false;
#ifdef _WIN32
    std::vector<wchar_t> short_name(32768);
    const auto short_size = GetShortPathNameW((scope / ".ztools-save-synthetic").c_str(), short_name.data(), static_cast<DWORD>(short_name.size()));
    if (!short_size || short_size >= short_name.size()) throw std::runtime_error("SHORT_NAME_OBSERVATION_FAILED");
    const auto short_leaf = fs::path(std::wstring(short_name.data(), short_size)).filename().u8string();
    short_alias = short_leaf != ".ztools-save-synthetic";
    if (short_alias) check_alias(short_leaf);
#endif
    const auto folded_leaf = std::string(u8".ztoolſ-save-synthetic");
    std::error_code alias_error;
    const bool folded_alias = fs::equivalent(scope / fs::u8path(folded_leaf), scope / ".ztools-save-synthetic", alias_error);
    if (alias_error && alias_error != std::errc::no_such_file_or_directory) throw std::runtime_error("CASE_ALIAS_OBSERVATION_FAILED");
    if (folded_alias) check_alias(folded_leaf);
    std::error_code rename_error;
    fs::rename(scope, root / "scope-original", rename_error);
    bool ancestor_replaced = false;
    if (!rename_error) {
      ancestor_replaced = true;
      Junction(scope, outside);
      Denied([&] { directory.Read({"sentinel.txt"}, 1024); });
      Denied([&] { PinnedPath::Open((scope / "sentinel.txt").u8string(), Kind::file); });
    } else {
#ifdef _WIN32
      Check(rename_error.value() == ERROR_ACCESS_DENIED || rename_error.value() == ERROR_SHARING_VIOLATION);
      Check(Text(directory.Read({"normal.txt"}, 1024)) == "replacement");
#else
      throw std::runtime_error("ANCESTOR_REPLACEMENT_FIXTURE_FAILED");
#endif
    }
    std::ifstream sentinel(outside / "sentinel.txt", std::ios::binary);
    const std::string content((std::istreambuf_iterator<char>(sentinel)), {});
    Check(content == "outside-unchanged");
    std::cout << "{\"status\":\"PASS\",\"scope\":\"native-pinned-path-contract\",\"tests\":" << passed
      << ",\"ancestorReplacement\":\"" << (ancestor_replaced ? "REPLACED_AND_DENIED" : "OS_BLOCKED")
      << "\",\"aliasChecks\":" << alias_checks << ",\"shortNameAlias\":\"" << (short_alias ? "PRESENT_AND_DENIED" : "NOT_PRESENT")
      << "\",\"unicodeCaseAlias\":\"" << (folded_alias ? "PRESENT_AND_DENIED" : "NOT_PRESENT") << "\"}\n";
    return 0;
  } catch (const std::exception&) {
    std::cerr << "{\"status\":\"FAIL\",\"code\":\"NATIVE_PATH_ACCESS_TEST_FAILED\",\"completedChecks\":" << passed << "}\n";
    return 1;
  }
}

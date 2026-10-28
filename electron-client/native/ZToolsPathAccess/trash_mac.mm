#import <Foundation/Foundation.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <stdexcept>

// 文件引用按对象身份定位，不能退回路径 URL，避免目录在校验后被替换。
void TrashPinnedMacFile(int descriptor) {
  @autoreleasepool {
    struct stat pinned{};
    char file_path[4096]{};
    if (fstat(descriptor, &pinned) != 0 || (!S_ISREG(pinned.st_mode) && !S_ISDIR(pinned.st_mode)) ||
        (S_ISREG(pinned.st_mode) && pinned.st_nlink != 1) ||
        fcntl(descriptor, F_GETPATH, file_path) != 0) throw std::runtime_error("PATH_TRASH_DENIED");
    NSString* name = [[NSFileManager defaultManager] stringWithFileSystemRepresentation:file_path length:strlen(file_path)];
    NSURL* reference = [[NSURL fileURLWithPath:name isDirectory:S_ISDIR(pinned.st_mode)] fileReferenceURL];
    struct stat resolved{};
    if (!reference || !reference.isFileReferenceURL || !reference.fileSystemRepresentation ||
        stat(reference.fileSystemRepresentation, &resolved) != 0 || resolved.st_dev != pinned.st_dev ||
        resolved.st_ino != pinned.st_ino || ((resolved.st_mode & S_IFMT) != (pinned.st_mode & S_IFMT)) ||
        (S_ISREG(resolved.st_mode) && resolved.st_nlink != 1)) throw std::runtime_error("PATH_TRASH_CHANGED");
    NSError* error = nil;
    NSURL* result = nil;
    if (![[NSFileManager defaultManager] trashItemAtURL:reference resultingItemURL:&result error:&error]) {
      throw std::runtime_error("PATH_TRASH_FAILED");
    }
    struct stat committed{};
    if (!result || !result.fileSystemRepresentation || stat(result.fileSystemRepresentation, &committed) != 0 ||
        committed.st_dev != pinned.st_dev || committed.st_ino != pinned.st_ino) throw std::runtime_error("PATH_COMMIT_UNCONFIRMED");
  }
}

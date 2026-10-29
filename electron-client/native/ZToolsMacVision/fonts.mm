#import <Foundation/Foundation.h>
#import <CoreText/CoreText.h>
#import <ImageIO/ImageIO.h>
#include <cmath>

static NSDictionary *FontFailure(NSString *code) { return @{ @"version": @1, @"success": @NO, @"code": code }; }
static NSString *FontName(CTFontRef font, CFStringRef key) {
  NSString *value = CFBridgingRelease(CTFontCopyName(font, key));
  return value ?: @"";
}
static NSArray *InstalledFonts(void) {
  CTFontCollectionRef collection = CTFontCollectionCreateFromAvailableFonts(nullptr);
  if (!collection) return nil;
  NSArray *fonts = CFBridgingRelease(CTFontCollectionCreateMatchingFontDescriptors(collection));
  CFRelease(collection);
  return fonts;
}
static CTFontRef LocalFont(CTFontDescriptorRef descriptor) {
  // 只读取已经可用的字体，不激活未启用字体，也不触发系统下载。
  return CTFontCreateWithFontDescriptorAndOptions(descriptor, 48, nullptr,
    kCTFontOptionsPreventAutoActivation | kCTFontOptionsPreventAutoDownload);
}
static NSString *FontPath(CTFontRef font) {
  NSURL *url = CFBridgingRelease(CTFontCopyAttribute(font, kCTFontURLAttribute));
  return [url isKindOfClass:[NSURL class]] && url.isFileURL ? url.path : @"";
}
static NSDictionary *FontList(NSArray *descriptors) {
  NSMutableArray *items = [NSMutableArray array];
  NSMutableSet *seen = [NSMutableSet set];
  for (id descriptor in descriptors) {
    CTFontRef font = LocalFont((__bridge CTFontDescriptorRef)descriptor);
    if (!font) return FontFailure(@"FONT_UNAVAILABLE");
    NSString *identifier = CFBridgingRelease(CTFontCopyPostScriptName(font));
    if (identifier.length && ![seen containsObject:identifier]) {
      [seen addObject:identifier];
      NSString *file = FontPath(font);
      [items addObject:@{ @"id": identifier, @"family": CFBridgingRelease(CTFontCopyFamilyName(font)) ?: identifier,
        @"style": FontName(font, kCTFontSubFamilyNameKey), @"filePath": file,
        @"hasLicense": @(FontName(font, kCTFontLicenseNameKey).length > 0),
        // 系统自带字体不只在 /System/Library/Fonts/：苹方等按需下载的字体在 /System/Library/AssetsV2/，
        // 另有一些在 PrivateFrameworks 下；/System/ 整卷只读（SSV），用户无法往里安装字体，按前缀判定可靠
        @"system": @([file hasPrefix:@"/System/"]) }];
    }
    CFRelease(font);
    if (items.count > 10000) return FontFailure(@"TOO_MANY_FONTS");
  }
  return @{ @"version": @1, @"success": @YES, @"fonts": items };
}
static NSDictionary *FontPreview(CTFontRef font, NSString *text) {
  CGColorRef black = CGColorCreateGenericRGB(0, 0, 0, 1);
  NSDictionary *attributes = @{ (__bridge NSString *)kCTFontAttributeName: (__bridge id)font,
    (__bridge NSString *)kCTForegroundColorAttributeName: (__bridge id)black };
  NSAttributedString *string = [[NSAttributedString alloc] initWithString:text attributes:attributes];
  CGColorRelease(black);
  CTFramesetterRef setter = CTFramesetterCreateWithAttributedString((__bridge CFAttributedStringRef)string);
  if (!setter) return FontFailure(@"FONT_RENDER_FAILED");
  CGSize size = CTFramesetterSuggestFrameSizeWithConstraints(setter, CFRangeMake(0, 0), nullptr, CGSizeMake(936, 10000), nullptr);
  if (!std::isfinite(size.height) || size.height > 1500) { CFRelease(setter); return FontFailure(@"PREVIEW_TOO_LONG"); }
  const size_t height = (size_t)std::ceil(MAX(128, size.height + 80));
  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(nullptr, 1000, height, 8, 4000, space, kCGImageAlphaPremultipliedLast);
  CGColorSpaceRelease(space);
  if (!context) { CFRelease(setter); return FontFailure(@"FONT_RENDER_FAILED"); }
  CGContextSetRGBFillColor(context, 1, 1, 1, 1); CGContextFillRect(context, CGRectMake(0, 0, 1000, height));
  CGPathRef path = CGPathCreateWithRect(CGRectMake(32, 32, 936, height - 64), nullptr);
  CTFrameRef frame = CTFramesetterCreateFrame(setter, CFRangeMake(0, 0), path, nullptr);
  CGPathRelease(path); CFRelease(setter);
  CFRange visible = CTFrameGetVisibleStringRange(frame);
  NSMutableSet *fallbacks = [NSMutableSet set];
  NSString *requested = CFBridgingRelease(CTFontCopyPostScriptName(font));
  for (id line in (__bridge NSArray *)CTFrameGetLines(frame)) {
    for (id run in (__bridge NSArray *)CTLineGetGlyphRuns((__bridge CTLineRef)line)) {
      NSDictionary *runAttributes = (__bridge NSDictionary *)CTRunGetAttributes((__bridge CTRunRef)run);
      CTFontRef used = (__bridge CTFontRef)runAttributes[(__bridge NSString *)kCTFontAttributeName];
      NSString *name = used ? CFBridgingRelease(CTFontCopyPostScriptName(used)) : nil;
      if (name && ![name isEqual:requested]) [fallbacks addObject:name];
    }
  }
  CTFrameDraw(frame, context); CFRelease(frame);
  CGImageRef image = CGBitmapContextCreateImage(context); CGContextRelease(context);
  NSMutableData *bytes = [NSMutableData data];
  CGImageDestinationRef destination = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)bytes, CFSTR("public.png"), 1, nullptr);
  bool ok = image && destination && visible.location == 0 && visible.length == (CFIndex)text.length;
  if (ok) { CGImageDestinationAddImage(destination, image, nullptr); ok = CGImageDestinationFinalize(destination); }
  if (destination) CFRelease(destination); if (image) CGImageRelease(image);
  if (!ok || !bytes.length || bytes.length > 2 * 1024 * 1024) return FontFailure(@"FONT_RENDER_FAILED");
  NSArray *sortedFallbacks = [[fallbacks allObjects] sortedArrayUsingSelector:@selector(compare:)];
  NSMutableDictionary *reply = [@{ @"version": @1, @"success": @YES, @"id": requested,
    @"png": [bytes base64EncodedStringWithOptions:0], @"fallbacks": sortedFallbacks,
    @"license": FontName(font, kCTFontLicenseNameKey), @"licenseUrl": FontName(font, kCTFontLicenseURLNameKey),
    @"copyright": FontName(font, kCTFontCopyrightNameKey), @"manufacturer": FontName(font, kCTFontManufacturerNameKey) } mutableCopy];
  // 本机没有任何字体含某个字形时，CoreText 用 LastResort 画占位方框：它不是可用的回退字体，返回缺字提示。
  // coverageWarning 会替代插件里的回退字体说明，所以把其余回退字体也写进去（最多列 8 个，宿主限制 1024 字符）
  if ([fallbacks containsObject:@"LastResort"]) {
    NSMutableArray *others = [NSMutableArray array];
    for (NSString *name in sortedFallbacks) if (![name isEqual:@"LastResort"]) [others addObject:name];
    NSString *warning = @"部分字符本机没有任何字体包含，显示为占位方框。";
    if (others.count) {
      NSArray *shown = [others subarrayWithRange:NSMakeRange(0, MIN((NSUInteger)8, others.count))];
      NSString *names = [shown componentsJoinedByString:@"、"];
      if (names.length > 600) names = [[names substringToIndex:600] stringByAppendingString:@"…"];
      warning = [warning stringByAppendingFormat:@"其余字形使用系统回退字体：%@%@", names,
        others.count > shown.count ? [NSString stringWithFormat:@" 等 %lu 个", (unsigned long)others.count] : @""];
    }
    reply[@"coverageWarning"] = warning;
  }
  return reply;
}

NSDictionary *DispatchFonts(NSDictionary *value) {
  NSString *operation = value[@"operation"];
  NSArray *keys = [operation isEqual:@"fonts-list"] ? @[@"version", @"operation"] : @[@"version", @"operation", @"id", @"text"];
  for (id key in value) if (![keys containsObject:key]) return FontFailure(@"INVALID_REQUEST");
  if (![operation isEqual:@"fonts-list"] && ![operation isEqual:@"fonts-preview"]) return FontFailure(@"INVALID_REQUEST");
  if ([operation isEqual:@"fonts-preview"] && (![value[@"id"] isKindOfClass:[NSString class]] || ![value[@"id"] length] || [value[@"id"] length] > 1024 ||
    ![value[@"text"] isKindOfClass:[NSString class]] || ![value[@"text"] length] || [value[@"text"] length] > 320)) return FontFailure(@"INVALID_REQUEST");
  NSArray *descriptors = InstalledFonts();
  if (!descriptors) return FontFailure(@"FONT_SCAN_FAILED");
  if ([operation isEqual:@"fonts-list"]) return FontList(descriptors);
  // 先在已安装字体中匹配标识，再检查实际返回的字体，防止 CoreText 静默替换成默认字体。
  for (id descriptor in descriptors) {
    NSString *identifier = CFBridgingRelease(CTFontDescriptorCopyAttribute((__bridge CTFontDescriptorRef)descriptor, kCTFontNameAttribute));
    if (![identifier isEqual:value[@"id"]]) continue;
    CTFontRef font = LocalFont((__bridge CTFontDescriptorRef)descriptor);
    if (!font) return FontFailure(@"FONT_UNAVAILABLE");
    NSString *actual = CFBridgingRelease(CTFontCopyPostScriptName(font));
    NSDictionary *result = [actual isEqual:value[@"id"]] ? FontPreview(font, value[@"text"]) : FontFailure(@"FONT_UNAVAILABLE");
    CFRelease(font); return result;
  }
  return FontFailure(@"FONT_UNAVAILABLE");
}

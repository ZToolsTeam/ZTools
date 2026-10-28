#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <ImageIO/ImageIO.h>
#import <CoreText/CoreText.h>
#include <cstdio>
#include <cstring>
#include <cmath>
NSDictionary *DispatchFonts(NSDictionary *value);

static const NSUInteger MaxBytes = 16 * 1024 * 1024;
static NSDictionary *Failure(NSString *code) { return @{ @"version": @1, @"success": @NO, @"code": code }; }
static bool ExactKeys(NSDictionary *value, NSArray *keys) {
  for (id key in value) if (![keys containsObject:key]) return false;
  return true;
}
static NSDictionary *Recognize(NSData *data, NSArray<NSString *> *languages) API_AVAILABLE(macos(10.15)) {
  if (!data.length || data.length > MaxBytes) return Failure(@"INVALID_IMAGE");
  CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, nullptr);
  if (!source) return Failure(@"INVALID_IMAGE");
  NSString *type = (__bridge NSString *)CGImageSourceGetType(source);
  NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, nullptr));
  const size_t count = CGImageSourceGetCount(source);
  CFRelease(source);
  if (count != 1 || ![@[@"public.png", @"public.jpeg"] containsObject:type]) return Failure(@"INVALID_IMAGE");
  double w = [properties[(__bridge NSString *)kCGImagePropertyPixelWidth] doubleValue];
  double h = [properties[(__bridge NSString *)kCGImagePropertyPixelHeight] doubleValue];
  if (!std::isfinite(w) || !std::isfinite(h) || std::floor(w) != w || std::floor(h) != h || w < 1 || h < 1 || w > 8192 || h > 8192 || w * h > 8 * 1024 * 1024) return Failure(@"IMAGE_TOO_LARGE");
  NSUInteger orientation = [properties[(__bridge NSString *)kCGImagePropertyOrientation] unsignedIntegerValue];
  if (orientation == 0) orientation = 1;
  if (orientation > 8) return Failure(@"INVALID_IMAGE");
  VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
  request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
  request.usesLanguageCorrection = YES;
  NSError *error = nil;
  NSArray *supported = [VNRecognizeTextRequest supportedRecognitionLanguagesForTextRecognitionLevel:request.recognitionLevel revision:request.revision error:&error];
  if (error || !supported.count) return Failure(@"LANGUAGES_UNAVAILABLE");
  for (NSString *language in languages) if (![supported containsObject:language]) return Failure(@"LANGUAGE_UNSUPPORTED");
  if (languages.count) request.recognitionLanguages = languages;
  VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithData:data orientation:(CGImagePropertyOrientation)orientation options:@{}];
  if (![handler performRequests:@[request] error:&error] || error) return Failure(@"RECOGNITION_FAILED");
  NSMutableArray *lines = [NSMutableArray array];
  NSMutableArray *texts = [NSMutableArray array];
  NSUInteger total = 0;
  if (request.results.count > 10000) return Failure(@"OUTPUT_TOO_LARGE");
  for (VNRecognizedTextObservation *observation in request.results) {
    VNRecognizedText *candidate = [observation topCandidates:1].firstObject;
    if (!candidate) continue;
    NSString *text = candidate.string;
    total += [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding] + 1;
    if (total > 1024 * 1024) return Failure(@"OUTPUT_TOO_LARGE");
    CGRect box = observation.boundingBox;
    [texts addObject:text];
    [lines addObject:@{ @"text": text, @"confidence": @(candidate.confidence), @"box": @[@(box.origin.x), @(box.origin.y), @(box.size.width), @(box.size.height)] }];
  }
  // Vision boxes use normalized coordinates with a bottom-left origin in the oriented image.
  bool swapped = orientation >= 5;
  return @{ @"version": @1, @"success": @YES, @"provider": @"apple-vision-local", @"revision": @(request.revision),
    @"width": @(swapped ? h : w), @"height": @(swapped ? w : h), @"text": [texts componentsJoinedByString:@"\n"], @"lines": lines };
}
static NSDictionary *Dispatch(id input) API_AVAILABLE(macos(10.15)) {
  if (![input isKindOfClass:[NSDictionary class]]) return Failure(@"INVALID_REQUEST");
  NSDictionary *value = input;
  if (![value[@"version"] isKindOfClass:[NSNumber class]] || CFGetTypeID((__bridge CFTypeRef)value[@"version"]) == CFBooleanGetTypeID() || ![value[@"version"] isEqual:@1] || ![value[@"operation"] isKindOfClass:[NSString class]]) return Failure(@"INVALID_REQUEST");
  if ([value[@"operation"] hasPrefix:@"fonts-"]) return DispatchFonts(value);
  if ([value[@"operation"] isEqual:@"languages"]) {
    if (!ExactKeys(value, @[@"version", @"operation"])) return Failure(@"INVALID_REQUEST");
    VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
    NSError *error = nil;
    NSArray *languages = [VNRecognizeTextRequest supportedRecognitionLanguagesForTextRecognitionLevel:VNRequestTextRecognitionLevelAccurate revision:request.revision error:&error];
    if (error || !languages.count) return Failure(@"LANGUAGES_UNAVAILABLE");
    return @{ @"version": @1, @"success": @YES, @"provider": @"apple-vision-local", @"revision": @(request.revision), @"languages": languages };
  }
  if (![value[@"operation"] isEqual:@"recognize"] || !ExactKeys(value, @[@"version", @"operation", @"imageBase64", @"languages"])) return Failure(@"INVALID_REQUEST");
  NSString *base64 = value[@"imageBase64"];
  NSArray *languages = value[@"languages"];
  if (![base64 isKindOfClass:[NSString class]] || base64.length > ((MaxBytes + 2) / 3) * 4 || ![languages isKindOfClass:[NSArray class]] || languages.count > 8) return Failure(@"INVALID_REQUEST");
  NSMutableSet *seen = [NSMutableSet set];
  for (id language in languages) {
    if (![language isKindOfClass:[NSString class]] || [language length] < 2 || [language length] > 64 || [seen containsObject:language]) return Failure(@"INVALID_REQUEST");
    [seen addObject:language];
  }
  NSData *data = [[NSData alloc] initWithBase64EncodedString:base64 options:0];
  if (!data || ![[data base64EncodedStringWithOptions:0] isEqual:base64]) return Failure(@"INVALID_IMAGE");
  return Recognize(data, languages);
}
static NSData *Fixture(bool text) {
  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(nullptr, 1000, 200, 8, 4000, space, kCGImageAlphaPremultipliedLast);
  CGColorSpaceRelease(space);
  if (!context) return nil;
  CGContextSetRGBFillColor(context, 1, 1, 1, 1); CGContextFillRect(context, CGRectMake(0, 0, 1000, 200));
  if (text) {
    CTFontRef font = CTFontCreateWithName(CFSTR("Helvetica"), 64, nullptr);
    CGColorRef black = CGColorCreateGenericRGB(0, 0, 0, 1);
    NSDictionary *attributes = @{ (__bridge NSString *)kCTFontAttributeName: (__bridge id)font, (__bridge NSString *)kCTForegroundColorAttributeName: (__bridge id)black };
    NSAttributedString *string = [[NSAttributedString alloc] initWithString:@"ZTools OCR 123" attributes:attributes];
    CTLineRef line = CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)string);
    CGContextSetTextPosition(context, 40, 80); CTLineDraw(line, context);
    CFRelease(line); CFRelease(font); CGColorRelease(black);
  }
  CGImageRef image = CGBitmapContextCreateImage(context);
  NSMutableData *bytes = [NSMutableData data];
  CGImageDestinationRef destination = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)bytes, CFSTR("public.png"), 1, nullptr);
  bool ok = image && destination;
  if (ok) { CGImageDestinationAddImage(destination, image, nullptr); ok = CGImageDestinationFinalize(destination); }
  if (destination) CFRelease(destination); if (image) CGImageRelease(image); CGContextRelease(context);
  return ok ? bytes : nil;
}
static NSData *JpegFixture(NSData *png, NSUInteger orientation) {
  CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)png, nullptr);
  CGImageRef image = source ? CGImageSourceCreateImageAtIndex(source, 0, nullptr) : nullptr;
  if (source) CFRelease(source);
  if (!image) return nil;
  NSMutableData *bytes = [NSMutableData data];
  CGImageDestinationRef destination = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)bytes, CFSTR("public.jpeg"), 1, nullptr);
  bool ok = destination != nullptr;
  if (ok) {
    NSDictionary *properties = @{ (__bridge NSString *)kCGImagePropertyOrientation: @(orientation), (__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @1 };
    CGImageDestinationAddImage(destination, image, (__bridge CFDictionaryRef)properties);
    ok = CGImageDestinationFinalize(destination);
    CFRelease(destination);
  }
  CGImageRelease(image);
  if (!ok) return nil;
  // Fail the fixture if this SDK/codec discarded its EXIF direction; never report a pretend direction check.
  source = CGImageSourceCreateWithData((__bridge CFDataRef)bytes, nullptr);
  NSDictionary *metadata = source ? CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, nullptr)) : nil;
  if (source) CFRelease(source);
  const NSUInteger encodedOrientation = [metadata[(__bridge NSString *)kCGImagePropertyOrientation] unsignedIntegerValue];
  if (encodedOrientation != orientation && !(orientation == 1 && encodedOrientation == 0)) return nil;
  return bytes;
}
static NSDictionary *SelfTest(void) API_AVAILABLE(macos(10.15)) {
  NSDictionary *languages = Dispatch(@{@"version": @1, @"operation": @"languages"});
  NSDictionary *recognized = Recognize(Fixture(true), @[@"en-US"]);
  NSDictionary *blank = Recognize(Fixture(false), @[@"en-US"]);
  bool ok = [languages[@"success"] boolValue] && [recognized[@"success"] boolValue] && [recognized[@"text"] containsString:@"OCR 123"] && [blank[@"success"] boolValue] && [blank[@"lines"] count] == 0;
  ok = ok && ![Dispatch(@{@"version": @1, @"operation": @"recognize", @"imageBase64": @"!!!!", @"languages": @[]})[@"success"] boolValue];
  ok = ok && ![Recognize(Fixture(false), @[@"not-a-language"])[@"success"] boolValue];
  NSDictionary *jpeg = Recognize(JpegFixture(Fixture(true), 1), @[@"en-US"]);
  ok = ok && [jpeg[@"success"] boolValue] && [jpeg[@"text"] containsString:@"OCR 123"];
  NSDictionary *oriented = Recognize(JpegFixture(Fixture(false), 5), @[@"en-US"]);
  ok = ok && [oriented[@"success"] boolValue] && [oriented[@"width"] isEqual:@200] && [oriented[@"height"] isEqual:@1000];
  ok = ok && ![Dispatch(@{@"version": @YES, @"operation": @"languages"})[@"success"] boolValue];
  ok = ok && ![Dispatch(@{@"version": @1, @"operation": @"unknown"})[@"success"] boolValue];
#if defined(__arm64__)
  NSString *architecture = @"arm64";
#else
  NSString *architecture = @"x64";
#endif
  return @{ @"version": @1, @"success": @(ok), @"architecture": architecture, @"scope": @"vision-local-native", @"cases": @9 };
}
int main(int argc, char **argv) {
  @autoreleasepool {
    NSDictionary *result = Failure(@"OS_UNSUPPORTED");
    @try {
      if (@available(macOS 10.15, *)) {
        if (argc == 2 && strcmp(argv[1], "--self-test") == 0) result = SelfTest();
        else if (argc != 1) result = Failure(@"INVALID_REQUEST");
        else {
          NSMutableData *input = [NSMutableData data]; unsigned char chunk[8192]; size_t count = 0;
          while ((count = fread(chunk, 1, sizeof(chunk), stdin)) != 0) {
            if (input.length + count > 24 * 1024 * 1024) { result = Failure(@"INPUT_TOO_LARGE"); break; }
            [input appendBytes:chunk length:count];
          }
          if (input.length <= 24 * 1024 * 1024 && ![result[@"code"] isEqual:@"INPUT_TOO_LARGE"])
            result = ferror(stdin) ? Failure(@"INPUT_FAILED") : Dispatch([NSJSONSerialization JSONObjectWithData:input options:0 error:nil]);
        }
      }
    } @catch (NSException *exception) { result = Failure(@"RECOGNITION_FAILED"); }
    NSData *output = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    if (!output || output.length > 4 * 1024 * 1024 || fwrite(output.bytes, 1, output.length, stdout) != output.length || fflush(stdout) != 0) return 2;
    return [result[@"success"] boolValue] ? 0 : 1;
  }
}

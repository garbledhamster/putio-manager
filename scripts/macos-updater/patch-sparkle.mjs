import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Adapt only the supported CLI user-driver callbacks. Sparkle's verifier,
// downloader, extractor and installer are deliberately left untouched.
export function patchUserDriver(source) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Pinned Sparkle callback did not match.');
    source = source.replace(before, after);
  };
  replace('#import <Sparkle/Sparkle.h>', `#import <Sparkle/Sparkle.h>
#include <signal.h>
static BOOL putioGateStarted = NO;
void putioEmit(NSDictionary *event) {
    NSMutableDictionary *value = [event mutableCopy];
    value[@"schema"] = @1;
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
    if (!data) return;
    NSString *receipt = NSProcessInfo.processInfo.environment[@"PUTIO_UPDATER_RECEIPT"];
    if (receipt && ([value[@"phase"] isEqual:@"finished"] || [value[@"phase"] isEqual:@"failed"]))
        [data writeToFile:receipt options:NSDataWritingAtomic error:NULL];
    signal(SIGPIPE, SIG_IGN);
    fwrite(data.bytes, 1, data.length, stdout); fputc('\\n', stdout); fflush(stdout);
}
static void putioInstallGate(void (^reply)(SPUUserUpdateChoice)) {
    if (putioGateStarted) { reply(SPUUserUpdateChoiceSkip); return; }
    putioGateStarted = YES;
    putioEmit(@{@"phase": @"ready"});
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        char command[32];
        BOOL install = fgets(command, sizeof(command), stdin) != NULL && strcmp(command, "install\\n") == 0;
        dispatch_async(dispatch_get_main_queue(), ^{ reply(install ? SPUUserUpdateChoiceInstall : SPUUserUpdateChoiceSkip); });
    });
}`);
  replace('- (void)showUpdateWithAppcastItem:(SUAppcastItem *)appcastItem updateAdjective:(NSString *)updateAdjective\n{', '- (void)showUpdateWithAppcastItem:(SUAppcastItem *)appcastItem updateAdjective:(NSString *)updateAdjective\n{\n    putioEmit(@{@"phase": @"available", @"version": appcastItem.versionString});');
  replace('                } else {\n                    reply(SPUUserUpdateChoiceInstall);\n                }\n                break;', '                } else {\n                    putioInstallGate(reply);\n                }\n                break;');
  replace('- (void)showDownloadInitiatedWithCancellation:(void (^)(void))__unused cancellation\n{', '- (void)showDownloadInitiatedWithCancellation:(void (^)(void))__unused cancellation\n{\n    putioEmit(@{@"phase": @"downloading"});');
  replace('    _bytesDownloaded += length;', '    _bytesDownloaded += length;\n    if (_bytesToDownload > 0) putioEmit(@{@"phase": @"downloading", @"percent": @(MIN(100.0, (double)_bytesDownloaded * 100.0 / (double)_bytesToDownload))});');
  replace('- (void)showDownloadDidStartExtractingUpdate\n{', '- (void)showDownloadDidStartExtractingUpdate\n{\n    putioEmit(@{@"phase": @"verifying"});');
  replace('        installUpdateHandler(SPUUserUpdateChoiceInstall);', '        putioInstallGate(installUpdateHandler);');
  replace('- (void)showUpdateInstalledAndRelaunched:(BOOL)__unused relaunched acknowledgement:(void (^)(void))acknowledgement\n{', '- (void)showUpdateInstalledAndRelaunched:(BOOL)__unused relaunched acknowledgement:(void (^)(void))acknowledgement\n{\n    putioEmit(@{@"phase": @"finished", @"relaunched": @(relaunched)});');
  return source;
}
export function patchCommandDriver(source) {
  const before = '    _updater.userAgentString = userAgentString;';
  if (!source.includes(before)) throw new Error('Pinned Sparkle setup did not match.');
  source = source.replace('#import "SPUCommandLineDriver.h"', '#import "SPUCommandLineDriver.h"\nextern void putioEmit(NSDictionary *event);');
  source = source.replace(before, `${before}\n            _updater.sendsSystemProfile = NO;`);
  const check = '    // We can always probe for update information';
  if (!source.includes(check)) throw new Error('Pinned Sparkle selection did not match.');
  source = source.replace(check, `    NSString *expected = NSProcessInfo.processInfo.environment[@"PUTIO_UPDATER_EXPECTED_VERSION"];
    if (expected != nil && ![expected isEqualToString:updateItem.versionString]) {
        if (error) *error = [NSError errorWithDomain:SPARKLE_CLI_ERROR_DOMAIN code:CLIErrorCodeCannotPerformCheck userInfo:nil];
        return NO;
    }
${check}`);
  source = source.replace('- (void)startUpdater SPU_OBJC_DIRECT', `- (void)updater:(SPUUpdater *)updater willDownloadUpdate:(SUAppcastItem *)item withRequest:(NSMutableURLRequest *)request {
    NSString *expected = NSProcessInfo.processInfo.environment[@"PUTIO_UPDATER_EXPECTED_URL"];
    if (expected != nil && ![request.URL.absoluteString isEqualToString:expected]) exit(EXIT_FAILURE);
}
- (void)startUpdater SPU_OBJC_DIRECT`);
  const completion = '    if (error == nil) {\n        if (_verbose) {';
  if (!source.includes(completion)) throw new Error('Pinned Sparkle completion did not match.');
  source = source.replace(completion, `    if (error != nil) {
        NSString *code = @"installer-failed";
        if ([error.domain isEqualToString:SUSparkleErrorDomain]) {
            switch (error.code) {
                case SUSignatureError: case SUValidationError: code = @"signature-invalid"; break;
                case SUDownloadError: case SUAppcastError: code = @"network"; break;
                case SUInstallationWriteNoPermissionError: case SUAuthenticationFailure: code = @"permission-required"; break;
                case SUInstallationCanceledError: code = @"installer-cancelled"; break;
                default: break;
            }
        }
        putioEmit(@{@"phase": @"failed", @"code": code});
    }
${completion}`);
  return source;
}
export async function patchSparkleSource(directory) {
  const driver = path.join(directory, 'sparkle-cli', 'SPUCommandLineUserDriver.m');
  await writeFile(driver, patchUserDriver(await readFile(driver, 'utf8')));
  const command = path.join(directory, 'sparkle-cli', 'SPUCommandLineDriver.m');
  await writeFile(command, patchCommandDriver(await readFile(command, 'utf8')));
  const config = path.join(directory, 'Configurations', 'ConfigSparkleTool.xcconfig');
  const original = await readFile(config, 'utf8');
  if (!original.includes('PRODUCT_BUNDLE_IDENTIFIER = org.sparkle-project.sparkle-cli')) throw new Error('Pinned Sparkle identity did not match.');
  await writeFile(config, original.replace('PRODUCT_BUNDLE_IDENTIFIER = org.sparkle-project.sparkle-cli', 'PRODUCT_BUNDLE_IDENTIFIER = space.ourstuff.putiomanager.updater'));
  const plist = path.join(directory, 'sparkle-cli', 'Info.plist');
  await writeFile(plist, (await readFile(plist, 'utf8')).replace(/\s*<key>NSAppTransportSecurity<\/key>\s*<dict>\s*<key>NSAllowsArbitraryLoads<\/key>\s*<true\/>\s*<\/dict>/, ''));
}

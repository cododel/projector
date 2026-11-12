#import <Cocoa/Cocoa.h>
#import <Sparkle/Sparkle.h>

@interface ProjectorUpdateDelegate : NSObject <SPUUpdaterDelegate>
@property (nonatomic, copy) NSString *feedURL;
@end

@implementation ProjectorUpdateDelegate
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater {
    return self.feedURL;
}

- (BOOL)updaterShouldPromptForPermissionToCheckForUpdates:(SPUUpdater *)updater {
    return NO;
}

- (void)updater:(SPUUpdater *)updater didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)check error:(NSError *)error {
    // The standard driver has finished presenting the result to the user.
    [NSApp stop:nil];
    [NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined
        location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0
        context:nil subtype:0 data1:0 data2:0] atStart:NO];
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 3) return 2;
        NSBundle *host = [NSBundle bundleWithPath:[NSString stringWithUTF8String:argv[1]]];
        if (!host) return 3;
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        __attribute__((objc_precise_lifetime)) ProjectorUpdateDelegate *delegate = [ProjectorUpdateDelegate new];
        delegate.feedURL = [NSString stringWithUTF8String:argv[2]];
        SPUStandardUserDriver *driver = [[SPUStandardUserDriver alloc] initWithHostBundle:host delegate:nil];
        __attribute__((objc_precise_lifetime)) SPUUpdater *updater = [[SPUUpdater alloc] initWithHostBundle:host applicationBundle:host userDriver:driver delegate:delegate];
        NSError *error = nil;
        if (![updater startUpdater:&error]) {
            fprintf(stderr, "%s\n", error.localizedDescription.UTF8String);
            return 4;
        }
        [updater checkForUpdates];
        [NSApp run];
        return 0;
    }
}

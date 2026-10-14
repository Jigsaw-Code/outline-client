// Copyright 2023 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import "AppDelegate+Outline.h"
#import "Outline-Swift.h"

#if TARGET_OS_MACCATALYST
@import OutlineCatalystApp;
@import ServiceManagement;
#endif

@implementation AppDelegate (Outline)

#pragma mark - Lifecycle

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:
        (NSDictionary<UIApplicationLaunchOptionsKey, id> *)launchOptions {
#if TARGET_OS_MACCATALYST
    [OutlineCatalystApp initApp];
#endif

  [super application:application didFinishLaunchingWithOptions:launchOptions];

  return YES;
}

#if TARGET_OS_MACCATALYST
- (void)buildMenuWithBuilder:(id<UIMenuBuilder>)builder {
  [super buildMenuWithBuilder:builder];
  if (builder.system != UIMenuSystem.mainSystem) {
    return;
  }
  // Keep Command-Q as a window-only action. The status menu owns service Quit.
  NSString *title = [builder menuForIdentifier:UIMenuHide].children.firstObject.title;
  UIKeyCommand *hide = [UIKeyCommand commandWithTitle:title ?: @"Hide Outline"
      image:nil action:@selector(hideOutlineWindow:) input:@"q"
      modifierFlags:UIKeyModifierCommand propertyList:nil];
  [builder replaceChildrenOfMenuForIdentifier:UIMenuQuit
      fromChildrenBlock:^NSArray<UIMenuElement *> *(NSArray<UIMenuElement *> *children) {
        return @[hide];
      }];
}

- (void)hideOutlineWindow:(id)sender {
  [NSNotificationCenter.defaultCenter postNotificationName:@"outlineHideWindow" object:nil];
}
#endif

@end

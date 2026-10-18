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
#import "MainViewController.h"
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
  // UIKit 27 requires window creation in a scene delegate. Cordova's legacy
  // superclass creates an unassociated window here, so defer that work.
  return YES;
}

@end

@interface OutlineSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation OutlineSceneDelegate

- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session
      options:(UISceneConnectionOptions *)connectionOptions {
  if (![scene isKindOfClass:[UIWindowScene class]]) return;
  AppDelegate *delegate = (AppDelegate *)UIApplication.sharedApplication.delegate;
  if (!delegate.viewController) delegate.viewController = [[MainViewController alloc] init];
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  self.window.rootViewController = delegate.viewController;
  delegate.window = self.window;
  [self.window makeKeyAndVisible];
#if TARGET_OS_MACCATALYST
  static dispatch_once_t once;
  dispatch_once(&once, ^{ [OutlineCatalystApp initApp]; });
#endif
  [self scene:scene openURLContexts:connectionOptions.URLContexts];
}

- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)contexts {
  AppDelegate *delegate = (AppDelegate *)UIApplication.sharedApplication.delegate;
  for (UIOpenURLContext *context in contexts) {
    NSMutableDictionary *options = [NSMutableDictionary dictionary];
    if (context.options.sourceApplication) options[UIApplicationOpenURLOptionsSourceApplicationKey] = context.options.sourceApplication;
    if (context.options.annotation) options[UIApplicationOpenURLOptionsAnnotationKey] = context.options.annotation;
    [delegate application:UIApplication.sharedApplication openURL:context.URL options:options];
  }
}

@end

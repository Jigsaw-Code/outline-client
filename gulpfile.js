// Copyright 2018 The Outline Authors
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

'use strict';

const path = require('path');

const browserify = require('browserify');
const babel = require('gulp-babel');
const babel_preset_env = require('babel-preset-env');
const child_process = require('child_process');
const generateRtlCss = require('./scripts/generate_rtl_css.js');
const gulp = require('gulp');
const gulpif = require('gulp-if');
const gutil = require('gulp-util');
const polymer_build = require('polymer-build');
const nodeNotifier = require('node-notifier');
const source = require('vinyl-source-stream');

//////////////////
//////////////////
//
// Command-line options.
//
//////////////////
//////////////////

const platform = gutil.env.platform || 'android';
const isRelease = gutil.env.release;
const watchNotify = gutil.env['notify'];
const watchReinstallAndroidApp = gutil.env['reinstall-android-app'];
const watchReloadMacosBrowser = gutil.env['reload-macos-browser'];

if (typeof watchReloadMacosBrowser === 'boolean') {
  console.error('--reload-macos-browser argument must include a browser name (e.g. --reload-macos-browser="Google Chrome")');

  process.exit();
}

//////////////////
//////////////////
//
// Helper functions.
//
//////////////////
//////////////////

function runCommand(command) {
  const child = child_process.exec(command);
  // Though Gulp 4 handles "ChildProcess as task" elegantly, it does not make it easy to pass the
  // command's output through to the console.
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  return child;
}

//////////////////
//////////////////
//
// Web app tasks.
//
//////////////////
//////////////////

const WEBAPP_OUT = 'www';

// Copies Babel polyfill from node_modules, as it needs to be included by cordova_index.html.
function copyBabelPolyfill() {
  const babelPolyfill = 'node_modules/babel-polyfill/dist/polyfill.min.js';
  return runCommand(`cp -v ${babelPolyfill} ${WEBAPP_OUT}/babel-polyfill.min.js`);
}

// Bundles code with the entry point www/app/cordova_main.js -> www/cordova_main.js.
//
// Useful Gulp/Browserify examples:
//   https://github.com/gulpjs/gulp/tree/master/docs/recipes
function browserifyAndBabelify() {
  return browserify({entries: `${WEBAPP_OUT}/app/cordova_main.js`, debug: true})
      .transform('babelify', {
        // Transpile code in node_modules, too.
        global: true,
        presets: ['env']
      })
      .bundle()
      // Transform the bundle() output stream into one regular Gulp plugins understand.
      .pipe(source('cordova_main.js'))
      .pipe(gulp.dest(WEBAPP_OUT));
}

// Transpiles to |src| to ES5, copying the output to |dest|.
function transpile(src, dest) {
  const sourcesHtmlSplitter = new polymer_build.HtmlSplitter();
  return gulp.src(src)
      .pipe(sourcesHtmlSplitter.split())
      .pipe(gulpif(/\.js$/, babel({presets: [babel_preset_env.default()]})))
      .pipe(sourcesHtmlSplitter.rejoin())
      .pipe(gulp.dest(dest));
}

// Note: This is currently done "in-place", i.e. the components are downloaded to `WEBAPP_OUT` and
// transpiled there, but this seems to work just fine (idempodent).
function transpileBowerComponents() {
  // Transpile bower_components with the exception of webcomponentsjs, which contains transpiled
  // polyfills, and minified files, which are generally already transpiled.
  const bowerComponentsSrc = [
    `${WEBAPP_OUT}/bower_components/**/*.html`, `${WEBAPP_OUT}/bower_components/**/*.js`,
    `!${WEBAPP_OUT}/bower_components/webcomponentsjs/**/*.js`,
    `!${WEBAPP_OUT}/bower_components/webcomponentsjs/**/*.html`,
    `!${WEBAPP_OUT}/bower_components/**/*.min.js`
  ];
  const bowerComponentsDest = `${WEBAPP_OUT}/bower_components`;
  return transpile(bowerComponentsSrc, bowerComponentsDest);
}

// Transpiling and generating RTL CSS happens sequentially, which means that the output of the first
// step must be the source of the next; otherwise the last step will clobber the previous steps.
// To avoid this, we transpile and generate RTL CSS in-place, with `WEBAPP_OUT` as input and output.
function transpileUiComponents() {
  return transpile([`${WEBAPP_OUT}/ui_components/*.html`], `${WEBAPP_OUT}/ui_components`);
}

function rtlCss() {
  return generateRtlCss(`${WEBAPP_OUT}/ui_components/*.html`, `${WEBAPP_OUT}/ui_components`)
}

function buildWebApp() {
  return runCommand(`yarn do src/www/build`);
}

const transpileWebApp = gulp.series(
    copyBabelPolyfill, browserifyAndBabelify, transpileBowerComponents, transpileUiComponents,
    rtlCss);

//////////////////
//////////////////
//
// Cordova tasks.
//
//////////////////
//////////////////

// "platform add" is weird: although "cordova build" will succeed without having run it first,
// *certain things won't behave as you'd expect*, notably cordova-custom-config.
function cordovaPlatformAdd() {
  // "platform add" fails if the platform has already been added.
  return runCommand(`test -d platforms/${platform} || yarn cordova platform add ${platform}`);
}

function cordovaPrepare() {
  return runCommand(`yarn cordova prepare ${platform}`);
}

function xcode() {
  return runCommand(
      (platform === 'ios' || platform === 'osx') ?
          `rsync -avc apple/xcode/${platform}/ platforms/${platform}/` :
          'echo not running on apple, skipping xcode rsync');
}

function cordovaCompile() {
  const platformArgs = platform === 'android' ? '--gradleArg=-PcdvBuildMultipleApks=true' : '';
  // Use flag -UseModernBuildSystem=0 as a workaround for Xcode 10 compatibility until upgrading to
  // cordova-ios@5.0.0. See https://github.com/apache/cordova-ios/issues/404.
  const compileArgs = platform === 'ios' ? '--device --buildFlag="-UseModernBuildSystem=0"' : '';
  const releaseArgs = isRelease ? platform === 'android' ?
                                  `--release --keystore=${gutil.env.KEYSTORE} ` +
              `--storePassword=${gutil.env.STOREPASS} --alias=${gutil.env.KEYALIAS} ` +
              `--password=${gutil.env.KEYPASS}` :
                                  '--release' :
                                  '';
  return runCommand(`yarn cordova compile ${platform} ${compileArgs} ${releaseArgs} ${platformArgs}`);
}

const setupWebApp = gulp.series(buildWebApp, transpileWebApp, writeEnvJson);
const setupCordova = gulp.series(cordovaPlatformAdd, cordovaPrepare, xcode);

//////////////////
//////////////////
//
// Watch tasks
//
//////////////////
//////////////////

const cordovaBuild = gulp.series(cordovaPrepare, xcode, cordovaCompile);

/**
 * Trigger system notification when rebuild complete if `--notify` argument
 * passed
 */
function notifyRebuildComplete(done) {
  if (!watchNotify) {
    return;
  }

  nodeNotifier.notify({
    icon: path.join(__dirname, 'resources/icons/osx/icon-64.png'),
    message: `${platform} rebuild complete`,
    remove: 'ALL',
    title: 'outline-client',
  });

  done();
}

/**
 * If platform is browser and `--reload-macos-browser` argument passed, use
 * AppleScript to reload front tab of browser. (Only works on macOS since it
 * relies on AppleScript, and only works on Chromium and Safari browsers since
 * Firefox has a weak AppleScript dictionary.)
 *
 * If platform is android and `--reinstall-android-app` arugment passed, use
 * `adb` to reinstall and start Android app on attached device. (This may not
 * work well on some configurations -- it has only been tested on one machine.)
 */
function reloadAppOrBrowser(done) {
  if (
    platform === 'browser'
    && typeof watchReloadMacosBrowser === 'string'
  ) {
    const appleScriptCommand = (() => {
      if (watchReloadMacosBrowser.includes('Safari')) {
        return 'set URL of front document to (URL of front document)';
      }
      if (watchReloadMacosBrowser.includes('Chrom') || watchReloadMacosBrowser.includes('Edge')) {
        return 'reload active tab of window 1';
      }
      return null;
    })();

    if (typeof appleScriptCommand === 'string') {
      runCommand(`osascript -e 'tell app "${watchReloadMacosBrowser}" to ${appleScriptCommand}'`);
    } else {
      console.warn(`Browser "${watchReloadMacosBrowser}" can’t be reloaded with AppleScript`);
    }

    return done();
  }

  if (
    platform === 'android'
    && watchReinstallAndroidApp
  ) {
    runCommand('adb install -r ./platforms/android/app/build/outputs/apk/debug/app-debug.apk && adb shell am start -n org.outline.android.client/org.outline.android.client.MainActivity');

    return done();
  }

  return done();
}

/**
 * This is a slightly modified version of the transpileUiComponents task. It
 * sources the files from `src/www/ui_components` rather than
 * `www/ui_components`, which is rsynced during the buildWebApp task (in
 * `src/www/build_action.sh`). The buildWebApp task is excluded from watch tasks
 * to improve rebuild speed.
 */
function transpileUiComponentsWatch() {
  return transpile([`src/www/ui_components/*.html`], `${WEBAPP_OUT}/ui_components`);
}

/**
 * Watch for changes in www/ui_components/*.html and www/app/*.js and rebuild
 * affected parts of the code.
 *
 * Note that this isn’t a full rebuild. It deliberately excludes parts of the
 * rebuild process (e.g. transpileBowerComponents) to reduce the build time.
 *
 * www/app/*.js files are built by tsc, so src/www/watch_action.sh needs to be
 * run in parallel.
 *
 * Note: This has only been tested with the browser and Android versions. It may
 * not be compatible with other platforms, particularly Windows (Electron).
 */
function watch() {
  console.info('Watching for changes to src/www/ui_components/*.html and www/app/*.js. Run ./src/www/watch_action.sh or ./src/electron/watch_action.sh in a separate shell for live reload on changes to src/www/app/*.ts')

  gulp.watch(
    [`src/www/ui_components/*.html`],
    gulp.series(
      transpileUiComponentsWatch,
      rtlCss,
      cordovaBuild,
      reloadAppOrBrowser,
      notifyRebuildComplete
    ),
  );

  gulp.watch(
    [`www/app/*.js`],
    gulp.series(
      copyBabelPolyfill,
      browserifyAndBabelify,
      cordovaBuild,
      reloadAppOrBrowser,
      notifyRebuildComplete
    ),
  );
}

//////////////////
//////////////////
//
// All other and
// exported tasks.
//
//////////////////
//////////////////

// Writes a JSON file accessible to environment.ts containing environment variables.
function writeEnvJson() {
  // bash for Windows' (Cygwin's) benefit (sh can *not* run this script, at least on Alpine).
  return runCommand(`bash scripts/environment_json.sh -p ${platform} ${isRelease ? '-r' : ''} > ${
      WEBAPP_OUT}/environment.json`);
}

const build = gulp.series(setupWebApp, setupCordova, cordovaCompile);

exports.build = build;
exports.setup = gulp.series(setupWebApp, setupCordova);
exports.watch = gulp.series(build, watch);

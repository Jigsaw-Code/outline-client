// Copyright 2020 The Outline Authors
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
import {createRequire} from 'module';
import path from 'path';
import {fileURLToPath} from 'url';

import {getRootDir} from '@outline/infrastructure/build/get_root_dir.mjs';
import CopyPlugin from 'copy-webpack-plugin';
import TerserPlugin from 'terser-webpack-plugin';

export const require = createRequire(import.meta.url);
export const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);

export const GENERATE_CSS_RTL_LOADER = path.resolve(
  __dirname,
  'webpack_css_rtl_loader.cjs'
);

export const TS_LOADER = {
  loader: 'ts-loader',
  options: {
    configFile: path.resolve(__dirname, 'tsconfig.json'),
  },
};

export const baseConfig = {
  resolve: {
    extensions: ['.ts', '.js', '.mts', '.mjs'],
    fallback: {url: require.resolve('url/')},
    // These aliai prevents multiple copies of lit from creeping into the build:
    // See: https://lit.dev/docs/tools/development/#multiple-lit-versions

    // We should be able to remove this once we drop support for iOS 15 and consolidate
    // our component libraries (see #2345)
    alias: {
      lit: path.resolve(getRootDir(), 'node_modules/lit'),
      'lit/*': path.resolve(getRootDir(), 'node_modules/lit/*'),
      'lit-html': path.resolve(getRootDir(), 'node_modules/lit-html'),
      '@lit/reactive-element': path.resolve(
        getRootDir(),
        'node_modules/@lit/reactive-element'
      ),
    },
  },
  optimization: {
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          keep_classnames: true,
          keep_fnames: true,
        },
      }),
    ],
  },
  externals: {
    // See https://github.com/modernweb-dev/web/issues/1908.
    '/__web-dev-server__web-socket.js':
      'commonjs __web-dev-server__web-socket.js',
  },
};

export const browserConfig = {
  entry: [path.resolve(__dirname, 'style.css')],
  output: {
    path: path.resolve(__dirname, '..', 'www'),
    filename: 'main.js',
  },
  module: {
    rules: [
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
      {
        test: /assets[/\\].*\.(png|woff2|svg)$/,
        use: ['file-loader'],
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [{from: 'messages', to: 'messages', context: __dirname}],
    }),
  ],
};

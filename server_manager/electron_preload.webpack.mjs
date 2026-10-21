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

import path from 'node:path';
import {fileURLToPath} from 'node:url';

import nodeExternals from 'webpack-node-externals';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// emit source maps only for debug builds.
export default (env, argv) => ({
  devtool: argv.mode === 'development' ? 'inline-source-map' : false,
  entry: path.resolve(__dirname, './electron/preload.ts'),
  target: 'electron-preload',
  output: {
    path: path.resolve(
      __dirname,
      '../output/build/server_manager/electron/static'
    ),
    filename: 'preload.js',
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  // don't bundle packages in node_modules
  externals: [nodeExternals()],
});

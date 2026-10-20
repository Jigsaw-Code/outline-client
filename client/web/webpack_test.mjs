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
import {merge} from 'webpack-merge';

import {baseConfig, TS_LOADER} from './webpack_base.mjs';

export default merge(baseConfig, {
  devtool: 'inline-source-map',
  module: {
    rules: [
      {
        test: /\.m?ts$/,
        exclude: /node_modules/,
        use: [TS_LOADER],
      },
      {
        test: /\.m?(t|j)s$/,
        exclude: /(node_modules|\.spec\.m?(t|j)s$)/,
        loader: '@jsdevtools/coverage-istanbul-loader',
        enforce: 'post',
      },
      {
        test: /\.png$/,
        use: ['file-loader'],
      },
      {
        test: /\.svg$/,
        use: ['file-loader'],
      },
      {
        test: /\.txt$/i,
        loader: 'raw-loader',
      },
    ],
  },
});

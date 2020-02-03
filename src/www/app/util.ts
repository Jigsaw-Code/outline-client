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

import * as errors from '../model/errors';

// Attempts to settle `promise`, but times it out after `ms` milliseconds.  A failed return type
// could either be a timed-out Promise or a failed Promise.  Use an instanceof guard to
// differentiate between the two.
export function timeoutPromise<T>(promise: Promise<T>, ms: number, name = ''): Promise<void|T> {
  let winner: Promise<void|T>;
  const timeout = new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      clearTimeout(timeoutId);
      // Failed promises are still truth-y
      if (winner) {
        console.log(`Promise "${name}" resolved before ${ms} ms.`);
        resolve();
      } else {
        console.log(`Promise "${name}" timed out after ${ms} ms.`);
        reject(new errors.OperationTimedOut(ms, name));
      }
    }, ms);
  });
  winner = Promise.race([promise, timeout]);
  return winner;
}

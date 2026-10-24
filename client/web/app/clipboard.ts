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

export type ClipboardListener = (text: string) => void;

export interface Clipboard {
  // Returns the current contents of the clipboard.
  getContents(): Promise<string>;

  // Sets a callback to be invoked when the contents of the clipboard should be read. When this
  // happens is implementation-dependent, e.g. it could be timer-based or, as is the case on mobile,
  // whenever the app is brought to the foreground.
  setListener(listener: ClipboardListener): void;
}

// Generic clipboard. Implementations should only have to implement getContents().
export class AbstractClipboard implements Clipboard {
  private listener: ClipboardListener | null = null;

  getContents(): Promise<string> {
    return Promise.reject(new Error('unimplemented skeleton method'));
  }

  setListener(listener: ClipboardListener) {
    this.listener = listener;
  }

  emitEvent() {
    if (this.listener) {
      this.getContents().then(this.listener);
    }
  }
}

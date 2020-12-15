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

export class InMemoryStorage implements Storage {
  readonly length = 0;
  [key: string]: {};
  [index: number]: string;

  constructor(private store: Map<string, string> = new Map<string, string>()) {}

  clear(): void {
    throw new Error('InMemoryStorage.clear not implemented');
  }

  getItem(key: string): string|null {
    return this.store.get(key) || null;
  }

  key(index: number): string|null {
    throw new Error('InMemoryStorage.key not implemented');
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, data: string): void {
    this.store.set(key, data);
  }
}

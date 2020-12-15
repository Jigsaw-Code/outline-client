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

import {InMemoryStorage} from '../infrastructure/memory_storage';

import {Settings, SettingsKey} from './settings';

const FAKE_SETTINGS_KEYS = ['key', 'key1', 'key2'];

describe('Settings', () => {
  it('sets and gets settings', () => {
    const key = 'key';
    const value = 'value';
    const settings = new Settings(new InMemoryStorage(), FAKE_SETTINGS_KEYS);
    settings.set(key, value);
    expect(settings.get(key)).toEqual(value);
  });

  it('loads existing settings', () => {
    const store = new Map([[Settings.STORAGE_KEY, '{"key1": "value1", "key2": "value2"}']]);
    const settings = new Settings(new InMemoryStorage(store), FAKE_SETTINGS_KEYS);
    expect(settings.get('key1')).toEqual('value1');
    expect(settings.get('key2')).toEqual('value2');
  });

  it('removes settings', () => {
    const key = 'key';
    const value = 'value';
    const settings = new Settings(new InMemoryStorage(), FAKE_SETTINGS_KEYS);
    settings.set(key, value);
    expect(settings.get(key)).toEqual(value);
    settings.remove(key);
    expect(settings.get(key)).toBeUndefined();
  });

  it('persists settings', () => {
    const key = 'key';
    const value = 'value';
    const storage = new InMemoryStorage();
    let settings = new Settings(storage, FAKE_SETTINGS_KEYS);
    settings.set(key, value);
    // Instantiate a new settings object to validate that settings have been persisted to storage.
    settings = new Settings(storage);
    expect(settings.get(key)).toEqual(value);
  });

  it('returns valid keys', () => {
    const settings = new Settings(new InMemoryStorage(), FAKE_SETTINGS_KEYS);
    expect(settings.isValidSetting('key')).toBeTruthy();
  });

  it('returns invalid keys', () => {
    const settings = new Settings(new InMemoryStorage(), FAKE_SETTINGS_KEYS);
    expect(settings.isValidSetting('invalidKey')).toBeFalsy();
  });

  it('is initialized with default valid keys', () => {
    // Constructor uses SettingKeys as the default value for valid keys.
    const settings = new Settings(new InMemoryStorage());
    expect(settings.isValidSetting(SettingsKey.VPN_WARNING_DISMISSED)).toBeTruthy();
  });

  it('throws when setting an invalid key', () => {
    const settings = new Settings(new InMemoryStorage(), FAKE_SETTINGS_KEYS);
    expect(() => {
      settings.set('invalidSetting', 'value');
    }).toThrowError();
  });

  it('throws when storage is corrupted', () => {
    const storage = new InMemoryStorage(new Map([[Settings.STORAGE_KEY, '"malformed": "json"']]));
    expect(() => {
      const settings = new Settings(storage, FAKE_SETTINGS_KEYS);
    }).toThrowError(SyntaxError);
  });
});

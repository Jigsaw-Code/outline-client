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

import {InMemoryStorage} from '../infrastructure/memory_storage';
import {ServerConfig} from '../model/server';

import {ConfigById, ConfigByIdV0, migrateServerConfigStorageToV1, PersistentServerRepository} from './persistent_server';

// TODO(alalama): unit tests for PersistentServerRepository

describe('migrateServerConfigStorageToV1', () => {
  it('migrates storage to V1', () => {
    const config0: ShadowsocksConfig = {
      host: '127.0.0.1',
      port: 1080,
      password: 'test',
      method: 'chacha20-ietf-poly1305',
      name: 'fake server 0'
    };
    const config1: ShadowsocksConfig = {
      host: '127.0.0.1',
      port: 1089,
      password: 'test',
      method: 'chacha20-ietf-poly1305',
      name: 'fake server 1'
    };
    const configByIdV0: ConfigByIdV0 = {'server-0': config0, 'server-1': config1};
    const configByIdV0Json = JSON.stringify(configByIdV0);
    const storage = new InMemoryStorage(
        new Map([[PersistentServerRepository.SERVERS_STORAGE_KEY_V0, configByIdV0Json]]));

    migrateServerConfigStorageToV1(storage);

    const configByIdV1Json = storage.getItem(PersistentServerRepository.SERVERS_STORAGE_KEY);
    expect(configByIdV1Json).toBeDefined();
    const configByIdV1: ConfigById = JSON.parse(configByIdV1Json || '');
    expect(configByIdV1['server-0'].proxy).toEqual(configByIdV0['server-0']);
    expect(configByIdV1['server-0'].name).toEqual(configByIdV0['server-0'].name);
    expect(configByIdV1['server-1'].proxy).toEqual(configByIdV0['server-1']);
    expect(configByIdV1['server-1'].name).toEqual(configByIdV0['server-1'].name);
  });

  it('loads migrated V1 servers', () => {
    const config0: ServerConfig = {
      proxy: {
        host: '127.0.0.1',
        port: 1080,
        password: 'test',
        method: 'chacha20-ietf-poly1305',
        name: 'server 0'
      },
      name: 'server 0'
    };
    const config1: ServerConfig = {
      proxy: {host: '127.0.0.1', port: 1089, password: 'test', method: 'chacha20-ietf-poly1305'},
      name: 'server 1'
    };
    const configByIdV1: ConfigById = {'server-0': config0, 'server-1': config1};
    const configByIdV0Json = JSON.stringify(configByIdV1);
    const storage = new InMemoryStorage(
        new Map([[PersistentServerRepository.SERVERS_STORAGE_KEY, configByIdV0Json]]));

    migrateServerConfigStorageToV1(storage);

    const configByIdV1Json = storage.getItem(PersistentServerRepository.SERVERS_STORAGE_KEY);
    expect(configByIdV1Json).toBeDefined();
    const configByIdV1Storage: ConfigById = JSON.parse(configByIdV1Json || '');
    expect(configByIdV1Storage).toEqual(configByIdV1);
  });
});
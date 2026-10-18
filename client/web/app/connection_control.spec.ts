// Copyright 2026 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {ConnectionControl, VpnSnapshot} from './connection_control';
import {Server, ServerRepository} from '../model/server';

describe('ConnectionControl', () => {
  let state: VpnSnapshot;
  let servers: Server[];
  let control: ConnectionControl;

  beforeEach(() => {
    state = {
      serverId: 'singapore',
      state: 'connected',
      onDemand: true,
      desiredConnected: true,
    };
    servers = ['singapore', 'frankfurt'].map(id => ({
      id,
      name: id,
      address: '',
      connect: async () => {
        state = {...state, serverId: id, state: 'connected'};
      },
      disconnect: async () => {
        state = {
          ...state,
          state: 'disconnected',
          onDemand: false,
          desiredConnected: false,
        };
      },
      checkRunning: async () => state.serverId === id,
    }));
    const repo = {
      getAll: () => servers,
      getById: (id: string) => servers.find(server => server.id === id),
    } as ServerRepository;
    control = new ConnectionControl(repo);
  });

  const snapshot = async () => state;
  const stop = async () => {
    state = {
      ...state,
      state: 'disconnected',
      onDemand: false,
      desiredConnected: false,
    };
  };
  const request = (action: string, server?: string, expected?: string) =>
    control.request(
      {action, server, expected, deadline: Date.now() + 10000},
      snapshot,
      stop
    );

  it('switches the active server through the shared queue', async () => {
    const result = await request('connect', 'frankfurt');
    expect(result).toEqual(jasmine.objectContaining({ok: true}));
    expect(state.serverId).toBe('frankfurt');
  });

  it('respects a manual disconnect when recovery is requested', async () => {
    await request('disconnect');
    const result = await request('recover', 'frankfurt', 'singapore');
    expect(result).toEqual(
      jasmine.objectContaining({ok: false, error: 'recovery_cancelled'})
    );
    expect(state.desiredConnected).toBe(false);
  });

  it('rejects recovery if the selected server changed', async () => {
    await request('connect', 'frankfurt');
    const result = await request('recover', 'singapore', 'singapore');
    expect(result).toEqual(
      jasmine.objectContaining({ok: false, error: 'recovery_cancelled'})
    );
    expect(state.serverId).toBe('frankfurt');
  });

  it('does not reveal errors returned by the VPN layer', async () => {
    servers[1].connect = async () => {
      throw Error('SECRET_ACCESS_KEY');
    };
    const result = await request('connect', 'frankfurt');
    expect(result).toEqual(
      jasmine.objectContaining({ok: false, error: 'operation_failed'})
    );
    expect(JSON.stringify(result)).not.toContain('SECRET_ACCESS_KEY');
  });
});

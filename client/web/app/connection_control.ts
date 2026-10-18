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

import {Server, ServerRepository} from '../model/server';

export interface VpnSnapshot {
  serverId: string | null;
  state: string;
  onDemand: boolean;
  desiredConnected: boolean;
}

export interface ControlRequest {
  action: string;
  server?: string;
  expected?: string;
  deadline?: number;
  domains?: string[];
}

// Both GUI buttons and local CLI commands enter this queue. In particular,
// an explicit user action invalidates watchdog work that has not started yet.
export class ConnectionControl {
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;

  constructor(private readonly repo: ServerRepository) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  connect(server: Server): Promise<void> {
    this.generation++;
    return this.enqueue(() => server.connect());
  }

  disconnect(server: Server): Promise<void> {
    this.generation++;
    return this.enqueue(() => server.disconnect());
  }

  async request(
    request: ControlRequest,
    snapshot: () => Promise<VpnSnapshot>,
    stop: () => Promise<void>,
    exclusions?: {
      read: () => Promise<object>;
      write: (domains: string[]) => Promise<object>;
    }
  ): Promise<object> {
    if (
      ![
        'status',
        'servers',
        'connect',
        'disconnect',
        'reconnect',
        'recover',
        'exclusions',
        'set-exclusions',
      ].includes(request.action)
    ) {
      return {ok: false, error: 'unknown_command'};
    }
    const automatic = request.action === 'recover';
    const readOnly = ['status', 'servers', 'exclusions'].includes(
      request.action
    );
    if (!automatic && !readOnly) this.generation++;
    const generation = this.generation;
    const describe = async () => ({
      ...(await snapshot()),
      servers: this.repo
        .getAll()
        .map(server => ({id: server.id, name: server.name})),
    });
    // Read-only commands can report status even when a tunnel operation stalls.
    if (readOnly) {
      try {
        if (request.action === 'exclusions') {
          if (!exclusions) return {ok: false, error: 'unsupported_platform'};
          return {ok: true, ...(await exclusions.read())};
        }
        return {ok: true, ...(await describe())};
      } catch {
        return {ok: false, error: 'status_unavailable'};
      }
    }
    return this.enqueue(async () => {
      try {
        if (!request.deadline || Date.now() >= request.deadline) {
          return {ok: false, error: 'request_expired'};
        }
        if (request.action === 'set-exclusions') {
          if (!exclusions) return {ok: false, error: 'unsupported_platform'};
          if (
            !Array.isArray(request.domains) ||
            request.domains.length > 100 ||
            request.domains.some(
              domain => typeof domain !== 'string' || domain.length > 253
            )
          ) {
            return {ok: false, error: 'invalid_domains'};
          }
          const state = await snapshot();
          if (
            state.state !== 'disconnected' ||
            state.desiredConnected ||
            state.onDemand
          ) {
            return {ok: false, error: 'disconnect_before_saving'};
          }
          return {ok: true, ...(await exclusions.write(request.domains))};
        }
        if (request.action === 'disconnect') {
          await stop();
          const result = await describe();
          return {
            ok:
              result.state === 'disconnected' &&
              !result.onDemand &&
              !result.desiredConnected,
            ...result,
          };
        }
        if (
          typeof request.server !== 'string' ||
          !request.server ||
          request.server.length > 256
        ) {
          return {ok: false, error: 'server_required'};
        }
        // IDs take precedence. Names must match exactly and unambiguously.
        const byId = this.repo.getById(request.server);
        const matches = byId
          ? [byId]
          : this.repo.getAll().filter(server => server.name === request.server);
        if (matches.length !== 1)
          return {
            ok: false,
            error: matches.length ? 'ambiguous_server_name' : 'unknown_server',
          };
        const server = matches[0];
        const before = await snapshot();
        if (Date.now() >= request.deadline)
          return {ok: false, error: 'request_expired'};
        if (
          automatic &&
          (!request.expected ||
            request.expected !== before.serverId ||
            before.desiredConnected !== true ||
            generation !== this.generation)
        ) {
          return {ok: false, error: 'recovery_cancelled', ...before};
        }
        if (
          request.action !== 'connect' ||
          before.serverId !== server.id ||
          before.state !== 'connected' ||
          !before.desiredConnected
        ) {
          await server.connect();
        }
        const after = await describe();
        return {
          ok: after.serverId === server.id && after.state === 'connected',
          ...after,
        };
      } catch {
        // Native errors can include transport configuration. Never return them
        // through the command socket or the watchdog's logs.
        return {ok: false, error: 'operation_failed'};
      }
    });
  }
}

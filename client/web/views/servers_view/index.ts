/*
  Copyright 2020 The Outline Authors

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

import '@material/mwc-button';

import {Localizer} from '@outline/infrastructure/i18n';
import {css, html, LitElement} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import {DirectiveResult} from 'lit/directive';
import {unsafeHTML, UnsafeHTMLDirective} from 'lit/directives/unsafe-html.js';

import {ServerConnectionState as _ServerConnectionState} from './server_connection_indicator';
import './server_connection_indicator';
import './server_list';
import {ServerListItem as _ServerListItem} from './server_list_item';

export type ServerListItem = _ServerListItem;

// (This value is used: it's exported.)
// eslint-disable-next-line @typescript-eslint/no-unused-vars, no-unused-vars
export import ServerConnectionState = _ServerConnectionState;

@customElement('servers-view')
export class ServerList extends LitElement {
  @property({type: Boolean}) darkMode = false;

  static styles = [
    css`
      :host {
        /* Stretched by app-root's page area to the space below the header. */
        display: flex;
        flex-direction: column;
        font-size: 0.9rem;
        line-height: 1.25rem;
        margin: 0 auto;
        max-width: 400px;
        width: 100%;
      }
      :host a {
        color: var(--outline-primary);
        text-decoration: none;
      }
      section {
        display: flex;
        flex-direction: column;
        flex: 1;
      }
      header {
        display: flex;
        flex-direction: column;
        flex: 1;
        justify-content: center;
        line-height: 32px;
        text-align: center;
      }
      h1,
      h2,
      footer {
        color: var(--outline-label-color);
        margin: 0;
      }
      h1 {
        color: var(--outline-text-color);
        font-size: 1.25rem;
        font-weight: 400;
      }
      h2 {
        color: var(--outline-text-color);
        font-size: 0.9rem;
        font-weight: initial;
        line-height: 1.5;
      }
      footer {
        border-top: 1px solid var(--outline-hairline);
        color: var(--outline-text-color);
        padding: 24px 0 max(16px, env(safe-area-inset-bottom));
        text-align: center;
      }
      /* Moved from global CSS - specific styling for zero state footer */
      section footer {
        color: var(--outline-text-color);
      }
      section footer a {
        color: var(--outline-primary);
      }
      button {
        align-items: center;
        background-color: transparent;
        border: 0;
        color: var(--outline-text-color);
        display: flex;
        flex-direction: column;
        justify-content: center;
        outline: none; /* Remove outline for Safari. */
        padding: 0;
      }
      button:hover {
        cursor: pointer;
      }
      server-connection-indicator {
        height: 192px;
        margin-bottom: 34px;
        width: 192px;
      }
    `,
  ];

  @property({type: Object}) localize: Localizer = msg => msg;
  @property({type: Boolean}) shouldShowAccessKeyWikiLink = false;
  @property({type: Array}) servers: ServerListItem[] = [];

  get shouldShowZeroState() {
    return this.servers ? this.servers.length === 0 : false;
  }

  private requestPromptAddServer() {
    this.dispatchEvent(
      new CustomEvent('add-server', {bubbles: true, composed: true})
    );
  }

  private get zeroStateContent(): DirectiveResult<typeof UnsafeHTMLDirective> {
    let msg;
    if (this.shouldShowAccessKeyWikiLink) {
      msg = this.localize(
        'server-create-your-own-zero-state-access',
        'breakLine',
        '<br/>',
        'openLink',
        '<a href=https://s3.amazonaws.com/outline-vpn/get-started/#step-1>',
        'openLink2',
        '<a href=https://www.reddit.com/r/outlinevpn/wiki/index/outline_vpn_access_keys/>',
        'closeLink',
        '</a>'
      );
    } else {
      msg = this.localize(
        'server-create-your-own-zero-state',
        'breakLine',
        '<br/>',
        'openLink',
        '<a href=https://s3.amazonaws.com/outline-vpn/get-started/#step-1>',
        'closeLink',
        '</a>'
      );
    }
    return unsafeHTML(msg);
  }

  render() {
    if (this.shouldShowZeroState) {
      return html`
        <section>
          <header>
            <button type="button" @click=${this.requestPromptAddServer}>
              <server-connection-indicator
                connection-state="disconnected"
                ?darkMode=${this.darkMode}
              ></server-connection-indicator>
              <h1>${this.localize('server-add')}</h1>
              <h2>${this.localize('server-add-zero-state-instructions')}</h2>
            </button>
          </header>
          <footer>${this.zeroStateContent}</footer>
        </section>
      `;
    } else {
      return html`
        <server-list
          ?darkMode=${this.darkMode}
          .servers=${this.servers}
          .localize=${this.localize}
        ></server-list>
      `;
    }
  }
}

/*
  Copyright 2024 The Outline Authors
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

import {LitElement, html, css} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';

@customElement('root-header')
export class RootHeader extends LitElement {
  @property({type: String}) title = '';
  @property({type: Boolean}) showBackButton = false;
  @property({type: Boolean}) showAddButton = false;

  static styles = css`
    header {
      align-items: center;
      justify-content: space-between;
      background-color: var(--outline-dark-primary);
      display: flex;
      min-height: 64px;
      /* Where the WebView extends under the status bar (iOS with
       * viewport-fit=cover), grow by the inset so the bar sits on the header
       * color. Elsewhere the inset is 0. */
      padding: env(safe-area-inset-top, 0px) 16px 0 16px;
    }

    h1 {
      color: var(--outline-white);
      font-family: 'Jigsaw Sans', 'Roboto', sans-serif;
      font-size: 24px;
      font-weight: 500;
      margin: 0;
      user-select: none;
    }

    md-icon {
      color: var(--outline-white);
    }

    .hidden {
      visibility: hidden;
    }
  `;

  render() {
    return html`<header>
      ${this.showBackButton
        ? html`<md-icon-button @click=${this.returnHome}>
            <md-icon>arrow_back</md-icon>
          </md-icon-button>`
        : html`<md-icon-button @click=${this.openNavigation}>
            <md-icon>menu</md-icon>
          </md-icon-button>`}
      <h1>${this.title || 'Outline'}</h1>
      <md-icon-button
        class=${classMap({hidden: !this.showAddButton})}
        @click=${this.openAddAccessKey}
      >
        <md-icon>add</md-icon>
      </md-icon-button>
    </header>`;
  }

  openAddAccessKey() {
    this.dispatchEvent(
      new CustomEvent('ShowAddServerDialog', {
        bubbles: true,
        composed: true,
      })
    );
  }

  openNavigation() {
    this.dispatchEvent(
      new CustomEvent('ShowNavigation', {
        bubbles: true,
        composed: true,
      })
    );
  }

  returnHome() {
    this.dispatchEvent(
      new CustomEvent('ChangePage', {
        detail: {page: 'home'},
        bubbles: true,
        composed: true,
      })
    );
  }
}

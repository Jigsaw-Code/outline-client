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

/// <reference types="../../types/shims" />

import {LitElement, html, css} from 'lit';
import {customElement} from 'lit/decorators.js';

import licenses from './licenses/licenses.txt?raw';

@customElement('licenses-view')
export class LicensesView extends LitElement {
  static styles = css`
    :host {
      height: 100%;
      overflow-x: hidden;
      overflow-y: scroll;
      padding: 12px;
      width: 100%;
    }

    code {
      font-size: 0.7em;
    }
  `;

  render() {
    return html`<code>${licenses}</code>`;
  }
}

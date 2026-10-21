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

import {LitElement, html, css, nothing} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';

export type LanguageDef = {
  id: string;
  // The corresponding locale ID for the support site, if any.
  supportId?: string;
  name: string;
  dir: 'ltr' | 'rtl';
};

@customElement('language-view')
export class LanguageView extends LitElement {
  @property({type: Array}) languages: LanguageDef[] = [];
  @property({type: String}) selectedLanguageId: string = '';

  static styles = css`
    :host {
      height: 100%;
      width: 100%;
      background-color: var(--outline-background);
      color: var(--outline-text-color);
      display: block;
    }

    md-list {
      background-color: var(--outline-background);
      --md-list-container-color: var(--outline-background);
      color: var(--outline-text-color);
      padding: 8px 0;
    }

    md-list-item {
      cursor: pointer;
      position: relative;
      --md-list-item-label-text-color: var(--outline-text-color);
      --md-list-item-headline-color: var(--outline-text-color);
      --md-list-item-supporting-text-color: var(--outline-text-color);
      color: var(--outline-text-color);
    }

    /* Important direct override for language text - needed for dark mode */
    md-list-item span,
    md-list-item div,
    md-list-item::before,
    md-list-item::after {
      color: var(--outline-text-color);
    }

    md-list-item.selected {
      --md-list-item-label-text-color: var(--outline-primary);
      --md-list-item-headline-color: var(--outline-primary);
      background-color: rgba(var(--outline-primary-rgb, 0, 0, 0), 0.1);
    }

    md-list-item.selected md-icon {
      color: var(--outline-primary);
    }

    md-icon {
      color: var(--outline-text-color);
      font-size: 24px;
    }

    /* Explicitly set text color for list items */
    md-list-item::part(label),
    md-list-item::part(supporting-text),
    md-list-item::part(headline) {
      color: var(--outline-text-color);
    }

    md-list-item.selected::part(label),
    md-list-item.selected::part(supporting-text),
    md-list-item.selected::part(headline) {
      color: var(--outline-primary);
    }
  `;

  render() {
    return html`
      <md-list>
        ${this.languages.map(
          ({id, name}) => html`
            <md-list-item
              class=${classMap({selected: this.selectedLanguageId === id})}
              data-value="${id}"
              @click="${this.handleLanguageSelection}"
            >
              <md-ripple></md-ripple>
              ${name}
              ${this.selectedLanguageId === id
                ? html`<md-icon slot="end">check</md-icon>`
                : nothing}
            </md-list-item>
          `
        )}
      </md-list>
    `;
  }

  private handleLanguageSelection({target}: Event) {
    this.dispatchEvent(
      new CustomEvent('SetLanguageRequested', {
        bubbles: true,
        composed: true,
        detail: {
          languageCode: (target as HTMLElement).getAttribute('data-value'),
        },
      })
    );
  }
}

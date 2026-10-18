// Copyright 2026 The Outline Authors
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

import {LitElement, html, css, PropertyValues} from 'lit';
import {customElement, property, state} from 'lit/decorators.js';

export interface ExclusionSettings {
  ok: boolean;
  domains?: string[];
  canSave?: boolean;
  error?: string;
}

@customElement('domain-exclusions-view')
export class DomainExclusionsView extends LitElement {
  @property({attribute: false}) request?: (
    domains?: string[]
  ) => Promise<ExclusionSettings>;
  @property({type: String}) page = '';
  @property({attribute: false}) localize: (key: string) => string = key => key;
  @state() private text = '';
  @state() private message = '';
  @state() private busy = false;
  @state() private canSave = false;

  static styles = css`
    :host {
      display: block;
      box-sizing: border-box;
      width: 100%;
      padding: 24px;
      color: var(--outline-text-color);
      background: var(--outline-background);
    }
    .content {
      max-width: 600px;
      margin: 0 auto;
    }
    p {
      line-height: 1.5;
    }
    label {
      display: block;
      font-weight: 600;
      margin: 24px 0 8px;
    }
    textarea {
      box-sizing: border-box;
      width: 100%;
      min-height: 180px;
      resize: vertical;
      color: inherit;
      background: var(--outline-card-background);
      border: 1px solid var(--outline-hairline);
      border-radius: 8px;
      padding: 12px;
      font: inherit;
      line-height: 1.6;
    }
    textarea:focus-visible {
      outline: 2px solid var(--outline-primary);
      outline-offset: 2px;
    }
    .actions {
      display: flex;
      gap: 12px;
      margin-top: 16px;
      flex-wrap: wrap;
    }
    [role='status'] {
      min-height: 24px;
    }
  `;

  protected updated(changed: PropertyValues) {
    if (
      (changed.has('page') || changed.has('request')) &&
      this.page === 'domain-exclusions' &&
      this.request
    ) {
      void this.load();
    }
  }

  private async load() {
    this.busy = true;
    this.message = '';
    try {
      const result = await this.request!();
      if (!result.ok) throw new Error();
      this.text = (result.domains ?? []).join('\n');
      this.canSave = result.canSave === true;
    } catch {
      this.message = this.localize('domain-exclusions-load-error');
      this.canSave = false;
    } finally {
      this.busy = false;
    }
  }

  private async save() {
    this.busy = true;
    this.message = '';
    try {
      const domains = this.text
        .split('\n')
        .map(value => value.trim())
        .filter(Boolean);
      const result = await this.request!(domains);
      if (!result.ok) {
        this.message = this.localize(
          result.error === 'disconnect_before_saving'
            ? 'domain-exclusions-disconnect'
            : 'domain-exclusions-save-error'
        );
        return;
      }
      this.text = (result.domains ?? []).join('\n');
      this.message = this.localize('domain-exclusions-saved');
    } catch {
      this.message = this.localize('domain-exclusions-save-error');
    } finally {
      this.busy = false;
    }
  }

  render() {
    return html`<div class="content">
      <p>${this.localize('domain-exclusions-description')}</p>
      <p id="help">${this.localize('domain-exclusions-help')}</p>
      <label for="domains">${this.localize('domain-exclusions-label')}</label>
      <textarea
        id="domains"
        aria-describedby="help"
        spellcheck="false"
        autocapitalize="off"
        placeholder="ab.chatgpt.com"
        .value=${this.text}
        ?disabled=${this.busy}
        @input=${(event: Event) => {
          this.text = (event.target as HTMLTextAreaElement).value;
        }}
      ></textarea>
      ${!this.canSave
        ? html`<p>${this.localize('domain-exclusions-disconnect')}</p>`
        : ''}
      <div class="actions">
        <md-filled-button
          ?disabled=${this.busy || !this.canSave}
          @click=${this.save}
        >
          ${this.localize('domain-exclusions-save')}</md-filled-button
        >
        <md-text-button ?disabled=${this.busy} @click=${this.load}>
          ${this.localize('domain-exclusions-reload')}</md-text-button
        >
      </div>
      <p role="status" aria-live="polite">${this.message}</p>
    </div>`;
  }
}

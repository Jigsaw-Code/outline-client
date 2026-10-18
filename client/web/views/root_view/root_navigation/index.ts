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

import {Localizer} from '@outline/infrastructure/i18n';
import {LitElement, html, css, nothing} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';

import navigationLogo from '../../../assets/logo-nav.png';

@customElement('root-navigation')
export class RootNavigation extends LitElement {
  @property({type: Object}) localize: Localizer = msg => msg;

  @property({type: Boolean}) open: boolean;
  @property({type: Boolean}) showQuit: boolean;
  @property({type: String}) align: 'left' | 'right';
  @property({type: String}) dataCollectionPageUrl: string;
  @property({type: Boolean}) showDomainExclusions = false;
  @property({type: Boolean}) showAppearanceView: boolean = false;

  static styles = css`
    :host {
      --md-list-container-color: var(--outline-background);
    }

    /* Prevent images from being selectable on iOS, which can cause a crash when trying to save them. */
    img {
      pointer-events: none;
      -webkit-user-select: none;
      user-select: none;
      -webkit-touch-callout: none;
    }

    .container {
      height: 100vh;
      left: 0;
      pointer-events: none;
      position: fixed;
      top: 0;
      width: 100vw;
    }

    .open.container {
      pointer-events: auto;
    }

    nav {
      background-color: var(--outline-background);
      color: var(--outline-text-color);
      display: block;
      height: 100vh;
      position: absolute;
      transition:
        transform 0.3s ease,
        visibility 0.3s ease;
      will-change: transform;
      visibility: hidden;
      box-shadow: 2px 0 8px rgba(0, 0, 0, 0.2);
    }

    md-list {
      background-color: var(--outline-background);
      color: var(--outline-text-color);
      --md-list-container-color: var(--outline-background);
    }

    md-list-item {
      --md-list-item-label-text-color: var(--outline-text-color);
      --md-list-item-headline-color: var(--outline-text-color);
      --md-list-item-supporting-text-color: var(--outline-text-color);
      color: var(--outline-text-color);
    }

    nav.left {
      left: 0;
      transform: translateX(-100%);
    }

    nav.right {
      right: 0;
      transform: translateX(100%);
    }

    .open nav {
      transform: translateX(0);
      visibility: visible;
    }

    header {
      background-color: var(--outline-dark-primary);
      position: sticky;
      top: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 124px;
      z-index: 1;
    }

    header img {
      width: 76px;
    }

    md-list-item {
      cursor: pointer;
    }

    md-list-item > a {
      color: inherit;
      display: block;
      height: 100%;
      text-decoration: none;
      width: 100%;
      display: flex;
      align-items: center;
    }

    #open-in-new-icon {
      font-size: 16px;
      height: 16px;
    }

    .selected {
      --md-list-item-label-text-color: var(--outline-primary);
      background-color: rgba(0, 0, 0, 0.05);
    }

    .selected md-icon {
      color: var(--outline-primary);
    }

    ul {
      border-top: 1px solid var(--outline-hairline);
      display: block;
      list-style-type: none;
      margin-bottom: 124px;
      margin: 0;
      padding: 0;
    }

    li {
      color: var(--outline-text-color);
      cursor: pointer;
      display: block;
      font-family: var(--outline-font-family);
      padding: 8px 16px;
      transition: visibility 0.3s ease;
    }

    li > a {
      text-decoration: none;
      color: var(--outline-text-color);
      display: flex;
      align-items: center;
    }

    .backdrop {
      background-color: var(--outline-elevation-color);
      height: 100%;
      left: 0;
      opacity: 0;
      pointer-events: none;
      position: absolute;
      top: 0;
      transition: opacity 0.3s ease;
      width: 100%;
    }

    .open .backdrop {
      opacity: 1;
      pointer-events: auto;
    }

    md-icon {
      color: var(--outline-icon-color);
      font-size: 24px;
    }
  `;

  render() {
    return html`<div
      class="${classMap({
        container: true,
        open: this.open,
      })}"
    >
      <div class="backdrop" @click=${this.close}></div>
      <nav
        class=${classMap({
          left: this.align === 'left',
          right: this.align === 'right',
        })}
      >
        <header>
          <img src="${navigationLogo}" alt="Outline navigation logo" />
        </header>
        <md-list>
          <!-- 
            current behavior is such that you can't actually see 
            the navbar unless you're on the servers page - no need for selection logic
          -->
          <md-list-item
            class="selected"
            @click=${() => this.changePage('home')}
          >
            <md-ripple></md-ripple>
            <md-icon slot="start">home</md-icon>
            ${this.localize('servers-menu-item')}
          </md-list-item>
          <md-list-item @click=${() => this.changePage('contact')}>
            <md-ripple></md-ripple>
            <md-icon slot="start">feedback</md-icon>
            ${this.localize('contact-page-title')}
          </md-list-item>
          <md-list-item @click=${() => this.changePage('about')}>
            <md-ripple></md-ripple>
            <md-icon slot="start">info</md-icon>
            ${this.localize('about-page-title')}
          </md-list-item>
          <md-list-item>
            <md-ripple></md-ripple>
            <md-icon slot="start">help</md-icon>
            <a href="https://support.getoutline.org">
              <span>${this.localize('help-page-title')}</span>
              <md-icon id="open-in-new-icon">open_in_new</md-icon>
            </a>
          </md-list-item>
          <md-list-item @click=${() => this.changePage('language')}>
            <md-ripple></md-ripple>
            <md-icon slot="start">language</md-icon>
            ${this.localize('change-language-page-title')}
          </md-list-item>
          ${this.showAppearanceView
            ? html`
                <md-list-item @click=${() => this.changePage('appearance')}>
                  <md-ripple></md-ripple>
                  <md-icon slot="start">brightness_medium</md-icon>
                  ${this.localize('appearance-page-title')}
                </md-list-item>
              `
            : nothing}
          ${this.showDomainExclusions
            ? html`<md-list-item
                type="button"
                @click=${() => this.changePage('domain-exclusions')}
              >
                <md-icon slot="start">alt_route</md-icon>
                ${this.localize('domain-exclusions-page-title')}
              </md-list-item>`
            : nothing}
          ${this.showQuit
            ? html`<md-list-item @click=${this.quit}>
                <md-ripple></md-ripple>
                <md-icon slot="start">exit_to_app</md-icon>
                ${this.localize('quit')}
              </md-list-item>`
            : nothing}
        </md-list>
        <ul>
          <li>
            <a href="https://getoutline.org/policies/privacy">
              ${this.localize('privacy')}
              <md-icon id="open-in-new-icon">open_in_new</md-icon>
            </a>
          </li>
          <li>
            <a href="${this.dataCollectionPageUrl}">
              ${this.localize('data-collection')}
              <md-icon id="open-in-new-icon">open_in_new</md-icon>
            </a>
          </li>
          <li>
            <a href="https://getoutline.org/policies/terms-of-service">
              ${this.localize('terms')}
              <md-icon id="open-in-new-icon">open_in_new</md-icon>
            </a>
          </li>
          <li @click=${() => this.changePage('licenses')}>
            ${this.localize('licenses-page-title')}
          </li>
        </ul>
      </nav>
    </div>`;
  }

  private close() {
    this.dispatchEvent(
      new CustomEvent('HideNavigation', {
        bubbles: true,
        composed: true,
      })
    );
  }

  private changePage(page: string) {
    this.dispatchEvent(
      new CustomEvent('ChangePage', {
        detail: {page},
        bubbles: true,
        composed: true,
      })
    );
  }

  private quit() {
    this.dispatchEvent(
      new CustomEvent('QuitPressed', {
        bubbles: true,
        composed: true,
      })
    );
  }
}

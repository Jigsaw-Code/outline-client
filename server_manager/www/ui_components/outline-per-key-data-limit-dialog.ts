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

import '@polymer/paper-button/paper-button';
import '@polymer/paper-checkbox/paper-checkbox';
import '@polymer/paper-dialog/paper-dialog';
import '@polymer/paper-dropdown-menu/paper-dropdown-menu';
import '@polymer/paper-input/paper-input';
import '@polymer/paper-item/paper-item';
import '@polymer/paper-listbox/paper-listbox';

import {PaperDialogElement} from '@polymer/paper-dialog/paper-dialog';
import {PaperInputElement} from '@polymer/paper-input/paper-input';
import {PaperListboxElement} from '@polymer/paper-listbox/paper-listbox';
import {css, html, LitElement} from 'lit';
import {customElement, property, state} from 'lit/decorators.js';

import {COMMON_STYLES} from './cloud-install-styles';
import {
  bytesToDisplayDataAmount,
  DisplayDataAmount,
  displayDataAmountToBytes,
  formatBytesParts,
} from '../data_formatting';

/**
 * A floating window representing settings specific to individual access keys. Its state is
 * dynamically set when opened using the open() method instead of with any in-HTML attributes.
 *
 * This element relies on conceptual separation of the data limit as input by the user, the data
 * limit of the UI key, and the actual data limit as saved on the server.  App controls the UI data
 * limit and the request to the server, and the display key in the element is never itself changed.
 */
@customElement('outline-per-key-data-limit-dialog')
export class OutlinePerKeyDataLimitDialog extends LitElement {
  static get styles() {
    return [
      COMMON_STYLES,
      css`
        #container {
          width: 100%;
          display: flex;
          flex-flow: column nowrap;
        }

        #dataLimitIcon {
          /* Split the padding evenly between the icon and the section to be bidirectional. */
          padding: 0 12px;
        }

        #headerSection {
          display: flex;
          flex-direction: row;
          padding: 0 12px;
        }

        #headerSection h3 {
          font-size: 18px;
          font-weight: 500;
          color: rgba(0, 0, 0, 0.87);
          line-height: 24px;
        }

        #menuSection {
          flex: 1;
          padding: 0 78px;
          margin-top: 10px;
        }

        #buttonsSection {
          margin-top: 10px;
          display: flex;
          flex-direction: row-reverse;
        }

        paper-button {
          display: flex;
          height: 36px;
          text-align: center;
        }

        #save {
          background-color: var(--primary-green);
          color: #fff;
        }

        #save[disabled] {
          color: var(--dark-gray);
          background-color: rgba(0, 0, 0, 0.13);
        }

        #menu {
          display: flex;
          flex-flow: row nowrap;
        }

        #unitsDropdown {
          width: 50px;
          padding: 0 10px;
        }

        paper-checkbox {
          /* We want the ink to be the color we're going to, not coming from */
          --paper-checkbox-checked-color: var(--primary-green);
          --paper-checkbox-checked-ink-color: var(--dark-gray);
          --paper-checkbox-unchecked-color: var(--dark-gray);
          --paper-checkbox-unchecked-ink-color: var(--primary-green);
        }

        paper-listbox paper-item:hover {
          cursor: pointer;
          background-color: var(--background-contrast-color);
          color: #fff;
        }
      `,
    ];
  }

  /**
   * @member _keyName The displayed name of the UI access key representing the key we're working on.
   */
  @state() _keyName = '';
  /**
   * @member _activeDataLimitBytes The data limit, if it exists, on the access key we're working on.
   */
  @state() _initialDataLimitBytes: number = undefined;
  /**
   * @member _showDataLimit Whether the menu for inputting the data limit should be shown.
   * Controlled by the checkbox.
   */
  @state() _showDataLimit = false;
  /**
   * @member _enableSave Whether the save button is enabled.  Controlled by the validator on the
   * input.
   */
  @state() _enableSave = false;
  /**
   * @member _saving Whether a save request is in flight.
   */
  @state() _saving = false;

  /**
   * @member language The ISO 3166-1 alpha-2 language code used for i18n.
   */
  @property({type: String}) language = '';
  @property({type: Function}) localize: Function;

  private _onDataLimitSet?: OnSetDataLimitHandler;
  private _onDataLimitRemoved?: OnRemoveDataLimitHandler;

  override render() {
    return html`
      <style>
        /* Custom element mixins with brackets don't work in style() */
        #unitsDropdown {
          --paper-input-container-underline: {
            display: none;
          }
          --paper-input-container-underline-focus: {
            display: none;
          }
        }
        #dataLimitInput {
          --paper-input-container-label-focus: {
            color: rgb(123, 123, 123);
          }
        }
      </style>
      <paper-dialog
        id="container"
        @opened-changed=${this._onDialogOpenedChanged}
      >
        <div id="headerSection">
          <iron-icon
            id="dataLimitIcon"
            icon="icons:perm-data-setting"
          ></iron-icon>
          <h3>
            ${this.localize(
              'per-key-data-limit-dialog-title',
              'keyName',
              this._keyName
            )}
          </h3>
        </div>
        <div id="menuSection">
          <paper-checkbox
            ?checked=${this._showDataLimit}
            @tap=${this._setCustomLimitTapped}
          >
            ${this.localize('per-key-data-limit-dialog-set-custom')}
          </paper-checkbox>
          ${this._showDataLimit ? this.renderDataLimit() : ''}
        </div>
        <div id="buttonsSection">
          <paper-button
            id="save"
            ?disabled=${!this._enableSave || this._saving}
            @tap=${this._onSaveButtonTapped}
            >${this.localize('save')}</paper-button
          >
          <paper-button @tap=${this.close}
            >${this.localize('cancel')}</paper-button
          >
        </div>
      </paper-dialog>
    `;
  }

  private renderDataLimit() {
    return html`
      <div id="menu">
        <!-- This input doesn't work for languages which don't use decimal points or Arabic numerals
           but it's difficult to accept internationalized inputs.  -->
        <paper-input
          id="dataLimitInput"
          label=${this.localize('data-limit')}
          always-float-label
          allowed-pattern="[0-9\\.]"
          pattern="[0-9]+(\\.[0-9]*)?"
          auto-validate
          value=${this._initialValue()}
          size="7"
          @keyup=${this._setSaveButtonDisabledState}
          @keydown=${this._onDataLimitInputKeydown}
        >
        </paper-input>
        <paper-dropdown-menu id="unitsDropdown" noink>
          <paper-listbox
            id="unitsListbox"
            slot="dropdown-content"
            attr-for-selected="name"
            selected="${this._initialUnit()}"
          >
            <paper-item name="GB"
              >${this._getInternationalizedUnit(1000000000)}</paper-item
            >
            <paper-item name="MB"
              >${this._getInternationalizedUnit(1000000)}</paper-item
            >
          </paper-listbox>
        </paper-dropdown-menu>
      </div>
    `;
  }

  private _queryAs<T extends HTMLElement>(selector: string): T {
    return this.shadowRoot.querySelector(selector) as T;
  }

  private get _input(): PaperInputElement {
    return this._queryAs<PaperInputElement>('#dataLimitInput');
  }

  private _dataLimitValue() {
    return Number(this._input?.value) ?? 0;
  }

  private _dataLimitUnit(): 'GB' | 'MB' {
    return this._queryAs<PaperListboxElement>('#unitsListbox').selected as
      | 'GB'
      | 'MB';
  }

  private _getInternationalizedUnit(bytes: number) {
    return formatBytesParts(bytes, this.language).unit;
  }

  private _initialUnit(): 'GB' | 'MB' {
    return bytesToDisplayDataAmount(this._initialDataLimitBytes)?.unit || 'GB';
  }

  private _initialValue() {
    return (
      bytesToDisplayDataAmount(this._initialDataLimitBytes)?.value.toString() ||
      ''
    );
  }

  private async _setCustomLimitTapped() {
    this._showDataLimit = !this._showDataLimit;
    if (this._showDataLimit) {
      await this.updateComplete;
      this._input?.focus();
    }
  }

  private _setSaveButtonDisabledState() {
    this._enableSave = !(this._input?.invalid ?? false);
  }

  private _onDataLimitInputKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    void this._onSaveButtonTapped();
  }

  private async _onSaveButtonTapped() {
    if (!this._enableSave || this._saving) {
      return;
    }
    const change = this._dataLimitChange();
    if (change === Change.UNCHANGED) {
      return;
    }
    this._saving = true;
    try {
      const result =
        change === Change.SET
          ? await this._onDataLimitSet(
              displayDataAmountToBytes(this.inputDataLimit())
            )
          : await this._onDataLimitRemoved();
      if (result) {
        this.close();
      }
    } finally {
      this._saving = false;
    }
  }

  /**
   * Calculates what type of change, or none at all, the user made.
   */
  private _dataLimitChange(): Change {
    if (this._showDataLimit) {
      if (this._initialDataLimitBytes === undefined) {
        // The user must have clicked the checkbox and input a limit.
        return Change.SET;
      }
      const inputLimit = displayDataAmountToBytes(this.inputDataLimit());
      if (inputLimit !== this._initialDataLimitBytes) {
        return Change.SET;
      }
      return Change.UNCHANGED;
    }
    if (this._initialDataLimitBytes !== undefined) {
      // The user must have unchecked the checkbox.
      return Change.REMOVED;
    }
    return Change.UNCHANGED;
  }

  /**
   * The current data limit as input by the user, but not necessarily as saved.
   */
  public inputDataLimit(): DisplayDataAmount {
    return this._showDataLimit
      ? {unit: this._dataLimitUnit(), value: this._dataLimitValue()}
      : null;
  }

  /**
   * Opens the dialog to display data limit information about the given key.
   *
   * @param keyName - The displayed name of the access key.
   * @param keyDataLimit - The display data limit of the access key, or undefined.
   * @param serverDefaultLimit - The default data limit for the server, or undefined if there is
   *     none.
   * @param language - The app's current language
   * @param onDataLimitSet - Callback for when a data limit is imposed.  Must return whether or not
   *    the data limit was set successfully.  Must not throw or change the dialog's state.
   * @param onDataLimitRemoved - Callback for when a data limit is removed.  Must return whether or
   *    not the data limit was removed successfully.  Must not throw or change the dialog's state.
   */
  public open(
    keyName: string,
    keyLimitBytes: number,
    onDataLimitSet: OnSetDataLimitHandler,
    onDataLimitRemoved: OnRemoveDataLimitHandler
  ) {
    this._keyName = keyName;
    this._initialDataLimitBytes = keyLimitBytes;
    this._showDataLimit = this._initialDataLimitBytes !== undefined;
    this._onDataLimitSet = onDataLimitSet;
    this._onDataLimitRemoved = onDataLimitRemoved;

    this._queryAs<PaperListboxElement>('#unitsListbox')?.select(
      this._initialUnit()
    );
    this._setSaveButtonDisabledState();
    this._queryAs<PaperDialogElement>('#container').open();
  }

  private _onDialogOpenedChanged(openedChanged: CustomEvent<{value: boolean}>) {
    const dialogWasClosed = !openedChanged.detail.value;
    if (dialogWasClosed) {
      delete this._onDataLimitSet;
      delete this._onDataLimitRemoved;
    }
  }

  /**
   * Closes the dialog.
   */
  public close() {
    this._queryAs<PaperDialogElement>('#container').close();
  }
}

enum Change {
  SET, // A data limit was added or the existing data limit changed
  REMOVED, // The data limit for the key was removed
  UNCHANGED, // No functional change happened.
}

type OnSetDataLimitHandler = (dataLimitBytes: number) => Promise<boolean>;
type OnRemoveDataLimitHandler = () => Promise<boolean>;

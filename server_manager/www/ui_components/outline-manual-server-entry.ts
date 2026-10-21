/*
  Copyright 2018 The Outline Authors

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
import '@polymer/polymer/polymer-legacy';
import '@polymer/iron-collapse/iron-collapse';
import '@polymer/iron-icon/iron-icon';
import '@polymer/iron-icons/iron-icons';
import '@polymer/paper-button/paper-button';
import '@polymer/paper-dialog/paper-dialog';
import '@polymer/paper-input/paper-textarea';
import '@polymer/paper-progress/paper-progress';
import './cloud-install-styles';
import './outline-cloud-instructions-view';
import './outline-step-view';
import './style.css';

import type {IronCollapseElement} from '@polymer/iron-collapse/iron-collapse';
import type {IronIconElement} from '@polymer/iron-icon/iron-icon';
import {Polymer} from '@polymer/polymer/lib/legacy/polymer-fn';
import {html} from '@polymer/polymer/lib/utils/html-tag';

export interface OutlineManualServerEntry extends Element {
  clear(): void;
  cancelTapped(): void;
  cloudProvider: 'generic' | 'aws' | 'gcp';
  enableDoneButton: boolean;
  showConnection: boolean;
}

Polymer({
  _template: html`
    <style include="cloud-install-styles"></style>
    <style>
      :host {
        text-align: center;
        --code-mixin: {
          color: var(--dark-gray);
          font-size: 14px;
          font-family: RobotoMono-Regular, monospace;
          line-height: 24px;
          word-break: break-all;
        }
      }
      .card {
        color: var(--light-gray);
        margin: 24px 0;
        text-align: left;
      }
      .section {
        padding: 24px 12px;
        background: var(--background-contrast-color);
        border-radius: 2px;
      }
      .section:not(:first-child) {
        margin-top: 8px;
      }
      .section-header {
        padding: 0 6px 0;
        display: flex;
      }
      .instructions {
        font-size: 16px;
        line-height: 26px;
        margin-left: 16px;
        flex: 2;
      }
      .stepcircle {
        height: 26px;
        width: 26px;
        font-size: 14px;
        border-radius: 50%;
        float: left;
        vertical-align: middle;
        color: #000;
        background-color: #fff;
        margin: auto;
        text-align: center;
        line-height: 26px;
      }
      .drop-down,
      .drop-down iron-icon {
        color: #fff;
      }
      .drop-down > * {
        vertical-align: middle;
      }
      .drop-down span {
        margin: 0 6px;
      }
      .drop-down:hover {
        cursor: pointer;
      }
      /* This element surrounds the copy and paste elements. */
      .section-content {
        margin: 24px 12px 0 48px;
        padding: 24px;
        background-color: #eceff1;
        border-radius: 4px;
      }
      .section-content-instructions {
        margin: 24px 12px;
      }
      .section-content-instructions li {
        margin-bottom: 24px;
      }
      .section-content-instructions a {
        color: #00bfa5;
      }
      .section-content-instructions iron-icon {
        color: #00bfa5;
        width: 16px;
        height: 16px;
        margin-left: 4px;
        vertical-align: middle;
      }
      paper-textarea {
        --iron-autogrow-textarea: {
          @apply --code-mixin;
        }
        --paper-input-container-underline: {
          display: none;
        }
        --paper-input-container-underline-focus: {
          display: none;
        }
      }
      #gcp-tag {
        font-weight: 500;
        letter-spacing: 0.05em;
        font-size: 10px;
        margin-bottom: 8px;
        text-transform: uppercase;
        color: var(--light-gray);
      }
      #gcp-new-flow-promo {
        padding: 24px;
        border: 1px solid var(--border-color);
        cursor: pointer;
        font-size: 16px;
        margin-top: unset;
      }
      /* rtl:ignore */
      .code,
      #command,
      paper-textarea {
        direction: ltr;
        text-align: left;
        @apply --code-mixin;
      }
      iron-icon {
        display: inline-block;
        vertical-align: top;
        color: black;
      }
      #button-row {
        display: flex;
        justify-content: space-between;
        padding: 0 24px 24px 60px;
        background-color: var(--background-contrast-color);
      }
      paper-button {
        margin: 0;
      }
      paper-progress {
        margin: 0;
      }
      #cancelButton {
        color: var(--light-gray);
        border: 1px solid var(--border-color);
        border-radius: 2px;
        width: 45%;
      }
      #doneButton {
        border-radius: 2px;
        width: 45%;
        background-color: var(--primary-green);
        color: var(--light-gray);
      }
      #doneButton[disabled] {
        background-color: var(--border-color);
      }
      #aws-logo {
        vertical-align: top;
      }
    </style>
    <outline-step-view>
      <span slot="step-title">[[localize('manual-server-title')]]</span>
      <span slot="step-description">[[serverDescription]]</span>

      <div class="card">
        <!-- GCP -->
        <div
          id="gcp-new-flow-promo"
          class="section-content-instructions"
          on-tap="gcpNewFlowTapped"
          hidden$="[[!isCloudProviderGcp]]"
        >
          <div id="gcp-tag">[[localize('experimental')]]</div>
          <a
            >[[localize('setup-gcp-promo')]]<iron-icon
              icon="open-in-new"
            ></iron-icon
          ></a>
        </div>
        <div class="section" hidden$="[[!isCloudProviderGcp]]">
          <div class="section-header">
            <!-- TODO(alalama): localize numbers  -->
            <span class="stepcircle">1</span>
            <div class="instructions">[[localize('gcp-create-server')]]</div>
            <div class="drop-down" on-tap="_toggleGcpCreateServerDropDown">
              <img src="images/gcp-logo.svg" />
              <span>[[localize('manual-server-instructions')]]</span>
              <iron-icon
                id="gcpCreateServerDropDownIcon"
                icon="arrow-drop-down"
              ></iron-icon>
            </div>
          </div>
          <iron-collapse
            id="gcpCreateServerDropDown"
            class="instructions-collapse"
          >
            <div class="section-content-instructions">
              <outline-cloud-instructions-view
                title="[[localize('gcp-create-project')]]"
                thumbnail-path="images/gcp-create-project-thumbnail.webp"
                image-path="images/gcp-create-project-screenshot.webp"
                localize="[[localize]]"
              >
                <ol>
                  <li
                    inner-h-t-m-l="[[localize('gcp-create-new-project', 'openLink', '<a href=https://console.cloud.google.com/projectcreate>', 'closeLink', '<iron-icon icon=open-in-new></iron-icon></a>')]]"
                  ></li>
                  <li>[[localize('gcp-name-your-project')]]</li>
                  <li>[[localize('gcp-click-create')]]</li>
                </ol>
              </outline-cloud-instructions-view>
            </div>
            <div class="section-content-instructions">
              <outline-cloud-instructions-view
                title="[[localize('manual-server-create-firewall')]]"
                thumbnail-path="images/gcp-thumbnail-1.webp"
                image-path="images/gcp-screenshot-1.webp"
                localize="[[localize]]"
              >
                <ol>
                  <li
                    inner-h-t-m-l="[[localize('gcp-firewall-create-0', 'openLink', '<a href=https://console.cloud.google.com/networking/firewalls/add>', 'closeLink', '<iron-icon icon=open-in-new></iron-icon></a>')]]"
                  ></li>
                  <li>[[localize('gcp-firewall-create-1')]]</li>
                  <li>[[localize('gcp-firewall-create-2')]]</li>
                  <li>[[localize('gcp-firewall-create-3')]]</li>
                  <li>[[localize('gcp-firewall-create-4')]]</li>
                  <li>[[localize('gcp-click-create')]]</li>
                </ol>
              </outline-cloud-instructions-view>
            </div>
            <div class="section-content-instructions">
              <outline-cloud-instructions-view
                title="[[localize('gcp-create-vm')]]"
                thumbnail-path="images/gcp-create-instance-thumbnail.webp"
                image-path="images/gcp-create-instance-screenshot.webp"
                localize="[[localize]]"
              >
                <ol>
                  <li
                    inner-h-t-m-l="[[localize('gcp-create-new-vm', 'openLink', '<a href=https://console.cloud.google.com/compute/instancesAdd>', 'closeLink', '<iron-icon icon=open-in-new></iron-icon></a>')]]"
                  ></li>
                  <li>[[localize('gcp-type-outline-server')]]</li>
                  <li>[[localize('gcp-select-region')]]</li>
                  <li>[[localize('gcp-select-machine-type')]]</li>
                  <li>[[localize('gcp-select-networking')]]</li>
                  <li>[[localize('gcp-type-network-tag')]]</li>
                  <li>[[localize('gcp-click-create')]]</li>
                </ol>
              </outline-cloud-instructions-view>
            </div>
          </iron-collapse>
        </div>
        <!-- AWS -->
        <div class="section" hidden$="[[!isCloudProviderAws]]">
          <div class="section-header">
            <span class="stepcircle">1</span>
            <div class="instructions">
              [[localize('manual-server-firewall')]]
            </div>
            <div class="drop-down" on-tap="_toggleAwsDropDown">
              <img id="aws-logo" src="images/aws-logo.svg" />
              <span>[[localize('manual-server-instructions')]]</span>
              <iron-icon
                id="awsDropDownIcon"
                icon="arrow-drop-down"
              ></iron-icon>
            </div>
          </div>
          <iron-collapse id="awsDropDown" class="instructions-collapse">
            <div class="section-content-instructions">
              <outline-cloud-instructions-view
                title="[[localize('manual-server-create-group')]]"
                thumbnail-path="images/aws-lightsail-thumbnail.webp"
                image-path="images/aws-lightsail-setup.webp"
                localize="[[localize]]"
              >
                <ol>
                  <li
                    inner-h-t-m-l="[[localize('aws-lightsail-firewall-0', 'openLink', '<a href=https://lightsail.aws.amazon.com>', 'closeLink', '<iron-icon icon=open-in-new></iron-icon></a>')]]"
                  ></li>
                  <li>[[localize('aws-lightsail-firewall-1')]]</li>
                  <li>[[localize('aws-lightsail-firewall-2')]]</li>
                  <li>[[localize('aws-lightsail-firewall-3')]]</li>
                  <li>[[localize('aws-lightsail-firewall-4')]]</li>
                  <li>[[localize('aws-lightsail-firewall-5')]]</li>
                  <li>[[localize('aws-lightsail-firewall-6')]]</li>
                  <li>[[localize('aws-lightsail-firewall-7')]]</li>
                </ol>
              </outline-cloud-instructions-view>
            </div>
          </iron-collapse>
        </div>
        <!-- Install command -->
        <div class="section">
          <div class="section-header">
            <span class="stepcircle">[[installScriptStepNumber]]</span>
            <div class="instructions">
              [[localize('manual-server-install-run')]]
            </div>
          </div>
          <div class="section-content">
            <div id="command">
              sudo bash -c "$(wget -qO-
              https://raw.githubusercontent.com/OutlineFoundation/outline-apps/master/server_manager/install_scripts/install_server.sh)"
            </div>
          </div>
        </div>
        <!-- Paste input -->
        <div class="section">
          <div class="section-header">
            <span class="stepcircle">[[pasteJsonStepNumber]]</span>
            <div class="instructions">
              [[localize('manual-server-install-paste')]]
            </div>
          </div>
          <div class="section-content">
            <paper-textarea
              id="serverConfig"
              type="text"
              placeholder$="[[placeholderText]]"
              class="code"
              rows="4"
              max-rows="4"
              no-label-float=""
              on-value-changed="onServerConfigChanged"
            ></paper-textarea>
          </div>
        </div>
        <div id="button-row">
          <paper-button
            id="cancelButton"
            on-tap="cancelTapped"
            class="secondary"
            >[[localize('cancel')]]</paper-button
          >
          <paper-button
            id="doneButton"
            on-tap="doneTapped"
            class="primary"
            disabled$="[[!enableDoneButton]]"
            >[[localize('done')]]</paper-button
          >
        </div>
        <paper-progress
          hidden$="[[!showConnection]]"
          indeterminate=""
          class="slow"
        ></paper-progress>
      </div>
    </outline-step-view>
  `,

  is: 'outline-manual-server-entry',

  properties: {
    placeholderText: {
      type: String,
      value:
        '{"apiUrl":"https://xxx.xxx.xxx.xxx:xxxxx/xxxxxxxxxxxxxxxxxxxxxx","certSha256":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}',
    },
    showConnection: Boolean,
    cloudProvider: {
      type: String,
      value: 'generic',
    },
    cloudProviderName: {
      type: String,
      computed: '_computeCloudProviderName(cloudProvider)',
    },
    serverDescription: {
      type: String,
      computed:
        '_computeServerDescription(cloudProvider, cloudProviderName, language)',
    },
    isCloudProviderAws: {
      type: Boolean,
      computed: '_computeIsCloudProviderAws(cloudProvider)',
    },
    isCloudProviderGcp: {
      type: Boolean,
      computed: '_computeIsCloudProviderGcp(cloudProvider)',
    },
    isGenericCloudProvider: {
      type: Boolean,
      computed: '_computeIsGenericCloudProvider(cloudProvider)',
    },
    installScriptStepNumber: {
      type: Number,
      computed: '_computeInstallScriptStepNumber(isGenericCloudProvider)',
    },
    pasteJsonStepNumber: {
      type: Number,
      computed: '_computePasteJsonStepNumber(installScriptStepNumber)',
    },
    enableDoneButton: {
      type: Boolean,
      value: false,
    },
    localize: {
      type: Function,
    },
  },

  doneTapped() {
    this.showConnection = true;
    this.fire('ManualServerEntered', {
      userInput: this.$.serverConfig.value,
    });
  },

  cancelTapped() {
    this.fire('ManualServerEntryCancelled');
  },

  gcpNewFlowTapped() {
    this.fire('ConnectGcpAccountRequested');
  },

  clear() {
    this.$.serverConfig.value = '';
    this.showConnection = false;
    for (const dropdown of this.root.querySelectorAll(
      '.instructions-collapse'
    )) {
      dropdown.hide();
    }
  },

  _computeCloudProviderName(cloudProvider: string) {
    switch (cloudProvider) {
      case 'aws':
        return 'Amazon Web Services';
      case 'gcp':
        return 'Google Cloud Platform';
      default:
        return '';
    }
  },

  _computeServerDescription(
    cloudProvider: string,
    cloudProviderName: string,
    _language: string
  ) {
    return cloudProvider === 'generic'
      ? this.localize('manual-server-description-generic')
      : this.localize(
          'manual-server-description',
          'cloudProvider',
          cloudProviderName
        );
  },

  _computeIsCloudProviderAws(cloudProvider: string) {
    return cloudProvider === 'aws';
  },

  _computeIsCloudProviderGcp(cloudProvider: string) {
    return cloudProvider === 'gcp';
  },

  _computeIsGenericCloudProvider(cloudProvider: string) {
    return cloudProvider === 'generic';
  },

  _computeInstallScriptStepNumber(isGenericCloudProvider: boolean) {
    return isGenericCloudProvider ? 1 : 2;
  },

  _computePasteJsonStepNumber(installScriptStepNumber: number) {
    return installScriptStepNumber + 1;
  },

  _toggleAwsDropDown() {
    this._toggleDropDown(this.$.awsDropDown, this.$.awsDropDownIcon);
  },

  _toggleGcpFirewallDropDown() {
    this._toggleDropDown(
      this.$.gcpFirewallDropDown,
      this.$.gcpFirewallDropDownIcon
    );
  },

  _toggleGcpCreateServerDropDown() {
    this._toggleDropDown(
      this.$.gcpCreateServerDropDown,
      this.$.gcpCreateServerDropDownIcon
    );
  },

  _toggleGcpCreateProjectDropDown() {
    this._toggleDropDown(
      this.$.gcpCreateProjectDropDown,
      this.$.gcpCreateProjectDropDownIcon
    );
  },

  _toggleDropDown(dropDown: IronCollapseElement, icon: IronIconElement) {
    dropDown.toggle();
    icon.icon = dropDown.opened ? 'arrow-drop-up' : 'arrow-drop-down';
  },

  onServerConfigChanged() {
    this.fire('ManualServerEdited', {
      userInput: this.$.serverConfig.value,
    });
  },
});

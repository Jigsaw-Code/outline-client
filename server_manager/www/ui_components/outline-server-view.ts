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
import '@polymer/paper-dialog/paper-dialog';
import '@polymer/iron-icons/iron-icons';
import '@polymer/iron-pages/iron-pages';
import '@polymer/iron-icons/editor-icons';
import '@polymer/iron-icons/social-icons';
import '@polymer/paper-icon-button/paper-icon-button';
import '@polymer/paper-item/paper-item';
import '@polymer/paper-listbox/paper-listbox';
import '@polymer/paper-menu-button/paper-menu-button';
import '@polymer/paper-progress/paper-progress';
import '@polymer/paper-tabs/paper-tabs';
import '@polymer/paper-tooltip/paper-tooltip';
import '@material/mwc-linear-progress';
import './cloud-install-styles';
import './outline-iconset';
import './outline-help-bubble';
import './outline-metrics-option-dialog';
import './outline-progress-spinner';
import './outline-server-progress-step';
import './outline-server-settings';
import './outline-share-dialog';
import './outline-sort-span';

import '../views/server_view/server_metrics_row/bandwidth';
import '../views/server_view/server_metrics_row/tunnel_time';
import {html, PolymerElement} from '@polymer/polymer';
import type {PolymerElementProperties} from '@polymer/polymer/interfaces';
import {DirMixin} from '@polymer/polymer/lib/mixins/dir-mixin';

import {getCloudIcon} from './cloud-assets';
import type {OutlineHelpBubble} from './outline-help-bubble';
import type {OutlineServerSettings} from './outline-server-settings';
import type {CloudLocation} from '../../model/location';
import * as formatting from '../data_formatting';
import {getShortName} from '../location_formatting';
import {
  AccessKeyDataTableEvent,
  AccessKeyDataTableRow,
} from '../views/server_view/access_key_data_table';
import {DataTableSortDirection} from '../views/server_view/access_key_data_table/data_table';
import type {ServerMetricsData} from '../views/server_view/server_metrics_row';
import {ServerMetricsBandwidthLocation} from '../views/server_view/server_metrics_row/bandwidth';
import {ServerMetricsTunnelTimeLocation} from '../views/server_view/server_metrics_row/tunnel_time';

export const MY_CONNECTION_USER_ID = '0';

// Makes an CustomEvent that bubbles up beyond the shadow root.
function makePublicEvent(eventName: string, detail?: object) {
  const params: CustomEventInit = {bubbles: true, composed: true};
  if (detail !== undefined) {
    params.detail = detail;
  }
  return new CustomEvent(eventName, params);
}

/**
 * Allows using an optional number as a boolean value without 0 being falsey.
 * @returns True if x is neither null nor undefined
 */
function exists(x: number): boolean {
  return x !== null && x !== undefined;
}

export class ServerView extends DirMixin(PolymerElement) {
  static get template() {
    return html`
      <style include="cloud-install-styles"></style>
      <style>
        .container {
          display: flex;
          flex-direction: column;
          color: var(--light-gray);
        }
        #managementView,
        #connectingView,
        #unreachableView {
          padding: 24px;
        }
        .tabs-container {
          display: flex;
          flex-direction: row;
          border-bottom: 1px solid var(--border-color);
        }
        .tabs-spacer {
          flex: 2;
        }
        paper-tabs {
          --paper-tabs-selection-bar-color: var(--primary-green);
          --paper-tab-ink: var(--primary-green);
          --paper-tab-content-unselected {
            color: var(--dark-gray);
          }
        }
        div[name='connections'],
        div[name='settings'],
        .access-key-list {
          margin-top: 24px;
        }
        .server-header {
          display: flex;
          flex-direction: column;
          margin: 24px 0;
        }
        .server-name {
          display: flex;
          flex-direction: row;
          align-items: center;
          justify-content: space-between;
        }
        .server-name h3 {
          font-size: 36px;
          font-weight: 400;
          color: #ffffff;
          flex: 11;
          margin: 0 0 6px 0;
        }
        .server-location,
        .unreachable-server paper-button {
          color: var(--medium-gray);
        }
        .unreachable-server {
          flex-direction: column;
          align-items: center;
          margin-top: 24px;
          padding: 72px 48px;
        }
        .unreachable-server p {
          line-height: 22px;
          max-width: 50ch;
          text-align: center;
          color: var(--medium-gray);
        }
        .unreachable-server .button-container {
          padding: 24px 0;
        }
        .unreachable-server paper-button.try-again-btn {
          color: var(--primary-green);
        }
        .connecting-server {
          flex-direction: column;
          align-items: center;
          margin-top: 24px;
          padding: 72px 48px;
        }
        .connecting-server p {
          margin-top: 24px;
          color: var(--medium-gray);
        }
        .server-img {
          width: 142px;
          height: 142px;
          margin: 24px;
        }
        .access-key-row {
          align-items: center;
          box-sizing: border-box;
          display: flex;
          justify-content: center;
          padding: 3rem;
        }
        .access-key-container {
          display: flex;
          flex: 4;
          align-items: center;
          gap: 1rem;
        }
        .overflow-menu {
          display: flex;
          justify-content: flex-end;
          padding: 0px;
          min-width: 40px;
          margin-left: 8px;
          color: var(--medium-gray);
        }
        .overflow-menu paper-item {
          cursor: pointer;
        }
        paper-item {
          font-size: 14px;
        }
        paper-listbox iron-icon {
          margin-right: 10px;
          width: 18px;
        }
        paper-dropdown {
          box-shadow: 0px 0px 20px #999999;
        }
        #addAccessKeyButton {
          background: var(--primary-green);
          color: #fff;
          border-radius: 50%;
        }
        .add-new-key {
          color: var(--primary-green);
          cursor: pointer;
        }
        outline-help-bubble {
          text-align: center;
        }
        outline-help-bubble h3 {
          padding-bottom: 0;
          font-weight: 500;
          line-height: 28px;
          font-size: 16px;
          margin: 0px 0px 12px 0px;
        }
        outline-help-bubble img {
          width: 76px;
          height: auto;
          margin: 12px 0px 24px 0px;
        }
        .cloud-icon {
          opacity: 0.54;
        }
        .flex-1 {
          flex: 1;
        }

        div[name='metrics'] {
          display: flex;
          flex-direction: column;
          gap: 1rem;
          margin-top: 1rem;
        }

        /* Mirror icons */
        :host(:dir(rtl)) iron-icon,
        :host(:dir(rtl)) .share-button,
        :host(:dir(rtl)) .access-key-icon {
          transform: scaleX(-1);
        }

        .privacy-statement-text {
          color: var(--medium-gray);
          font-style: italic;
        }

        .privacy-statement-link {
          color: var(--primary-green);
          cursor: pointer;
          font-weight: bold;
          text-decoration: underline;
        }

        .advanced-metrics-link {
          align-items: center;
          border-radius: 2px;
          border: 1px solid var(--border-color);
          cursor: pointer;
          display: inline-flex;
          gap: 2px;
          margin-bottom: 8px;
          padding: 8px 12px;
        }

        .advanced-metrics-link-icon {
          width: 16px;
        }

        .advanced-metrics-link-text {
          color: var(--medium-gray);
        }

        .connections-container {
          background: hsl(197, 13%, 22%);
        }

        .metrics-loading-container,
        .connections-loading-container {
          align-items: center;
          box-sizing: border-box;
          display: flex;
          justify-content: center;
          padding: 2rem;
          width: 100%;
        }

        .metrics-loading-container {
          background: hsl(197, 13%, 22%);
        }

        mwc-linear-progress {
          --mdc-theme-primary: hsla(0, 0%, 46%, 1);
          --mdc-linear-progress-buffer-color: var(--primary-green);
        }
      </style>

      <div class="container">
        <iron-pages
          id="pages"
          attr-for-selected="id"
          selected="[[selectedPage]]"
        >
          <outline-server-progress-step
            id="progressView"
            server-name="[[serverName]]"
            localize="[[localize]]"
            progress="[[installProgress]]"
          ></outline-server-progress-step>
          <div id="connectingView">${this.connectingViewTemplate}</div>
          <div id="unreachableView">${this.unreachableViewTemplate}</div>
          <div id="managementView">${this.managementViewTemplate}</div>
        </iron-pages>
      </div>

      <outline-help-bubble
        id="getConnectedHelpBubble"
        vertical-align="bottom"
        horizontal-align="right"
      >
        <img src="images/connect-tip-2x.png" />
        <h3>[[localize('server-help-connection-title')]]</h3>
        <p>[[localize('server-help-connection-description')]]</p>
        <paper-button on-tap="_closeGetConnectedHelpBubble"
          >[[localize('server-help-connection-ok')]]</paper-button
        >
      </outline-help-bubble>
      <outline-help-bubble
        id="addAccessKeyHelpBubble"
        vertical-align="bottom"
        horizontal-align="left"
      >
        <img src="images/key-tip-2x.png" />
        <h3>[[localize('server-help-access-key-title')]]</h3>
        <p>[[localize('server-help-access-key-description')]]</p>
        <paper-button on-tap="_closeAddAccessKeyHelpBubble"
          >[[localize('server-help-access-key-next')]]</paper-button
        >
      </outline-help-bubble>
      <outline-help-bubble
        id="dataLimitsHelpBubble"
        vertical-align="top"
        horizontal-align="right"
      >
        <h3>[[localize('data-limits-dialog-title')]]</h3>
        <p>[[localize('data-limits-dialog-text')]]</p>
        <paper-button on-tap="_closeDataLimitsHelpBubble"
          >[[localize('ok')]]</paper-button
        >
      </outline-help-bubble>
    `;
  }

  static get connectingViewTemplate() {
    return html` <div class="server-header">
        <div class="server-name">
          <h3>[[serverName]]</h3>
        </div>
      </div>
      <div class="card-section connecting-server">
        <outline-progress-spinner></outline-progress-spinner>
        <p>[[localize('server-connecting')]]</p>
      </div>`;
  }

  static get unreachableViewTemplate() {
    return html` <div class="server-header">
        <div class="server-name">
          <h3>[[serverName]]</h3>
        </div>
      </div>
      <div class="card-section unreachable-server">
        <img class="server-img" src="images/server-unreachable.png" />
        <h3>[[localize('server-unreachable')]]</h3>
        <p></p>
        <div>[[localize('server-unreachable-description')]]</div>
        <span hidden$="[[_isServerManaged(cloudId)]]"
          >[[localize('server-unreachable-managed-description')]]</span
        >
        <span hidden$="[[!_isServerManaged(cloudId)]]"
          >[[localize('server-unreachable-manual-description')]]</span
        >
        <div class="button-container">
          <paper-button
            on-tap="removeServer"
            hidden$="[[_isServerManaged(cloudId)]]"
            >[[localize('server-remove')]]</paper-button
          >
          <paper-button
            on-tap="destroyServer"
            hidden$="[[!_isServerManaged(cloudId)]]"
            >[[localize('server-destroy')]]</paper-button
          >
          <paper-button on-tap="retryDisplayingServer" class="try-again-btn"
            >[[localize('retry')]]</paper-button
          >
        </div>
      </div>`;
  }

  static get managementViewTemplate() {
    return html` <div class="server-header">
        <div class="server-name">
          <h3>[[serverName]]</h3>
          <paper-menu-button
            horizontal-align="right"
            class="overflow-menu flex-1"
            close-on-activate=""
            no-animations=""
            dynamic-align=""
            no-overlap=""
          >
            <paper-icon-button
              icon="more-vert"
              slot="dropdown-trigger"
            ></paper-icon-button>
            <paper-listbox slot="dropdown-content">
              <paper-item
                hidden$="[[!_isServerManaged(cloudId)]]"
                on-tap="destroyServer"
              >
                <iron-icon icon="icons:remove-circle-outline"></iron-icon
                >[[localize('server-destroy')]]
              </paper-item>
              <paper-item
                hidden$="[[_isServerManaged(cloudId)]]"
                on-tap="removeServer"
              >
                <iron-icon icon="icons:remove-circle-outline"></iron-icon
                >[[localize('server-remove')]]
              </paper-item>
            </paper-listbox>
          </paper-menu-button>
        </div>
        <div class="server-location">
          [[getShortName(cloudLocation, localize)]]
        </div>
      </div>
      <div class="tabs-container">
        <paper-tabs
          selected="{{selectedTab}}"
          attr-for-selected="name"
          noink=""
        >
          <paper-tab name="connections">[[accessKeyTabMessage]]</paper-tab>
          <paper-tab name="metrics"
            >[[localize('server-view-server-metrics-tab')]]</paper-tab
          >
          <paper-tab name="settings" id="settingsTab"
            >[[localize('server-settings')]]</paper-tab
          >
        </paper-tabs>
        <div class="tabs-spacer"></div>
      </div>
      <iron-pages
        id="pages"
        selected="[[selectedTab]]"
        attr-for-selected="name"
        on-selected-changed="_selectedTabChanged"
      >
        <div name="connections">
          <aside>
            <p class="privacy-statement">
              <span class="privacy-statement-text"
                >[[localize('server-view-privacy-statement')]]</span
              >
              <a
                class="privacy-statement-link"
                href="https://getoutline.org/policies/data-collection"
                >[[localize('server-view-privacy-statement-link')]]</a
              >
            </p>
          </aside>

          <div class="connections-container">
            <template is="dom-if" if="{{!hasServerMetricsData}}">
              <mwc-linear-progress indeterminate></mwc-linear-progress>
            </template>
            <template is="dom-if" if="{{!hasAccessKeyData}}">
              <div class="connections-loading-container">
                <outline-progress-spinner></outline-progress-spinner>
              </div>
            </template>

            <template is="dom-if" if="{{hasAccessKeyData}}">
              <access-key-data-table
                id="accessKeysContainer"
                access-keys="[[accessKeyData]]"
                language="[[language]]"
                localize="[[localize]]"
                server-version="[[serverVersion]]"
                sort-direction="[[accessKeyDataSortDirection]]"
                sort-column-id="[[accessKeyDataSortColumnId]]"
              ></access-key-data-table>

              <div class="access-key-row">
                <span class="access-key-container">
                  <paper-icon-button
                    icon="icons:add"
                    on-tap="_handleAddAccessKeyPressed"
                    id="addAccessKeyButton"
                    class="access-key-icon"
                  ></paper-icon-button>
                  <div class="add-new-key" on-tap="_handleAddAccessKeyPressed">
                    [[localize('server-access-key-new')]]
                  </div>
                </span>
              </div>
            </template>
          </div>
        </div>

        <div name="metrics">
          <aside>
            <p class="privacy-statement">
              <span class="privacy-statement-text"
                >[[localize('server-view-privacy-statement')]]</span
              >
              <a
                class="privacy-statement-link"
                href="https://getoutline.org/policies/data-collection"
                >[[localize('server-view-privacy-statement-link')]]</a
              >
            </p>

              <a class="advanced-metrics-link" href="https://developer.getoutline.org/vpn/management/metrics">
                <span class="advanced-metrics-link-text"
                  >[[localize('server-view-server-metrics-advanced-metrics-link')]]</span
                >
                <iron-icon
                  class="advanced-metrics-link-icon"
                  icon="open-in-new"
                ></iron-icon>
              </a>
            </aside>

            <template is="dom-if" if="{{!hasServerMetricsData}}">
              <div class="metrics-loading-container">
                <outline-progress-spinner></outline-progress-spinner>
              </div>
            </template>

            <template is="dom-if" if="{{hasServerMetricsData}}">
              <server-metrics-bandwidth-row
                data-limit-bytes="[[monthlyOutboundTransferBytes]]"
                has-access-key-data-limits="[[hasAccessKeyDataLimits]]"
                language="[[language]]"
                localize="[[localize]]"
                locations="[[serverMetricsBandwidthLocations]]"
                metrics="[[serverMetricsData]]"
              ></server-metrics-bandwidth-row>
              <server-metrics-tunnel-time-row
                language="[[language]]"
                localize="[[localize]]"
                locations="[[serverMetricsTunnelTimeLocations]]"
                metrics="[[serverMetricsData]]"
              ></server-metrics-tunnel-time-row>
            </template>
          </div>
        </template>
        <div name="settings">
          <outline-server-settings
            id="serverSettings"
            metrics-id="[[metricsId]]"
            server-hostname="[[serverHostname]]"
            server-name="[[serverName]]"
            server-version="[[serverVersion]]"
            is-hostname-editable="[[isHostnameEditable]]"
            server-management-api-url="[[serverManagementApiUrl]]"
            server-port-for-new-access-keys="[[serverPortForNewAccessKeys]]"
            is-access-key-port-editable="[[isAccessKeyPortEditable]]"
            default-data-limit="[[_computeDisplayDataLimit(defaultDataLimitBytes)]]"
            is-default-data-limit-enabled="{{isDefaultDataLimitEnabled}}"
            supports-default-data-limit="[[supportsDefaultDataLimit]]"
            show-feature-metrics-disclaimer="[[showFeatureMetricsDisclaimer]]"
            server-creation-date="[[serverCreationDate]]"
            server-monthly-cost="[[monthlyCost]]"
            server-monthly-transfer-limit="[[_formatBytesTransferred(monthlyOutboundTransferBytes, language)]]"
            cloud-id="[[cloudId]]"
            cloud-location="[[cloudLocation]]"
            metrics-enabled="[[metricsEnabled]]"
            language="[[language]]"
            localize="[[localize]]"
          >
          </outline-server-settings>
        </div>
      </iron-pages>`;
  }

  static get is() {
    return 'outline-server-view';
  }

  static get properties(): PolymerElementProperties {
    return {
      accessKeyData: Array,
      accessKeyDataSortColumnId: String,
      accessKeyDataSortDirection: String,
      accessKeyTabMessage: {
        type: String,
        computed:
          '_computeAccessKeyTabMessage(hasAccessKeyData, accessKeyData, localize)',
      },
      cloudId: String,
      cloudLocation: Object,
      defaultDataLimitBytes: Number,
      featureFlags: Object,
      hasAccessKeyDataLimits: {
        type: Boolean,
        computed:
          '_computeHasAccessKeyDataLimits(isDefaultDataLimitEnabled, accessKeyData)',
      },
      hasAccessKeyData: Boolean,
      hasServerMetricsData: Boolean,
      hasNonAdminAccessKeys: Boolean,
      installProgress: Number,
      isAccessKeyPortEditable: Boolean,
      isDefaultDataLimitEnabled: Boolean,
      isHostnameEditable: Boolean,
      isServerReachable: Boolean,
      language: String,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
      localize: Function,
      metricsEnabled: Boolean,
      metricsId: String,
      monthlyCost: Number,
      monthlyOutboundTransferBytes: Number,
      retryDisplayingServer: Function,
      selectedPage: String,
      selectedTab: String,
      serverCreationDate: Date,
      serverHostname: String,
      serverId: String,
      serverManagementApiUrl: String,
      serverMetricsBandwidthLocations: Array,
      serverMetricsData: Object,
      serverMetricsTunnelTimeLocations: Array,
      serverName: String,
      serverPortForNewAccessKeys: Number,
      serverVersion: String,
      showFeatureMetricsDisclaimer: Boolean,
      supportsDefaultDataLimit: Boolean,
    };
  }

  ready() {
    super.ready();

    this._restoreAccessKeySortPreference();

    this.addEventListener(
      AccessKeyDataTableEvent.SORT,
      (event: CustomEvent) => {
        this.accessKeyDataSortDirection = event.detail.sortDirection;
        this.accessKeyDataSortColumnId = event.detail.columnId;
        this._persistAccessKeySortPreference();
      }
    );

    this.addEventListener(
      AccessKeyDataTableEvent.DELETE_KEY,
      (event: CustomEvent) =>
        this.dispatchEvent(
          makePublicEvent('RemoveAccessKeyRequested', {
            accessKeyId: event.detail.id,
          })
        )
    );

    this.addEventListener(
      AccessKeyDataTableEvent.EDIT_KEY_NAME,
      (event: CustomEvent) => {
        this.dispatchEvent(
          makePublicEvent('RenameAccessKeyRequested', {
            accessKeyId: event.detail.id,
            newName: event.detail.name,
          })
        );
      }
    );

    this.addEventListener(
      AccessKeyDataTableEvent.EDIT_KEY_DATA_LIMIT,
      (event: CustomEvent) =>
        this.dispatchEvent(
          makePublicEvent('OpenPerKeyDataLimitDialogRequested', {
            keyId: event.detail.id,
            keyDataLimitBytes: event.detail.dataLimitBytes,
            keyName: event.detail.name,
            serverId: this.serverId,
            defaultDataLimitBytes: this.isDefaultDataLimitEnabled
              ? this.defaultDataLimitBytes
              : undefined,
          })
        )
    );

    this.addEventListener(
      AccessKeyDataTableEvent.SHARE_KEY,
      (event: CustomEvent) =>
        this.dispatchEvent(
          makePublicEvent('OpenShareDialogRequested', {
            accessKey: event.detail.accessUrl,
          })
        )
    );
  }

  accessKeyData: AccessKeyDataTableRow[] = [];
  accessKeyDataSortDirection: DataTableSortDirection;
  accessKeyDataSortColumnId: string;

  private _accessKeySortStorageKey(): string {
    return `outline-manager-access-key-sort:${this.serverId || 'default'}`;
  }

  private _persistAccessKeySortPreference(): void {
    try {
      window.localStorage.setItem(
        this._accessKeySortStorageKey(),
        JSON.stringify({
          columnId: this.accessKeyDataSortColumnId,
          sortDirection: this.accessKeyDataSortDirection,
        })
      );
    } catch (e) {
      // Ignore quota / private-mode failures.
    }
  }

  private _restoreAccessKeySortPreference(): void {
    try {
      const raw = window.localStorage.getItem(this._accessKeySortStorageKey());
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as {
        columnId?: string;
        sortDirection?: DataTableSortDirection;
      };
      if (parsed.columnId) {
        this.accessKeyDataSortColumnId = parsed.columnId;
      }
      if (parsed.sortDirection) {
        this.accessKeyDataSortDirection = parsed.sortDirection;
      }
    } catch (e) {
      // Ignore corrupt preference.
    }
  }
  cloudId = '';
  cloudLocation: CloudLocation = null;
  defaultDataLimitBytes: number = null;
  isAccessKeyPortEditable = false;
  isDefaultDataLimitEnabled = false;
  isHostnameEditable = false;
  metricsId = '';
  readonly getCloudIcon = getCloudIcon;
  readonly getShortName = getShortName;
  serverCreationDate = new Date(0);
  serverHostname = '';
  serverId = '';
  serverManagementApiUrl = '';
  serverMetricsBandwidthLocations: ServerMetricsBandwidthLocation[];
  serverMetricsData: ServerMetricsData;
  serverMetricsTunnelTimeLocations: ServerMetricsTunnelTimeLocation[];
  serverName = '';
  serverPortForNewAccessKeys: number = null;
  serverVersion = '';
  hasPerKeyDataLimitDialog = false;
  /** Whether the server supports default data limits. */
  supportsDefaultDataLimit = false;
  showFeatureMetricsDisclaimer = false;
  installProgress = 0;
  isServerReachable = false;
  /** Callback for retrying to display an unreachable server. */
  retryDisplayingServer: () => void = null;
  hasNonAdminAccessKeys = false;
  hasAccessKeyData = false;
  hasServerMetricsData = false;
  metricsEnabled = false;
  // Initialize monthlyOutboundTransferBytes and monthlyCost to 0, so they can
  // be bound to hidden attributes.  Initializing to undefined does not
  // cause hidden$=... expressions to be evaluated and so elements may be
  // shown incorrectly.  See:
  //   https://stackoverflow.com/questions/33700125/polymer-1-0-hidden-attribute-negate-operator
  //   https://www.polymer-project.org/1.0/docs/devguide/data-binding.html
  monthlyOutboundTransferBytes = 0;
  monthlyCost = 0;
  language = 'en';
  localize: (msgId: string, ...params: string[]) => string = null;
  selectedPage:
    | 'progressView'
    | 'connectingView'
    | 'unreachableView'
    | 'managementView' = 'managementView';
  selectedTab: 'connections' | 'metrics' | 'settings' = 'connections';
  featureFlags = {serverMetricsTab: false};

  // Help bubbles should be shown after this outline-server-view
  // is on the screen (e.g. selected in iron-pages). If help bubbles
  // are initialized before this point, setPosition will not work and
  // they will appear in the top left of the view.
  showGetConnectedHelpBubble() {
    return this._showHelpBubble(
      'getConnectedHelpBubble',
      'accessKeysContainer'
    );
  }

  showAddAccessKeyHelpBubble() {
    return this._showHelpBubble(
      'addAccessKeyHelpBubble',
      'addAccessKeyButton',
      'down',
      'left'
    );
  }

  showDataLimitsHelpBubble() {
    return this._showHelpBubble(
      'dataLimitsHelpBubble',
      'settingsTab',
      'up',
      'right'
    );
  }

  _computeAccessKeyTabMessage(
    hasAccessKeyData: boolean,
    accessKeyData: AccessKeyDataTableRow[],
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    localize: Function
  ) {
    if (!hasAccessKeyData) {
      return localize('server-view-access-keys-tab', 'accessKeyCount', '...');
    }

    return localize(
      'server-view-access-keys-tab',
      'accessKeyCount',
      new Intl.NumberFormat(this.language).format(accessKeyData.length)
    );
  }

  _computeHasAccessKeyDataLimits(
    isDefaultDataLimitEnabled: boolean,
    accessKeyData: AccessKeyDataTableRow[]
  ) {
    if (!accessKeyData) {
      return false;
    }

    return (
      !isDefaultDataLimitEnabled &&
      !accessKeyData.some(({dataLimit}) => dataLimit)
    );
  }

  _closeAddAccessKeyHelpBubble() {
    (this.$.addAccessKeyHelpBubble as OutlineHelpBubble).hide();
  }

  _closeGetConnectedHelpBubble() {
    (this.$.getConnectedHelpBubble as OutlineHelpBubble).hide();
  }

  _closeDataLimitsHelpBubble() {
    (this.$.dataLimitsHelpBubble as OutlineHelpBubble).hide();
  }

  _handleAddAccessKeyPressed() {
    this.dispatchEvent(makePublicEvent('AddAccessKeyRequested'));
    (this.$.addAccessKeyHelpBubble as OutlineHelpBubble).hide();
  }

  _computeDisplayDataLimit(limit?: number) {
    return formatting.bytesToDisplayDataAmount(limit);
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  _formatDisplayDataLimit(limit: number, language: string, localize: Function) {
    return exists(limit)
      ? formatting.formatBytes(limit, language)
      : localize('no-data-limit');
  }

  _formatInboundBytesUnit(totalBytes: number, language: string) {
    // This happens during app startup before we set the language
    if (!language) {
      return '';
    }
    return formatting.formatBytesParts(totalBytes, language).unit;
  }

  _formatInboundBytesValue(totalBytes: number, language: string) {
    // This happens during app startup before we set the language
    if (!language) {
      return '';
    }
    return formatting.formatBytesParts(totalBytes, language).value;
  }

  _formatBytesTransferred(numBytes: number, language: string, emptyValue = '') {
    if (!numBytes) {
      // numBytes may not be set for manual servers, or may be 0 for
      // unused access keys.
      return emptyValue;
    }
    return formatting.formatBytes(numBytes, language);
  }

  _formatMonthlyCost(monthlyCost: number, language: string) {
    if (!monthlyCost) {
      return '';
    }
    return new Intl.NumberFormat(language, {
      style: 'currency',
      currency: 'USD',
      currencyDisplay: 'code',
    }).format(monthlyCost);
  }

  _selectedTabChanged() {
    if (this.selectedTab === 'settings') {
      this._closeAddAccessKeyHelpBubble();
      this._closeGetConnectedHelpBubble();
      this._closeDataLimitsHelpBubble();
      (this.$.serverSettings as OutlineServerSettings).setServerName(
        this.serverName
      );
    }
  }

  _showHelpBubble(
    helpBubbleId: string,
    positionTargetId: string,
    arrowDirection = 'down',
    arrowAlignment = 'right'
  ) {
    return new Promise(resolve => {
      const helpBubble = this.$[helpBubbleId] as OutlineHelpBubble;
      const target =
        this.$[positionTargetId] ??
        this.$['pages'].querySelector(`#${positionTargetId}`);
      helpBubble.show(target, arrowDirection, arrowAlignment);
      helpBubble.addEventListener('outline-help-bubble-dismissed', resolve);
    });
  }

  destroyServer() {
    this.dispatchEvent(
      makePublicEvent('DeleteServerRequested', {serverId: this.serverId})
    );
  }

  removeServer() {
    this.dispatchEvent(
      makePublicEvent('ForgetServerRequested', {serverId: this.serverId})
    );
  }

  _isServerManaged(cloudId: string) {
    return !!cloudId;
  }
}

customElements.define(ServerView.is, ServerView);

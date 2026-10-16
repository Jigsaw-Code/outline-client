// Copyright 2024 The Outline Authors
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

package outline

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"sync"

	"localhost/client/go/outline/callback"
	perrs "localhost/client/go/outline/platerrors"
	"localhost/client/go/outline/vpn"
)

// establishVpnRequestJSON must match TypeScript's EstablishVpnRequestJson.
type establishVpnRequestJSON struct {
	Client string     `json:"client"`
	VPN    vpn.Config `json:"vpn"`
}

type vpnAPI struct {
	client   *Client
	clientMu sync.Mutex
}

var vpnSingleton vpnAPI

func getSingletonVPNAPI() *vpnAPI {
	return &vpnSingleton
}

// Establish establishes a VPN connection using the given configuration string.
// The configuration string should be a JSON object containing the VPN configuration
// and the transport configuration.
//
// The function returns a non-nil error if the connection fails.
func (api *vpnAPI) Establish(configStr string) (err error) {
	var conf establishVpnRequestJSON
	if err := json.Unmarshal([]byte(configStr), &conf); err != nil {
		return perrs.PlatformError{
			Code:    perrs.InvalidConfig,
			Message: "invalid VPN config format",
			Cause:   perrs.ToPlatformError(err),
		}
	}

	clientConfig := ClientParser{}
	tcp := newFWMarkProtectedTCPDialer(conf.VPN.ProtectionMark)
	udp := newFWMarkProtectedUDPDialer(conf.VPN.ProtectionMark)
	clientComposer, err := NewClientComposer(tcp, udp)
	if err != nil {
		return perrs.PlatformError{
			Code:    perrs.InternalError,
			Message: "failed to create client composer",
			Cause:   perrs.ToPlatformError(err),
		}
	}
	clientConfig.Composer = clientComposer
	result := clientConfig.NewClient(conf.VPN.ID, conf.Client)
	if result.Error != nil {
		return result.Error
	}
	client := result.Client

	if err := client.StartSession(); err != nil {
		return perrs.PlatformError{
			Code:    perrs.SetupTrafficHandlerFailed,
			Message: "failed to start backend client",
			Cause:   perrs.ToPlatformError(err),
		}
	}
	defer func() {
		if err != nil {
			if err := client.EndSession(); err != nil {
				slog.Warn("failed to end backend client session", "err", err)
			}
		}
	}()
	_, err = vpn.EstablishVPN(context.Background(), &conf.VPN, client, client)

	api.clientMu.Lock()
	if api.client != nil {
		api.client.EndSession()
	}
	api.client = client
	api.clientMu.Unlock()

	return err
}

// closeVPN closes the currently active VPN connection.
func (api *vpnAPI) Close() error {
	api.clientMu.Lock()
	defer api.clientMu.Unlock()

	vpnErr := vpn.CloseVPN()

	var sessionErr error
	if api.client != nil {
		sessionErr = api.client.EndSession()
		api.client = nil
	}

	return errors.Join(vpnErr, sessionErr)
}

func setVPNStateChangeListener(cbTokenStr string) error {
	cbToken, err := strconv.Atoi(cbTokenStr)
	if err != nil {
		return perrs.PlatformError{
			Code:    perrs.InternalError,
			Message: "invalid callback token",
			Cause:   perrs.ToPlatformError(err),
		}
	}
	vpn.SetStateChangeListener(callback.Token(cbToken))
	return nil
}

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

package netconfig

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	"golang.getoutline.org/sdk/transport"
	"localhost/client/go/composer"
)

func mustNode(t *testing.T, text string) composer.Node {
	t.Helper()
	n, err := composer.ParseYAML([]byte(text))
	require.NoError(t, err)
	return n
}

func TestBlockConfig(t *testing.T) {
	cfg, err := ParseBlock(context.Background(), mustNode(t, "$type: block"))
	require.NoError(t, err)

	sd, err := cfg.NewStreamDialer(context.Background())
	require.NoError(t, err)
	_, err = sd.DialStream(context.Background(), "example.com:443")
	require.ErrorContains(t, err, "blocked by config")

	pd, err := cfg.NewPacketDialer(context.Background())
	require.NoError(t, err)
	_, err = pd.DialPacket(context.Background(), "example.com:443")
	require.ErrorContains(t, err, "blocked by config")
}

func TestBlockConfig_RejectsUnknownFields(t *testing.T) {
	_, err := ParseBlock(context.Background(), mustNode(t, "$type: block\nwat: 1"))
	require.Error(t, err)
}

func TestDirectConfigs(t *testing.T) {
	base := &transport.TCPDialer{}
	cfg := NewDirectStreamDialerConfig(base)
	sd, err := cfg.NewStreamDialer(context.Background())
	require.NoError(t, err)
	require.Same(t, base, sd)
}

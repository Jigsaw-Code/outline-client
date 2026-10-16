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

package composer

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

type fakeDialer struct {
	kind string
	addr string
}

func newTestParser(t *testing.T) *TypeParser[*fakeDialer] {
	t.Helper()
	p := NewTypeParser(func(ctx context.Context, node Node) (*fakeDialer, error) {
		if node.IsAbsent() {
			return &fakeDialer{kind: "direct"}, nil
		}
		var addr string
		if err := node.Decode(&addr); err == nil {
			return &fakeDialer{kind: "shorthand", addr: addr}, nil
		}
		return nil, errors.New("parser not specified")
	})
	type ssConfig struct {
		Endpoint string
		Cipher   Optional[string]
	}
	RegisterParser(p, "ss", func(ctx context.Context, cfg ssConfig) (*fakeDialer, error) {
		return &fakeDialer{kind: "ss", addr: cfg.Endpoint}, nil
	})
	p.RegisterSubParser("broken", func(ctx context.Context, node Node) (*fakeDialer, error) {
		return nil, errors.New("bad params")
	})
	return p
}

func TestTypeParser_Dispatch(t *testing.T) {
	p := newTestParser(t)
	d, err := p.Parse(context.Background(), mustParse(t, "$type: ss\nendpoint: example.com:443"))
	require.NoError(t, err)
	require.Equal(t, &fakeDialer{kind: "ss", addr: "example.com:443"}, d)
}

func TestTypeParser_Fallbacks(t *testing.T) {
	p := newTestParser(t)

	d, err := p.Parse(context.Background(), mustParse(t, `"example.com:443"`))
	require.NoError(t, err)
	require.Equal(t, "shorthand", d.kind)

	d, err = p.Parse(context.Background(), Node{})
	require.NoError(t, err)
	require.Equal(t, "direct", d.kind)

	// Mapping without $type goes to the fallback too.
	_, err = p.Parse(context.Background(), mustParse(t, "endpoint: example.com"))
	require.Error(t, err)
}

func TestTypeParser_UnknownType(t *testing.T) {
	p := newTestParser(t)
	_, err := p.Parse(context.Background(), mustParse(t, "$type: warp-drive"))
	require.ErrorIs(t, err, errors.ErrUnsupported)
	require.Contains(t, err.Error(), "warp-drive")
}

func TestTypeParser_DuplicateRegistrationPanics(t *testing.T) {
	p := newTestParser(t)
	require.Panics(t, func() {
		p.RegisterSubParser("ss", func(ctx context.Context, node Node) (*fakeDialer, error) {
			return nil, nil
		})
	})
}

func TestFirstSupported_PicksFirstSupported(t *testing.T) {
	p := newTestParser(t)
	d, err := p.Parse(context.Background(), mustParse(t, `
$type: first-supported
options:
  - $type: warp-drive
    speed: 9
  - $type: ss
    endpoint: example.com:443
`))
	require.NoError(t, err)
	require.Equal(t, "ss", d.kind)
}

func TestFirstSupported_HardErrorAborts(t *testing.T) {
	p := newTestParser(t)
	_, err := p.Parse(context.Background(), mustParse(t, `
$type: first-supported
options:
  - $type: broken
  - $type: ss
    endpoint: example.com:443
`))
	require.Error(t, err)
	require.NotErrorIs(t, err, errors.ErrUnsupported)
}

func TestFirstSupported_NoneSupported(t *testing.T) {
	p := newTestParser(t)
	_, err := p.Parse(context.Background(), mustParse(t, `
$type: first-supported
options:
  - $type: warp-drive
  - $type: teleport
`))
	require.ErrorIs(t, err, errors.ErrUnsupported)
	// The combined error reports why each option failed.
	require.Contains(t, err.Error(), "warp-drive")
	require.Contains(t, err.Error(), "teleport")
}

func TestFirstSupported_Empty(t *testing.T) {
	p := newTestParser(t)
	_, err := p.Parse(context.Background(), mustParse(t, "$type: first-supported\noptions: []"))
	require.Error(t, err)
}

func TestFirstSupported_UnknownRequiredFieldFallsThrough(t *testing.T) {
	// An unknown required field inside an option is ErrUnsupported,
	// so first-supported moves on; with ? it would have been accepted.
	p := newTestParser(t)
	d, err := p.Parse(context.Background(), mustParse(t, `
$type: first-supported
options:
  - $type: ss
    endpoint: example.com:443
    quantum_padding: 7
  - $type: ss
    endpoint: fallback.example.com:443
`))
	require.NoError(t, err)
	require.Equal(t, "fallback.example.com:443", d.addr)
}

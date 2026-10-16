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

package reporting

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"golang.getoutline.org/sdk/transport"
	"localhost/client/go/composer"
)

func parseReporter(t *testing.T, text string) (Reporter, error) {
	t.Helper()
	node, err := composer.ParseYAML([]byte(text))
	require.NoError(t, err)
	config, err := NewHTTPReporterConfigParser("")(context.Background(), node)
	if err != nil {
		return nil, err
	}
	return config.NewReporter(&transport.TCPDialer{})
}

func TestHTTPReporter_Parse(t *testing.T) {
	r, err := parseReporter(t, `
request:
  url: https://collector.example.com/report
  method: PUT
  headers:
    X-Thing: [a, b]
  body: "hello"
interval: 2h
`)
	require.NoError(t, err)
	hr := r.(*HTTPReporter)
	require.Equal(t, 2*time.Hour, hr.Interval)
	req, err := hr.NewRequest()
	require.NoError(t, err)
	require.Equal(t, "PUT", req.Method)
	require.Equal(t, []string{"a", "b"}, req.Header["X-Thing"])
}

func TestHTTPReporter_Defaults(t *testing.T) {
	r, err := parseReporter(t, "request:\n  url: https://collector.example.com/report")
	require.NoError(t, err)
	req, err := r.(*HTTPReporter).NewRequest()
	require.NoError(t, err)
	require.Equal(t, "POST", req.Method)
}

func TestHTTPReporter_EmptyValuesUseDefaults(t *testing.T) {
	r, err := parseReporter(t, "request:\n  url: https://collector.example.com/report\n  method: \"\"\ninterval: \"\"")
	require.NoError(t, err)
	hr := r.(*HTTPReporter)
	require.Zero(t, hr.Interval)
	req, err := hr.NewRequest()
	require.NoError(t, err)
	require.Equal(t, http.MethodPost, req.Method)
}

func TestHTTPReporter_Validation(t *testing.T) {
	_, err := parseReporter(t, "request:\n  url: https://c.example.com\ninterval: 10m")
	require.Error(t, err, "interval under 1h rejected")

	_, err = parseReporter(t, "request:\n  url: https://c.example.com\nenable_cookies: true")
	require.Error(t, err, "cookies without filename rejected")

	_, err = parseReporter(t, "request:\n  url: https://c.example.com\nsurprise: 1")
	require.Error(t, err, "unknown field rejected")
}

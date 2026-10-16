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
	"testing"

	"github.com/stretchr/testify/require"
)

func TestOptional_Absent(t *testing.T) {
	var o Optional[int]
	v, ok := o.Get()
	require.False(t, ok)
	require.Zero(t, v)
	require.Equal(t, 42, o.Or(42))
}

func TestOptional_Present(t *testing.T) {
	o := NewOptional("hello")
	v, ok := o.Get()
	require.True(t, ok)
	require.Equal(t, "hello", v)
	require.Equal(t, "hello", o.Or("fallback"))
}

func TestOptional_DecoderHook(t *testing.T) {
	var o Optional[int]
	var hook optionalField = &o
	*(hook.valuePtr().(*int)) = 7
	hook.markPresent()
	v, ok := o.Get()
	require.True(t, ok)
	require.Equal(t, 7, v)
}

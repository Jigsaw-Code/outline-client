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

package registry_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"localhost/client/go/composer"
	"localhost/client/go/composer/registry"

	"github.com/stretchr/testify/require"
)

func parseNode(t *testing.T, text string) composer.Node {
	t.Helper()
	node, err := composer.ParseYAML([]byte(text))
	require.NoError(t, err)
	return node
}

func TestRegisterAndParse(t *testing.T) {
	type config struct {
		Name string
	}
	kind := registry.NewKind[string]("animal")
	r := registry.New()
	require.NoError(t, registry.Register(r, kind, "cat", func(ctx context.Context, node composer.Node) (string, error) {
		var cfg config
		if err := node.Decode(&cfg); err != nil {
			return "", err
		}
		return cfg.Name, nil
	}))

	got, err := registry.Parser(r, kind)(context.Background(), parseNode(t, "$type: cat\nname: Luna"))
	require.NoError(t, err)
	require.Equal(t, "Luna", got)
}

type sounder interface {
	Sound() string
}

func TestTypedNilInterfaceResult(t *testing.T) {
	kind := registry.NewKind[sounder]("sounder")
	r := registry.New()
	require.NoError(t, registry.Register(r, kind, "silent", func(context.Context, composer.Node) (sounder, error) {
		return nil, nil
	}))

	got, err := registry.Parser(r, kind)(context.Background(), parseNode(t, "$type: silent"))
	require.NoError(t, err)
	require.Nil(t, got)
}

func TestSameTypeNameUnderDifferentKinds(t *testing.T) {
	stringKind := registry.NewKind[string]("string value")
	intKind := registry.NewKind[int]("integer value")
	r := registry.New()
	require.NoError(t, registry.Register(r, stringKind, "constant", func(context.Context, composer.Node) (string, error) {
		return "text", nil
	}))
	require.NoError(t, registry.Register(r, intKind, "constant", func(context.Context, composer.Node) (int, error) {
		return 42, nil
	}))
	node := parseNode(t, "$type: constant")

	text, err := registry.Parser(r, stringKind)(context.Background(), node)
	require.NoError(t, err)
	require.Equal(t, "text", text)
	number, err := registry.Parser(r, intKind)(context.Background(), node)
	require.NoError(t, err)
	require.Equal(t, 42, number)
}

func TestKindIdentityIsOpaque(t *testing.T) {
	first := registry.NewKind[string]("same name")
	second := registry.NewKind[string]("same name")
	r := registry.New()
	require.NoError(t, registry.Register(r, first, "value", func(context.Context, composer.Node) (string, error) {
		return "first", nil
	}))
	require.NoError(t, registry.Register(r, second, "value", func(context.Context, composer.Node) (string, error) {
		return "second", nil
	}))
	node := parseNode(t, "$type: value")

	gotFirst, err := registry.Parser(r, first)(context.Background(), node)
	require.NoError(t, err)
	gotSecond, err := registry.Parser(r, second)(context.Background(), node)
	require.NoError(t, err)
	require.Equal(t, "first", gotFirst)
	require.Equal(t, "second", gotSecond)
}

func TestDuplicateTypeRegistrationReturnsError(t *testing.T) {
	kind := registry.NewKind[string]("animal")
	r := registry.New()
	parse := func(context.Context, composer.Node) (string, error) { return "cat", nil }
	require.NoError(t, registry.Register(r, kind, "cat", parse))

	err := registry.Register(r, kind, "cat", parse)
	require.EqualError(t, err, `composer registry: kind "animal" type "cat" is already registered`)
}

func TestDuplicateFallbackRegistrationReturnsError(t *testing.T) {
	kind := registry.NewKind[string]("animal")
	r := registry.New()
	parse := func(context.Context, composer.Node) (string, error) { return "cat", nil }
	require.NoError(t, registry.RegisterFallback(r, kind, parse))

	err := registry.RegisterFallback(r, kind, parse)
	require.EqualError(t, err, `composer registry: fallback for kind "animal" is already registered`)
}

func TestUnknownTypeIsUnsupportedWithDiagnostics(t *testing.T) {
	type outerConfig struct {
		Child composer.Node
	}
	kind := registry.NewKind[string]("animal")
	parse := registry.Parser(registry.New(), kind)
	var cfg outerConfig
	require.NoError(t, parseNode(t, "child:\n  $type: warp-drive").Decode(&cfg))

	_, err := parse(context.Background(), cfg.Child)
	require.ErrorIs(t, err, errors.ErrUnsupported)
	require.Contains(t, err.Error(), "animal")
	require.Contains(t, err.Error(), "warp-drive")
	require.Contains(t, err.Error(), "child")
	require.Contains(t, err.Error(), "line 2")
}

func TestRegisteredFallbackParsesTypelessValue(t *testing.T) {
	kind := registry.NewKind[string]("animal")
	r := registry.New()
	require.NoError(t, registry.RegisterFallback(r, kind, func(ctx context.Context, node composer.Node) (string, error) {
		var value string
		if err := node.Decode(&value); err != nil {
			return "", err
		}
		return value, nil
	}))

	got, err := registry.Parser(r, kind)(context.Background(), parseNode(t, `"fallback"`))
	require.NoError(t, err)
	require.Equal(t, "fallback", got)
}

func TestMissingFallbackIsClear(t *testing.T) {
	kind := registry.NewKind[string]("animal")

	_, err := registry.Parser(registry.New(), kind)(context.Background(), parseNode(t, `"fallback"`))
	require.EqualError(t, err, `composer registry: kind "animal": config without $type has no registered fallback`)
}

func TestFirstSupportedForNewKind(t *testing.T) {
	kind := registry.NewKind[string]("animal")
	r := registry.New()
	require.NoError(t, registry.Register(r, kind, "cat", func(context.Context, composer.Node) (string, error) {
		return "cat", nil
	}))
	node := parseNode(t, `
$type: first-supported
options:
  - $type: warp-drive
  - $type: cat
`)

	got, err := registry.Parser(r, kind)(context.Background(), node)
	require.NoError(t, err)
	require.Equal(t, "cat", got)
}

func TestFirstSupportedReportsAllUnsupportedOptions(t *testing.T) {
	kind := registry.NewKind[string]("animal")
	node := parseNode(t, `
$type: first-supported
options:
  - $type: warp-drive
  - $type: teleport
`)

	_, err := registry.Parser(registry.New(), kind)(context.Background(), node)
	require.ErrorIs(t, err, errors.ErrUnsupported)
	require.Contains(t, err.Error(), "warp-drive")
	require.Contains(t, err.Error(), "teleport")
}

func TestConcurrentParsingOfUnregisteredKind(t *testing.T) {
	kind := registry.NewKind[string]("animal")
	parse := registry.Parser(registry.New(), kind)
	node := parseNode(t, "$type: warp-drive")

	const workerCount = 32
	start := make(chan struct{})
	errs := make(chan error, workerCount)
	var workers sync.WaitGroup
	workers.Add(workerCount)
	for range workerCount {
		go func() {
			defer workers.Done()
			<-start
			_, err := parse(context.Background(), node)
			errs <- err
		}()
	}
	close(start)
	workers.Wait()
	close(errs)

	for err := range errs {
		require.ErrorIs(t, err, errors.ErrUnsupported)
	}
}

func TestParserIsLateBound(t *testing.T) {
	kind := registry.NewKind[string]("animal")
	r := registry.New()
	parse := registry.Parser(r, kind)
	require.NoError(t, registry.Register(r, kind, "cat", func(context.Context, composer.Node) (string, error) {
		return "cat", nil
	}))

	got, err := parse(context.Background(), parseNode(t, "$type: cat"))
	require.NoError(t, err)
	require.Equal(t, "cat", got)
}

type tree struct {
	value string
	child *tree
}

func TestRecursiveSameKindParser(t *testing.T) {
	type config struct {
		Value string
		Child composer.Optional[composer.Node]
	}
	kind := registry.NewKind[*tree]("tree")
	r := registry.New()
	parseTree := registry.Parser(r, kind)
	require.NoError(t, registry.Register(r, kind, "branch", func(ctx context.Context, node composer.Node) (*tree, error) {
		var cfg config
		if err := node.Decode(&cfg); err != nil {
			return nil, err
		}
		result := &tree{value: cfg.Value}
		if childNode, ok := cfg.Child.Get(); ok {
			child, err := parseTree(ctx, childNode)
			if err != nil {
				return nil, err
			}
			result.child = child
		}
		return result, nil
	}))

	got, err := parseTree(context.Background(), parseNode(t, `
$type: branch
value: root
child:
  $type: branch
  value: leaf
`))
	require.NoError(t, err)
	require.Equal(t, &tree{value: "root", child: &tree{value: "leaf"}}, got)
}

type registrationBundle struct {
	kind registry.Kind[string]
}

func (p registrationBundle) Register(r registry.Registrar) error {
	for _, name := range []registry.TypeName{"cat", "dog"} {
		name := name
		if err := registry.Register(r, p.kind, name, func(context.Context, composer.Node) (string, error) {
			return string(name), nil
		}); err != nil {
			return err
		}
	}
	return nil
}

func TestRegistrationFunctionCanRegisterMultipleTypes(t *testing.T) {
	kind := registry.NewKind[string]("animal")
	r := registry.New()
	require.NoError(t, (registrationBundle{kind: kind}).Register(r))

	for _, name := range []string{"cat", "dog"} {
		got, err := registry.Parser(r, kind)(context.Background(), parseNode(t, fmt.Sprintf("$type: %s", name)))
		require.NoError(t, err)
		require.Equal(t, name, got)
	}
}

type observingComposer struct {
	delegate registry.Composer
	kinds    []string
	paths    []string
}

func (c *observingComposer) Compose(ctx context.Context, request registry.ParseRequest) error {
	c.kinds = append(c.kinds, request.KindName())
	c.paths = append(c.paths, request.Node().Path())
	return c.delegate.Compose(ctx, request)
}

var _ registry.Composer = (*observingComposer)(nil)

func TestComposerWrapperCanObserveAndDelegate(t *testing.T) {
	kind := registry.NewKind[string]("animal")
	r := registry.New()
	require.NoError(t, registry.Register(r, kind, "cat", func(context.Context, composer.Node) (string, error) {
		return "cat", nil
	}))
	wrapper := &observingComposer{delegate: r}

	got, err := registry.Parser(wrapper, kind)(context.Background(), parseNode(t, "$type: cat"))
	require.NoError(t, err)
	require.Equal(t, "cat", got)
	require.Equal(t, []string{"animal"}, wrapper.kinds)
	require.Equal(t, []string{""}, wrapper.paths)
}

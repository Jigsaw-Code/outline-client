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

package configregistry

import (
	"context"
	"errors"
	"fmt"
	"reflect"

	"localhost/client/go/composer"
	"localhost/client/go/composer/netconfig"
)

type metadataCollectorContextKey struct{}

// ErrMetadataWiring marks internal errors where an Outline registration did
// not produce or propagate the metadata required by its parent.
var ErrMetadataWiring = errors.New("internal Outline metadata wiring error")

// metadataCollector owns the connection metadata produced by one Outline
// config parse. Config values remain their canonical concrete types; the
// collector is a side table keyed by those values. It is accessed only through
// the context, like the direct-resolution cache; TransportMetadata reads the
// root result.
type metadataCollector struct {
	connectionInfo map[any]ConnectionProviderInfo
	transportInfo  map[any]TransportPairInfo
}

// WithMetadataCollection seeds the per-parse metadata side table into ctx.
// Outline parser registrations require such a context; read the root result
// with TransportMetadata.
func WithMetadataCollection(parent context.Context) context.Context {
	collector := &metadataCollector{
		connectionInfo: make(map[any]ConnectionProviderInfo),
		transportInfo:  make(map[any]TransportPairInfo),
	}
	return context.WithValue(parent, metadataCollectorContextKey{}, collector)
}

func collectorFromContext(ctx context.Context) (*metadataCollector, error) {
	collector, _ := ctx.Value(metadataCollectorContextKey{}).(*metadataCollector)
	if collector == nil {
		return nil, fmt.Errorf("%w: no collector in context", ErrMetadataWiring)
	}
	return collector, nil
}

func comparableMetadataKey(value any) error {
	if value == nil {
		return fmt.Errorf("%w: cannot store metadata for <nil>", ErrMetadataWiring)
	}
	if !reflect.TypeOf(value).Comparable() {
		return fmt.Errorf("%w: metadata key %T is not comparable", ErrMetadataWiring, value)
	}
	return nil
}

func storeConnectionInfo(ctx context.Context, cfg any, info ConnectionProviderInfo) error {
	collector, err := collectorFromContext(ctx)
	if err != nil {
		return err
	}
	if err := comparableMetadataKey(cfg); err != nil {
		return err
	}
	collector.connectionInfo[cfg] = info
	return nil
}

func requireConnectionInfo(ctx context.Context, cfg any) (ConnectionProviderInfo, error) {
	collector, err := collectorFromContext(ctx)
	if err != nil {
		return ConnectionProviderInfo{}, err
	}
	if err := comparableMetadataKey(cfg); err != nil {
		return ConnectionProviderInfo{}, err
	}
	info, ok := collector.connectionInfo[cfg]
	if !ok {
		return ConnectionProviderInfo{}, fmt.Errorf("%w: no connection metadata for %T", ErrMetadataWiring, cfg)
	}
	return info, nil
}

func storeTransportPairInfo(ctx context.Context, cfg any, info TransportPairInfo) error {
	collector, err := collectorFromContext(ctx)
	if err != nil {
		return err
	}
	if err := comparableMetadataKey(cfg); err != nil {
		return err
	}
	collector.transportInfo[cfg] = info
	return nil
}

// TransportMetadata returns the metadata collected for cfg during parsing. A
// missing entry is an internal registration/wrapping error, never an implicit
// direct transport.
func TransportMetadata(ctx context.Context, cfg TransportPairConfig) (TransportPairInfo, error) {
	collector, err := collectorFromContext(ctx)
	if err != nil {
		return TransportPairInfo{}, err
	}
	if err := comparableMetadataKey(cfg); err != nil {
		return TransportPairInfo{}, err
	}
	info, ok := collector.transportInfo[cfg]
	if !ok {
		return TransportPairInfo{}, fmt.Errorf("%w: no transport metadata for %T", ErrMetadataWiring, cfg)
	}
	return info, nil
}

type connectionInfoFunc[Cfg any] func(context.Context, Cfg) (ConnectionProviderInfo, error)
type transportPairInfoFunc[Cfg any] func(context.Context, Cfg) (TransportPairInfo, error)

func streamDialerParser[Cfg netconfig.StreamDialerConfig](
	parse composer.ParseFunc[Cfg], info connectionInfoFunc[Cfg],
) composer.ParseFunc[netconfig.StreamDialerConfig] {
	return func(ctx context.Context, node composer.Node) (netconfig.StreamDialerConfig, error) {
		cfg, err := parse(ctx, node)
		if err != nil {
			return nil, err
		}
		metadata, err := info(ctx, cfg)
		if err != nil {
			return nil, err
		}
		if err := storeConnectionInfo(ctx, cfg, metadata); err != nil {
			return nil, err
		}
		return cfg, nil
	}
}

func packetDialerParser[Cfg netconfig.PacketDialerConfig](
	parse composer.ParseFunc[Cfg], info connectionInfoFunc[Cfg],
) composer.ParseFunc[netconfig.PacketDialerConfig] {
	return func(ctx context.Context, node composer.Node) (netconfig.PacketDialerConfig, error) {
		cfg, err := parse(ctx, node)
		if err != nil {
			return nil, err
		}
		metadata, err := info(ctx, cfg)
		if err != nil {
			return nil, err
		}
		if err := storeConnectionInfo(ctx, cfg, metadata); err != nil {
			return nil, err
		}
		return cfg, nil
	}
}

func streamEndpointParser[Cfg netconfig.StreamEndpointConfig](
	parse composer.ParseFunc[Cfg], info connectionInfoFunc[Cfg],
) composer.ParseFunc[netconfig.StreamEndpointConfig] {
	return func(ctx context.Context, node composer.Node) (netconfig.StreamEndpointConfig, error) {
		cfg, err := parse(ctx, node)
		if err != nil {
			return nil, err
		}
		metadata, err := info(ctx, cfg)
		if err != nil {
			return nil, err
		}
		if err := storeConnectionInfo(ctx, cfg, metadata); err != nil {
			return nil, err
		}
		return cfg, nil
	}
}

func packetEndpointParser[Cfg netconfig.PacketEndpointConfig](
	parse composer.ParseFunc[Cfg], info connectionInfoFunc[Cfg],
) composer.ParseFunc[netconfig.PacketEndpointConfig] {
	return func(ctx context.Context, node composer.Node) (netconfig.PacketEndpointConfig, error) {
		cfg, err := parse(ctx, node)
		if err != nil {
			return nil, err
		}
		metadata, err := info(ctx, cfg)
		if err != nil {
			return nil, err
		}
		if err := storeConnectionInfo(ctx, cfg, metadata); err != nil {
			return nil, err
		}
		return cfg, nil
	}
}

func packetListenerParser[Cfg netconfig.PacketListenerConfig](
	parse composer.ParseFunc[Cfg], info connectionInfoFunc[Cfg],
) composer.ParseFunc[netconfig.PacketListenerConfig] {
	return func(ctx context.Context, node composer.Node) (netconfig.PacketListenerConfig, error) {
		cfg, err := parse(ctx, node)
		if err != nil {
			return nil, err
		}
		metadata, err := info(ctx, cfg)
		if err != nil {
			return nil, err
		}
		if err := storeConnectionInfo(ctx, cfg, metadata); err != nil {
			return nil, err
		}
		return cfg, nil
	}
}

func transportPairParser[Cfg TransportPairConfig](
	parse composer.ParseFunc[Cfg], info transportPairInfoFunc[Cfg],
) composer.ParseFunc[TransportPairConfig] {
	return func(ctx context.Context, node composer.Node) (TransportPairConfig, error) {
		cfg, err := parse(ctx, node)
		if err != nil {
			return nil, err
		}
		metadata, err := info(ctx, cfg)
		if err != nil {
			return nil, err
		}
		if err := storeTransportPairInfo(ctx, cfg, metadata); err != nil {
			return nil, err
		}
		return cfg, nil
	}
}

# Outline Composer Format Specification

Status: Draft. This document is normative for the `composer` package.

## Documents

A config is a single-document YAML text (JSON, being a YAML subset, is
also valid). Multi-document streams are rejected.

## Values

A config value is one of:

- **Scalar**: string, integer, float, boolean.
- **Mapping**: string keys to config values.
- **Sequence**: list of config values.
- **Absent**: a missing field, or an explicit `null`/empty value.
  `field: null` and omitting `field` are equivalent.

YAML anchors (`&name`) and aliases (`*name`) are supported and resolved
by the framework, with limits (see Limits).

### Merge keys

The standard YAML merge key `<<` inserts the entries of another mapping
into the host mapping, which de-duplicates shared config sections:

```yaml
tcp:
  $type: shadowsocks
  endpoint: ss.example.com:80
  <<: &cipher
    cipher: chacha20-ietf-poly1305
    secret: SECRET
udp:
  $type: shadowsocks
  endpoint: ss.example.com:53
  <<: *cipher
```

Semantics:

- Keys explicitly present in the host mapping win over merged keys.
- The value of `<<` may be a mapping (inline or via alias) or a
  sequence of mappings; earlier mappings in the sequence win.
- Merges are shallow (top-level keys only) and may be chained — a
  merged mapping may itself contain `<<` — up to 20 levels.
- Merges are expanded before any field matching, so they apply equally
  to struct targets, map targets, and `$type` dispatch.

## Reserved key namespace: `$`

Mapping keys starting with `$` are reserved for the framework and are
never treated as fields:

- `$type` (string): selects the registered sub-parser for the value.
  A mapping without `$type` is handled by the type's fallback rules
  (e.g. scalar shorthand, legacy formats).
- `$defs`: the conventional place to define YAML anchors for reuse
  elsewhere in the document; parsers ignore its content.
- All other `$` keys are reserved for future use and ignored.

`$type` names and fallback rules are scoped to the expected config
category, not global to the document. For example, `shadowsocks` may be
registered independently as a stream dialer and a packet listener, while
the same name need not be valid for a whole transport. The parser that
delegates a field determines its expected category. A `$type` registered
for another category is unsupported at that location.

### Application metadata

Metadata such as connection type and first-hop address is not part of the wire
format and is not a responsibility of reusable strategy parsers. An
application may wrap a concrete parser at registration time to record metadata
for the Config object it returns. Delegating parsers build children first, so a
parent wrapper can read already-recorded child metadata. The built-in
`first-supported` combinator returns the selected Config object unchanged; it
does not create a wrapper Config or require separate metadata behavior.

## Field naming

Field names are lowercase `snake_case` (e.g. `server_port`). Matching is
tolerant: keys are compared case-insensitively with underscores removed,
so `serverport` and `Server_Port` match the same field. `snake_case` is
the spelling convention for documentation and examples; error messages
name fields in the normalized form (e.g. `serverport`), which is always
itself a valid spelling.

## Sender-side optional fields: the `?` suffix

A key ending in `?` (e.g. `padding?: 32`) tells the parser the field is
**safe to ignore if unknown**:

- Known field, `?` suffix: parsed normally; the `?` changes nothing.
- Unknown field, `?` suffix: skipped.
- Unknown field, no `?`: an error that matches `errors.ErrUnsupported`.
- The same field appearing both with and without `?`: an error.

The `?` marker applies to key *recognition* only. If the field is known,
errors inside its value are real errors. For a whole optional subtree
with fallback semantics, use `first-supported`.

## Receiver-side required fields

Parsers declare their schema as Go structs. Every exported struct field
is **required by default**: the config must set it to a non-absent value.
Fields typed `composer.Optional[T]` are optional. There are no struct
tags.

Unknown fields (without `?`) are always errors: they mean the client
cannot faithfully implement the config.

## Scalar conversions

| Config value       | Go targets                                | Notes                                |
|--------------------|-------------------------------------------|--------------------------------------|
| string, block text | `string`                                  | no coercion from numbers or booleans |
| integer            | `int*`, `uint*` (range-checked), `float*` | no coercion from strings             |
| float              | `float32`, `float64`                      |                                      |
| boolean            | `bool`                                    | only `true`/`false`                  |

A mapping decodes into a struct or a `map[string]T` (map keys are taken
verbatim: no `$`/`?` semantics). A sequence decodes into a slice. Any
value can decode into a `composer.Node` to defer parsing.

## Negotiation and `first-supported`

Errors that mean "this client cannot handle this config" — unknown
`$type`, unknown required field, unsupported platform — match
`errors.ErrUnsupported`. The built-in combinator:

```yaml
$type: first-supported
options:
  - {$type: fancy-new-thing, ...}
  - {$type: old-reliable, ...}
```

tries each option in order, skipping only options that fail with
`ErrUnsupported`; any other error aborts. If no option is supported the
combined error (matching `ErrUnsupported`) reports why each option
failed.

## Limits

To protect against adversarial configs:

- Alias indirection: at most 20 levels.
- Merge expansion work: at most 100,000 mapping and sequence values.
- Decode depth: at most 100 nested levels.
- Decode work: at most 100,000 values visited per Decode call
  (defeats billion-laughs style alias amplification).

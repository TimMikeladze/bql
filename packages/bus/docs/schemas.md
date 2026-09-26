# Schemas

A registry of JSON Schema 2020-12 documents, bound to subject *patterns*, enforced at publish and
at delivery. The validator is written here rather than depended on — the bus ships as one binary
with no runtime dependencies — and the consequence that matters is stated first.

## Registration rejects any keyword the validator does not implement

A validator that quietly ignores `if`/`then` reports a document as valid when the rule the author
wrote has never been checked. So an unsupported keyword is a **400 at registration**, naming the
pointer, rather than a constraint that silently does nothing.

```
$ bql-bus schema register order ./order.json
error: keyword 'if' is not supported: conditional subschemas are not implemented at /if
```

`GET /api/schemas/keywords` returns the list this build actually implements, so a schema author
can ask rather than guess.

### Supported

`$schema` · `$id` · `$ref` (local `#/$defs/<name>` only) · `$defs` · `$comment` · `title` ·
`description` · `default` · `examples` · `deprecated` · `type` · `enum` · `const` · `minimum` ·
`maximum` · `exclusiveMinimum` · `exclusiveMaximum` · `multipleOf` · `minLength` · `maxLength` ·
`pattern` · `properties` · `required` · `additionalProperties` · `minProperties` ·
`maxProperties` · `items` · `prefixItems` · `minItems` · `maxItems` · `uniqueItems` · `allOf` ·
`anyOf` · `oneOf` · `not`

### Refused, with the reason

`format` (annotation-only in 2020-12, so it would not be enforced) · `if`/`then`/`else` ·
`dependentSchemas` · `dependentRequired` · `contains`/`minContains`/`maxContains` ·
`patternProperties` · `propertyNames` · `unevaluatedProperties` · `unevaluatedItems` ·
`contentEncoding`/`contentMediaType`/`contentSchema` · `$dynamicRef`/`$dynamicAnchor` ·
`$anchor` · `$vocabulary`

## Compatibility is checked, not documented

`backward | forward | full | none`, computed structurally at registration against the previous
version. A version that breaks the declared mode is a **409 naming the pointer**.

- **backward** — a consumer on the new schema can still read data written against the old one, so
  the new version may not accept *less*. Broken by: a newly required property, a narrowed type, a
  shrunk enum, a tightened numeric bound, `additionalProperties` going from open to closed.
- **forward** — a consumer on the old schema can read data written against the new one, so the new
  version may not accept *more*. Broken by the mirror image of each of the above.
- **full** — both.
- **none** — no check. A deliberate choice an operator makes, not a default that happens.

Exact subset checking of JSON Schema is undecidable, so the comparator is a structural
approximation that errs toward **reporting** a change: anything it cannot decide — a changed
`anyOf`, a changed `pattern` — is reported in both directions and therefore fails a strict mode
rather than passing one it should not.

`bql-bus schema check <name> <file>` is the dry run:

```
$ bql-bus schema check order ./order-v2.json --compat backward
narrowed  /required 'currency' is newly required
1 change(s) break 'backward' against version 1
```

## Bindings, and the two modes

A binding attaches a schema to a **subject pattern** — the same matcher subscriptions use — so
`orders.>` covers the family rather than needing a row per subject nobody has published yet. Where
two patterns match, the one with more literal tokens wins.

```sh
bql-bus schema bind 'orders.>' order --mode warn
bql-bus schema bind 'orders.>' order --mode enforce
```

- **`warn`** — publish succeeds, the envelope is stamped `schema-invalid: <pointer> <message>`,
  and `bql-bus.schema.violations` counts it. This is how a schema is introduced against live
  traffic before anyone depends on it.
- **`enforce`** — a publish that does not validate is a **422** naming the failing JSON Pointer
  and the schema version.
- **`off`** — bound but not checked.

Every message that passed validation carries `schema` and `schema-version` headers, so a consumer
can branch on the version rather than sniff the body.

## Validation at delivery

A message already in the log cannot be rejected — it was accepted, and the publisher is long
gone. So a delivery that fails an **enforced** schema goes to the dead-letter queue with
`dlq-reason: schema` and the detail in `dlq-detail`, rather than being dropped or handed to a
handler anyway. That is what catches the messages published before the binding existed, or while
it was still `warn`.

## Client-side typing, still zero dependencies

`BusClient.publish` accepts a [Standard Schema](https://standardschema.dev) object for local
validation and TypeScript inference. Standard Schema is an *interface*, not a package, so this
adds no dependency. The wire contract stays JSON Schema; the client-side schema is a convenience
and is never the source of truth.

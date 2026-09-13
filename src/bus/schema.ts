/**
 * A JSON Schema 2020-12 validator, for an explicitly enumerated subset.
 *
 * Written rather than depended on, because the bus ships as one binary with no
 * runtime dependencies and a validator is a few hundred lines. The interesting
 * decision is not which keywords are supported — it is that **registration
 * rejects any keyword this file does not implement**. A validator that quietly
 * ignores `if`/`then` tells you your data is valid when it has never been
 * checked, and a schema registry whose answer is "probably" is worse than no
 * registry at all. A loud gap beats a quiet hole.
 *
 * Also here: a structural compatibility comparator. A registry that records a
 * `compat` mode and never checks it is paperwork, so registration computes
 * whether the new version accepts more, less, or the same documents as the one
 * before it, and refuses the ones that break the declared mode.
 */

import type {
  CompatChange,
  CompatMode,
  Json,
  Violation,
} from "../shared/protocol";

export type { CompatChange, CompatMode, Violation };

/** Every keyword this validator implements. Anything else is refused. */
export const SUPPORTED_KEYWORDS = [
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "type",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "properties",
  "required",
  "additionalProperties",
  "minProperties",
  "maxProperties",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
] as const;

/** Keywords deliberately *not* implemented, with the reason, for the error. */
const REFUSED: Record<string, string> = {
  format: "'format' is annotation-only in 2020-12 and would not be enforced",
  if: "conditional subschemas are not implemented",
  then: "conditional subschemas are not implemented",
  else: "conditional subschemas are not implemented",
  dependentSchemas: "dependent subschemas are not implemented",
  dependentRequired: "dependent requirements are not implemented",
  contains: "'contains' is not implemented",
  minContains: "'contains' is not implemented",
  maxContains: "'contains' is not implemented",
  patternProperties: "'patternProperties' is not implemented",
  propertyNames: "'propertyNames' is not implemented",
  unevaluatedProperties: "annotation-dependent keywords are not implemented",
  unevaluatedItems: "annotation-dependent keywords are not implemented",
  contentEncoding: "content keywords are not implemented",
  contentMediaType: "content keywords are not implemented",
  contentSchema: "content keywords are not implemented",
  $dynamicRef: "dynamic references are not implemented",
  $dynamicAnchor: "dynamic references are not implemented",
  $anchor: "anchors are not implemented; use '#/$defs/<name>'",
  $vocabulary: "custom vocabularies are not implemented",
};

export class SchemaError extends Error {
  constructor(
    message: string,
    /** JSON Pointer into the *schema* that is at fault. */
    readonly pointer = "",
  ) {
    super(message);
    this.name = "SchemaError";
  }
}

export interface Validator {
  (value: Json): Violation[];
}

type Node = Record<string, Json>;

const TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
] as const;
type TypeName = (typeof TYPES)[number];

function typeOf(value: Json): Exclude<TypeName, "integer"> {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") return kind;
  return "object";
}

function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((entry, index) => deepEqual(entry, b[index]!));
  }
  if (typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, Json>;
    const right = b as Record<string, Json>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every(
      (key) => key in right && deepEqual(left[key]!, right[key]!),
    );
  }
  return false;
}

/**
 * Walk a schema and refuse anything the validator would not actually enforce.
 *
 * Runs at registration, once, so the hot path never has to wonder.
 */
export function assertSupported(schema: Json, pointer = ""): void {
  if (typeof schema === "boolean") return;
  if (schema === null || Array.isArray(schema) || typeof schema !== "object")
    throw new SchemaError("a schema must be an object or a boolean", pointer);
  const node = schema as Node;
  for (const key of Object.keys(node)) {
    if (key in REFUSED)
      throw new SchemaError(
        `keyword '${key}' is not supported: ${REFUSED[key]}`,
        `${pointer}/${key}`,
      );
    if (!(SUPPORTED_KEYWORDS as readonly string[]).includes(key))
      throw new SchemaError(
        `keyword '${key}' is not supported by this validator`,
        `${pointer}/${key}`,
      );
  }
  if (node.$ref !== undefined) {
    if (typeof node.$ref !== "string" || !node.$ref.startsWith("#/$defs/"))
      throw new SchemaError(
        "only local references of the form '#/$defs/<name>' are supported",
        `${pointer}/$ref`,
      );
  }
  if (node.type !== undefined) {
    const names = Array.isArray(node.type) ? node.type : [node.type];
    for (const name of names)
      if (typeof name !== "string" || !TYPES.includes(name as TypeName))
        throw new SchemaError(
          `unknown type '${String(name)}'`,
          `${pointer}/type`,
        );
  }
  if (node.pattern !== undefined) {
    if (typeof node.pattern !== "string")
      throw new SchemaError("'pattern' must be a string", `${pointer}/pattern`);
    try {
      new RegExp(node.pattern, "u");
    } catch (error) {
      throw new SchemaError(
        `'pattern' is not a valid regular expression: ${String(error)}`,
        `${pointer}/pattern`,
      );
    }
  }
  for (const key of ["properties", "$defs"] as const) {
    const value = node[key];
    if (value === undefined) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new SchemaError(`'${key}' must be an object`, `${pointer}/${key}`);
    for (const [name, child] of Object.entries(value as Node))
      assertSupported(child, `${pointer}/${key}/${name}`);
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
    const value = node[key];
    if (value === undefined) continue;
    if (!Array.isArray(value))
      throw new SchemaError(`'${key}' must be an array`, `${pointer}/${key}`);
    value.forEach((child, index) =>
      assertSupported(child, `${pointer}/${key}/${index}`),
    );
  }
  for (const key of ["items", "not", "additionalProperties"] as const)
    if (node[key] !== undefined)
      assertSupported(node[key]!, `${pointer}/${key}`);
}

/**
 * Compile a schema to a closure.
 *
 * Compiled once per distinct schema and cached by hash at the call site: a
 * publish should cost a tree walk over the *instance*, never over the schema.
 */
export function compile(schema: Json): Validator {
  assertSupported(schema);
  const root = schema;
  const resolve = (ref: string, pointer: string): Json => {
    const name = ref.slice("#/$defs/".length);
    const defs =
      typeof root === "object" && root !== null && !Array.isArray(root)
        ? ((root as Node).$defs as Node | undefined)
        : undefined;
    const found = defs?.[name];
    if (found === undefined)
      throw new SchemaError(`'${ref}' does not resolve`, pointer);
    return found;
  };

  const check = (
    node: Json,
    value: Json,
    at: string,
    out: Violation[],
  ): void => {
    if (node === true || node === undefined) return;
    if (node === false) {
      out.push({ pointer: at, message: "no value is allowed here" });
      return;
    }
    const schemaNode = node as Node;
    if (typeof schemaNode.$ref === "string") {
      check(resolve(schemaNode.$ref, at), value, at, out);
      return;
    }

    const actual = typeOf(value);
    if (schemaNode.type !== undefined) {
      const expected = (
        Array.isArray(schemaNode.type) ? schemaNode.type : [schemaNode.type]
      ) as TypeName[];
      const ok = expected.some((name) =>
        name === "integer"
          ? typeof value === "number" && Number.isInteger(value)
          : name === actual,
      );
      if (!ok) {
        out.push({
          pointer: at,
          message: `expected ${expected.join(" or ")}, got ${actual}`,
        });
        // Everything below assumes the type; reporting a dozen consequences of
        // one mistake helps nobody.
        return;
      }
    }

    if (schemaNode.const !== undefined && !deepEqual(schemaNode.const, value))
      out.push({
        pointer: at,
        message: `must equal ${JSON.stringify(schemaNode.const)}`,
      });
    if (Array.isArray(schemaNode.enum)) {
      if (!schemaNode.enum.some((entry) => deepEqual(entry, value)))
        out.push({
          pointer: at,
          message: `must be one of ${schemaNode.enum
            .map((entry) => JSON.stringify(entry))
            .join(", ")}`,
        });
    }

    if (typeof value === "number") {
      const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } =
        schemaNode;
      if (typeof minimum === "number" && value < minimum)
        out.push({ pointer: at, message: `must be >= ${minimum}` });
      if (typeof maximum === "number" && value > maximum)
        out.push({ pointer: at, message: `must be <= ${maximum}` });
      if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum)
        out.push({ pointer: at, message: `must be > ${exclusiveMinimum}` });
      if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum)
        out.push({ pointer: at, message: `must be < ${exclusiveMaximum}` });
      if (typeof multipleOf === "number" && multipleOf > 0) {
        const quotient = value / multipleOf;
        if (Math.abs(quotient - Math.round(quotient)) > 1e-9)
          out.push({ pointer: at, message: `must be a multiple of ${multipleOf}` });
      }
    }

    if (typeof value === "string") {
      const { minLength, maxLength, pattern } = schemaNode;
      // Code points, not UTF-16 units: 2020-12 counts characters, and an emoji
      // is one character however many units it takes.
      const length = [...value].length;
      if (typeof minLength === "number" && length < minLength)
        out.push({ pointer: at, message: `must be at least ${minLength} characters` });
      if (typeof maxLength === "number" && length > maxLength)
        out.push({ pointer: at, message: `must be at most ${maxLength} characters` });
      if (typeof pattern === "string" && !new RegExp(pattern, "u").test(value))
        out.push({ pointer: at, message: `must match /${pattern}/` });
    }

    if (actual === "array" && Array.isArray(value)) {
      const { minItems, maxItems, uniqueItems, prefixItems, items } = schemaNode;
      if (typeof minItems === "number" && value.length < minItems)
        out.push({ pointer: at, message: `must have at least ${minItems} items` });
      if (typeof maxItems === "number" && value.length > maxItems)
        out.push({ pointer: at, message: `must have at most ${maxItems} items` });
      if (uniqueItems === true)
        for (let index = 1; index < value.length; index++)
          if (
            value
              .slice(0, index)
              .some((earlier) => deepEqual(earlier, value[index]!))
          ) {
            out.push({ pointer: at, message: "items must be unique" });
            break;
          }
      const prefix = Array.isArray(prefixItems) ? prefixItems : [];
      value.forEach((entry, index) => {
        if (index < prefix.length) check(prefix[index]!, entry, `${at}/${index}`, out);
        else if (items !== undefined) check(items, entry, `${at}/${index}`, out);
      });
    }

    if (actual === "object") {
      const object = value as Record<string, Json>;
      const {
        properties,
        required,
        additionalProperties,
        minProperties,
        maxProperties,
      } = schemaNode;
      const known = new Set(
        properties && typeof properties === "object" && !Array.isArray(properties)
          ? Object.keys(properties as Node)
          : [],
      );
      if (Array.isArray(required))
        for (const name of required)
          if (typeof name === "string" && !(name in object))
            out.push({ pointer: at, message: `missing required property '${name}'` });
      const count = Object.keys(object).length;
      if (typeof minProperties === "number" && count < minProperties)
        out.push({ pointer: at, message: `must have at least ${minProperties} properties` });
      if (typeof maxProperties === "number" && count > maxProperties)
        out.push({ pointer: at, message: `must have at most ${maxProperties} properties` });
      for (const [name, entry] of Object.entries(object)) {
        const pointer = `${at}/${escapePointer(name)}`;
        if (known.has(name)) {
          check((properties as Node)[name]!, entry, pointer, out);
          continue;
        }
        if (additionalProperties === undefined || additionalProperties === true)
          continue;
        if (additionalProperties === false) {
          out.push({ pointer, message: `unexpected property '${name}'` });
          continue;
        }
        check(additionalProperties, entry, pointer, out);
      }
    }

    for (const entry of Array.isArray(schemaNode.allOf) ? schemaNode.allOf : [])
      check(entry, value, at, out);
    if (Array.isArray(schemaNode.anyOf)) {
      const matched = schemaNode.anyOf.some(
        (entry) => collect(entry, value, at).length === 0,
      );
      if (!matched)
        out.push({ pointer: at, message: "did not match any of the allowed forms" });
    }
    if (Array.isArray(schemaNode.oneOf)) {
      const matches = schemaNode.oneOf.filter(
        (entry) => collect(entry, value, at).length === 0,
      ).length;
      if (matches !== 1)
        out.push({
          pointer: at,
          message: `must match exactly one of the allowed forms, matched ${matches}`,
        });
    }
    if (schemaNode.not !== undefined && collect(schemaNode.not, value, at).length === 0)
      out.push({ pointer: at, message: "must not match the excluded form" });
  };

  const collect = (node: Json, value: Json, at: string): Violation[] => {
    const out: Violation[] = [];
    check(node, value, at, out);
    return out;
  };

  return (value: Json) => collect(root, value, "");
}

/** `~` and `/` have to be escaped in a JSON Pointer token. */
function escapePointer(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

// --------------------------------------------------------- compatibility

/**
 * How the new version's accepted documents relate to the old version's.
 *
 * Exact subset checking of JSON Schema is undecidable, so this is a structural
 * approximation that errs toward *reporting* a change: anything it cannot
 * decide is reported in both directions, which fails a strict mode rather than
 * passing one it should not. The error names the pointer, so the answer to "why
 * was this rejected" is in the response and not in a guess.
 */
export function compare(older: Json, newer: Json): CompatChange[] {
  const out: CompatChange[] = [];
  walk(older, newer, "", out);
  return out;
}

function asNode(schema: Json): Node | null {
  if (schema === true || schema === undefined) return {};
  if (schema === false) return null;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema))
    return {};
  return schema as Node;
}

function walk(older: Json, newer: Json, at: string, out: CompatChange[]): void {
  const a = asNode(older);
  const b = asNode(newer);
  if (a === null && b === null) return;
  if (a === null) {
    out.push({ pointer: at, direction: "widened", detail: "nothing was allowed here before" });
    return;
  }
  if (b === null) {
    out.push({ pointer: at, direction: "narrowed", detail: "nothing is allowed here now" });
    return;
  }

  // Anything involving a combinator or a reference is compared by identity:
  // deciding whether `anyOf` grew or shrank in general is the undecidable part.
  for (const key of ["allOf", "anyOf", "oneOf", "not", "$ref"] as const)
    if (a[key] !== undefined || b[key] !== undefined) {
      if (!deepEqual(a[key] ?? null, b[key] ?? null)) {
        out.push({
          pointer: `${at}/${key}`,
          direction: "narrowed",
          detail: `'${key}' changed and cannot be compared structurally`,
        });
        out.push({
          pointer: `${at}/${key}`,
          direction: "widened",
          detail: `'${key}' changed and cannot be compared structurally`,
        });
      }
      return;
    }

  const types = (node: Node): Set<string> =>
    node.type === undefined
      ? new Set(TYPES)
      : new Set(
          (Array.isArray(node.type) ? node.type : [node.type]) as string[],
        );
  const before = types(a);
  const after = types(b);
  for (const name of before)
    if (!after.has(name) && !(name === "integer" && after.has("number")))
      out.push({ pointer: `${at}/type`, direction: "narrowed", detail: `type '${name}' is no longer accepted` });
  for (const name of after)
    if (!before.has(name) && !(name === "integer" && before.has("number")))
      out.push({ pointer: `${at}/type`, direction: "widened", detail: `type '${name}' is newly accepted` });

  const members = (node: Node): Json[] | null =>
    Array.isArray(node.enum)
      ? node.enum
      : node.const !== undefined
        ? [node.const]
        : null;
  const oldEnum = members(a);
  const newEnum = members(b);
  if (oldEnum && newEnum) {
    for (const entry of oldEnum)
      if (!newEnum.some((other) => deepEqual(other, entry)))
        out.push({ pointer: `${at}/enum`, direction: "narrowed", detail: `${JSON.stringify(entry)} was removed` });
    for (const entry of newEnum)
      if (!oldEnum.some((other) => deepEqual(other, entry)))
        out.push({ pointer: `${at}/enum`, direction: "widened", detail: `${JSON.stringify(entry)} was added` });
  } else if (oldEnum && !newEnum)
    out.push({ pointer: `${at}/enum`, direction: "widened", detail: "the value is no longer restricted to a set" });
  else if (!oldEnum && newEnum)
    out.push({ pointer: `${at}/enum`, direction: "narrowed", detail: "the value is newly restricted to a set" });

  bound(a, b, at, "minimum", "up", out);
  bound(a, b, at, "exclusiveMinimum", "up", out);
  bound(a, b, at, "minLength", "up", out);
  bound(a, b, at, "minItems", "up", out);
  bound(a, b, at, "minProperties", "up", out);
  bound(a, b, at, "maximum", "down", out);
  bound(a, b, at, "exclusiveMaximum", "down", out);
  bound(a, b, at, "maxLength", "down", out);
  bound(a, b, at, "maxItems", "down", out);
  bound(a, b, at, "maxProperties", "down", out);

  if (a.pattern !== b.pattern) {
    if (a.pattern === undefined)
      out.push({ pointer: `${at}/pattern`, direction: "narrowed", detail: "a pattern was added" });
    else if (b.pattern === undefined)
      out.push({ pointer: `${at}/pattern`, direction: "widened", detail: "the pattern was removed" });
    else {
      out.push({ pointer: `${at}/pattern`, direction: "narrowed", detail: "the pattern changed" });
      out.push({ pointer: `${at}/pattern`, direction: "widened", detail: "the pattern changed" });
    }
  }
  if (a.uniqueItems !== b.uniqueItems)
    out.push({
      pointer: `${at}/uniqueItems`,
      direction: b.uniqueItems === true ? "narrowed" : "widened",
      detail: "uniqueItems changed",
    });

  const requiredBefore = new Set(
    (Array.isArray(a.required) ? a.required : []) as string[],
  );
  const requiredAfter = new Set(
    (Array.isArray(b.required) ? b.required : []) as string[],
  );
  for (const name of requiredAfter)
    if (!requiredBefore.has(name))
      out.push({
        pointer: `${at}/required`,
        direction: "narrowed",
        detail: `'${name}' is newly required`,
      });
  for (const name of requiredBefore)
    if (!requiredAfter.has(name))
      out.push({
        pointer: `${at}/required`,
        direction: "widened",
        detail: `'${name}' is no longer required`,
      });

  const openBefore = a.additionalProperties === undefined || a.additionalProperties === true;
  const openAfter = b.additionalProperties === undefined || b.additionalProperties === true;
  if (openBefore && !openAfter)
    out.push({ pointer: `${at}/additionalProperties`, direction: "narrowed", detail: "additional properties are no longer free" });
  if (!openBefore && openAfter)
    out.push({ pointer: `${at}/additionalProperties`, direction: "widened", detail: "additional properties are newly free" });
  if (!openBefore && !openAfter)
    walk(a.additionalProperties ?? true, b.additionalProperties ?? true, `${at}/additionalProperties`, out);

  const propertiesOf = (node: Node): Node =>
    node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)
      ? (node.properties as Node)
      : {};
  const propsBefore = propertiesOf(a);
  const propsAfter = propertiesOf(b);
  for (const name of new Set([
    ...Object.keys(propsBefore),
    ...Object.keys(propsAfter),
  ])) {
    const pointer = `${at}/properties/${escapePointer(name)}`;
    const left = propsBefore[name];
    const right = propsAfter[name];
    if (left !== undefined && right !== undefined) {
      walk(left, right, pointer, out);
      continue;
    }
    if (right !== undefined) {
      // The property was unconstrained before (or banned) and is constrained
      // now, which is a narrowing whichever it was.
      out.push({
        pointer,
        direction: openBefore ? "narrowed" : "widened",
        detail: `property '${name}' was added`,
      });
      continue;
    }
    out.push({
      pointer,
      direction: openAfter ? "widened" : "narrowed",
      detail: `property '${name}' was removed`,
    });
  }

  if (a.items !== undefined || b.items !== undefined)
    walk(a.items ?? true, b.items ?? true, `${at}/items`, out);
  const prefixBefore = Array.isArray(a.prefixItems) ? a.prefixItems : [];
  const prefixAfter = Array.isArray(b.prefixItems) ? b.prefixItems : [];
  for (let index = 0; index < Math.max(prefixBefore.length, prefixAfter.length); index++)
    walk(
      prefixBefore[index] ?? true,
      prefixAfter[index] ?? true,
      `${at}/prefixItems/${index}`,
      out,
    );
}

function bound(
  a: Node,
  b: Node,
  at: string,
  key: string,
  tighter: "up" | "down",
  out: CompatChange[],
): void {
  const before = a[key];
  const after = b[key];
  if (before === after) return;
  if (typeof before !== "number" && typeof after !== "number") return;
  if (typeof after !== "number") {
    out.push({ pointer: `${at}/${key}`, direction: "widened", detail: `'${key}' was removed` });
    return;
  }
  if (typeof before !== "number") {
    out.push({ pointer: `${at}/${key}`, direction: "narrowed", detail: `'${key}' was added` });
    return;
  }
  const stricter = tighter === "up" ? after > before : after < before;
  out.push({
    pointer: `${at}/${key}`,
    direction: stricter ? "narrowed" : "widened",
    detail: `'${key}' moved from ${before} to ${after}`,
  });
}

/** The changes that break a declared compatibility mode. */
export function breaking(
  changes: CompatChange[],
  mode: CompatMode,
): CompatChange[] {
  if (mode === "none") return [];
  // Backward = a reader on the new schema can still read data written against
  // the old one, so the new version may not accept *less*.
  if (mode === "backward")
    return changes.filter((change) => change.direction === "narrowed");
  if (mode === "forward")
    return changes.filter((change) => change.direction === "widened");
  return changes;
}

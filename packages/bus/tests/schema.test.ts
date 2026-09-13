/**
 * The validator and the compatibility checker.
 *
 * Two properties matter more than coverage of any individual keyword: an
 * unsupported keyword is *refused* rather than ignored, and a version that
 * breaks its declared compatibility mode is refused with the pointer that
 * broke it. Both are the difference between a registry and paperwork.
 */
import { expect, test } from "bun:test";
import {
  assertSupported,
  breaking,
  compare,
  compile,
  SchemaError,
} from "../src/bus/schema";
import { BusStore } from "../src/bus/store";
import type { Json } from "../src/shared/protocol";

const W = "default";
let clock = 1_000_000;
const store = () => new BusStore(":memory:", { now: () => clock });

const order: Json = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    total: { type: "number", minimum: 0 },
    currency: { enum: ["EUR", "USD"] },
    items: {
      type: "array",
      minItems: 1,
      items: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
    },
  },
  required: ["id", "total"],
  additionalProperties: false,
};

test("a valid document passes and an invalid one names the pointer", () => {
  const validate = compile(order);
  expect(
    validate({ id: "a", total: 10, currency: "EUR", items: [{ sku: "x" }] }),
  ).toEqual([]);

  const violations = validate({ id: "", total: -1, currency: "GBP" });
  expect(violations.map((v) => `${v.pointer} ${v.message}`)).toEqual([
    "/id must be at least 1 characters",
    "/total must be >= 0",
    "/currency must be one of \"EUR\", \"USD\"",
  ]);
});

test("an unexpected property is caught when additionalProperties is false", () => {
  expect(compile(order)({ id: "a", total: 1, sneaky: true })).toEqual([
    { pointer: "/sneaky", message: "unexpected property 'sneaky'" },
  ]);
});

test("a keyword the validator does not implement is refused, not ignored", () => {
  // The whole point. `if`/`then` silently ignored would report a document as
  // valid that has never been checked against the rule the author wrote.
  expect(() =>
    assertSupported({ type: "object", if: { const: 1 }, then: { const: 2 } }),
  ).toThrow(/keyword 'if' is not supported/);
  expect(() => assertSupported({ type: "string", format: "email" })).toThrow(
    /annotation-only/,
  );
  expect(() => assertSupported({ type: "string", patternProperties: {} })).toThrow(
    /patternProperties/,
  );
  try {
    assertSupported({ properties: { a: { type: "string", format: "uri" } } });
    throw new Error("should have thrown");
  } catch (error) {
    // The pointer says *where*, so a large schema does not need bisecting.
    expect((error as SchemaError).pointer).toBe("/properties/a/format");
  }
});

test("only local $defs references are accepted", () => {
  expect(() =>
    assertSupported({ $ref: "https://example.com/schema.json" }),
  ).toThrow(/local references/);
  const withDefs: Json = {
    $defs: { id: { type: "string", minLength: 2 } },
    type: "object",
    properties: { id: { $ref: "#/$defs/id" } },
  };
  expect(compile(withDefs)({ id: "ab" })).toEqual([]);
  expect(compile(withDefs)({ id: "a" })).toHaveLength(1);
});

test("oneOf must match exactly one, and says how many it matched", () => {
  const either: Json = {
    oneOf: [{ type: "object", properties: { a: { type: "number" } }, required: ["a"] }, { type: "string" }],
  };
  expect(compile(either)("hello")).toEqual([]);
  expect(compile(either)({ a: 1 })).toEqual([]);
  expect(compile(either)(true)[0]!.message).toMatch(/matched 0/);
});

// ---------------------------------------------------------- compatibility

test("adding a required property narrows, and breaks backward", () => {
  const next = {
    ...(order as Record<string, Json>),
    required: ["id", "total", "currency"],
  } as Json;
  const changes = compare(order, next);
  expect(
    changes.some(
      (change) =>
        change.direction === "narrowed" && change.detail.includes("newly required"),
    ),
  ).toBe(true);
  expect(breaking(changes, "backward")).not.toHaveLength(0);
  // Forward is the other direction: a reader on the old schema can still read
  // documents written against the new one.
  expect(breaking(changes, "forward")).toHaveLength(0);
  expect(breaking(changes, "none")).toHaveLength(0);
});

test("removing an enum member narrows; adding one widens", () => {
  const shrunk = JSON.parse(JSON.stringify(order)) as Record<string, Json>;
  (shrunk.properties as Record<string, Json>).currency = { enum: ["EUR"] };
  expect(breaking(compare(order, shrunk as Json), "backward")).not.toHaveLength(0);

  const grown = JSON.parse(JSON.stringify(order)) as Record<string, Json>;
  (grown.properties as Record<string, Json>).currency = {
    enum: ["EUR", "USD", "GBP"],
  };
  expect(breaking(compare(order, grown as Json), "backward")).toHaveLength(0);
  expect(breaking(compare(order, grown as Json), "forward")).not.toHaveLength(0);
});

test("a tightened numeric bound narrows", () => {
  const tighter = JSON.parse(JSON.stringify(order)) as Record<string, Json>;
  (tighter.properties as Record<string, Json>).total = { type: "number", minimum: 1 };
  const changes = compare(order, tighter as Json);
  expect(breaking(changes, "backward")[0]!.pointer).toBe("/properties/total/minimum");
});

test("what the comparator cannot decide, it reports in both directions", () => {
  // Conservative on purpose: an undecidable change fails a strict mode rather
  // than passing one it should not.
  const changes = compare(
    { anyOf: [{ type: "string" }] },
    { anyOf: [{ type: "number" }] },
  );
  expect(changes.some((change) => change.direction === "narrowed")).toBe(true);
  expect(changes.some((change) => change.direction === "widened")).toBe(true);
  expect(breaking(changes, "full")).not.toHaveLength(0);
});

// -------------------------------------------------------------- registry

test("registration refuses a version that breaks its declared mode", () => {
  const bus = store();
  bus.registerSchema(W, "order", order, "backward");
  const next = {
    ...(order as Record<string, Json>),
    required: ["id", "total", "currency"],
  } as Json;
  expect(() => bus.registerSchema(W, "order", next, "backward")).toThrow(
    /breaks 'backward' compatibility with version 1/,
  );
  // The same change is fine under `none`, which is a decision the operator
  // makes explicitly rather than one the registry makes for them.
  expect(bus.registerSchema(W, "order", next, "none").version).toBe(2);
  bus.close();
});

test("enforce rejects at publish; warn publishes and stamps the envelope", async () => {
  const bus = store();
  bus.registerSchema(W, "order", order, "backward");
  bus.bindSchema(W, "orders.>", "order", "enforce");
  await expect(
    bus.publish(W, { subject: "orders.created", body: { id: "a" } }),
  ).rejects.toThrow(/does not match schema 'order' version 1/);

  const good = await bus.publish(W, {
    subject: "orders.created",
    body: { id: "a", total: 1 },
  });
  const message = await bus.message(W, good.seq);
  expect(message.headers.schema).toBe("order");
  expect(message.headers["schema-version"]).toBe("1");

  bus.bindSchema(W, "orders.>", "order", "warn");
  const warned = await bus.publish(W, {
    subject: "orders.created",
    body: { id: "a" },
  });
  expect((await bus.message(W, warned.seq)).headers["schema-invalid"]).toMatch(
    /missing required property 'total'/,
  );
  bus.close();
});

test("a message already in the log dead-letters rather than being dropped", async () => {
  const bus = store();
  bus.subscribe(W, {
    name: "orders",
    pattern: "orders.>",
    deliverFrom: "beginning",
    backoff: { baseMs: 0 },
  });
  // Published with no schema bound at all, which is how every message that
  // predates a registry got there.
  await bus.publish(W, { subject: "orders.created", body: { nonsense: true } });
  bus.registerSchema(W, "order", order, "backward");
  bus.bindSchema(W, "orders.>", "order", "enforce");

  expect(await bus.claim(W, "orders", "c1", 10)).toHaveLength(0);
  const dead = await bus.log(W, 0, 10, { subject: "dlq.orders" });
  expect(dead).toHaveLength(1);
  expect(dead[0]!.headers["dlq-reason"]).toBe("schema");
  bus.close();
});

test("the most specific binding wins", () => {
  const bus = store();
  bus.registerSchema(W, "loose", { type: "object" }, "none");
  bus.registerSchema(
    W,
    "strict",
    { type: "object", required: ["id"] },
    "none",
  );
  bus.bindSchema(W, "orders.>", "loose", "enforce");
  bus.bindSchema(W, "orders.eu.>", "strict", "enforce");
  expect(
    bus.validateAgainstSchema(W, "orders.eu.created", {})?.schema,
  ).toBe("strict");
  expect(bus.validateAgainstSchema(W, "orders.us.created", {})?.schema).toBe(
    "loose",
  );
  bus.close();
});

// ------------------------------------------------- client-side validation

test("a Standard Schema catches a bad body in the producer, with no dependency", async () => {
  const { BusClient, LocalValidationError } = await import("../src/client/bus");
  // Any Standard Schema library satisfies this shape. Hand-rolled here so the
  // test proves the *interface* is enough — which is the whole reason the bus
  // can offer this without depending on a validation library.
  const nonEmptyString = {
    "~standard": {
      version: 1 as const,
      vendor: "test",
      validate: (value: unknown) =>
        typeof value === "string" && value.length > 0
          ? { value }
          : { issues: [{ message: "expected a non-empty string", path: ["body"] }] },
    },
  };
  let calls = 0;
  const client = new BusClient({
    url: "http://example.invalid",
    token: "t",
    fetchImpl: (async () => {
      calls++;
      return new Response(JSON.stringify({ seq: 1, id: "x", duplicate: false, correlation: null }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });

  await expect(
    client.publish({ subject: "a.b", body: "", schema: nonEmptyString }),
  ).rejects.toThrow(LocalValidationError);
  // Nothing reached the network: the point is to fail where the stack trace is.
  expect(calls).toBe(0);

  expect((await client.publish({ subject: "a.b", body: "ok", schema: nonEmptyString })).seq).toBe(1);
  expect(calls).toBe(1);
});

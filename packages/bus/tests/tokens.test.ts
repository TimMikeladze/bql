import { expect, test } from "bun:test";
import {
  authorizeConsumer,
  authorizePublish,
  authorizeSubscribe,
  generateKey,
  mint,
  TokenError,
  verify,
} from "../src/bus/tokens";
import type { TokenClaims } from "../src/shared/protocol";

const key = generateKey();
const claims: TokenClaims = {
  sub: "resizer-1",
  scope: "consumer",
  workspace: "acme",
  publish: ["images.>", "audit.resized"],
  subscribe: ["images"],
  exp: 0,
};

test("a minted token verifies back to its claims", () => {
  const verified = verify(mint(claims, key), key);
  expect(verified).toMatchObject(claims);
  // Every token gets an id, because a credential nothing but key rotation can
  // withdraw is a credential you cannot withdraw.
  expect(verified.jti).toMatch(/^[0-9a-f-]{36}$/);
});

test("a token signed with another key is rejected", () => {
  expect(() => verify(mint(claims, generateKey()), key)).toThrow(TokenError);
});

test("a payload swapped onto another signature is rejected", () => {
  const real = mint(claims, key);
  const forged = mint({ ...claims, scope: "admin" }, generateKey());
  expect(() =>
    verify(`${forged.split(".")[0]}.${real.split(".")[1]}`, key),
  ).toThrow(TokenError);
});

test("an expired token is rejected", () => {
  expect(() => verify(mint({ ...claims, exp: 1 }, key), key)).toThrow(/expired/);
});

test("publish grants are subject patterns, not exact subjects", () => {
  expect(() => authorizePublish(claims, "images.thumb.created")).not.toThrow();
  expect(() => authorizePublish(claims, "audit.resized")).not.toThrow();
  expect(() => authorizePublish(claims, "billing.charge")).toThrow(/may not publish/);
  expect(() => authorizePublish(claims, "images")).toThrow(/may not publish/);
});

test("a consumer may only claim from the subscriptions it was granted", () => {
  expect(() => authorizeSubscribe(claims, "images")).not.toThrow();
  expect(() => authorizeSubscribe(claims, "billing")).toThrow(/may not consume/);
});

test("a consumer cannot act as another consumer", () => {
  expect(() => authorizeConsumer(claims, "resizer-1")).not.toThrow();
  expect(() => authorizeConsumer(claims, "resizer-2")).toThrow(/issued for/);
});

test("a reader may neither publish nor consume", () => {
  const reader: TokenClaims = { ...claims, scope: "reader" };
  expect(() => authorizePublish(reader, "images.x")).toThrow(/may not publish/);
  expect(() => authorizeSubscribe(reader, "images")).toThrow(/may not consume/);
});

test("an admin token bypasses subject and consumer scoping", () => {
  const admin: TokenClaims = {
    ...claims,
    scope: "admin",
    publish: [],
    subscribe: [],
  };
  expect(() => authorizePublish(admin, "anything.at.all")).not.toThrow();
  expect(() => authorizeSubscribe(admin, "whatever")).not.toThrow();
  expect(() => authorizeConsumer(admin, "someone-else")).not.toThrow();
});

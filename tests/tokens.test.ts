import { expect, test } from "bun:test";
import {
  authorizeRegistration,
  generateKey,
  mint,
  TokenError,
  verify,
} from "../src/broker/tokens";
import type { TokenClaims } from "../src/shared/protocol";

const key = generateKey();
const claims: TokenClaims = {
  sub: "worker-a",
  scope: "worker",
  runtimes: ["bun"],
  labels: { pool: "general" },
  exp: 0,
};

test("a minted token verifies back to its claims", () => {
  expect(verify(mint(claims, key), key)).toEqual(claims);
});

test("a token signed with another key is rejected", () => {
  expect(() => verify(mint(claims, generateKey()), key)).toThrow(TokenError);
});

test("a tampered payload is rejected", () => {
  const token = mint(claims, key);
  const forged = mint({ ...claims, scope: "admin" }, generateKey());
  expect(() =>
    verify(`${forged.split(".")[0]}.${token.split(".")[1]}`, key),
  ).toThrow(TokenError);
});

test("an expired token is rejected", () => {
  const expired = mint({ ...claims, exp: 1 }, key);
  expect(() => verify(expired, key)).toThrow(/expired/);
});

test("a worker may not register a runtime its token withholds", () => {
  expect(() =>
    authorizeRegistration(claims, "worker-a", ["bun", "shell"], {
      pool: "general",
    }),
  ).toThrow(/runtime 'shell'/);
});

test("a worker may not register under another worker's identity", () => {
  expect(() =>
    authorizeRegistration(claims, "worker-b", ["bun"], { pool: "general" }),
  ).toThrow(/issued for worker/);
});

test("a pinned label cannot be swapped", () => {
  expect(() =>
    authorizeRegistration(claims, "worker-a", ["bun"], { pool: "gpu" }),
  ).toThrow(/pins label/);
});

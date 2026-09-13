import { expect, test } from "bun:test";
import {
  assertPattern,
  assertSubject,
  matches,
  narrowingGlob,
  SubjectError,
} from "../src/bus/subjects";

test("a concrete subject may not contain wildcards", () => {
  expect(assertSubject("orders.eu.created")).toBe("orders.eu.created");
  expect(() => assertSubject("orders.*.created")).toThrow(SubjectError);
  expect(() => assertSubject("orders.>")).toThrow(SubjectError);
  expect(() => assertSubject("orders..created")).toThrow(SubjectError);
  expect(() => assertSubject("")).toThrow(SubjectError);
});

test("'>' is only legal as the final token", () => {
  expect(assertPattern("orders.>")).toBe("orders.>");
  expect(assertPattern("orders.*.created")).toBe("orders.*.created");
  expect(() => assertPattern("orders.>.created")).toThrow(SubjectError);
});

test("'*' matches exactly one token", () => {
  expect(matches("orders.*.created", "orders.eu.created")).toBe(true);
  expect(matches("orders.*.created", "orders.eu.west.created")).toBe(false);
  expect(matches("orders.*.created", "orders.created")).toBe(false);
});

test("'>' matches one or more trailing tokens, never zero", () => {
  expect(matches("orders.>", "orders.eu")).toBe(true);
  expect(matches("orders.>", "orders.eu.west.created")).toBe(true);
  expect(matches("orders.>", "orders")).toBe(false);
});

test("a literal pattern matches only itself", () => {
  expect(matches("work.bun", "work.bun")).toBe(true);
  expect(matches("work.bun", "work.bunny")).toBe(false);
  expect(matches("work.bun", "work.bun.slow")).toBe(false);
});

test("the narrowing glob never excludes a subject the pattern matches", () => {
  const cases: [string, string[]][] = [
    ["orders.*.created", ["orders.eu.created", "orders.us.created"]],
    ["orders.>", ["orders.a", "orders.a.b"]],
    ["work.bun", ["work.bun"]],
    ["*.created", ["orders.created", "users.created"]],
  ];
  for (const [pattern, subjects] of cases) {
    const glob = narrowingGlob(pattern);
    for (const subject of subjects) {
      expect(matches(pattern, subject)).toBe(true);
      // Bun's SQLite is the real evaluator; this mirrors GLOB prefix semantics.
      const prefix = glob.endsWith("*") ? glob.slice(0, -1) : glob;
      expect(subject.startsWith(prefix)).toBe(true);
    }
  }
});

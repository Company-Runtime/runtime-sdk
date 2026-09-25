import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, digest, jsonEqual, mergePatch, protocolBundle } from "../src/index.ts";

test("canonical JSON follows RFC 8785", () => {
  assert.equal(
    canonicalize({ b: [3, "x", null], a: { d: true, c: 1.5 } }),
    '{"a":{"c":1.5,"d":true},"b":[3,"x",null]}',
  );
  assert.equal(canonicalize({ é: 1, e: 2, "€": 3 }), '{"e":2,"é":1,"€":3}');
  assert.equal(canonicalize(1e21), "1e+21");
  assert.equal(canonicalize(0.000001), "0.000001");
  assert.equal(canonicalize({ skipped: undefined, kept: 0 }), '{"kept":0}');
});

test("digests are SHA-256 over canonical JSON, independent of key order", () => {
  assert.match(digest({ a: 1 }), /^sha256:[0-9a-f]{64}$/);
  assert.equal(digest({ a: 1, b: [1, 2] }), digest({ b: [1, 2], a: 1 }));
  assert.notEqual(digest({ a: 1 }), digest({ a: "1" }));
  assert.ok(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
});

test("JSON Merge Patch follows RFC 7396", () => {
  assert.deepEqual(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null, e: 4 }, f: [1] }), {
    a: 1,
    b: { d: 3, e: 4 },
    f: [1],
  });
  assert.deepEqual(mergePatch([1, 2], { a: 1 }), { a: 1 });
});

test("the protocol bundle is pinned to a runtime/0.1 commit", () => {
  assert.equal(protocolBundle.protocol, "runtime/0.1");
  assert.match(protocolBundle.source.commit, /^[0-9a-f]{40}$/);
  assert.ok(protocolBundle.registry.capabilities.length > 0);
});

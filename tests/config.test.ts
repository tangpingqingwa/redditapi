import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_DATABASE_PATH,
  DEFAULT_PORT,
  parseListenPort,
  resolveBootstrapKey,
  resolveDatabasePath,
} from "../src/config.js";

test("parseListenPort defaults unset and empty to 3000", () => {
  assert.equal(parseListenPort(undefined), DEFAULT_PORT);
  assert.equal(parseListenPort(""), DEFAULT_PORT);
  assert.equal(parseListenPort("8080"), 8080);
});

test("parseListenPort rejects non-integers and out-of-range ports", () => {
  assert.throws(() => parseListenPort("0"), /PORT must be an integer/);
  assert.throws(() => parseListenPort("abc"), /PORT must be an integer/);
  assert.throws(() => parseListenPort("70000"), /PORT must be an integer/);
  assert.throws(() => parseListenPort("3000.5"), /PORT must be an integer/);
});

test("resolveDatabasePath and bootstrap key treat empty as unset", () => {
  assert.equal(resolveDatabasePath(undefined), DEFAULT_DATABASE_PATH);
  assert.equal(resolveDatabasePath(""), DEFAULT_DATABASE_PATH);
  assert.equal(resolveDatabasePath("/tmp/redditapi.sqlite"), "/tmp/redditapi.sqlite");
  assert.equal(resolveBootstrapKey(undefined), undefined);
  assert.equal(resolveBootstrapKey(""), undefined);
  assert.equal(resolveBootstrapKey("rk_test_dev"), "rk_test_dev");
});

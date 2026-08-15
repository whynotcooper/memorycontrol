import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteJson, clampImportance, memoryRoot, newId, normPath,
  nowIso, parseDateInput, readJson,
} from "../lib/util.js";
import { writeFileSync } from "node:fs";

test("newId generates unique mem_ ids", () => {
  const a = newId();
  const b = newId();
  assert.match(a, /^mem_[0-9a-f]{16}$/);
  assert.notEqual(a, b);
});

test("normPath normalizes separators and resolves", () => {
  assert.equal(normPath("C:\\a\\b"), "C:/a/b");
  assert.equal(normPath("C:/a/b"), "C:/a/b");
  assert.equal(normPath(""), "");
  if (process.platform !== "win32") {
    assert.equal(normPath("/x/y"), "/x/y");
  }
});

test("memoryRoot honors root and DSH_HOME", () => {
  const old = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = "C:/custom/dsh";
    assert.equal(memoryRoot(""), join("C:/custom/dsh", "memory"));
    assert.equal(memoryRoot("D:/mem"), join("D:/mem"));
    assert.equal(memoryRoot("  "), join("C:/custom/dsh", "memory"));
  } finally {
    if (old === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = old;
  }
});

test("atomicWriteJson + readJson roundtrip", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-util-"));
  try {
    const file = join(dir, "entries.json");
    atomicWriteJson(file, { version: 1, entries: [{ id: "a" }] });
    const doc = readJson(file);
    assert.equal(doc.version, 1);
    assert.equal(doc.entries[0].id, "a");
    assert.equal(existsSync(file + ".tmp-"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJson returns null for missing/corrupt files", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-util2-"));
  try {
    assert.equal(readJson(join(dir, "nope.json")), null);
    writeFileSync(join(dir, "bad.json"), "{ not json", "utf8");
    assert.equal(readJson(join(dir, "bad.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clampImportance clamps into 1..5", () => {
  assert.equal(clampImportance(3), 3);
  assert.equal(clampImportance(9), 5);
  assert.equal(clampImportance(0), 1);
  assert.equal(clampImportance("4.6"), 5);
  assert.equal(clampImportance("x"), 3);
  assert.equal(clampImportance(undefined), 3);
});

test("parseDateInput handles ISO, dates, and relative offsets", () => {
  assert.equal(parseDateInput("2026-01-15"), "2026-01-15T00:00:00.000Z");
  assert.ok(Date.parse(parseDateInput("7d")) <= Date.now());
  assert.ok(Date.parse(parseDateInput("2w")) <= Date.now());
  assert.ok(Date.parse(parseDateInput("1mo")) <= Date.now());
  assert.ok(Date.parse(parseDateInput("1y")) <= Date.now());
  assert.equal(parseDateInput("garbage"), null);
  assert.equal(parseDateInput(""), null);
  assert.equal(parseDateInput(null), null);
  assert.ok(parseDateInput("2026-06-01", { endOfDay: true }).endsWith("T23:59:59.999Z"));
});

test("nowIso is ISO-parseable", () => {
  assert.ok(!Number.isNaN(Date.parse(nowIso())));
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hydratePersistedValue } from "../usePersistentState.js";

describe("hydratePersistedValue", () => {
  let removeItemSpy;
  let warnSpy;

  beforeEach(() => {
    globalThis.window = {
      localStorage: {
        removeItem: vi.fn(),
      },
    };
    removeItemSpy = globalThis.window.localStorage.removeItem;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    delete globalThis.window;
    warnSpy.mockRestore();
  });

  it("returns data when version matches", () => {
    const result = hydratePersistedValue(
      { v: 1, data: { foo: "bar" } },
      { foo: "default" },
      1
    );
    expect(result).toEqual({ foo: "bar" });
  });

  it("drops unversioned legacy payloads and falls back to default", () => {
    const result = hydratePersistedValue({ foo: "bar" }, { foo: "default" }, 1, {}, "tt.test");
    expect(result).toEqual({ foo: "default" });
    expect(removeItemSpy).toHaveBeenCalledWith("tt.test");
  });

  it("drops future-version payloads rather than guessing", () => {
    const result = hydratePersistedValue(
      { v: 99, data: { foo: "bar" } },
      { foo: "default" },
      1,
      {},
      "tt.test"
    );
    expect(result).toEqual({ foo: "default" });
    expect(removeItemSpy).toHaveBeenCalled();
  });

  it("walks migrations from old version to expected version", () => {
    const migrations = {
      1: (d) => ({ ...d, addedInV2: true }),
      2: (d) => ({ ...d, addedInV3: true }),
    };
    const result = hydratePersistedValue(
      { v: 1, data: { foo: "bar" } },
      {},
      3,
      migrations
    );
    expect(result).toEqual({ foo: "bar", addedInV2: true, addedInV3: true });
  });

  it("drops the entry when a required migration is missing", () => {
    const result = hydratePersistedValue(
      { v: 1, data: { foo: "bar" } },
      { foo: "default" },
      3,
      { 1: (d) => d }, // no migration from 2 → 3
      "tt.test"
    );
    expect(result).toEqual({ foo: "default" });
    expect(removeItemSpy).toHaveBeenCalled();
  });

  it("drops the entry when a migration throws", () => {
    const result = hydratePersistedValue(
      { v: 1, data: { foo: "bar" } },
      { foo: "default" },
      2,
      { 1: () => { throw new Error("boom"); } },
      "tt.test"
    );
    expect(result).toEqual({ foo: "default" });
    expect(removeItemSpy).toHaveBeenCalled();
  });

  it("drops payloads with non-numeric version", () => {
    const result = hydratePersistedValue(
      { v: "oops", data: {} },
      { foo: "default" },
      1,
      {},
      "tt.test"
    );
    expect(result).toEqual({ foo: "default" });
  });
});

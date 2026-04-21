import { useEffect, useRef, useState } from "react";

// Current persisted-state schema version. Bump whenever a key rename or
// shape change would make older saves incompatible.
//
// Migrations are functions (data) -> data that upgrade from version v to v+1.
// They live in the `migrations` option so call sites can opt in without the
// hook owning knowledge of each key's shape.
export const PERSIST_SCHEMA_VERSION = 1;

// useState wrapper that persists to localStorage and hydrates on mount.
// Stored payload shape: `{ v: <schemaVersion>, data: <value> }`. On read
// we:
//   - return the payload's `data` if `v === expectedVersion`
//   - run any provided migrations from `v` up to expectedVersion
//   - drop the entry and fall back to defaultValue if the payload is
//     malformed, unversioned (legacy), or unmigratable
//
// Silently falls back to the default on parse / storage errors.
export function usePersistentState(key, defaultValue, opts = {}) {
  const { version = PERSIST_SCHEMA_VERSION, migrations = {} } = opts;

  const [value, setValue] = useState(() => {
    if (typeof window === "undefined") return defaultValue;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null) return defaultValue;
      const parsed = JSON.parse(raw);
      return hydrate(parsed, defaultValue, version, migrations, key);
    } catch {
      return defaultValue;
    }
  });

  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    try {
      window.localStorage.setItem(
        key,
        JSON.stringify({ v: version, data: value })
      );
    } catch {
      /* storage quota / disabled — ignore */
    }
  }, [key, value, version]);

  function clear() {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    setValue(defaultValue);
  }

  return [value, setValue, clear];
}

// Exported for unit testing — the hook itself runs this via its useState init.
// Interpret a localStorage payload against the expected schema version.
// Unversioned payloads (pre-v1) are discarded rather than guessed at —
// that's the whole reason the schema version exists.
export function hydratePersistedValue(parsed, defaultValue, expectedVersion, migrations = {}, key = "") {
  return hydrate(parsed, defaultValue, expectedVersion, migrations, key);
}

function hydrate(parsed, defaultValue, expectedVersion, migrations, key) {
  const versioned =
    parsed && typeof parsed === "object" && "v" in parsed && "data" in parsed;
  if (!versioned) {
    dropStale(key, "unversioned");
    return defaultValue;
  }

  let { v, data } = parsed;
  if (typeof v !== "number") {
    dropStale(key, "non-numeric version");
    return defaultValue;
  }
  if (v === expectedVersion) return data;
  if (v > expectedVersion) {
    // Future version — safer to drop than to risk partial reads.
    dropStale(key, `newer version ${v} > ${expectedVersion}`);
    return defaultValue;
  }

  // Walk migrations v -> v+1 -> ... -> expectedVersion.
  try {
    while (v < expectedVersion) {
      const step = migrations[v];
      if (typeof step !== "function") {
        dropStale(key, `no migration from v${v} to v${v + 1}`);
        return defaultValue;
      }
      data = step(data);
      v += 1;
    }
    return data;
  } catch {
    dropStale(key, "migration threw");
    return defaultValue;
  }
}

function dropStale(key, reason) {
  try {
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
    console.warn(`[persist] dropping stale "${key}" (${reason})`);
  } catch {
    /* ignore */
  }
}

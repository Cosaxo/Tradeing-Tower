import { useEffect, useRef, useState } from "react";

// useState wrapper that persists to localStorage and hydrates on mount.
// Silently falls back to the default on parse / storage errors.
export function usePersistentState(key, defaultValue) {
  const [value, setValue] = useState(() => {
    if (typeof window === "undefined") return defaultValue;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null) return defaultValue;
      return JSON.parse(raw);
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
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage quota / disabled — ignore */
    }
  }, [key, value]);

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

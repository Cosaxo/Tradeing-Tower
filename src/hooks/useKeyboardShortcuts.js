import { useEffect } from "react";

// Global keybindings.
// handlers: { [key: string]: () => void }
// Ignores keystrokes while focus is inside text inputs / textareas / selects.
export function useKeyboardShortcuts(handlers) {
  useEffect(() => {
    function onKey(e) {
      const target = e.target;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        return;
      }

      const key = e.key === " " ? "Space" : e.key;
      const h = handlers[key] ?? handlers[key.toLowerCase()];
      if (h) {
        e.preventDefault();
        h(e);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlers]);
}

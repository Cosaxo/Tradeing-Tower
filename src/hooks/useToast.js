import { useState, useCallback } from "react";

let toastId = 0;

export function useToast() {
  const [toasts, setToasts] = useState([]);
  const [history, setHistory] = useState([]);

  const addToast = useCallback((message, type = "info", duration = 3500) => {
    const id = ++toastId;
    const entry = { id, message, type, at: Date.now() };
    setToasts((prev) => [...prev.slice(-4), entry]);
    setHistory((prev) => [...prev.slice(-99), entry]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, duration);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearHistory = useCallback(() => setHistory([]), []);

  return { toasts, history, addToast, removeToast, clearHistory };
}

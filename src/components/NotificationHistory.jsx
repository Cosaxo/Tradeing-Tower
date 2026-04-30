// Slide-out notification history panel.
import { useState } from "react";

const TYPE_COLOR = {
  error: "#f87171",
  warning: "#fbbf24",
  info: "#818cf8",
};

function formatTime(t) {
  const d = new Date(t);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}

export function NotificationHistory({ history = [], onClear }) {
  const [open, setOpen] = useState(false);
  const unreadCount = history.length;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="relative text-[10px] font-mono px-2 py-1 rounded border border-gray-700 bg-gray-800 text-gray-400 hover:text-gray-200 hover:border-gray-500 hover:bg-gray-700 transition-colors"
        title="Notification history"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
      >
        bell
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 text-[8px] font-mono px-1 rounded-full bg-indigo-500 text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50"
          onClick={() => setOpen(false)}
        >
          <aside
            onClick={(e) => e.stopPropagation()}
            className="absolute top-0 right-0 h-full w-80 border-l border-gray-800 bg-gray-950 p-3 flex flex-col gap-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-gray-300">Notifications</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={onClear}
                  className="text-[10px] font-mono text-gray-500 hover:text-gray-300 transition-colors"
                >
                  clear
                </button>
                <button
                  onClick={() => setOpen(false)}
                  className="text-[10px] font-mono text-gray-500 hover:text-gray-200 px-2 py-0.5 rounded hover:bg-gray-800 transition-colors"
                  aria-label="Close notifications"
                >
                  ×
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto flex flex-col gap-1">
              {history.length === 0 && (
                <span className="text-[10px] font-mono text-gray-600">No notifications yet.</span>
              )}
              {[...history].reverse().map((t) => (
                <div
                  key={t.id}
                  className="flex flex-col gap-0.5 rounded border border-gray-800 bg-gray-900 px-2 py-1"
                >
                  <div className="flex items-center justify-between">
                    <span
                      className="text-[9px] font-mono uppercase"
                      style={{ color: TYPE_COLOR[t.type] ?? "#9ca3af" }}
                    >
                      {t.type}
                    </span>
                    <span className="text-[9px] font-mono text-gray-600">
                      {formatTime(t.at)}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-gray-200">{t.message}</span>
                </div>
              ))}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

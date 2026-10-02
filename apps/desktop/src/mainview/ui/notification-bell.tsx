import React, { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Bell } from "lucide-react";

import type { Notification } from "@jittle-lamp/shared";

import { deepLinkTargetPath } from "../../deep-link";
import { notificationTarget } from "../test-runs/live-run";
import { testQueryKeys, useNotifications, useTestApi } from "../test-runs/test-api-context";
import { formatRelativeTime } from "../utils";

// In-app notification channel (design.md §10b): unread count, list, mark read, open the run.

export function NotificationBell(): React.JSX.Element {
  const api = useTestApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const notificationsQuery = useNotifications();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const items = notificationsQuery.data?.items ?? [];
  const unread = notificationsQuery.data?.unread ?? 0;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const refreshList = (): void => {
    void queryClient.invalidateQueries({ queryKey: testQueryKeys.notifications() });
  };

  const openNotification = async (notification: Notification): Promise<void> => {
    const target = notificationTarget(notification);
    if (notification.readAt === null) {
      // Optimistic: the bell clears at once; a failed write comes back on the next poll.
      queryClient.setQueryData(testQueryKeys.notifications(), (previous: typeof notificationsQuery.data) =>
        previous
          ? {
              unread: Math.max(0, previous.unread - 1),
              items: previous.items.map((item) => (item.id === notification.id ? { ...item, readAt: Date.now() } : item))
            }
          : previous
      );
      void api.markNotificationRead(notification.id).catch(refreshList);
    }
    if (target) {
      setOpen(false);
      navigate(deepLinkTargetPath(target));
    }
  };

  const markAll = async (): Promise<void> => {
    try {
      await api.markAllNotificationsRead();
    } finally {
      refreshList();
    }
  };

  return (
    <div className="bell" ref={rootRef}>
      <button
        type="button"
        className="button ghost sm icon-only bell-button"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) refreshList();
        }}
      >
        <Bell aria-hidden size={15} strokeWidth={2} />
        {unread > 0 ? <span className="bell-badge">{unread > 99 ? "99+" : unread}</span> : null}
      </button>
      {open ? (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="bell-panel-header">
            <span className="card-title">Notifications</span>
            <button className="button ghost xs" type="button" onClick={() => void markAll()} disabled={unread === 0}>
              Mark all read
            </button>
          </div>
          {notificationsQuery.error ? (
            <p className="bell-empty auth-error">
              {notificationsQuery.error instanceof Error ? notificationsQuery.error.message : "Unable to load notifications."}
            </p>
          ) : items.length === 0 ? (
            <p className="bell-empty muted">{notificationsQuery.isLoading ? "Loading…" : "Nothing yet. Finished and blocked runs show up here."}</p>
          ) : (
            <ul className="bell-list">
              {items.map((notification) => (
                <li key={notification.id}>
                  <button
                    type="button"
                    className="bell-item"
                    data-unread={notification.readAt === null}
                    data-kind={notification.kind}
                    onClick={() => void openNotification(notification)}
                  >
                    <span className="bell-item-dot" aria-hidden />
                    <span className="bell-item-body">
                      <span className="bell-item-title">{notification.title}</span>
                      {notification.body ? <span className="bell-item-text">{notification.body}</span> : null}
                      <span className="bell-item-time">{formatRelativeTime(notification.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

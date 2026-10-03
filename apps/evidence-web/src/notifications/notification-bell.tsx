import React, { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, Check, CheckCheck } from "lucide-react";
import { useNavigate } from "react-router";
import type { Notification } from "@jittle-lamp/shared";

import { cn } from "../lib/cn";
import { formatRelativeTime } from "../utils";
import { testAdminApi } from "../test-cases/admin-api";
import { testAdminKeys, useActiveOrgId, useNotifications, useTestAdminMutation } from "../test-cases/admin-queries";
import { pressable } from "../test-cases/admin-ui";
import { bellAccessibleName, notificationHref, unreadBadgeLabel } from "./notification-links";
import { Hint } from "../components/ui/tooltip";

// In-app notification bell for the workspace header (design.md §10b). Polls every 30 s.

type ListData = { items: Notification[]; unread: number };

export type NotificationTriggerState = { unread: number; badge: string | null; label: string };

export function NotificationBell(props: {
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  // Receives an unstyled Popover trigger element to use as a `render` target.
  children?: (trigger: React.ReactElement, state: NotificationTriggerState) => React.ReactNode;
} = {}): React.JSX.Element {
  const navigate = useNavigate();
  const orgId = useActiveOrgId();
  const queryClient = useQueryClient();
  const notifications = useNotifications();
  const [open, setOpen] = useState(false);
  const unread = notifications.data?.unread ?? 0;
  const items = notifications.data?.items ?? [];
  const badge = unreadBadgeLabel(unread);

  const markRead = useTestAdminMutation((getToken, body: { ids: string[] } | { all: true }) => testAdminApi.markNotificationsRead(getToken, body), [testAdminKeys.notifications]);

  const optimisticRead = (ids: string[] | "all") => {
    const now = Date.now();
    queryClient.setQueryData(testAdminKeys.notifications(orgId), (current: ListData | undefined) => {
      if (!current) return current;
      const marked = current.items.map((item) => (item.readAt === null && (ids === "all" || ids.includes(item.id)) ? { ...item, readAt: now } : item));
      const newlyRead = current.items.filter((item, index) => item.readAt === null && marked[index]?.readAt !== null).length;
      return { items: marked, unread: ids === "all" ? 0 : Math.max(0, current.unread - newlyRead) };
    });
    void markRead.mutateAsync(ids === "all" ? { all: true } : { ids }).catch(() => undefined);
  };

  const openItem = (item: Notification) => {
    if (item.readAt === null) optimisticRead([item.id]);
    const href = notificationHref(item, window.location.origin);
    setOpen(false);
    if (href) navigate(href);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {props.children ? (
        props.children(<Popover.Trigger />, { unread, badge, label: bellAccessibleName(unread) })
      ) : (
        <Popover.Trigger
          aria-label={bellAccessibleName(unread)}
          title="Notifications"
          className={cn("relative grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4", pressable)}
        >
          <Bell aria-hidden />
          {badge ? (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-white tabular-nums"
            >
              {badge}
            </span>
          ) : null}
        </Popover.Trigger>
      )}
      <Popover.Portal>
        <Popover.Positioner className="z-[960]" side={props.side ?? "bottom"} align={props.align ?? "end"} sideOffset={8}>
          <Popover.Popup
            className={cn(
              "w-[min(24rem,calc(100vw-1.5rem))] origin-[var(--transform-origin)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-pop outline-none",
              "transition-[opacity,transform] duration-200 ease-[cubic-bezier(.23,1,.32,1)] data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 motion-reduce:transition-none"
            )}
          >
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <Popover.Title className="text-[13px] font-semibold">Inbox</Popover.Title>
              <button
                type="button"
                className={cn("inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50", pressable)}
                disabled={unread === 0}
                onClick={() => optimisticRead("all")}
              >
                <CheckCheck className="size-3.5" aria-hidden />
                Mark all read
              </button>
            </div>
            {notifications.isError ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">Notifications are unavailable right now.</p>
            ) : items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">{notifications.isPending ? "Loading…" : "You are all caught up."}</p>
            ) : (
              <ul className="jl-scroll max-h-[min(28rem,70vh)] overflow-y-auto py-1" aria-label="Recent notifications">
                {items.map((item) => {
                  const isUnread = item.readAt === null;
                  return (
                    <li key={item.id} className={cn("group relative flex items-start gap-2 px-2", isUnread && "bg-primary/5")}>
                      <button
                        type="button"
                        onClick={() => openItem(item)}
                        className="flex min-w-0 flex-1 items-start gap-3 rounded-md px-2 py-2.5 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                      >
                        <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", isUnread ? "bg-primary" : "bg-transparent")} aria-hidden />
                        <span className="min-w-0">
                          <span className={cn("block text-sm text-foreground", isUnread && "font-semibold")}>
                            {item.title}
                            {isUnread ? <span className="sr-only"> (unread)</span> : null}
                          </span>
                          {item.body ? <span className="mt-0.5 block text-sm text-muted-foreground line-clamp-2">{item.body}</span> : null}
                          <time className="mt-0.5 block text-xs text-muted-foreground" dateTime={new Date(item.createdAt).toISOString()}>
                            {formatRelativeTime(item.createdAt)}
                          </time>
                        </span>
                      </button>
                      {isUnread ? (
                        <Hint label="Mark as read" side="left">
                          <button
                            type="button"
                            aria-label={`Mark “${item.title}” as read`}
                            className={cn("mt-2 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground", pressable)}
                            onClick={() => optimisticRead([item.id])}
                          >
                            <Check className="size-4" aria-hidden />
                          </button>
                        </Hint>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

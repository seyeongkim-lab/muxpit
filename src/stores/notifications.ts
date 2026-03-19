import { create } from "zustand";

export interface Notification {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  timestamp: number;
  read: boolean;
}

interface NotificationState {
  notifications: Notification[];
  panelOpen: boolean;

  addNotification: (wsId: string, title: string, body: string) => void;
  markRead: (wsId: string) => void;
  clearAll: () => void;
  togglePanel: () => void;
  setPanel: (open: boolean) => void;
  unreadCount: (wsId: string) => number;
}

let notifCounter = 0;

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  panelOpen: false,

  addNotification: (wsId, title, body) => {
    const notif: Notification = {
      id: `notif-${Date.now()}-${notifCounter++}`,
      workspaceId: wsId,
      title,
      body,
      timestamp: Date.now(),
      read: false,
    };
    set((s) => ({
      notifications: [notif, ...s.notifications].slice(0, 100),
    }));
  },

  markRead: (wsId) => {
    set((s) => ({
      notifications: s.notifications.map((n) =>
        n.workspaceId === wsId ? { ...n, read: true } : n,
      ),
    }));
  },

  clearAll: () => set({ notifications: [] }),

  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setPanel: (open) => set({ panelOpen: open }),

  unreadCount: (wsId) => {
    return get().notifications.filter(
      (n) => n.workspaceId === wsId && !n.read,
    ).length;
  },
}));

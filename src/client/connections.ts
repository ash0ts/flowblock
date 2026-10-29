import { create } from "zustand";
import {
  persist,
  createJSONStorage,
  type StateStorage,
} from "zustand/middleware";
import { get, set, del } from "idb-keyval";

export type ShareLink = {
  token: string;
  url: string;
  planId: string;
  name: string;
  createdAt: string;
};
export type ProjectBinding = { projectId: string; versionId: string };
const storage: StateStorage = {
  getItem: async (name) => {
    try {
      return (await get<string>(name)) ?? null;
    } catch {
      return null;
    }
  },
  setItem: async (name, value) => {
    try {
      await set(name, value);
    } catch {
      if (typeof window !== "undefined")
        window.dispatchEvent(new Event("flowblock-storage-error"));
    }
  },
  removeItem: async (name) => {
    await del(name);
  },
};
type Connections = {
  shares: ShareLink[];
  bindings: Record<string, ProjectBinding>;
  addShare: (link: ShareLink) => void;
  removeShare: (token: string) => void;
  bind: (recipeId: string, binding: ProjectBinding) => void;
};
export const useConnections = create<Connections>()(
  persist(
    (setState) => ({
      shares: [],
      bindings: {},
      addShare: (link) =>
        setState((state) => ({ shares: [link, ...state.shares] })),
      removeShare: (token) =>
        setState((state) => ({
          shares: state.shares.filter((link) => link.token !== token),
        })),
      bind: (recipeId, binding) =>
        setState((state) => ({
          bindings: { ...state.bindings, [recipeId]: binding },
        })),
    }),
    {
      name: "flowblock-connections-v1",
      storage: createJSONStorage(() => storage),
      skipHydration: true,
    },
  ),
);

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { z } from "zod";
import { validatedStorage } from "./storage";

export type ShareLink = {
  token: string;
  url: string;
  planId: string;
  name: string;
  createdAt: string;
};
export type ProjectBinding = { projectId: string; versionId: string };
const storage = validatedStorage(
  z.object({
    shares: z.array(
      z.object({
        token: z.string(),
        url: z.string(),
        planId: z.string(),
        name: z.string(),
        createdAt: z.string(),
      }),
    ),
    bindings: z.record(
      z.string(),
      z.object({ projectId: z.string(), versionId: z.string() }),
    ),
  }),
);

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
      partialize: ({ shares, bindings }) => ({ shares, bindings }),
    },
  ),
);

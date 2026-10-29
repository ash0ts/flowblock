import { del, get, set } from "idb-keyval";
import type { StateStorage } from "zustand/middleware";
import type { z } from "zod";

let pendingWrites = 0;
const subscribers = new Set<() => void>();
export const getPendingWrites = () => pendingWrites;
export function subscribeStorage(listener: () => void) {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

async function write(operation: () => Promise<unknown>) {
  pendingWrites++;
  subscribers.forEach((notify) => notify());
  try {
    await operation();
  } catch {
    report("error");
  } finally {
    pendingWrites--;
    subscribers.forEach((notify) => notify());
  }
}

function report(name: "error" | "recovered") {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(`flowblock-storage-${name}`));
}

// Stored JSON can outlive the build that wrote it. Validate before Zustand merges
// it, including stripping unknown keys so stored data cannot replace actions.
export function validatedStorage(schema: z.ZodType): StateStorage {
  return {
    async getItem(name) {
      try {
        const raw = await get<string>(name);
        if (raw == null) return null;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          report("recovered");
          return null;
        }
        const result = schema.safeParse(parsed?.state);
        if (!result.success || parsed.version !== 0) {
          report("recovered");
          return null;
        }
        return JSON.stringify({ state: result.data, version: 0 });
      } catch {
        report("error");
        return null;
      }
    },
    async setItem(name, value) {
      await write(() => set(name, value));
    },
    async removeItem(name) {
      await write(() => del(name));
    },
  };
}

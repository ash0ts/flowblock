import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { z } from "zod";
import { validatedStorage } from "./storage";
import { PlanVersionSchema } from "@/domain/contracts";
import { TakeAnalysisSchema } from "@/domain/take-analysis";
import type { PlanVersion } from "@/domain/contracts";
import type { TakeAnalysis } from "@/domain/take-analysis";

export type ProductAnnotation = {
  timeSeconds: number;
  box: { x: number; y: number; width: number; height: number };
};
export type SavedAttempt = {
  id: string;
  name: string;
  createdAt: string;
  plan: PlanVersion;
  takeId: string | null;
  duration: number;
  ratio: number;
  uploadComplete?: boolean;
  analysis: TakeAnalysis | null;
  seed: ProductAnnotation | null;
  corrections: ProductAnnotation[];
  expectedStart: number;
  expectedEnd: number;
  revised: boolean;
};
const annotationSchema = z.object({
  timeSeconds: z.number().finite().min(0).max(60),
  box: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  }),
});
const storage = validatedStorage(
  z.object({
    attempts: z
      .array(
        z.object({
          id: z.string().min(1),
          name: z.string(),
          createdAt: z.string(),
          plan: PlanVersionSchema,
          takeId: z.string().nullable(),
          duration: z.number().finite().nonnegative(),
          ratio: z.number().positive(),
          uploadComplete: z.boolean().optional(),
          analysis: TakeAnalysisSchema.nullable(),
          seed: annotationSchema.nullable(),
          corrections: z.array(annotationSchema).max(4),
          expectedStart: z.number().finite().nonnegative(),
          expectedEnd: z.number().finite().nonnegative(),
          revised: z.boolean(),
        }),
      )
      .max(12),
  }),
);

type TakeHistory = {
  attempts: SavedAttempt[];
  save: (attempt: SavedAttempt) => void;
  remove: (id: string) => void;
};
export const useTakeHistory = create<TakeHistory>()(
  persist(
    (setState) => ({
      attempts: [],
      save: (attempt) =>
        setState((state) => ({
          attempts: [
            ...state.attempts.filter((item) => item.id !== attempt.id),
            attempt,
          ]
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .slice(-12),
        })),
      remove: (id) =>
        setState((state) => ({
          attempts: state.attempts.filter((item) => item.id !== id),
        })),
    }),
    {
      name: "flowblock-takes-v1",
      storage: createJSONStorage(() => storage),
      skipHydration: true,
      partialize: ({ attempts }) => ({ attempts }),
    },
  ),
);

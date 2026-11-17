import { describe, expect, it } from "vitest";
import { teacherRows } from "../training/experiments/next/build";
import { createTasks } from "../training/experiments/next/fixtures";
import { actionSchema } from "../training/experiments/next/planner";

describe("next-action training curriculum", () => {
  it("teaches repairs without labeling the deliberately invalid compile as a good initial action", () => {
    const tasks = createTasks("train", 2, 99123);
    const teachers = tasks.map(teacherRows);
    const repaired = teachers.find((result) =>
      result.labels.some((label) => label.type === "failed-compile-repair"),
    );
    expect(repaired).toBeDefined();
    const index = repaired!.labels.findIndex(
      (label) => label.type === "failed-compile-repair",
    );
    const messages = repaired!.rows[index].messages;
    expect(
      JSON.parse(messages.at(-2)!.content).observation.validation.valid,
    ).toBe(false);
    expect(JSON.parse(messages.at(-1)!.content).action).toBe(
      "compile_candidate",
    );
    for (const result of teachers)
      for (const row of result.rows) {
        expect(
          actionSchema.safeParse(JSON.parse(row.messages.at(-1)!.content))
            .success,
        ).toBe(true);
        if (row.messages.length === 3)
          expect(JSON.parse(row.messages.at(-1)!.content).action).toBe(
            "compile_candidate",
          );
      }
  });
  it("requires a checked candidate before a hard-constraint abstention", () => {
    const tripod = createTasks("train", 8, 99123).find(
      (task) =>
        task.input.gear.stabilizer === "tripod" &&
        task.briefSpec.family === "push-in",
    )!;
    const result = teacherRows(tripod);
    expect(result.status).toBe("hard-constraint");
    expect(result.rows).toHaveLength(2);
    const messages = result.rows[1].messages;
    expect(JSON.parse(messages[2].content).action).toBe("compile_candidate");
    expect(JSON.parse(messages[3].content).observation.validation.valid).toBe(
      false,
    );
    expect(JSON.parse(messages[4].content)).toMatchObject({
      action: "finish",
      candidateIds: [],
    });
  });
});

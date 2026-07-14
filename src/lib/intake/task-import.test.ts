import { describe, expect, it } from "vitest";
import { importTasks } from "./task-import";

describe("mission task intake", () => {
  it("imports a plain one-task-per-line list", () => {
    const result = importTasks("Fix login\nAdd billing\nShip docs");
    expect(result.source).toBe("text");
    expect(result.tasks.map((task) => task.title)).toEqual([
      "Fix login",
      "Add billing",
      "Ship docs",
    ]);
  });

  it("extracts markdown ids, priorities, roles, dependencies and acceptance", () => {
    const result = importTasks(`
# Release
- [ ] [T-1] P0 @security Harden auth
  AC: forged tokens are rejected
- [ ] [T-2] P1 @tester Regression suite; depends: T-1
`);
    expect(result.source).toBe("markdown");
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toMatchObject({
      externalId: "T-1",
      title: "Harden auth",
      priority: 100,
      role: "security",
      acceptanceCriteria: ["forged tokens are rejected"],
    });
    expect(result.tasks[1].dependencyRefs).toEqual(["T-1"]);
  });

  it("parses quoted CSV fields and reports empty rows", () => {
    const result = importTasks(
      'id,title,description,priority,dependencies,acceptance\nT1,"API, v2",Ship it,high,,tests pass\nT2,,missing,low,T1,',
    );
    expect(result.source).toBe("csv");
    expect(result.tasks[0]).toMatchObject({
      externalId: "T1",
      title: "API, v2",
      priority: 80,
      acceptanceCriteria: ["tests pass"],
    });
    expect(result.warnings[0]).toContain("Row 3");
  });

  it("imports JSON exports without trusting unknown fields", () => {
    const result = importTasks(
      JSON.stringify({
        tasks: [
          {
            key: "GH-9",
            name: "Fix checkout",
            priority: 72,
            labels: ["bug", "payments"],
            dependencies: ["GH-1"],
          },
        ],
      }),
    );
    expect(result.source).toBe("json");
    expect(result.tasks[0]).toMatchObject({
      externalId: "GH-9",
      title: "Fix checkout",
      priority: 72,
      labels: ["bug", "payments"],
      dependencyRefs: ["GH-1"],
    });
  });

  it("caps bulk imports without silently accepting unlimited work", () => {
    const input = Array.from({ length: 550 }, (_, index) => `Task ${index}`).join("\n");
    const result = importTasks(input);
    expect(result.tasks).toHaveLength(500);
    expect(result.warnings.join(" ")).toContain("first 500");
  });
});

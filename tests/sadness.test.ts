import { describe, expect, test } from "bun:test";
import { sadness } from "../src/collect.ts";
import { pod } from "./helpers.ts";

describe("sadness", () => {
  test("CrashLoopBackOff conta mesmo com outro container ainda em ContainerCreating", () => {
    const p = pod({
      containers: [{ name: "sidecar" }, { name: "app" }],
      statuses: [
        { name: "sidecar", ready: false, state: { waiting: { reason: "ContainerCreating" } } },
        { name: "app", ready: false, restartCount: 7, state: { waiting: { reason: "CrashLoopBackOff" } } },
      ],
    });
    expect(sadness(p)).toBe(70);
  });

  test("só ContainerCreating não conta como espera triste", () => {
    const p = pod({
      statuses: [{ ready: false, state: { waiting: { reason: "ContainerCreating" } } }],
    });
    expect(sadness(p)).toBe(50);
  });
});

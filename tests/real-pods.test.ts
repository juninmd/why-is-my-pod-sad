import { describe, expect, test } from "bun:test";
import { sadness } from "../src/collect.ts";
import { analyze } from "../src/rules.ts";
import { analyzeService } from "../src/service-rules.ts";
import type { ServiceSnapshot } from "../src/service-types.ts";
import type { Pod } from "../src/types.ts";
import completed from "./fixtures/real-completed.json" with { type: "json" };
import running from "./fixtures/real-running.json" with { type: "json" };
import realService from "./fixtures/real-service.json" with { type: "json" };

/**
 * Snapshots reais do cluster k3s: a garantia de que o analisador não grita
 * com pod saudável nem com Job que terminou com sucesso.
 */
describe("pods reais do cluster", () => {
  test("pod Running e Ready não é apontado como problema", () => {
    const pod = running as unknown as Pod;
    const findings = analyze({ pod, events: [], logs: {} });
    expect(findings.every((f) => f.severity === "info")).toBe(true);
    expect(sadness(pod)).toBe(0);
  });

  test("pod de Job que completou com exit 0 não vira falso positivo", () => {
    const pod = completed as unknown as Pod;
    const findings = analyze({ pod, events: [], logs: {} });
    expect(findings.some((f) => f.severity === "critical")).toBe(false);
    expect(findings.some((f) => f.id === "terminated-error")).toBe(false);
  });

  test("Service real com endpoint e ingress não vira falso positivo", () => {
    const findings = analyzeService(realService as unknown as ServiceSnapshot);
    expect(findings.map((f) => f.id)).toEqual(["healthy"]);
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../src/rules.ts";
import type { PodSnapshot } from "../src/types.ts";
import { ids, pod } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "wimps-kubectl-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs collect() in a child process whose PATH has a fake kubectl (Bun resolves PATH at startup). */
function collectWithKubectl(script: string): PodSnapshot {
  writeFileSync(join(dir, "kubectl"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, "kubectl"), 0o755);
  const runner = join(dir, "run.ts");
  writeFileSync(
    runner,
    `import { collect } from ${JSON.stringify(join(import.meta.dir, "../src/collect.ts"))};
     const p = ${JSON.stringify(pod({ statuses: [{}] }))};
     console.log(JSON.stringify(await collect(p, {}, { tail: 50, logs: true })));`,
  );
  const run = Bun.spawnSync([process.execPath, runner], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  return JSON.parse(run.stdout.toString()) as PodSnapshot;
}

describe("eventos/logs que o kubectl não conseguiu ler", () => {
  test("RBAC negado vira aviso de diagnóstico incompleto, não 'pod está bem'", () => {
    const snap = collectWithKubectl(
      "echo 'Error from server (Forbidden): User \"dev\" cannot list resource' >&2; exit 1",
    );
    expect(snap.unavailable?.map((u) => u.split(":")[0])).toEqual(["eventos", "logs de app"]);
    const found = analyze(snap);
    expect(ids(found)).toContain("data-unavailable");
    expect(ids(found)).not.toContain("healthy");
    expect(found[0]?.id).toBe("data-unavailable");
  });

  test("container sem log anterior não conta como dado indisponível", () => {
    const snap = collectWithKubectl(
      'case "$*" in *events*) echo \'{"items":[]}\';; *--previous*) echo \'previous terminated container "app" not found\' >&2; exit 1;; *) echo ok;; esac',
    );
    expect(snap.unavailable).toBeUndefined();
    expect(snap.logs.app?.current).toBe("ok\n");
  });
});

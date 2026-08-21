import { describe, expect, test } from "bun:test";
import { analyze } from "../src/rules.ts";
import type { Finding } from "../src/types.ts";
import { event, ids, pod, snapshot } from "./helpers.ts";

const find = (findings: Finding[], id: string) => findings.find((f) => f.id === id);

describe("pod saudável", () => {
  test("não inventa problema", () => {
    const f = analyze(
      snapshot(
        pod({
          containers: [{ name: "app", resources: { limits: { memory: "256Mi" } } }],
          statuses: [{ name: "app", ready: true }],
        }),
      ),
    );
    expect(ids(f)).toEqual(["healthy"]);
  });

  test("aponta ausência de requests/limits como info, não como crítico", () => {
    const f = analyze(snapshot(pod({ statuses: [{ name: "app", ready: true }] })));
    expect(ids(f)).toEqual(["no-resources"]);
    expect(f[0]?.severity).toBe("info");
  });
});

describe("scheduling", () => {
  test("Insufficient cpu vira dica sobre requests", () => {
    const f = analyze(
      snapshot(pod({ phase: "Pending", nodeName: null }), [
        event("FailedScheduling", "0/3 nodes are available: 3 Insufficient cpu."),
      ]),
    );
    const finding = find(f, "pending-unschedulable");
    expect(finding?.severity).toBe("critical");
    expect(finding?.hint).toContain("requests.cpu");
  });

  test("taint sem toleration", () => {
    const f = analyze(
      snapshot(pod({ phase: "Pending", nodeName: null }), [
        event("FailedScheduling", "0/1 nodes are available: 1 node(s) had untolerated taint {a: b}."),
      ]),
    );
    expect(find(f, "pending-unschedulable")?.hint).toContain("toleration");
  });

  test("PVC não ligado cita o claim", () => {
    const f = analyze(
      snapshot(
        pod({
          phase: "Pending",
          nodeName: null,
          volumes: [{ name: "data", persistentVolumeClaim: { claimName: "meu-pvc" } }],
        }),
        [event("FailedScheduling", "pod has unbound immediate PersistentVolumeClaims")],
      ),
    );
    expect(find(f, "pending-unschedulable")?.hint).toContain("meu-pvc");
  });

  test("sem evento de scheduling ainda reporta o pod parado", () => {
    const f = analyze(snapshot(pod({ phase: "Pending", nodeName: null })));
    expect(find(f, "pending-unschedulable")?.hint).toContain("kube-scheduler");
  });
});

describe("imagem", () => {
  test("401 sem imagePullSecrets manda criar o secret", () => {
    const f = analyze(
      snapshot(
        pod({
          containers: [{ name: "app", image: "ghcr.io/juninmd/app:1" }],
          statuses: [
            {
              name: "app",
              ready: false,
              image: "ghcr.io/juninmd/app:1",
              state: {
                waiting: { reason: "ImagePullBackOff", message: "unauthorized: authentication required" },
              },
            },
          ],
        }),
      ),
    );
    const finding = find(f, "image-pull");
    expect(finding?.severity).toBe("critical");
    expect(finding?.hint).toContain("docker-registry");
  });

  test("401 com secret aponta escopo do token", () => {
    const f = analyze(
      snapshot(
        pod({
          imagePullSecrets: ["ghcr-cred"],
          statuses: [
            {
              name: "app",
              ready: false,
              image: "ghcr.io/juninmd/app:1",
              state: { waiting: { reason: "ErrImagePull", message: "denied" } },
            },
          ],
        }),
      ),
    );
    expect(find(f, "image-pull")?.hint).toContain("read:packages");
  });

  test("manifest unknown = tag inexistente", () => {
    const f = analyze(
      snapshot(
        pod({
          statuses: [
            {
              name: "app",
              ready: false,
              image: "app:99",
              state: { waiting: { reason: "ErrImagePull", message: "manifest unknown" } },
            },
          ],
        }),
      ),
    );
    expect(find(f, "image-pull")?.hint).toContain("não existe no registry");
  });
});

describe("crash", () => {
  test("OOMKilled com limite cita o limite e traz o log anterior", () => {
    const f = analyze(
      snapshot(
        pod({
          containers: [{ name: "app", resources: { limits: { memory: "128Mi" } } }],
          statuses: [
            {
              name: "app",
              ready: false,
              restartCount: 3,
              state: { waiting: { reason: "CrashLoopBackOff" } },
              lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } },
            },
          ],
        }),
        [],
        { app: { previous: "linha1\nlinha2\nheap out of memory" } },
      ),
    );
    const oom = find(f, "oom-killed");
    expect(oom?.detail).toContain("128Mi");
    expect(oom?.evidence).toContain("heap out of memory");
    expect(find(f, "crashloop")).toBeDefined();
  });

  test("OOMKilled sem limite explica o risco para o nó", () => {
    const f = analyze(
      snapshot(
        pod({
          statuses: [
            {
              name: "app",
              ready: false,
              lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } },
              state: { waiting: { reason: "CrashLoopBackOff" } },
            },
          ],
        }),
      ),
    );
    expect(find(f, "oom-killed")?.detail).toContain("Sem limits.memory");
  });

  test("exit 0 em loop aponta ENTRYPOINT que não segura o processo", () => {
    const f = analyze(
      snapshot(
        pod({
          statuses: [
            {
              name: "app",
              ready: false,
              state: { waiting: { reason: "CrashLoopBackOff" } },
              lastState: { terminated: { exitCode: 0 } },
            },
          ],
        }),
      ),
    );
    expect(find(f, "crashloop")?.hint).toContain("foreground");
  });

  test("exit 127 é traduzido", () => {
    const f = analyze(
      snapshot(
        pod({
          statuses: [
            {
              name: "app",
              ready: false,
              state: { waiting: { reason: "CrashLoopBackOff" } },
              lastState: { terminated: { exitCode: 127 } },
            },
          ],
        }),
      ),
    );
    expect(find(f, "crashloop")?.detail).toContain("comando não encontrado");
  });

  test("secret faltando em CreateContainerConfigError", () => {
    const f = analyze(
      snapshot(
        pod({
          statuses: [
            {
              name: "app",
              ready: false,
              state: {
                waiting: {
                  reason: "CreateContainerConfigError",
                  message: 'secret "api-keys" not found',
                },
              },
            },
          ],
        }),
      ),
    );
    expect(find(f, "config-error")?.hint).toContain('secret "api-keys"');
  });
});

describe("probes", () => {
  test("readiness reprovando em container rodando", () => {
    const f = analyze(
      snapshot(
        pod({
          containers: [
            {
              name: "app",
              ports: [{ containerPort: 8080 }],
              readinessProbe: { httpGet: { port: 8080, path: "/health" } },
            },
          ],
          statuses: [{ name: "app", ready: false, state: { running: { startedAt: "x" } } }],
        }),
        [event("Unhealthy", "Readiness probe failed: HTTP probe failed with statuscode: 503", 40)],
      ),
    );
    const r = find(f, "readiness-failing");
    expect(r?.severity).toBe("critical");
    expect(r?.detail).toContain("8080/health");
  });

  test("liveness matando sem startupProbe sugere startupProbe", () => {
    const f = analyze(
      snapshot(
        pod({
          containers: [
            { name: "app", ports: [{ containerPort: 80 }], livenessProbe: { httpGet: { port: 80 } } },
          ],
          statuses: [
            { name: "app", ready: true, restartCount: 2, state: { running: { startedAt: "x" } } },
          ],
        }),
        [event("Unhealthy", "Liveness probe failed: connection refused", 5)],
      ),
    );
    expect(find(f, "liveness-kills")?.hint).toContain("startupProbe");
  });

  test("probe apontando para porta não declarada", () => {
    const f = analyze(
      snapshot(
        pod({
          containers: [
            {
              name: "app",
              ports: [{ containerPort: 3000 }],
              readinessProbe: { httpGet: { port: 8080 } },
            },
          ],
          statuses: [{ name: "app", ready: true }],
        }),
      ),
    );
    expect(find(f, "probe-port-mismatch")?.detail).toContain("3000");
  });

  test("probe por nome de porta declarado não gera falso positivo", () => {
    const f = analyze(
      snapshot(
        pod({
          containers: [
            {
              name: "app",
              ports: [{ name: "http", containerPort: 3000 }],
              readinessProbe: { httpGet: { port: "http" } },
            },
          ],
          statuses: [{ name: "app", ready: true }],
        }),
      ),
    );
    expect(find(f, "probe-port-mismatch")).toBeUndefined();
  });
});

describe("ciclo de vida", () => {
  test("Evicted", () => {
    const f = analyze(snapshot(pod({ phase: "Failed", reason: "Evicted" })));
    expect(find(f, "evicted")?.severity).toBe("critical");
  });

  test("Terminating com finalizer culpa o controller", () => {
    const f = analyze(
      snapshot(
        pod({ deletionTimestamp: "2026-08-01T00:00:00Z", finalizers: ["kubernetes.io/pvc-protection"] }),
      ),
    );
    expect(find(f, "stuck-terminating")?.hint).toContain("finalizer");
  });

  test("Terminating sem finalizer culpa o SIGTERM", () => {
    const f = analyze(snapshot(pod({ deletionTimestamp: "2026-08-01T00:00:00Z" })));
    expect(find(f, "stuck-terminating")?.hint).toContain("SIGTERM");
  });

  test("FailedMount de secret", () => {
    const f = analyze(
      snapshot(pod({ statuses: [{ name: "app", ready: false }] }), [
        event("FailedMount", 'MountVolume.SetUp failed for volume "cfg" : secret "cfg" not found'),
      ]),
    );
    expect(find(f, "mount-failed")?.hint).toContain("não existe neste namespace");
  });

  test("init container travado", () => {
    const f = analyze(
      snapshot(
        pod({
          phase: "Pending",
          initContainers: [{ name: "wait-db" }],
          initStatuses: [{ name: "wait-db", ready: false, state: { running: { startedAt: "x" } } }],
          statuses: [{ name: "app", ready: false }],
        }),
      ),
    );
    expect(find(f, "init-blocked")?.title).toContain("wait-db");
  });
});

describe("ordenação", () => {
  test("crítico vem antes de warn e info", () => {
    const f = analyze(
      snapshot(
        pod({
          statuses: [
            {
              name: "app",
              ready: false,
              restartCount: 9,
              state: { waiting: { reason: "CrashLoopBackOff" } },
              lastState: { terminated: { exitCode: 1 } },
            },
          ],
        }),
      ),
    );
    expect(f[0]?.severity).toBe("critical");
    expect(f.at(-1)?.severity).toBe("info");
  });
});

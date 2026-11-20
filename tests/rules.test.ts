import { describe, expect, test } from "bun:test";
import { containerOfFieldPath, eventFieldSelector } from "../src/collect.ts";
import { analyze } from "../src/rules.ts";
import type { EventLite, Finding } from "../src/types.ts";
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

  test("evidência do pull mostra só eventos de imagem do próprio container", () => {
    const f = analyze(
      snapshot(
        pod({
          containers: [
            { name: "app", image: "app:1" },
            { name: "sidecar", image: "ghcr.io/x/sidecar:9" },
          ],
          statuses: [
            { name: "app", ready: false, restartCount: 6, state: { waiting: { reason: "CrashLoopBackOff" } } },
            {
              name: "sidecar",
              ready: false,
              state: { waiting: { reason: "ImagePullBackOff", message: "manifest unknown" } },
            },
          ],
        }),
        [
          { ...event("BackOff", "Back-off pulling image \"ghcr.io/x/sidecar:9\"", 4), container: "sidecar" },
          { ...event("BackOff", "Back-off restarting failed container app in pod x", 12), container: "app" },
          event("FailedMount", "MountVolume.SetUp failed for volume \"cfg\""),
        ],
      ),
    );
    expect(find(f, "image-pull")?.evidence).toEqual([
      "manifest unknown",
      'BackOff (x4): Back-off pulling image "ghcr.io/x/sidecar:9"',
    ]);
  });

  test("InvalidImageName is reported once, as image-pull", () => {
    const f = analyze(
      snapshot(
        pod({
          statuses: [
            {
              name: "app",
              ready: false,
              image: "App:Bad Tag",
              state: { waiting: { reason: "InvalidImageName", message: "Failed to apply default image tag" } },
            },
          ],
        }),
      ),
    );
    expect(ids(f).filter((id) => id === "image-pull" || id === "config-error")).toEqual(["image-pull"]);
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

describe("eventos de probe atribuídos ao container certo", () => {
  const twoContainers = (readyApp: boolean) =>
    pod({
      containers: [
        { name: "app", ports: [{ containerPort: 80 }], readinessProbe: { httpGet: { port: 80 } } },
        { name: "sidecar", ports: [{ containerPort: 9090 }], readinessProbe: { httpGet: { port: 9090 } } },
      ],
      statuses: [
        { name: "app", ready: readyApp, restartCount: 3, state: { running: { startedAt: "x" } } },
        { name: "sidecar", ready: false, restartCount: 3, state: { running: { startedAt: "x" } } },
      ],
    });
  const forContainer = (e: EventLite, container: string): EventLite => ({ ...e, container });

  test("readiness do sidecar não acusa o app", () => {
    const f = analyze(
      snapshot(twoContainers(false), [
        forContainer(event("Unhealthy", "Readiness probe failed: connection refused", 9), "sidecar"),
      ]),
    );
    const titles = f.filter((x) => x.id === "readiness-failing").map((x) => x.title);
    expect(titles).toEqual(['container "sidecar" está rodando mas nunca fica Ready']);
  });

  test("liveness do sidecar não acusa o app", () => {
    const f = analyze(
      snapshot(twoContainers(true), [
        forContainer(event("Unhealthy", "Liveness probe failed: connection refused", 4), "sidecar"),
      ]),
    );
    const titles = f.filter((x) => x.id === "liveness-kills").map((x) => x.title);
    expect(titles).toEqual(['livenessProbe está matando o container "sidecar"']);
  });

  test("evento sem container conhecido continua valendo para todos (compatível)", () => {
    const f = analyze(
      snapshot(twoContainers(false), [event("Unhealthy", "Readiness probe failed: x", 2)]),
    );
    expect(f.filter((x) => x.id === "readiness-failing")).toHaveLength(2);
  });
});

describe("containerOfFieldPath", () => {
  test("extrai o nome do container do fieldPath do evento", () => {
    expect(containerOfFieldPath("spec.containers{app}")).toBe("app");
    expect(containerOfFieldPath("spec.initContainers{wait-db}")).toBe("wait-db");
    expect(containerOfFieldPath(undefined)).toBeUndefined();
    expect(containerOfFieldPath("metadata.name")).toBeUndefined();
  });
});

describe("eventFieldSelector", () => {
  const base = { spec: { containers: [] }, status: {} };

  test("filtra pelo uid: pod de StatefulSet recriado com o mesmo nome não herda eventos do anterior", () => {
    const pod = { ...base, metadata: { name: "web-0", namespace: "apps", uid: "abc-123" } };
    expect(eventFieldSelector(pod)).toBe("involvedObject.name=web-0,involvedObject.uid=abc-123");
  });

  test("sem uid (pod montado à mão) cai só no nome", () => {
    const pod = { ...base, metadata: { name: "web-0", namespace: "apps" } };
    expect(eventFieldSelector(pod)).toBe("involvedObject.name=web-0");
  });
});

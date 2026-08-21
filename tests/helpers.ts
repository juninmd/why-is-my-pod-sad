import type { ContainerSpec, ContainerStatus, EventLite, Pod, PodSnapshot } from "../src/types.ts";

export function pod(overrides: {
  name?: string;
  namespace?: string;
  phase?: string;
  reason?: string;
  nodeName?: string | null;
  deletionTimestamp?: string;
  finalizers?: string[];
  containers?: Partial<ContainerSpec>[];
  initContainers?: Partial<ContainerSpec>[];
  statuses?: Partial<ContainerStatus>[];
  initStatuses?: Partial<ContainerStatus>[];
  imagePullSecrets?: string[];
  nodeSelector?: Record<string, string>;
  volumes?: Pod["spec"]["volumes"];
} = {}): Pod {
  const containers = (overrides.containers ?? [{ name: "app", image: "app:1" }]).map((c) => ({
    name: "app",
    ...c,
  })) as ContainerSpec[];
  return {
    metadata: {
      name: overrides.name ?? "app-abc123",
      namespace: overrides.namespace ?? "default",
      creationTimestamp: "2026-08-01T00:00:00Z",
      deletionTimestamp: overrides.deletionTimestamp,
      finalizers: overrides.finalizers,
    },
    spec: {
      nodeName: overrides.nodeName === null ? undefined : (overrides.nodeName ?? "node-1"),
      containers,
      initContainers: overrides.initContainers as ContainerSpec[] | undefined,
      imagePullSecrets: overrides.imagePullSecrets?.map((name) => ({ name })),
      nodeSelector: overrides.nodeSelector,
      volumes: overrides.volumes,
    },
    status: {
      phase: overrides.phase ?? "Running",
      reason: overrides.reason,
      containerStatuses: (overrides.statuses ?? []).map((s) => ({
        name: "app",
        ready: true,
        restartCount: 0,
        ...s,
      })) as ContainerStatus[],
      initContainerStatuses: overrides.initStatuses as ContainerStatus[] | undefined,
    },
  };
}

export function snapshot(
  p: Pod,
  events: EventLite[] = [],
  logs: PodSnapshot["logs"] = {},
): PodSnapshot {
  return { pod: p, events, logs };
}

export const event = (reason: string, message: string, count = 1): EventLite => ({
  type: "Warning",
  reason,
  message,
  count,
  lastTimestamp: "2026-08-01T00:01:00Z",
});

export const ids = (findings: { id: string }[]) => findings.map((f) => f.id);

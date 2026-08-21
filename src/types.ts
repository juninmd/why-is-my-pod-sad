/** Minimal subset of the Kubernetes API objects this tool reads. */

export interface ContainerState {
  waiting?: { reason?: string; message?: string };
  running?: { startedAt?: string };
  terminated?: {
    reason?: string;
    message?: string;
    exitCode?: number;
    signal?: number;
    startedAt?: string;
    finishedAt?: string;
  };
}

export interface Probe {
  httpGet?: { port?: number | string; path?: string; scheme?: string };
  tcpSocket?: { port?: number | string };
  exec?: { command?: string[] };
  initialDelaySeconds?: number;
  periodSeconds?: number;
  failureThreshold?: number;
  timeoutSeconds?: number;
}

export interface ContainerSpec {
  name: string;
  image?: string;
  ports?: { name?: string; containerPort?: number }[];
  resources?: {
    limits?: Record<string, string>;
    requests?: Record<string, string>;
  };
  livenessProbe?: Probe;
  readinessProbe?: Probe;
  startupProbe?: Probe;
}

export interface ContainerStatus {
  name: string;
  ready?: boolean;
  started?: boolean;
  restartCount?: number;
  image?: string;
  state?: ContainerState;
  lastState?: ContainerState;
}

export interface Pod {
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    deletionTimestamp?: string;
    finalizers?: string[];
    creationTimestamp?: string;
    ownerReferences?: { kind?: string; name?: string }[];
  };
  spec: {
    nodeName?: string;
    containers: ContainerSpec[];
    initContainers?: ContainerSpec[];
    imagePullSecrets?: { name: string }[];
    nodeSelector?: Record<string, string>;
    volumes?: { name: string; persistentVolumeClaim?: { claimName: string } }[];
  };
  status: {
    phase?: string;
    reason?: string;
    message?: string;
    startTime?: string;
    containerStatuses?: ContainerStatus[];
    initContainerStatuses?: ContainerStatus[];
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
  };
}

export interface EventLite {
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string;
  firstTimestamp?: string;
}

export interface ContainerLogs {
  /** stdout of the running container, may be empty */
  current?: string;
  /** stdout of the previous (crashed) instance, the interesting one */
  previous?: string;
}

/** Everything the rules engine is allowed to look at. Pure data. */
export interface PodSnapshot {
  pod: Pod;
  events: EventLite[];
  logs: Record<string, ContainerLogs>;
}

export type Severity = "critical" | "warn" | "info";

export interface Finding {
  id: string;
  severity: Severity;
  /** One-line verdict, shown big. */
  title: string;
  /** Why we think so. */
  detail: string;
  /** What to actually do about it. */
  hint?: string;
  /** Raw excerpts: event messages, log tails. */
  evidence?: string[];
}

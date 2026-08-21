import { kubectlJson, kubectlSoft, type Target } from "./kubectl.ts";
import type { ContainerLogs, EventLite, Pod, PodSnapshot } from "./types.ts";

interface PodList {
  items: Pod[];
}

interface EventList {
  items: {
    type?: string;
    reason?: string;
    message?: string;
    count?: number;
    lastTimestamp?: string;
    firstTimestamp?: string;
    eventTime?: string;
  }[];
}

/** Pods that are not plainly happy — used when no pod name is given. */
export function sadness(pod: Pod): number {
  const phase = pod.status.phase ?? "";
  if (pod.status.reason === "Evicted") return 100;
  if (pod.metadata.deletionTimestamp) return 90;
  if (phase === "Pending") return 80;
  const statuses = [
    ...(pod.status.initContainerStatuses ?? []),
    ...(pod.status.containerStatuses ?? []),
  ];
  const waiting = statuses.find((s) => s.state?.waiting?.reason);
  if (waiting && waiting.state?.waiting?.reason !== "ContainerCreating") return 70;
  if (phase === "Failed") return 60;
  if (statuses.some((s) => s.ready === false) && phase === "Running") return 50;
  const restarts = Math.max(0, ...statuses.map((s) => s.restartCount ?? 0));
  if (restarts >= 5) return 30;
  if (restarts > 0) return 10;
  return 0;
}

export async function listPods(t: Target, allNamespaces = false): Promise<Pod[]> {
  const args = allNamespaces ? ["get", "pods", "--all-namespaces"] : ["get", "pods"];
  const list = await kubectlJson<PodList>(args, allNamespaces ? { context: t.context } : t);
  return list.items ?? [];
}

/** Resolve a user-typed name into one pod: exact, then prefix, then substring. */
export async function resolvePod(
  query: string | undefined,
  t: Target,
  selector?: string,
): Promise<Pod> {
  if (query && !selector) {
    try {
      return await kubectlJson<Pod>(["get", "pod", query], t);
    } catch {
      // fall through to fuzzy match
    }
  }

  const pods = selector
    ? await kubectlJson<PodList>(["get", "pods", "-l", selector], t).then((l) => l.items ?? [])
    : await listPods(t);

  if (!pods.length) {
    throw new Error(
      `nenhum pod no namespace "${t.namespace}"${selector ? ` com selector "${selector}"` : ""}`,
    );
  }

  const candidates = query
    ? pods.filter(
        (p) => p.metadata.name.startsWith(query) || p.metadata.name.includes(query),
      )
    : pods;

  if (query && !candidates.length) {
    throw new Error(
      `nenhum pod bate com "${query}" em "${t.namespace}". Disponíveis: ${pods
        .map((p) => p.metadata.name)
        .slice(0, 10)
        .join(", ")}`,
    );
  }

  // Sem nome exato: o pod mais triste ganha. Empate → o mais recente.
  const ranked = [...candidates].sort((a, b) => {
    const d = sadness(b) - sadness(a);
    if (d !== 0) return d;
    return (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? "");
  });
  const winner = ranked[0];
  if (!winner) throw new Error("nenhum pod candidato");
  return winner;
}

async function fetchEvents(podName: string, t: Target): Promise<EventLite[]> {
  const raw = await kubectlSoft(
    [
      "get",
      "events",
      "--field-selector",
      `involvedObject.name=${podName}`,
      "-o",
      "json",
    ],
    t,
  );
  if (!raw) return [];
  let list: EventList;
  try {
    list = JSON.parse(raw) as EventList;
  } catch {
    return [];
  }
  return (list.items ?? [])
    .map((e) => ({
      type: e.type,
      reason: e.reason,
      message: e.message,
      count: e.count,
      lastTimestamp: e.lastTimestamp ?? e.eventTime,
      firstTimestamp: e.firstTimestamp,
    }))
    .sort((a, b) => (a.lastTimestamp ?? "").localeCompare(b.lastTimestamp ?? ""));
}

async function fetchLogs(
  pod: Pod,
  t: Target,
  tailLines: number,
): Promise<Record<string, ContainerLogs>> {
  const names = [
    ...(pod.spec.initContainers ?? []),
    ...(pod.spec.containers ?? []),
  ].map((c) => c.name);

  const entries = await Promise.all(
    names.map(async (name) => {
      const [current, previous] = await Promise.all([
        kubectlSoft(["logs", pod.metadata.name, "-c", name, `--tail=${tailLines}`], t),
        kubectlSoft(
          ["logs", pod.metadata.name, "-c", name, "--previous", `--tail=${tailLines}`],
          t,
        ),
      ]);
      return [name, { current: current ?? undefined, previous: previous ?? undefined }] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function collect(
  pod: Pod,
  t: Target,
  opts: { tail: number; logs: boolean },
): Promise<PodSnapshot> {
  const scoped: Target = { ...t, namespace: pod.metadata.namespace };
  const [events, logs] = await Promise.all([
    fetchEvents(pod.metadata.name, scoped),
    opts.logs ? fetchLogs(pod, scoped, opts.tail) : Promise.resolve({}),
  ]);
  return { pod, events, logs };
}

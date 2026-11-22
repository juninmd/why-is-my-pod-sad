import { kubectlJson, kubectlTry, type Target } from "./kubectl.ts";
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
    involvedObject?: { fieldPath?: string };
  }[];
}

/** "spec.containers{app}" / "spec.initContainers{init}" -> "app" / "init". */
export const containerOfFieldPath = (fieldPath: string | undefined): string | undefined =>
  /^spec\.(?:init|ephemeral)?[cC]ontainers\{([^}]+)\}$/.exec(fieldPath ?? "")?.[1];

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
  // Any container counts: a sibling still in ContainerCreating must not hide a CrashLoopBackOff.
  if (statuses.some((s) => (s.state?.waiting?.reason ?? "ContainerCreating") !== "ContainerCreating")) return 70;
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

/**
 * Events of this pod instance. Name alone also matches a previous pod with the same name
 * (StatefulSet, recreated pod), whose events linger for an hour — the uid tells them apart.
 */
export const eventFieldSelector = (pod: Pod): string =>
  [`involvedObject.name=${pod.metadata.name}`, pod.metadata.uid && `involvedObject.uid=${pod.metadata.uid}`]
    .filter(Boolean)
    .join(",");

/** Access or connectivity failures; a container that has not started yet is not one of them. */
const ACCESS_FAILURE = /forbidden|unauthorized|demorou mais|timeout|unable to connect|connection refused/i;

async function fetchEvents(pod: Pod, t: Target, unavailable: string[]): Promise<EventLite[]> {
  const res = await kubectlTry(
    ["get", "events", "--field-selector", eventFieldSelector(pod), "-o", "json"],
    t,
  );
  if ("error" in res) {
    unavailable.push(`eventos: ${res.error}`);
    return [];
  }
  let list: EventList;
  try {
    list = JSON.parse(res.out) as EventList;
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
      container: containerOfFieldPath(e.involvedObject?.fieldPath),
    }))
    .sort((a, b) => (a.lastTimestamp ?? "").localeCompare(b.lastTimestamp ?? ""));
}

async function fetchLogs(
  pod: Pod,
  t: Target,
  tailLines: number,
  unavailable: string[],
): Promise<Record<string, ContainerLogs>> {
  const names = [
    ...(pod.spec.initContainers ?? []),
    ...(pod.spec.containers ?? []),
  ].map((c) => c.name);

  const entries = await Promise.all(
    names.map(async (name) => {
      const [current, previous] = await Promise.all([
        kubectlTry(["logs", pod.metadata.name, "-c", name, `--tail=${tailLines}`], t),
        kubectlTry(
          ["logs", pod.metadata.name, "-c", name, "--previous", `--tail=${tailLines}`],
          t,
        ),
      ]);
      const denied = [current, previous].find((r) => "error" in r && ACCESS_FAILURE.test(r.error));
      if (denied && "error" in denied) unavailable.push(`logs de ${name}: ${denied.error}`);
      const out = (r: { out: string } | { error: string }) => ("out" in r ? r.out : undefined);
      return [name, { current: out(current), previous: out(previous) }] as const;
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
  const unavailable: string[] = [];
  const [events, logs] = await Promise.all([
    fetchEvents(pod, scoped, unavailable),
    opts.logs ? fetchLogs(pod, scoped, opts.tail, unavailable) : Promise.resolve({}),
  ]);
  return { pod, events, logs, ...(unavailable.length ? { unavailable } : {}) };
}

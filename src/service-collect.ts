import { kubectlJson, kubectlSoft, type Target } from "./kubectl.ts";
import type { EndpointSlice, Ingress, Service, ServiceSnapshot } from "./service-types.ts";
import type { EventLite, Pod } from "./types.ts";

interface List<T> {
  items?: T[];
}

const selectorArg = (selector: Record<string, string>) =>
  Object.entries(selector)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");

export async function resolveService(query: string, t: Target): Promise<Service> {
  try {
    return await kubectlJson<Service>(["get", "service", query], t);
  } catch {
    const list = await kubectlJson<List<Service>>(["get", "services"], t);
    const items = list.items ?? [];
    const hit = items.find(
      (s) => s.metadata.name.startsWith(query) || s.metadata.name.includes(query),
    );
    if (!hit) {
      throw new Error(
        `nenhum Service bate com "${query}" em "${t.namespace}". Disponíveis: ${items
          .map((s) => s.metadata.name)
          .slice(0, 10)
          .join(", ")}`,
      );
    }
    return hit;
  }
}

/** Ingresses do namespace que citam este Service em algum backend. */
export function ingressesFor(ingresses: Ingress[], serviceName: string): Ingress[] {
  return ingresses.filter((ing) =>
    (ing.spec.rules ?? []).some((r) =>
      (r.http?.paths ?? []).some((p) => p.backend?.service?.name === serviceName),
    ),
  );
}

export async function collectService(service: Service, t: Target): Promise<ServiceSnapshot> {
  const scoped: Target = { ...t, namespace: service.metadata.namespace };
  const name = service.metadata.name;
  const selector = service.spec.selector ?? {};

  const [slices, allPods, ingressList, secretList, events] = await Promise.all([
    kubectlJson<List<EndpointSlice>>(
      ["get", "endpointslices", "-l", `kubernetes.io/service-name=${name}`],
      scoped,
    ).catch(() => ({ items: [] as EndpointSlice[] })),
    kubectlJson<List<Pod>>(["get", "pods"], scoped).catch(() => ({ items: [] as Pod[] })),
    kubectlJson<List<Ingress>>(["get", "ingresses"], scoped).catch(() => ({
      items: [] as Ingress[],
    })),
    kubectlSoft(["get", "secrets", "-o", "jsonpath={.items[*].metadata.name}"], scoped),
    kubectlJson<List<EventLite>>(
      ["get", "events", "--field-selector", `involvedObject.name=${name}`],
      scoped,
    ).catch(() => ({ items: [] as EventLite[] })),
  ]);

  const pods = allPods.items ?? [];
  const keys = Object.keys(selector);
  const matches = keys.length
    ? pods.filter((p) => keys.every((k) => p.metadata.labels?.[k] === selector[k]))
    : [];
  const matchNames = new Set(matches.map((p) => p.metadata.name));

  return {
    service,
    endpointSlices: slices.items ?? [],
    pods: matches,
    otherPods: pods
      .filter((p) => !matchNames.has(p.metadata.name))
      .map((p) => ({ name: p.metadata.name, labels: p.metadata.labels ?? {} })),
    ingresses: ingressesFor(ingressList.items ?? [], name),
    secretNames: (secretList ?? "").split(/\s+/).filter(Boolean),
    events: events.items ?? [],
  };
}

/** Serviço "triste": sem endpoint pronto apesar de existir para balancear algo. */
export function serviceSadness(service: Service, readyEndpoints: number): number {
  if ((service.spec.type ?? "ClusterIP") === "ExternalName") return 0;
  if (!service.spec.selector || !Object.keys(service.spec.selector).length) return 0;
  return readyEndpoints === 0 ? 70 : 0;
}

export { selectorArg };

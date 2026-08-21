import type {
  EndpointSlice,
  Ingress,
  Service,
  ServicePort,
  ServiceSnapshot,
} from "./service-types.ts";
import type { ContainerSpec, Finding, Pod, Severity } from "./types.ts";

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };

const containers = (pod: Pod): ContainerSpec[] => [
  ...(pod.spec.initContainers ?? []),
  ...(pod.spec.containers ?? []),
];

const declaredPorts = (pod: Pod) =>
  containers(pod).flatMap((c) => (c.ports ?? []).map((p) => p.containerPort));

const declaredPortNames = (pod: Pod) =>
  containers(pod).flatMap((c) => (c.ports ?? []).map((p) => p.name).filter(Boolean) as string[]);

const isReady = (pod: Pod) =>
  (pod.status.containerStatuses ?? []).length > 0 &&
  (pod.status.containerStatuses ?? []).every((s) => s.ready);

/** Endereços prontos somando todas as EndpointSlices do Service. */
export function readyAddresses(slices: EndpointSlice[]): number {
  return slices.reduce(
    (total, slice) =>
      total +
      (slice.endpoints ?? []).reduce(
        (n, e) => n + (e.conditions?.ready === false ? 0 : (e.addresses ?? []).length),
        0,
      ),
    0,
  );
}

/** targetPort ausente vale como igual à port — é a regra do Kubernetes e a origem de metade dos bugs. */
export function effectiveTargetPort(p: ServicePort): number | string {
  return p.targetPort ?? p.port;
}

const selectorText = (sel: Record<string, string> | undefined) =>
  Object.entries(sel ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(",");

/**
 * Selector "quase certo": pods cujos labels compartilham chave mas divergem no valor,
 * ou que casariam se uma chave a menos fosse exigida. É o erro real na maioria das vezes.
 */
export function nearMisses(
  selector: Record<string, string>,
  others: { name: string; labels: Record<string, string> }[],
): string[] {
  const entries = Object.entries(selector);
  if (!entries.length) return [];
  return others
    .map((pod) => {
      const hits = entries.filter(([k, v]) => pod.labels[k] === v).length;
      const wrongValue = entries.filter(([k, v]) => pod.labels[k] !== undefined && pod.labels[k] !== v);
      return { pod, hits, wrongValue };
    })
    .filter((r) => r.hits > 0 || r.wrongValue.length > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3)
    .map((r) => {
      const diff = r.wrongValue
        .map(([k, v]) => `${k}: quer "${v}", pod tem "${r.pod.labels[k]}"`)
        .join("; ");
      const missing = entries
        .filter(([k]) => r.pod.labels[k] === undefined)
        .map(([k]) => k);
      const why = [diff, missing.length ? `pod não tem o label ${missing.join(", ")}` : ""]
        .filter(Boolean)
        .join(" · ");
      return `${r.pod.name}: ${why}`;
    });
}

function ingressFindings(
  ing: Ingress,
  service: Service,
  secretNames: string[],
  push: (f: Finding) => void,
): void {
  const label = `ingress "${ing.metadata.name}"`;
  const servicePorts = service.spec.ports ?? [];

  for (const rule of ing.spec.rules ?? []) {
    for (const path of rule.http?.paths ?? []) {
      const backend = path.backend?.service;
      if (!backend || backend.name !== service.metadata.name) continue;
      const byNumber = backend.port?.number;
      const byName = backend.port?.name;

      if (byNumber !== undefined && !servicePorts.some((p) => p.port === byNumber)) {
        push({
          id: "ing-backend-port",
          severity: "critical",
          title: `${label} aponta para a porta ${byNumber}, que o Service não expõe`,
          detail: `portas do Service: ${servicePorts.map((p) => p.port).join(", ") || "(nenhuma)"}`,
          hint: "O Ingress referencia a `port` do Service (não a do container). Alinhe os dois.",
        });
      }
      if (byName !== undefined && !servicePorts.some((p) => p.name === byName)) {
        push({
          id: "ing-backend-port",
          severity: "critical",
          title: `${label} aponta para a porta nomeada "${byName}", que o Service não declara`,
          detail: `nomes no Service: ${servicePorts.map((p) => p.name).filter(Boolean).join(", ") || "(nenhum)"}`,
          hint: "Porta nomeada no Ingress precisa do mesmo `name` em spec.ports do Service.",
        });
      }
    }
  }

  for (const tls of ing.spec.tls ?? []) {
    if (tls.secretName && !secretNames.includes(tls.secretName)) {
      push({
        id: "ing-tls-secret",
        severity: "critical",
        title: `${label} usa o secret TLS "${tls.secretName}", que não existe neste namespace`,
        detail: `hosts: ${(tls.hosts ?? []).join(", ") || "(não declarados)"}`,
        hint: "Sem o secret o controller serve certificado default e o navegador reclama. Se é cert-manager, veja o Certificate e o Order.",
      });
    }
  }

  const hasClass =
    Boolean(ing.spec.ingressClassName) ||
    Boolean(ing.metadata.annotations?.["kubernetes.io/ingress.class"]);
  if (!hasClass) {
    push({
      id: "ing-no-class",
      severity: "warn",
      title: `${label} não declara ingressClassName`,
      detail: "Sem classe, só um controller marcado como default adota a regra.",
      hint: "Declare `spec.ingressClassName` (ex.: traefik, nginx) e confira `kubectl get ingressclass`.",
    });
  }

  if (!(ing.status?.loadBalancer?.ingress ?? []).length) {
    push({
      id: "ing-no-address",
      severity: "warn",
      title: `${label} está sem endereço atribuído`,
      detail: "status.loadBalancer.ingress vazio: nenhum controller assumiu a regra.",
      hint: "Ou a classe não bate com nenhum controller instalado, ou o controller está fora do ar.",
    });
  }
}

/**
 * Diagnóstico da camada que o `analyze` de pod não alcança: Service, endpoints e Ingress.
 * Pura: tudo vem do snapshot.
 */
export function analyzeService(snap: ServiceSnapshot): Finding[] {
  const { service, endpointSlices, pods, otherPods, ingresses, secretNames } = snap;
  const found: Finding[] = [];
  const push = (f: Finding) => found.push(f);

  const type = service.spec.type ?? "ClusterIP";
  const selector = service.spec.selector;
  const ports = service.spec.ports ?? [];
  const ready = readyAddresses(endpointSlices);

  // ---- ExternalName: não tem selector nem endpoint, e está tudo bem -------
  if (type === "ExternalName") {
    push({
      id: "svc-externalname",
      severity: "info",
      title: "Service é ExternalName — vira um CNAME, não balanceia nada",
      detail: `aponta para ${service.spec.externalName ?? "(vazio)"}`,
      hint: "Não há endpoints por definição. Se o cliente não resolve, o problema é DNS, não o Service.",
    });
    return found;
  }

  // ---- Sem selector ------------------------------------------------------
  if (!selector || !Object.keys(selector).length) {
    push({
      id: "svc-no-selector",
      severity: ready ? "info" : "critical",
      title: ready
        ? "Service sem selector, com endpoints gerenciados à mão"
        : "Service não tem selector e nem endpoints manuais",
      detail: ready
        ? `${ready} endereço(s) vindo de EndpointSlice manual.`
        : "Sem selector, o Kubernetes não popula endpoint nenhum: o Service aponta para o vazio.",
      hint: ready
        ? undefined
        : "Ou declare `spec.selector`, ou crie a EndpointSlice/Endpoints na mão apontando para o destino.",
    });
  } else if (!pods.length) {
    // ---- Selector não bate em ninguém ------------------------------------
    const misses = nearMisses(selector, otherPods);
    push({
      id: "svc-selector-empty",
      severity: "critical",
      title: "O selector do Service não bate em nenhum pod",
      detail: `selector: ${selectorText(selector)}`,
      hint: misses.length
        ? "Os pods abaixo quase batem — normalmente é uma chave a mais no Service ou um valor divergente."
        : "Nenhum pod do namespace chega perto desse selector. Confira se o Deployment está no namespace certo.",
      evidence: misses,
    });
  } else if (ready === 0) {
    // ---- Bate em pods, mas nenhum pronto ---------------------------------
    const notReady = pods.filter((p) => !isReady(p));
    push({
      id: "svc-pods-not-ready",
      severity: "critical",
      title: `Service acha ${pods.length} pod(s), mas nenhum está Ready — endpoints vazios`,
      detail: "Pod fora de Ready é removido do balanceamento; o Service existe e não roteia nada.",
      hint: `Diagnostique o pod: wimps -n ${service.metadata.namespace} ${notReady[0]?.metadata.name ?? pods[0]?.metadata.name}`,
      evidence: pods.map(
        (p) => `${p.metadata.name}: ${p.status.phase ?? "?"}${isReady(p) ? " (Ready)" : " (não Ready)"}`,
      ),
    });
  } else if (ready < pods.length) {
    push({
      id: "svc-partial-endpoints",
      severity: "warn",
      title: `Só ${ready} de ${pods.length} pod(s) estão no balanceamento`,
      detail: "O tráfego está concentrado nas réplicas prontas.",
      hint: "Durante rollout é esperado. Se persiste, é readiness reprovando em parte das réplicas.",
    });
  }

  // ---- Porta de destino que ninguém escuta -------------------------------
  for (const p of ports) {
    const target = effectiveTargetPort(p);
    const implicit = p.targetPort === undefined;
    for (const pod of pods) {
      const numbers = declaredPorts(pod);
      const names = declaredPortNames(pod);
      if (!numbers.length && !names.length) continue;
      const ok =
        typeof target === "number" ? numbers.includes(target) : names.includes(target);
      if (ok) continue;
      push({
        id: implicit ? "svc-missing-targetport" : "svc-targetport-mismatch",
        severity: "critical",
        title: implicit
          ? `Service não declara targetPort, então manda para a porta ${target} — que o pod não expõe`
          : `targetPort ${target} não existe no pod "${pod.metadata.name}"`,
        detail: `portas do pod: ${numbers.join(", ") || "(nenhuma numérica)"}${
          names.length ? ` / nomes: ${names.join(", ")}` : ""
        }`,
        hint: implicit
          ? `Sem targetPort o Kubernetes usa a própria \`port\` (${p.port}). Declare targetPort: ${numbers[0] ?? "<porta do container>"}.`
          : "Alinhe targetPort com a containerPort real (ou use o nome da porta, que sobrevive a mudança de número).",
      });
      break; // um aviso por porta do Service basta
    }
  }

  // ---- LoadBalancer sem IP ----------------------------------------------
  if (type === "LoadBalancer" && !(service.status?.loadBalancer?.ingress ?? []).length) {
    push({
      id: "svc-lb-pending",
      severity: "warn",
      title: "Service LoadBalancer está sem IP externo",
      detail: "status.loadBalancer.ingress vazio.",
      hint: "Em cluster self-hosted isso é normal sem MetalLB/klipper-lb. Considere NodePort ou Ingress.",
    });
  }

  // ---- Headless ----------------------------------------------------------
  if (service.spec.clusterIP === "None") {
    push({
      id: "svc-headless",
      severity: "info",
      title: "Service é headless (clusterIP: None)",
      detail: "DNS devolve os IPs dos pods direto; não há balanceamento nem IP virtual.",
      hint: "Se o cliente esperava um único IP estável, o tipo está errado.",
    });
  }

  // ---- Ingresses apontando para este Service -----------------------------
  for (const ing of ingresses) ingressFindings(ing, service, secretNames, push);

  if (!found.length) {
    push({
      id: "healthy",
      severity: "info",
      title: "Este Service não está triste",
      detail: `${ready} endpoint(s) prontos, ${ports.length} porta(s) publicada(s)${
        ingresses.length ? `, ${ingresses.length} ingress apontando` : ""
      }.`,
    });
  }

  return found.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

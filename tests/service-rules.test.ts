import { describe, expect, test } from "bun:test";
import { ingressesFor } from "../src/service-collect.ts";
import { analyzeService, effectiveTargetPort, nearMisses, readyAddresses } from "../src/service-rules.ts";
import type { EndpointSlice, Ingress, Service, ServiceSnapshot } from "../src/service-types.ts";
import type { Finding } from "../src/types.ts";
import { pod } from "./helpers.ts";

const find = (findings: Finding[], id: string) => findings.find((f) => f.id === id);

function service(over: Partial<Service["spec"]> & { type?: string } = {}): Service {
  return {
    metadata: { name: "api", namespace: "apps" },
    spec: {
      type: over.type ?? "ClusterIP",
      clusterIP: over.clusterIP ?? "10.43.0.10",
      selector: over.selector ?? { app: "api" },
      ports: over.ports ?? [{ port: 80, targetPort: 3000 }],
      externalName: over.externalName,
    },
    status: {},
  };
}

const slice = (ready: number): EndpointSlice => ({
  metadata: { name: "api-abc", namespace: "apps" },
  endpoints: Array.from({ length: ready }, (_, i) => ({
    addresses: [`10.42.0.${i + 1}`],
    conditions: { ready: true },
  })),
});

function snap(over: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    service: over.service ?? service(),
    endpointSlices: over.endpointSlices ?? [],
    pods: over.pods ?? [],
    otherPods: over.otherPods ?? [],
    ingresses: over.ingresses ?? [],
    secretNames: over.secretNames ?? [],
    events: over.events ?? [],
  };
}

const backendPod = (name: string, port = 3000) =>
  pod({
    name,
    namespace: "apps",
    containers: [{ name: "app", ports: [{ name: "http", containerPort: port }] }],
    statuses: [{ name: "app", ready: true }],
  });

describe("endpoints", () => {
  test("service saudável não vira problema", () => {
    const f = analyzeService(
      snap({ pods: [backendPod("api-1")], endpointSlices: [slice(1)] }),
    );
    expect(f.map((x) => x.id)).toEqual(["healthy"]);
  });

  test("selector que não bate em ninguém é crítico e sugere o quase-certo", () => {
    const f = analyzeService(
      snap({
        service: service({ selector: { app: "api", tier: "backend" } }),
        otherPods: [{ name: "api-1", labels: { app: "api" } }],
      }),
    );
    const finding = find(f, "svc-selector-empty");
    expect(finding?.severity).toBe("critical");
    expect(finding?.evidence?.[0]).toContain("não tem o label tier");
  });

  test("valor divergente no label aparece como diff", () => {
    const f = analyzeService(
      snap({
        service: service({ selector: { app: "api" } }),
        otherPods: [{ name: "api-1", labels: { app: "api-v2" } }],
      }),
    );
    expect(find(f, "svc-selector-empty")?.evidence?.[0]).toContain('quer "api", pod tem "api-v2"');
  });

  test("pods batem mas nenhum Ready aponta para o wimps do pod", () => {
    const notReady = pod({
      name: "api-1",
      namespace: "apps",
      containers: [{ name: "app", ports: [{ containerPort: 3000 }] }],
      statuses: [{ name: "app", ready: false }],
    });
    const f = analyzeService(snap({ pods: [notReady], endpointSlices: [] }));
    const finding = find(f, "svc-pods-not-ready");
    expect(finding?.severity).toBe("critical");
    expect(finding?.hint).toContain("wimps -n apps api-1");
  });

  test("parte das réplicas fora do balanceamento é aviso", () => {
    const f = analyzeService(
      snap({
        pods: [backendPod("api-1"), backendPod("api-2")],
        endpointSlices: [slice(1)],
      }),
    );
    expect(find(f, "svc-partial-endpoints")?.severity).toBe("warn");
  });

  test("service sem selector e sem endpoint manual é crítico", () => {
    const f = analyzeService(snap({ service: service({ selector: {} }) }));
    expect(find(f, "svc-no-selector")?.severity).toBe("critical");
  });

  test("service sem selector com endpoint manual é só informativo", () => {
    const f = analyzeService(
      snap({ service: service({ selector: {} }), endpointSlices: [slice(2)] }),
    );
    expect(find(f, "svc-no-selector")?.severity).toBe("info");
  });
});

describe("portas", () => {
  test("targetPort que o pod não expõe é crítico", () => {
    const f = analyzeService(
      snap({
        service: service({ ports: [{ port: 80, targetPort: 8080 }] }),
        pods: [backendPod("api-1", 3000)],
        endpointSlices: [slice(1)],
      }),
    );
    expect(find(f, "svc-targetport-mismatch")?.detail).toContain("3000");
  });

  test("targetPort ausente cai na port e é diagnosticado como tal", () => {
    const f = analyzeService(
      snap({
        service: service({ ports: [{ port: 80 }] }),
        pods: [backendPod("api-1", 3000)],
        endpointSlices: [slice(1)],
      }),
    );
    const finding = find(f, "svc-missing-targetport");
    expect(finding?.hint).toContain("targetPort: 3000");
  });

  test("targetPort nomeado que existe no pod não gera falso positivo", () => {
    const f = analyzeService(
      snap({
        service: service({ ports: [{ port: 80, targetPort: "http" }] }),
        pods: [backendPod("api-1", 3000)],
        endpointSlices: [slice(1)],
      }),
    );
    expect(find(f, "svc-targetport-mismatch")).toBeUndefined();
  });

  test("effectiveTargetPort trata a omissão como a regra do Kubernetes manda", () => {
    expect(effectiveTargetPort({ port: 80 })).toBe(80);
    expect(effectiveTargetPort({ port: 80, targetPort: 3000 })).toBe(3000);
  });
});

describe("tipos de service", () => {
  test("LoadBalancer sem IP vira aviso com contexto de self-hosted", () => {
    const f = analyzeService(
      snap({
        service: { ...service({ type: "LoadBalancer" }), status: { loadBalancer: {} } },
        pods: [backendPod("api-1")],
        endpointSlices: [slice(1)],
      }),
    );
    expect(find(f, "svc-lb-pending")?.hint).toContain("MetalLB");
  });

  test("ExternalName encerra o diagnóstico sem cobrar endpoints", () => {
    const f = analyzeService(
      snap({ service: service({ type: "ExternalName", externalName: "db.externo.com", selector: {} }) }),
    );
    expect(f.map((x) => x.id)).toEqual(["svc-externalname"]);
  });

  test("headless é sinalizado como info", () => {
    const f = analyzeService(
      snap({
        service: service({ clusterIP: "None" }),
        pods: [backendPod("api-1")],
        endpointSlices: [slice(1)],
      }),
    );
    expect(find(f, "svc-headless")?.severity).toBe("info");
  });
});

describe("ingress", () => {
  const ingress = (over: Partial<Ingress["spec"]> = {}, annotations?: Record<string, string>): Ingress => ({
    metadata: { name: "api-ing", namespace: "apps", annotations },
    spec: {
      // "ingressClassName" in over permite testar a ausência do campo, não só o valor.
      ingressClassName: "ingressClassName" in over ? over.ingressClassName : "traefik",
      tls: over.tls,
      rules: over.rules ?? [
        {
          host: "api.exemplo.com",
          http: { paths: [{ path: "/", backend: { service: { name: "api", port: { number: 80 } } } }] },
        },
      ],
    },
    status: { loadBalancer: { ingress: [{ ip: "1.2.3.4" }] } },
  });

  const healthy = { pods: [backendPod("api-1")], endpointSlices: [slice(1)] };

  test("ingress apontando para porta que o Service não expõe", () => {
    const bad = ingress({
      rules: [
        {
          host: "api.exemplo.com",
          http: { paths: [{ path: "/", backend: { service: { name: "api", port: { number: 3000 } } } }] },
        },
      ],
    });
    const f = analyzeService(snap({ ...healthy, ingresses: [bad] }));
    expect(find(f, "ing-backend-port")?.hint).toContain("port` do Service");
  });

  test("porta nomeada inexistente no Service", () => {
    const bad = ingress({
      rules: [
        {
          host: "api.exemplo.com",
          http: { paths: [{ path: "/", backend: { service: { name: "api", port: { name: "web" } } } }] },
        },
      ],
    });
    const f = analyzeService(snap({ ...healthy, ingresses: [bad] }));
    expect(find(f, "ing-backend-port")?.title).toContain('"web"');
  });

  test("secret TLS que não existe no namespace", () => {
    const withTls = ingress({ tls: [{ hosts: ["api.exemplo.com"], secretName: "api-tls" }] });
    const f = analyzeService(snap({ ...healthy, ingresses: [withTls], secretNames: ["outro"] }));
    expect(find(f, "ing-tls-secret")?.severity).toBe("critical");
  });

  test("secret TLS existente não gera achado", () => {
    const withTls = ingress({ tls: [{ hosts: ["api.exemplo.com"], secretName: "api-tls" }] });
    const f = analyzeService(snap({ ...healthy, ingresses: [withTls], secretNames: ["api-tls"] }));
    expect(find(f, "ing-tls-secret")).toBeUndefined();
  });

  test("ingress sem classe é avisado", () => {
    const noClass = ingress({ ingressClassName: undefined });
    const f = analyzeService(snap({ ...healthy, ingresses: [noClass] }));
    expect(find(f, "ing-no-class")?.severity).toBe("warn");
  });

  test("annotation legada de classe conta como classe declarada", () => {
    const legacy = ingress({ ingressClassName: undefined }, { "kubernetes.io/ingress.class": "nginx" });
    const f = analyzeService(snap({ ...healthy, ingresses: [legacy] }));
    expect(find(f, "ing-no-class")).toBeUndefined();
  });

  test("ingress sem endereço indica controller que não assumiu", () => {
    const orphan = { ...ingress(), status: { loadBalancer: {} } };
    const f = analyzeService(snap({ ...healthy, ingresses: [orphan] }));
    expect(find(f, "ing-no-address")?.hint).toContain("controller");
  });

  test("ingressesFor filtra só quem cita este Service", () => {
    const outro: Ingress = {
      metadata: { name: "outro", namespace: "apps" },
      spec: {
        rules: [
          { http: { paths: [{ backend: { service: { name: "web", port: { number: 80 } } } }] } },
        ],
      },
    };
    expect(ingressesFor([ingress(), outro], "api").map((i) => i.metadata.name)).toEqual(["api-ing"]);
  });
});

describe("helpers", () => {
  test("readyAddresses soma slices e ignora endpoint não pronto", () => {
    const mixed: EndpointSlice = {
      metadata: { name: "x", namespace: "apps" },
      endpoints: [
        { addresses: ["10.0.0.1"], conditions: { ready: true } },
        { addresses: ["10.0.0.2"], conditions: { ready: false } },
      ],
    };
    expect(readyAddresses([mixed, slice(2)])).toBe(3);
  });

  test("nearMisses ordena por quantidade de labels que batem", () => {
    const out = nearMisses({ app: "api", tier: "backend" }, [
      { name: "quase", labels: { app: "api" } },
      { name: "longe", labels: { app: "outro" } },
    ]);
    expect(out[0]).toContain("quase");
  });

  test("ordenação: crítico antes de info", () => {
    const f = analyzeService(
      snap({
        service: service({ clusterIP: "None", selector: { app: "nao-existe" } }),
        otherPods: [{ name: "x", labels: { app: "api" } }],
      }),
    );
    expect(f[0]?.severity).toBe("critical");
    expect(f.at(-1)?.severity).toBe("info");
  });
});

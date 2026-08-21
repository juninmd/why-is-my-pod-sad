import type { EventLite, Pod } from "./types.ts";

export interface ServicePort {
  name?: string;
  port: number;
  targetPort?: number | string;
  protocol?: string;
  nodePort?: number;
}

export interface Service {
  metadata: { name: string; namespace: string; creationTimestamp?: string };
  spec: {
    type?: string;
    clusterIP?: string;
    selector?: Record<string, string>;
    ports?: ServicePort[];
    externalName?: string;
  };
  status?: {
    loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] };
  };
}

export interface EndpointSlice {
  metadata: { name: string; namespace: string };
  addressType?: string;
  endpoints?: {
    addresses?: string[];
    conditions?: { ready?: boolean; serving?: boolean; terminating?: boolean };
    targetRef?: { kind?: string; name?: string };
  }[];
  ports?: { name?: string; port?: number; protocol?: string }[];
}

export interface IngressBackend {
  service?: { name?: string; port?: { number?: number; name?: string } };
}

export interface Ingress {
  metadata: {
    name: string;
    namespace: string;
    annotations?: Record<string, string>;
  };
  spec: {
    ingressClassName?: string;
    tls?: { hosts?: string[]; secretName?: string }[];
    rules?: {
      host?: string;
      http?: { paths?: { path?: string; pathType?: string; backend?: IngressBackend }[] };
    }[];
  };
  status?: { loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] } };
}

/** Tudo que as regras de Service podem olhar. Pura, como o snapshot de pod. */
export interface ServiceSnapshot {
  service: Service;
  endpointSlices: EndpointSlice[];
  /** pods que batem no selector do Service, em qualquer estado */
  pods: Pod[];
  /** os demais pods do namespace: usados para sugerir o selector quase-certo */
  otherPods: { name: string; labels: Record<string, string> }[];
  /** ingresses deste namespace que apontam para este Service */
  ingresses: Ingress[];
  /** secrets existentes no namespace, só os nomes (para checar TLS do Ingress) */
  secretNames: string[];
  events: EventLite[];
}

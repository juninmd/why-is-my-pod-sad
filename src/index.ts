#!/usr/bin/env bun
import { collect, listPods, resolvePod, sadness } from "./collect.ts";
import { currentNamespace, KubectlError, type Target } from "./kubectl.ts";
import { render, renderList, renderService } from "./render.ts";
import { analyze } from "./rules.ts";
import { collectService, resolveService } from "./service-collect.ts";
import { analyzeService } from "./service-rules.ts";
import type { ServiceSnapshot } from "./service-types.ts";
import type { Pod, PodSnapshot } from "./types.ts";

const HELP = `
why-is-my-pod-sad — diagnóstico de pod em uma tela só

  wimps                     escaneia o namespace e lista quem está triste
  wimps <pod>               diagnostica um pod (aceita prefixo do nome)
  wimps -l app=api          diagnostica o pod mais triste que bate no selector
  wimps svc <service>       diagnostica Service + endpoints + Ingress que apontam pra ele

opções:
  -n, --namespace <ns>      namespace (padrão: o do contexto atual)
      --context <ctx>       contexto do kubeconfig
  -A, --all-namespaces      no modo lista, varre todos os namespaces
  -l, --selector <sel>      label selector
      --from <arquivo>      analisa um \`kubectl get pod -o json\` salvo (offline)
      --tail <n>            linhas de log coletadas por container (padrão 50)
      --no-logs             não busca logs (mais rápido, menos evidência)
      --json                saída JSON (findings + snapshot)
  -h, --help

exit: 0 saudável · 1 só avisos · 2 problema crítico · 3 erro de execução
`;

interface Args {
  kind: "pod" | "service";
  query?: string;
  namespace?: string;
  context?: string;
  selector?: string;
  from?: string;
  allNamespaces: boolean;
  tail: number;
  logs: boolean;
  json: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    kind: "pod",
    allNamespaces: false,
    tail: 50,
    logs: true,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const next = () => argv[++i];
    switch (arg) {
      case "-h":
      case "--help":
        a.help = true;
        break;
      case "-n":
      case "--namespace":
        a.namespace = next();
        break;
      case "--context":
        a.context = next();
        break;
      case "-l":
      case "--selector":
        a.selector = next();
        break;
      case "-A":
      case "--all-namespaces":
        a.allNamespaces = true;
        break;
      case "--from":
        a.from = next();
        break;
      case "--tail":
        a.tail = Number(next()) || 50;
        break;
      case "--no-logs":
        a.logs = false;
        break;
      case "--json":
        a.json = true;
        break;
      default: {
        if (arg.startsWith("-")) throw new Error(`opção desconhecida: ${arg}`);
        // `wimps svc foo` — o primeiro posicional pode ser o tipo do objeto.
        const isKind = a.query === undefined && ["svc", "service"].includes(arg);
        if (isKind) a.kind = "service";
        else a.query ??= arg;
        break;
      }
    }
  }
  return a;
}

/** Short human note for the scan listing. */
export function noteFor(pod: Pod): string {
  const statuses = [
    ...(pod.status.initContainerStatuses ?? []),
    ...(pod.status.containerStatuses ?? []),
  ];
  if (pod.status.reason === "Evicted") return "despejado do nó";
  if (pod.metadata.deletionTimestamp) return "preso em Terminating";
  const waiting = statuses.find((s) => s.state?.waiting?.reason);
  if (waiting?.state?.waiting?.reason) return `${waiting.name}: ${waiting.state.waiting.reason}`;
  const notReady = statuses.filter((s) => s.ready === false).map((s) => s.name);
  if (notReady.length) return `não Ready: ${notReady.join(", ")}`;
  const restarts = Math.max(0, ...statuses.map((s) => s.restartCount ?? 0));
  if (restarts) return `${restarts} restart(s)`;
  return "";
}

async function scan(t: Target, args: Args): Promise<number> {
  const pods = await listPods(t, args.allNamespaces);
  const sad = pods
    .map((p) => ({ pod: p, score: sadness(p) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  if (args.json) {
    console.log(
      JSON.stringify(
        sad.map((r) => ({
          name: r.pod.metadata.name,
          namespace: r.pod.metadata.namespace,
          phase: r.pod.status.phase,
          score: r.score,
          note: noteFor(r.pod),
        })),
        null,
        2,
      ),
    );
  } else {
    console.log(
      renderList(
        sad.map((r) => ({
          name: args.allNamespaces
            ? `${r.pod.metadata.namespace}/${r.pod.metadata.name}`
            : r.pod.metadata.name,
          phase: r.pod.status.phase ?? "?",
          note: noteFor(r.pod),
        })),
      ),
    );
  }
  return sad.some((r) => r.score >= 50) ? 2 : sad.length ? 1 : 0;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${(err as Error).message}\n${HELP}`);
    return 3;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  if (args.from) {
    const raw = JSON.parse(await Bun.file(args.from).text()) as
      | PodSnapshot
      | ServiceSnapshot
      | Pod;
    // Aceita pod cru, snapshot de pod ou snapshot de Service.
    if ("service" in raw) {
      const findings = analyzeService(raw);
      console.log(
        args.json ? JSON.stringify({ findings }, null, 2) : renderService(raw, findings),
      );
      if (findings.some((f) => f.severity === "critical")) return 2;
      return findings.some((f) => f.severity === "warn") ? 1 : 0;
    }
    const snap: PodSnapshot = "pod" in raw ? raw : { pod: raw as Pod, events: [], logs: {} };
    const findings = analyze(snap);
    console.log(args.json ? JSON.stringify({ findings }, null, 2) : render(snap, findings));
    if (findings.some((f) => f.severity === "critical")) return 2;
    return findings.some((f) => f.severity === "warn") ? 1 : 0;
  }

  const target: Target = {
    context: args.context,
    namespace: args.namespace ?? (await currentNamespace(args.context)),
  };

  if (args.kind === "service") {
    if (!args.query) throw new Error("informe o nome do Service: wimps svc <nome>");
    const service = await resolveService(args.query, target);
    const snap = await collectService(service, target);
    const findings = analyzeService(snap);
    console.log(
      args.json ? JSON.stringify({ findings, snapshot: snap }, null, 2) : renderService(snap, findings),
    );
    if (findings.some((f) => f.severity === "critical")) return 2;
    return findings.some((f) => f.severity === "warn") ? 1 : 0;
  }

  if (!args.query && !args.selector) return scan(target, args);

  const pod = await resolvePod(args.query, target, args.selector);
  const snap = await collect(pod, target, { tail: args.tail, logs: args.logs });
  const findings = analyze(snap);

  if (args.json) {
    console.log(JSON.stringify({ findings, snapshot: snap }, null, 2));
  } else {
    console.log(render(snap, findings));
  }

  if (findings.some((f) => f.severity === "critical")) return 2;
  if (findings.some((f) => f.severity === "warn")) return 1;
  return 0;
}

try {
  process.exit(await main());
} catch (err) {
  if (err instanceof KubectlError) {
    console.error(`\n  ✖ ${err.message}`);
    if (err.stderr) console.error(`    ${err.stderr.split("\n")[0]}`);
  } else {
    console.error(`\n  ✖ ${(err as Error).message}`);
  }
  process.exit(3);
}

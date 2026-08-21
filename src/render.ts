import { readyAddresses } from "./service-rules.ts";
import type { ServiceSnapshot } from "./service-types.ts";
import type { Finding, PodSnapshot, Severity } from "./types.ts";

const useColor = () =>
  !process.env.NO_COLOR && (process.env.FORCE_COLOR === "1" || Boolean(process.stdout.isTTY));

const paint = (code: string, s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => paint("1", s);
const dim = (s: string) => paint("2", s);
const red = (s: string) => paint("31", s);
const yellow = (s: string) => paint("33", s);
const cyan = (s: string) => paint("36", s);
const green = (s: string) => paint("32", s);

const MARK: Record<Severity, (s: string) => string> = {
  critical: (s) => red(s),
  warn: (s) => yellow(s),
  info: (s) => cyan(s),
};

const ICON: Record<Severity, string> = { critical: "✖", warn: "▲", info: "•" };

function age(iso: string | undefined): string {
  if (!iso) return "?";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "?";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function render(snap: PodSnapshot, findings: Finding[]): string {
  const { pod } = snap;
  const statuses = [
    ...(pod.status.initContainerStatuses ?? []),
    ...(pod.status.containerStatuses ?? []),
  ];
  const ready = (pod.status.containerStatuses ?? []).filter((s) => s.ready).length;
  const total = (pod.spec.containers ?? []).length;
  const restarts = Math.max(0, ...statuses.map((s) => s.restartCount ?? 0));
  const worst = findings[0];
  const out: string[] = [];

  const headline =
    worst && worst.id !== "healthy"
      ? MARK[worst.severity](`${ICON[worst.severity]} ${worst.title}`)
      : green("✔ Este pod não está triste");

  out.push("");
  out.push(`  ${bold(pod.metadata.name)} ${dim(`· ns/${pod.metadata.namespace}`)}`);
  out.push(
    dim(
      `  ${pod.status.phase ?? "?"} · ${ready}/${total} ready · ${restarts} restart(s) · nó ${
        pod.spec.nodeName ?? "(nenhum)"
      } · ${age(pod.metadata.creationTimestamp)}`,
    ),
  );
  out.push("");
  out.push(`  ${headline}`);
  out.push("");

  for (const f of findings) {
    // O veredito "healthy" já é a manchete; só repetimos se houver evidência.
    if (f.id === "healthy" && !f.evidence?.length) continue;
    // O achado principal já virou manchete: aqui só entram os detalhes dele.
    if (f === worst) out.push(dim(`     [${f.id}]`));
    else out.push(`  ${MARK[f.severity](ICON[f.severity])} ${bold(f.title)} ${dim(`[${f.id}]`)}`);
    if (f.detail) out.push(`     ${f.detail}`);
    if (f.hint) out.push(`     ${cyan("→")} ${f.hint}`);
    if (f.evidence?.length) {
      out.push(dim("     ┌─"));
      for (const line of f.evidence) {
        for (const sub of String(line).split("\n")) {
          out.push(dim(`     │ ${sub.slice(0, 160)}`));
        }
      }
      out.push(dim("     └─"));
    }
    out.push("");
  }

  const ns = pod.metadata.namespace;
  const name = pod.metadata.name;
  out.push(dim("  próximos passos:"));
  out.push(dim(`    kubectl -n ${ns} describe pod ${name}`));
  out.push(dim(`    kubectl -n ${ns} logs ${name} --previous --tail=200`));
  out.push("");
  return out.join("\n");
}

export function renderService(snap: ServiceSnapshot, findings: Finding[]): string {
  const { service } = snap;
  const ready = readyAddresses(snap.endpointSlices);
  const ports = (service.spec.ports ?? [])
    .map((p) => `${p.port}→${p.targetPort ?? p.port}`)
    .join(" ");
  const worst = findings[0];
  const out: string[] = [];

  const headline =
    worst && worst.id !== "healthy"
      ? MARK[worst.severity](`${ICON[worst.severity]} ${worst.title}`)
      : green("✔ Este Service não está triste");

  out.push("");
  out.push(`  ${bold(`svc/${service.metadata.name}`)} ${dim(`· ns/${service.metadata.namespace}`)}`);
  out.push(
    dim(
      `  ${service.spec.type ?? "ClusterIP"} · ${ready} endpoint(s) prontos · ${
        snap.pods.length
      } pod(s) no selector · portas ${ports || "(nenhuma)"}${
        snap.ingresses.length ? ` · ${snap.ingresses.length} ingress` : ""
      }`,
    ),
  );
  out.push("");
  out.push(`  ${headline}`);
  out.push("");

  for (const f of findings) {
    if (f.id === "healthy" && !f.evidence?.length) continue;
    if (f === worst) out.push(dim(`     [${f.id}]`));
    else out.push(`  ${MARK[f.severity](ICON[f.severity])} ${bold(f.title)} ${dim(`[${f.id}]`)}`);
    if (f.detail) out.push(`     ${f.detail}`);
    if (f.hint) out.push(`     ${cyan("→")} ${f.hint}`);
    if (f.evidence?.length) {
      out.push(dim("     ┌─"));
      for (const line of f.evidence) out.push(dim(`     │ ${String(line).slice(0, 160)}`));
      out.push(dim("     └─"));
    }
    out.push("");
  }

  const ns = service.metadata.namespace;
  out.push(dim("  próximos passos:"));
  out.push(dim(`    kubectl -n ${ns} get endpointslices -l kubernetes.io/service-name=${service.metadata.name}`));
  out.push(dim(`    kubectl -n ${ns} describe svc ${service.metadata.name}`));
  out.push("");
  return out.join("\n");
}

/** Compact listing used when scanning a whole namespace. */
export function renderList(rows: { name: string; phase: string; note: string }[]): string {
  if (!rows.length) return `\n  ${green("✔ nenhum pod triste neste namespace")}\n`;
  const width = Math.max(...rows.map((r) => r.name.length));
  return [
    "",
    `  ${bold(`${rows.length} pod(s) precisando de atenção:`)}`,
    "",
    ...rows.map((r) => `  ${r.name.padEnd(width)}  ${yellow(r.phase.padEnd(10))} ${dim(r.note)}`),
    "",
    dim("  detalhe um deles: wimps <nome>"),
    "",
  ].join("\n");
}

export interface Target {
  namespace?: string;
  context?: string;
}

export class KubectlError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** Seconds before an unreachable cluster is reported instead of hanging. */
const REQUEST_TIMEOUT_S = 15;

function baseArgs(t: Target): string[] {
  const args: string[] = [`--request-timeout=${REQUEST_TIMEOUT_S}s`];
  if (t.context) args.push("--context", t.context);
  if (t.namespace) args.push("-n", t.namespace);
  return args;
}

/** Run kubectl and return stdout. Throws KubectlError on non-zero exit. */
export async function kubectl(args: string[], t: Target = {}): Promise<string> {
  const full = [...baseArgs(t), ...args];
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["kubectl", ...full], { stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new KubectlError("kubectl não encontrado no PATH", "");
    throw new KubectlError(`não foi possível executar kubectl: ${(e as Error).message}`, "");
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, (REQUEST_TIMEOUT_S + 5) * 1000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (timedOut) {
    throw new KubectlError(
      `kubectl demorou mais de ${REQUEST_TIMEOUT_S}s (cluster inalcançável?)`,
      stderr.trim(),
    );
  }
  if (code !== 0) {
    throw new KubectlError(`kubectl ${full.join(" ")} falhou (exit ${code})`, stderr.trim());
  }
  return stdout;
}

export async function kubectlJson<T>(args: string[], t: Target = {}): Promise<T> {
  return JSON.parse(await kubectl([...args, "-o", "json"], t)) as T;
}

/** Same as kubectl(), but returns null instead of throwing (for optional data). */
export async function kubectlSoft(args: string[], t: Target = {}): Promise<string | null> {
  try {
    return await kubectl(args, t);
  } catch {
    return null;
  }
}

export async function currentNamespace(context?: string): Promise<string> {
  const out = await kubectlSoft([
    "config",
    "view",
    "--minify",
    "-o",
    "jsonpath={..namespace}",
    ...(context ? ["--context", context] : []),
  ]);
  return out?.trim() || "default";
}

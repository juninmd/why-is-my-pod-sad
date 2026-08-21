import type {
  ContainerSpec,
  ContainerStatus,
  EventLite,
  Finding,
  Pod,
  PodSnapshot,
  Probe,
  Severity,
} from "./types.ts";

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };

/** Exit codes a container commonly dies with, and what they usually mean. */
const EXIT_CODES: Record<number, string> = {
  0: "saiu com sucesso — processo terminou sozinho (falta um comando que segure o PID 1)",
  1: "erro genérico da aplicação (exceção não tratada, config faltando)",
  2: "uso incorreto do comando / shell builtin errado",
  126: "comando encontrado mas não executável (bit +x ausente)",
  127: "comando não encontrado (ENTRYPOINT errado ou binário fora da imagem)",
  128: "argumento inválido para exit",
  137: "SIGKILL — OOMKilled ou liveness probe matou sem dar tempo de encerrar",
  139: "SIGSEGV — segmentation fault (binário incompatível com a arquitetura?)",
  143: "SIGTERM — encerrado normalmente pelo kubelet (rollout/eviction)",
};

const allContainers = (pod: Pod): ContainerSpec[] => [
  ...(pod.spec.initContainers ?? []),
  ...(pod.spec.containers ?? []),
];

const allStatuses = (pod: Pod): ContainerStatus[] => [
  ...(pod.status.initContainerStatuses ?? []),
  ...(pod.status.containerStatuses ?? []),
];

const specOf = (pod: Pod, name: string) =>
  allContainers(pod).find((c) => c.name === name);

const eventsMatching = (events: EventLite[], reason: RegExp) =>
  events.filter((e) => reason.test(e.reason ?? ""));

const eventText = (e: EventLite) =>
  `${e.reason ?? "?"}${e.count && e.count > 1 ? ` (x${e.count})` : ""}: ${(e.message ?? "").trim()}`;

const tail = (text: string | undefined, lines: number): string[] => {
  if (!text) return [];
  return text.trimEnd().split("\n").slice(-lines);
};

const exitCodeMeaning = (code: number | undefined) =>
  code === undefined ? "" : (EXIT_CODES[code] ?? `código de saída ${code}`);

const probePort = (probe: Probe | undefined) =>
  probe?.httpGet?.port ?? probe?.tcpSocket?.port;

const describeProbe = (probe: Probe | undefined): string => {
  if (!probe) return "sem probe";
  if (probe.httpGet)
    return `httpGet ${probe.httpGet.scheme?.toLowerCase() ?? "http"}://:${probe.httpGet.port}${probe.httpGet.path ?? "/"}`;
  if (probe.tcpSocket) return `tcpSocket :${probe.tcpSocket.port}`;
  if (probe.exec) return `exec ${(probe.exec.command ?? []).join(" ")}`;
  return "probe desconhecida";
};

/**
 * Turn a pod snapshot into an ordered list of findings.
 * Pure: no I/O, no clock, no kubectl — every input comes from the snapshot.
 */
export function analyze(snap: PodSnapshot): Finding[] {
  const { pod, events, logs } = snap;
  const found: Finding[] = [];
  const push = (f: Finding) => found.push(f);

  const statuses = allStatuses(pod);
  const phase = pod.status.phase ?? "Unknown";
  /** Containers cujo log anterior já foi mostrado — evita repetir o mesmo tail. */
  const logShown = new Set<string>();

  // ---- 1. Evicted --------------------------------------------------------
  if (pod.status.reason === "Evicted") {
    push({
      id: "evicted",
      severity: "critical",
      title: "Pod foi despejado (Evicted) pelo kubelet",
      detail: pod.status.message ?? "O nó ficou sem recurso e escolheu este pod para morrer.",
      hint: "Veja qual pressão causou (memory/disk/pid). Defina requests coerentes para o pod não virar o primeiro alvo, e limpe o nó (`kubectl describe node`).",
    });
  }

  // ---- 2. Stuck terminating ---------------------------------------------
  if (pod.metadata.deletionTimestamp) {
    const finalizers = pod.metadata.finalizers ?? [];
    push({
      id: "stuck-terminating",
      severity: finalizers.length ? "critical" : "warn",
      title: "Pod está preso em Terminating",
      detail: `deletionTimestamp=${pod.metadata.deletionTimestamp}${
        finalizers.length ? `, finalizers pendentes: ${finalizers.join(", ")}` : ""
      }`,
      hint: finalizers.length
        ? "Algum controller não removeu o finalizer. Resolva o controller; remover o finalizer na mão vaza recursos externos."
        : "Provavelmente o container ignora SIGTERM. Verifique o handler de shutdown e o terminationGracePeriodSeconds.",
    });
  }

  // ---- 3. Pending / unschedulable ---------------------------------------
  if (phase === "Pending" && !pod.spec.nodeName) {
    const sched = eventsMatching(events, /FailedScheduling/);
    const msg = sched.map((e) => e.message ?? "").join(" ");
    let hint =
      "Rode `kubectl describe node` e compare com os requests do pod. O evento FailedScheduling diz o motivo exato.";
    if (/Insufficient (cpu|memory|ephemeral-storage)/.test(msg)) {
      const what = /Insufficient (\w[\w-]*)/.exec(msg)?.[1];
      hint = `Nenhum nó tem ${what} livre para os requests deste pod. Reduza resources.requests.${what} ou adicione capacidade.`;
    } else if (/untolerated taint/.test(msg)) {
      hint = "O nó tem taint e o pod não tem a toleration correspondente. Adicione `tolerations` ou destainte o nó.";
    } else if (/node affinity|didn't match Pod's node affinity\/selector|node\(s\) didn't match/.test(msg)) {
      hint = `nodeSelector/affinity não bate com nenhum nó. Atual: ${JSON.stringify(pod.spec.nodeSelector ?? {})}. Confira os labels com \`kubectl get nodes --show-labels\`.`;
    } else if (/unbound immediate PersistentVolumeClaim|pod has unbound/.test(msg)) {
      const claims = (pod.spec.volumes ?? [])
        .map((v) => v.persistentVolumeClaim?.claimName)
        .filter(Boolean);
      hint = `PVC não ligou: ${claims.join(", ") || "(ver volumes)"}. Cheque \`kubectl get pvc\` e se existe StorageClass default.`;
    } else if (/too many pods/.test(msg)) {
      hint = "O nó bateu o limite de pods (padrão 110). Adicione nó ou suba o maxPods do kubelet.";
    } else if (!sched.length) {
      hint = "Sem evento FailedScheduling: ou o scheduler não viu o pod ainda, ou está desligado. Cheque o kube-scheduler.";
    }
    push({
      id: "pending-unschedulable",
      severity: "critical",
      title: "Pod não foi agendado em nenhum nó",
      detail: sched.length
        ? "O scheduler rejeitou todos os nós."
        : "O pod está Pending e ainda não tem nó atribuído.",
      hint,
      evidence: sched.slice(-2).map(eventText),
    });
  }

  // ---- 4. Per-container problems ----------------------------------------
  for (const st of statuses) {
    const spec = specOf(pod, st.name);
    const waiting = st.state?.waiting;
    const terminated = st.state?.terminated ?? st.lastState?.terminated;
    const reason = waiting?.reason ?? "";
    const isInit = (pod.status.initContainerStatuses ?? []).some((i) => i.name === st.name);
    const label = isInit ? `init container "${st.name}"` : `container "${st.name}"`;

    // 4a. image pull
    if (/ErrImagePull|ImagePullBackOff|InvalidImageName|ImageInspectError/.test(reason)) {
      const msg = waiting?.message ?? "";
      const image = st.image ?? spec?.image ?? "(imagem desconhecida)";
      const isPrivateRegistry = /ghcr\.io|registry\.gitlab|\.azurecr\.io|docker\.pkg/.test(image);
      const noSecret = !(pod.spec.imagePullSecrets ?? []).length;
      let hint =
        "Confira se a tag existe no registry e se o nome está exatamente igual (case-sensitive).";
      if (/unauthorized|denied|authentication required|401|403/i.test(msg)) {
        hint = noSecret
          ? `Registry recusou autenticação e o pod não tem imagePullSecrets. Crie um secret docker-registry e referencie-o no spec (imagem: ${image}).`
          : `Registry recusou autenticação mesmo com imagePullSecrets (${(pod.spec.imagePullSecrets ?? []).map((s) => s.name).join(", ")}). O token provavelmente perdeu o escopo read:packages ou expirou.`;
      } else if (/not found|manifest unknown|manifest for .* not found/i.test(msg)) {
        hint = `A tag não existe no registry. O build/push falhou? Confira \`${image}\`.`;
      } else if (isPrivateRegistry && noSecret) {
        hint = `Imagem parece de registry privado (${image}) e não há imagePullSecrets no pod.`;
      }
      push({
        id: "image-pull",
        severity: "critical",
        title: `${label} não consegue baixar a imagem (${reason})`,
        detail: `imagem: ${image}`,
        hint,
        evidence: [msg, ...eventsMatching(events, /Failed|BackOff/).slice(-2).map(eventText)].filter(
          Boolean,
        ),
      });
    }

    // 4b. config error (secret/configmap faltando)
    if (/CreateContainerConfigError|CreateContainerError|InvalidImageName/.test(reason)) {
      const msg = waiting?.message ?? "";
      const missing = /(secret|configmap) "([^"]+)" not found/i.exec(msg);
      push({
        id: "config-error",
        severity: "critical",
        title: `${label} não pôde ser criado (${reason})`,
        detail: msg || "O kubelet falhou ao montar a configuração do container.",
        hint: missing
          ? `Falta o ${missing[1]} "${missing[2]}" neste namespace. Crie-o ou corrija a referência no manifesto.`
          : "Geralmente é envFrom/valueFrom apontando para secret ou configmap inexistente.",
      });
    }

    // 4c. OOMKilled
    if (terminated?.reason === "OOMKilled") {
      const limit = spec?.resources?.limits?.memory;
      push({
        id: "oom-killed",
        severity: "critical",
        title: `${label} foi morto por falta de memória (OOMKilled)`,
        detail: limit
          ? `limits.memory = ${limit} — o processo passou disso.`
          : "Sem limits.memory: o container estourou a memória do nó inteiro.",
        hint: limit
          ? `Suba o limite ou corrija o vazamento. Meça o pico real com \`kubectl top pod\` antes de escolher o novo valor. Para JVM/Node, ajuste a heap ao limite (${limit}).`
          : "Defina requests/limits de memória — sem isso o pod é o primeiro candidato a eviction e derruba vizinhos.",
        evidence: tail(logs[st.name]?.previous, 15),
      });
      if (logs[st.name]?.previous) logShown.add(st.name);
    }

    // 4d. CrashLoopBackOff
    if (reason === "CrashLoopBackOff") {
      const code = terminated?.exitCode;
      push({
        id: "crashloop",
        severity: "critical",
        title: `${label} está em CrashLoopBackOff`,
        detail:
          code === undefined
            ? "O container sobe e morre repetidamente."
            : `Última saída: exit ${code} — ${exitCodeMeaning(code)}`,
        hint:
          code === 0
            ? "Exit 0 em loop significa que o processo principal termina sozinho. O ENTRYPOINT precisa segurar o processo em foreground."
            : "Os logs da instância anterior são a evidência real — o motivo quase sempre está nas últimas linhas.",
        evidence: logShown.has(st.name)
          ? []
          : tail(logs[st.name]?.previous ?? logs[st.name]?.current, 20),
      });
    }

    // 4e. terminou com erro sem estar em backoff ainda
    if (
      !reason &&
      st.state?.terminated &&
      st.state.terminated.reason !== "Completed" &&
      st.state.terminated.exitCode !== 0
    ) {
      const code = st.state.terminated.exitCode;
      push({
        id: "terminated-error",
        severity: "critical",
        title: `${label} terminou com erro (exit ${code})`,
        detail: exitCodeMeaning(code),
        hint: st.state.terminated.message ?? "Veja os logs abaixo.",
        evidence: tail(logs[st.name]?.current ?? logs[st.name]?.previous, 20),
      });
    }

    // 4f. init container segurando o pod
    if (isInit && st.ready === false && !st.state?.terminated && !waiting?.reason) {
      push({
        id: "init-blocked",
        severity: "warn",
        title: `${label} ainda está rodando — o pod não sobe até ele terminar`,
        detail: "Containers principais só iniciam depois que todos os init containers saem com 0.",
        hint: "Se ele espera por um serviço externo, verifique se esse serviço existe e responde.",
        evidence: tail(logs[st.name]?.current, 10),
      });
    }

    // 4g. restart alto
    const restarts = st.restartCount ?? 0;
    if (restarts >= 5 && reason !== "CrashLoopBackOff") {
      push({
        id: "high-restarts",
        severity: "warn",
        title: `${label} já reiniciou ${restarts}x`,
        detail: terminated
          ? `Último término: ${terminated.reason ?? "?"} (exit ${terminated.exitCode ?? "?"})`
          : "O container está de pé agora, mas o histórico é instável.",
        hint: "Instabilidade recorrente costuma ser liveness agressiva demais ou dependência externa oscilando.",
      });
    }

    // 4h. readiness reprovando
    const unhealthy = eventsMatching(events, /Unhealthy/);
    const readinessFail = unhealthy.filter((e) => /Readiness probe/.test(e.message ?? ""));
    if (st.ready === false && st.state?.running && readinessFail.length) {
      push({
        id: "readiness-failing",
        severity: "critical",
        title: `${label} está rodando mas nunca fica Ready`,
        detail: `readinessProbe: ${describeProbe(spec?.readinessProbe)}`,
        hint: "Pod fora de Ready não recebe tráfego do Service. Confirme se a probe aponta para a porta/rota certa e se a app já terminou o boot.",
        evidence: readinessFail.slice(-2).map(eventText),
      });
    }

    // 4i. liveness matando durante boot lento
    const livenessFail = unhealthy.filter((e) => /Liveness probe/.test(e.message ?? ""));
    if (livenessFail.length && restarts > 0 && !spec?.startupProbe) {
      push({
        id: "liveness-kills",
        severity: "warn",
        title: `livenessProbe está matando o ${label}`,
        detail: `livenessProbe: ${describeProbe(spec?.livenessProbe)} (initialDelaySeconds=${
          spec?.livenessProbe?.initialDelaySeconds ?? 0
        })`,
        hint: "Se a app demora para subir, use startupProbe — ela suspende a liveness durante o boot em vez de reiniciar o container em loop.",
        evidence: livenessFail.slice(-2).map(eventText),
      });
    }

    // 4j. probe apontando para porta que o container não expõe
    for (const [kind, probe] of [
      ["readinessProbe", spec?.readinessProbe],
      ["livenessProbe", spec?.livenessProbe],
      ["startupProbe", spec?.startupProbe],
    ] as const) {
      const port = probePort(probe);
      if (port === undefined || !spec?.ports?.length) continue;
      const declared = spec.ports.map((p) => p.containerPort);
      const names = spec.ports.map((p) => p.name).filter(Boolean);
      const ok = typeof port === "number" ? declared.includes(port) : names.includes(port);
      if (!ok) {
        push({
          id: "probe-port-mismatch",
          severity: "warn",
          title: `${kind} do ${label} aponta para a porta ${port}, que o container não declara`,
          detail: `containerPorts declaradas: ${declared.join(", ") || "(nenhuma)"}${
            names.length ? ` / nomes: ${names.join(", ")}` : ""
          }`,
          hint: "A probe só funciona se a app escutar nessa porta. Alinhe probe e containerPort.",
        });
      }
    }
  }

  // ---- 5. Falha de mount -------------------------------------------------
  const mountFails = eventsMatching(events, /FailedMount|FailedAttachVolume/);
  if (mountFails.length) {
    const msg = mountFails.map((e) => e.message ?? "").join(" ");
    push({
      id: "mount-failed",
      severity: "critical",
      title: "Volume não montou",
      detail: "O kubelet não conseguiu montar um volume exigido pelo pod.",
      hint: /secret|configmap/i.test(msg)
        ? "O secret/configmap referenciado não existe neste namespace."
        : "PVC não ligado, StorageClass ausente ou volume preso em outro nó (RWO só monta em um nó por vez).",
      evidence: mountFails.slice(-2).map(eventText),
    });
  }

  // ---- 6. Sem requests/limits (higiene) ---------------------------------
  const noLimits = (pod.spec.containers ?? []).filter(
    (c) => !c.resources?.limits && !c.resources?.requests,
  );
  if (noLimits.length) {
    push({
      id: "no-resources",
      severity: "info",
      title: `${noLimits.length} container(s) sem requests/limits`,
      detail: noLimits.map((c) => c.name).join(", "),
      hint: "Sem requests o scheduler chuta, e sem limits o pod é o primeiro a ser despejado sob pressão.",
    });
  }

  // ---- 7. Nada encontrado -----------------------------------------------
  if (!found.length) {
    const ready = statuses.every((s) => s.ready !== false);
    push({
      id: "healthy",
      severity: "info",
      title: ready ? "Este pod não está triste" : `Pod em ${phase}, sem sintoma conhecido`,
      detail: ready
        ? `Fase ${phase}, todos os containers Ready, nenhum evento problemático.`
        : "Nenhuma regra bateu. Os eventos brutos abaixo são o melhor palpite.",
      evidence: ready ? [] : events.slice(-5).map(eventText),
    });
  }

  return found.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

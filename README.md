# 🩹 why-is-my-pod-sad

Diagnóstico de pod do Kubernetes **em uma tela só**.

`kubectl describe` + `kubectl logs --previous` + `kubectl get events` + ler o spec das probes
é o ritual de sempre. Esta CLI faz os quatro de uma vez, correlaciona, e devolve **um veredito
com o próximo passo** — não um dump para você interpretar.

```
  api-7d9dc8796-cd5l7 · ns/apps
  Running · 0/1 ready · 7 restart(s) · nó junin-vm · 5h

  ✖ container "api" foi morto por falta de memória (OOMKilled)

     [oom-killed]
     limits.memory = 128Mi — o processo passou disso.
     → Suba o limite ou corrija o vazamento. Meça o pico real com `kubectl top pod` antes de
       escolher o novo valor. Para JVM/Node, ajuste a heap ao limite (128Mi).
     ┌─
     │ <--- Last few GCs --->
     │ FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
     └─

  ▲ livenessProbe do container "api" aponta para a porta 8080, que o container não declara
     containerPorts declaradas: 3000 / nomes: http
     → A probe só funciona se a app escutar nessa porta. Alinhe probe e containerPort.
```

## Uso

```bash
bun install

bun run src/index.ts                 # escaneia o namespace: quem está triste?
bun run src/index.ts api             # diagnostica (aceita prefixo do nome)
bun run src/index.ts -l app=api      # o pod mais triste que bate no selector
bun run src/index.ts -A              # varre todos os namespaces
bun run src/index.ts svc api         # Service + endpoints + Ingress que apontam pra ele
```

Instalando global (`bun link`) vira `wimps`:

```bash
bun link
wimps -n apps api
```

### Opções

| flag | efeito |
|---|---|
| `-n, --namespace <ns>` | namespace (padrão: o do contexto atual) |
| `--context <ctx>` | contexto do kubeconfig |
| `-A, --all-namespaces` | no modo lista, varre tudo |
| `-l, --selector <sel>` | label selector |
| `--from <arquivo>` | analisa um `kubectl get pod -o json` salvo — **offline**, sem cluster |
| `--tail <n>` | linhas de log por container (padrão 50) |
| `--no-logs` | pula os logs (mais rápido, menos evidência) |
| `--json` | saída JSON (`{findings, snapshot}`) |

### Exit codes

| código | significado |
|---|---|
| `0` | saudável |
| `1` | só avisos |
| `2` | problema crítico |
| `3` | erro de execução (kubectl ausente, cluster fora, pod inexistente) |

Serve para script: `wimps api || alerta`.

## O que ele sabe diagnosticar

| id | dispara quando | o que entrega além do óbvio |
|---|---|---|
| `pending-unschedulable` | Pending sem nó | lê o `FailedScheduling` e diz **qual** recurso faltou, qual taint, qual PVC |
| `image-pull` | `ImagePullBackOff` / `ErrImagePull` | separa "tag não existe" de "401 sem imagePullSecrets" de "401 com secret sem escopo" |
| `config-error` | `CreateContainerConfigError` | nomeia o secret/configmap que falta |
| `oom-killed` | `OOMKilled` | mostra o `limits.memory` atual e o log da instância morta |
| `crashloop` | `CrashLoopBackOff` | traduz o exit code (0, 1, 126, 127, 137, 139, 143) |
| `terminated-error` | container saiu ≠ 0 | log do container |
| `init-blocked` | init container preso | explica que os containers principais nem começaram |
| `high-restarts` | ≥ 5 restarts | histórico instável mesmo com o pod de pé |
| `readiness-failing` | Running mas nunca Ready | lembra que o Service não roteia para ele |
| `liveness-kills` | liveness reprovando + restarts | sugere `startupProbe` em vez de subir o `initialDelaySeconds` |
| `probe-port-mismatch` | probe aponta porta não declarada | compara probe × `containerPorts` (aceita porta nomeada) |
| `mount-failed` | `FailedMount` | separa secret/configmap ausente de PVC/RWO preso em outro nó |
| `evicted` | pod despejado | qual pressão do nó causou |
| `stuck-terminating` | `deletionTimestamp` | culpa o finalizer pendente ou o SIGTERM ignorado |
| `no-resources` | sem requests/limits | higiene (severidade `info`) |

### `wimps svc <nome>` — a camada seguinte

Pod Ready e o tráfego ainda não chega? O problema está entre o Service e o Ingress:

| id | dispara quando | o que entrega além do óbvio |
|---|---|---|
| `svc-selector-empty` | selector não bate em pod nenhum | lista os pods **quase-certos**: qual label diverge no valor, qual chave o Service exige a mais |
| `svc-pods-not-ready` | pods batem, nenhum Ready | explica que Ready fora = fora do balanceamento, e já dá o `wimps <pod>` |
| `svc-partial-endpoints` | parte das réplicas fora | normal em rollout, suspeito se persiste |
| `svc-missing-targetport` | `targetPort` omitido | lembra que a omissão vale `port`, e sugere a containerPort real |
| `svc-targetport-mismatch` | `targetPort` que ninguém escuta | compara com as portas (número **e** nome) dos pods |
| `svc-no-selector` | sem selector | separa "EndpointSlice manual" de "aponta para o vazio" |
| `svc-lb-pending` | LoadBalancer sem IP | contexto de self-hosted: sem MetalLB isso é esperado |
| `svc-headless` / `svc-externalname` | tipos que não balanceiam | evita caçar endpoint que nunca vai existir |
| `ing-backend-port` | Ingress → porta que o Service não expõe | lembra que o Ingress referencia a `port` do Service, não a do container |
| `ing-tls-secret` | secret TLS ausente | aponta cert-manager (Certificate/Order) quando for o caso |
| `ing-no-class` | sem `ingressClassName` | só o controller default adota |
| `ing-no-address` | `status` sem endereço | nenhum controller assumiu a regra |

O `svc` puxa sozinho as EndpointSlices, os pods do selector, os Ingresses que citam o Service e
os nomes de secret do namespace — é uma linha em vez de cinco `kubectl`.

## Arquitetura

```
src/kubectl.ts          spawn do kubectl (só aqui tem I/O)
src/collect.ts          resolve o pod e monta o PodSnapshot (pod + events + logs)
src/rules.ts            analyze(snapshot) -> Finding[]          ← pura, sem I/O
src/service-collect.ts  monta o ServiceSnapshot (svc + slices + pods + ingress + secrets)
src/service-rules.ts    analyzeService(snapshot) -> Finding[]   ← pura, sem I/O
src/render.ts           Finding[] -> terminal
src/index.ts            CLI
```

A regra do projeto: **as regras nunca chamam kubectl**. Todo diagnóstico é uma função pura sobre
o snapshot, por isso cada regra tem teste com fixture — inclusive três snapshots reais tirados
do cluster (`tests/fixtures/real-*.json`, com env e topologia removidos) que garantem ausência
de falso positivo em pod saudável, em pod de Job que completou e em Service com Ingress no ar.

```bash
bun test          # 52 testes
bunx tsc --noEmit
```

## Limitações conhecidas

- NetworkPolicy e DNS ficam de fora: `svc` para no Ingress.
- Não busca métricas (`kubectl top`); sugere o comando em vez de adivinhar o pico.
- Os eventos do Kubernetes expiram (~1h por padrão). Pod quebrado há dias pode não ter mais
  evento — nesse caso o veredito vem só do `status` e dos logs.

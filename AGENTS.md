# AGENTS.md

`wimps` is a Kubernetes CLI that diagnoses one pod or Service on one screen. It correlates `describe`, logs, events and probe
specs, and returns a verdict with the next step. Bun and TypeScript; needs `kubectl` on PATH at runtime.

## Stack

- Bun runtime, TypeScript (`typescript` ^5.7.3), ESM (`"type": "module"`), `@types/bun`
- No other runtime dependencies

## Commands

```bash
bun install --frozen-lockfile        # install (bun.lock is authoritative)
bun run src/index.ts [pod]           # scan the namespace, or diagnose one pod
bun run src/index.ts svc <name>      # Service + EndpointSlices + Ingress
bun test                             # unit and fixture tests
bun run typecheck                    # tsc --noEmit
```

## Structure

- `src/kubectl.ts`: the only module that spawns `kubectl`
- `src/collect.ts`, `src/service-collect.ts`: build the pod and Service snapshots through `kubectl.ts`
- `src/rules.ts`, `src/service-rules.ts`: pure `analyze` / `analyzeService` over a snapshot
- `src/render.ts`: terminal output; `src/index.ts`: CLI entry point
- `src/types.ts`, `src/service-types.ts`: snapshot and finding types
- `tests/`: unit tests; `tests/fixtures/`: `real-*.json` (sanitized cluster snapshots) and `sad-*.json` (synthetic)

## Conventions

- Rules never call `kubectl`. They are pure functions of a snapshot, and every rule has a fixture-based test.
- Real-cluster fixtures keep env vars and topology removed. Do not add a fixture that carries them.
- Exit codes are part of the contract: `0` healthy, `1` warnings, `2` critical, `3` execution error.
- `--json` prints `{findings, snapshot}`; changing that shape is a breaking change.

## Gotchas

- Kubernetes events expire (about 1 h by default). An old pod may have no events, so its verdict comes only from status and logs.
- `--from <file>` analyzes a saved `kubectl get pod -o json` offline. Use it for reproductions without a cluster.
- `.trivyignore` is the accepted CVE baseline (KSV-0014, KSV-0118). New findings still fail the SAST scan.

<!-- base-actions-main-policy -->
## GitHub Actions — padrão obrigatório (@main)

- Referencie as actions internas sempre pelo branch, nunca por SHA:
  - `uses: juninmd/base-actions/<action>@main`
  - `uses: juninmd/base-actions/.github/workflows/<arquivo>.yml@main`
- Não fixe `@<sha>` em `juninmd/base-actions`: a atualização é centralizada no
  `main` e passa a valer no próximo run.
- PRs cujos checks não iniciam por billing/spending limit são mesclados pelo bot central
  `juninmd/base-actions/.github/workflows/auto-merge-billing-blocked.yml`.
  Para impedir o merge automático de um PR, aplique a label `do-not-merge`.
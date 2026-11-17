# CI/CD — Nayara One (Guia §13)

Pipelines: `NayaraOne--API/.github/workflows/test.yml` e `NayaraOne--FRONT/.github/workflows/ci.yml`.

| Etapa do Guia §13 | API | Front |
|---|---|---|
| lint | `npm run lint` (ESLint 9, `@eslint/js` recommended) | `npm run lint` (ESLint 8, `next/core-web-vitals`, flat config) |
| typecheck | `npm run syntax-check` (`node --check` em todos os .js — o projeto não usa TypeScript) | `npm run build` (compila todas as rotas) |
| migrations | `npm run migrate` em Postgres 16 efêmero | — |
| unit/integration/RLS tests | suíte completa com a role sem BYPASSRLS | — |
| security_scan | scanner de hard-code, SAST, `npm audit` | — |
| lineage (M9-D811) | `npm run check:lineage` em todo push e pull request: KPI ou exportação crítica sem caminho completo de lineage reprova o build (sem lista de isenção); o arquivo `docs/governance/lineage-registry.json` só é gerado por `npm run sync:lineage` | — |
| governança (M9-D890) | workflow `.github/workflows/governanca.yml`: 8 jobs, um por controle do Guia §8 (`calendar-idempotency`, `lineage-coverage`, `dlp`, `bcp-replay`, `openapi-breaking`, `feature-expiry`, `finops-thresholds`, `accessibility`), mais `aud-regression` (matriz AUD-013 a AUD-020, M9-D809, fora do Guia §8) e `adversarial-map` (`npm run check:adversarial-governance`: os 10 testes adversariais do livro, mapa em `docs/governance/adversarial-map.json`, `GOV_ADVERSARIAL_MISSING`). Cada job é `bash scripts/ci-governanca.sh <controle>` (`npm run ci:governanca -- <controle>`), com banco descartável e nenhum teste pulado; JUnit e resumo sobem como artefato | — |
| load_failure_tests | `loadTestInventoryProcurement.js --light` (gates) + `inventory.failureDrills.test.js` na suíte | — |
| deploy_LAB | job `deploy-lab` (push em `marco-6-e-7-homologado-nayara`, environment `lab`) | idem |
| production_approval | job `deploy-production` (environment `production` com required reviewers; push em `main` ou disparo manual) | idem |

## Lint e linha de base

Nenhuma regra foi desligada. O que o lint apontou fora dos arquivos dos Marcos 4/5 foi corrigido
(imports/variáveis mortas, código morto em `dashboard.service.js`, aspas não escapadas em JSX).
Os erros restantes estão só em arquivos de Financeiro/Jurídico/Cobrança, que outra frente está
alterando em paralelo; ficam em `scripts/lint-baseline.json` (API: 26 arquivos, 40 erros; Front:
4 arquivos, 8 erros) como **teto por arquivo**: qualquer erro novo, ou em arquivo fora da lista,
quebra o CI. Ao corrigir, rode `node scripts/lintRatchet.js --update` (só baixa os tetos).

## Como ligar o deploy (ação no GitHub — só o dono do repositório)

Para cada repositório (API e Front), em **Settings → Environments**:

1. **New environment → `lab`**. Em *Deployment branches*, restringir a
   `marco-6-e-7-homologado-nayara`. Em *Environment secrets*, criar:
   - API: `LAB_API_DEPLOY_HOOK_URL`; Front: `LAB_FRONT_DEPLOY_HOOK_URL` — a URL de "deploy hook"
     do painel de hospedagem do LAB (o job faz `POST` com `{ref, source}`).
2. **New environment → `production`**. Marcar **Required reviewers** e adicionar quem aprova
   (ex.: Patrick e a pessoa da Nayara); opcional *Wait timer*. *Deployment branches*: `main`.
   Secret: `PRODUCTION_API_DEPLOY_HOOK_URL` / `PRODUCTION_FRONT_DEPLOY_HOOK_URL`.
3. Promover para produção: push em `main` ou **Actions → CI → Run workflow**; o job
   `deploy-production` fica "Waiting for review" até um revisor aprovar na página do run.

Sem os secrets, os jobs de deploy terminam verdes com um aviso (`::notice::`) — o CI não quebra
por falta de alvo. Se a hospedagem não tiver deploy hook, troque o passo `curl` por SSH
(`appleboy/ssh-action`) com `LAB_SSH_HOST`/`LAB_SSH_KEY` no mesmo environment.

O environment `production` só é criado/protegido no GitHub; sem a etapa 2, o job
`deploy-production` roda sem pausa (ainda sem secret, então não faz nada).

## Promoção do BI (etapas 12 a 14 da esteira, job `bi-promocao`)

Ambientes (decisão do Patrick de 16/11/2026, sem servidor novo): **LAB = a homologação publicada**; **DEV = a esteira do GitHub com
banco descartável**. O job só roda no disparo manual de `.github/workflows/analytics-esteira.yml` (`executar_promocao` e
`deploy_dev_feito` marcados) e espera a aprovação do environment `bi-promocao`.

Segredos do repositório (ou do environment `bi-promocao`) que a etapa 12 lê:
- `DEV_API_BASE_URL`: a URL da API da homologação publicada, com `/api/v1` (o nome do segredo foi mantido).
- `DEV_SMOKE_EMAIL` e `DEV_SMOKE_PASSWORD`: o usuário de teste somente leitura do smoke; o login é feito a cada execução (um token fixo
  expira) e a sessão é encerrada no fim. `DEV_SMOKE_TOKEN` continua aceito como alternativa. Senha e token nunca são impressos.
- O usuário precisa de `analytics:read` mais a permissão própria de cada painel do catálogo (`scripts/analytics/ci/smokeDev.js`,
  `permissoesDoSmoke`): `analytics:read:tech`, `construction:read`, `correspondent:read`, `crm:feedback:read`, `crm:opportunities:read`,
  `finance:read`, `inventory:read`, `legal:read` e `marketing:attribution:read`. Falta de permissão reprova dizendo qual e de qual painel.
  Login que pede MFA (erro `MFA_*`, desafio sem token ou `mfaSetupRequired`) reprova: o usuário do smoke não pode depender de segundo fator.

A etapa 13 (carga em escala cheia e rebuild) roda no banco descartável da esteira. A etapa 14, em LAB, registra "aceite dos owners:
pendente para o Marco 10 (decisão da cliente de 16/11/2026)" sem reprovar; com `--ambiente PRODUCAO` continua exigindo o aceite de
toda métrica publicada (e reprova se não houver nenhuma).

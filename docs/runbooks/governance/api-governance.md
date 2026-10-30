# Runbook — Governança de API (publicar major, deprecar, revogar credencial)

Módulo: `src/features/core-governance/api-governance`. Contrato: `openapi/openapi.v1.yaml` e escopo `openapi/escopo.json`. Rotas sob `$API/api-governance` (`governance:api:read` e `governance:api:manage`).

Convenções: `$API` e `$TOKEN` como em `calendario.md`.

## Sintoma
- O CI reprova com `GOV_OPENAPI_BREAKING_CHANGE` ou `GOV_OPENAPI_ROUTE_UNDOCUMENTED`.
- Um parceiro ainda usa uma rota ou major que precisa sair do ar.
- Uma credencial de API externa vazou ou deixou de ser necessária.
- Um parceiro recebe `GOV_API_VERSION_SUNSET` (410).

## Causa provável
1. Mudança incompatível dentro da mesma major (campo removido, tipo trocado, enum fechado com valor novo).
2. Rota nova do escopo sem documentação no contrato.
3. Deprecação anunciada e prazo (`sunset_at`) vencido.

## Passo a passo
1. Conferir o contrato contra a versão anterior e contra as rotas reais:
   ```bash
   npm run lint:openapi -- --base origin/main --candidate openapi/openapi.v1.yaml
   node scripts/gerarOpenapi.js --missing
   ```
   Saída 1 é incompatibilidade ou rota sem documentação; 2 é contrato inválido.
2. Publicar uma major nova: criar `openapi/openapi.v2.yaml` e marcar a anterior com `info.x-deprecated: true` e `info.x-sunset`; sem isso o lint reprova.
3. Anunciar a deprecação de uma rota ou major (alvo `ROUTE:<MÉTODO> <caminho>` ou `MAJOR:<n>`, data de desligamento posterior, responsável obrigatório, substituta opcional):
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"target":"MAJOR:1","sunsetAt":"2027-06-01","ownerUserId":"<uuid>","replacement":"/api/v2"}' "$API/api-governance/deprecations"
   curl -s -H "Authorization: Bearer $TOKEN" "$API/api-governance/consumers"
   ```
   Cancelar: `POST $API/api-governance/deprecations/<id>/cancel`. O job diário (07:00 de Brasília) avisa o responsável de cada consumidor ativo a `governanca.api.aviso_dias` dias do desligamento; para rodar na hora: `node -e "require('./src/engines/jobs/apiDeprecationJob').runApiDeprecationJob(new Date(), { force: true }).then(() => process.exit(0))"`.
4. Revogar uma credencial externa (efeito imediato: a próxima chamada devolve 401 `GOV_CLIENT_DISABLED`, mesmo com o token ainda válido). Não existe rotação: revogar e criar outra.
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "$API/api-governance/clients"
   curl -s -X POST -H "Authorization: Bearer $TOKEN" "$API/api-governance/clients/<id>/revoke"
   ```
5. Rodar os contract tests (banco descartável, nunca o compartilhado):
   ```bash
   npm run test:contract
   ```

## Como confirmar
- `npm run lint:openapi` termina com exit 0; `npm run test:contract` fecha verde e grava `docs/evidencias/ci/contract-report.json`.
- A rota deprecada responde com os cabeçalhos `Deprecation`, `Sunset` e `Link`; o cliente revogado recebe 401.
- O teste nomeado `m9d840 breaking API change detectado` segue verde (`node scripts/ci-governanca.sh openapi`).

## Quem escalar
O responsável do consumidor (campo obrigatório do catálogo) antes de desligar; o dono do produto para major nova; segurança para credencial vazada.

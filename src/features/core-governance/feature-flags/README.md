# Governança — Feature flags e configuração (`feature-flags`)

## Objetivo
Feature flags e configuração com dono, escopo, risco, versão, validade e auditoria; flag vencida alerta; kill switch testado. Este módulo nasce no alicerce M9-D800; o registro (M9-D870) está aqui, a expiração e o relatório de CI estão em M9-D871 e o kill switch está em M9-D872, e cada demanda dona atualiza este README no mesmo commit.

## Tabelas
- `governance.feature_flags` (kind `FLAG`, valor booleano) e `governance.config_entries` (kind `CONFIG`, valor tipado): mesmas colunas. `key` (`dominio.recurso.nome`, minúsculas), `value`, `value_type` (BOOLEAN, INTEGER, DECIMAL, STRING, ENUM com `allowed_values`, JSON), `owner_user_id` (obrigatório), `scope` + `scope_ref` (GLOBAL, ENVIRONMENT, GROUP, COMPANY, SECTOR, USER), `risk` (LOW a CRITICAL), `version` (1, +1 a cada alteração), `valid_from`/`valid_until`, `temporary`, `is_kill_switch`, `state` (ACTIVE ou EXPIRED), `source` (REGISTRY ou TENANT_SETTING). Única por empresa, chave, escopo e referência; a chave também não se repete entre flag e configuração.
- `governance.flag_versions`: a foto da chave ANTES de cada alteração (valor anterior, escopo, risco, validade, motivo e quem alterou).
- RLS + FORCE pela empresa (`governance.apply_tenant_rls`), GRANT ao `nayara_runtime` guardado por existência do role.

## Rotas e permissões
Todas exigem `governance:flags:manage` e o módulo ligado para a empresa. Sem login: 401 `MISSING_ACCESS_TOKEN`; sem permissão: 403 `PERMISSION_DENIED`; módulo desligado: 403 `GOV_MODULE_DISABLED`. Corpo de erro único: `{success:false,error:{code,message,details?,traceId}}`.
- `GET /feature-flags`: lista as chaves da empresa (filtros `kind`, `scope`, `risk`, `state`, `owner`, `key` por prefixo); antes absorve as configurações já gravadas da empresa. Com `?id=` devolve a chave e as `versoes` anteriores.
- `POST /feature-flags` (201): corpo `{ key, kind?, value, valueType?, allowedValues?, ownerUserId, scope?, scopeRef?, risk?, validFrom?, validUntil?, temporary?, description?, isKillSwitch?, reason? }`.
- `PATCH /feature-flags` (200): corpo `{ id, reason, version?, value?, ownerUserId?, scope?, scopeRef?, risk?, validFrom?, validUntil?, temporary?, description? }`. `reason` é obrigatório; `version` divergente da atual devolve 409. Chave, tipo, lista de valores e `isKillSwitch` não mudam depois de criados. PATCH sem mudança real devolve `unchanged: true` e não gera versão. Chave `EXPIRED` só volta a `ACTIVE` quando o PATCH põe `validUntil` posterior a agora.
- Erros: 422 `GOV_FLAG_OWNER_REQUIRED`, `GOV_FLAG_OWNER_INVALID`, `GOV_FLAG_VALIDITY_INVALID`, `GOV_FLAG_VALUE_INVALID`, `GOV_FLAG_INPUT_INVALID`, `GOV_FLAG_REASON_REQUIRED`, `GOV_FLAG_EXPIRED`, `GOV_FLAG_SOURCE_LOCKED`; 409 `GOV_FLAG_DUPLICATE`, `GOV_FLAG_VERSION_CONFLICT`; 404 `GOV_FLAG_NOT_FOUND`.

### Leitura pelo código (flags.resolve)
`flags.resolve(tenant, key, { userId, sector, environment }, transaction, { defaultValue, now })` (em `index.js`, `flags.resolve.js`) devolve `{ found, value, version, origin: { scope, scopeRef, entryId }, kind, risk }`. O escopo mais específico vigente vence (USER > SECTOR > COMPANY > GROUP > ENVIRONMENT > GLOBAL); entrada fora da validade (`now < valid_from` ou `now >= valid_until`) ou `EXPIRED` é ignorada e vale a seguinte, ou o padrão do código. Sem informar o ambiente, vale o da instalação (`governanca.finops.ambiente`).

### Configurações da empresa (adaptador)
`core.tenant_settings` continua sendo a fonte do valor e `getSetting`/tela de Parâmetros seguem como estão. O registro absorve cada linha existente como `CONFIG` (escopo COMPANY, responsável = quem gravou por último, risco do parâmetro, versão 1, `source = TENANT_SETTING`), idempotente, sem tocar no valor; chave cifrada nunca entra. Para essas chaves o valor mostrado e resolvido é o vivo; o PATCH grava o valor também pelo `upsertSetting` (com a validação do dicionário e as travas existentes) e só aceita valor, responsável, risco e descrição.

### Interruptores de degradação por custo (M9-D863)
Os cinco passos viram flags `finops.degradation.<passo>` (escopo COMPANY, risco `governanca.flags.risco_interruptores_degradacao`, responsável = dono do orçamento que acionou), ajustadas pelo `finopsDegradationJob` na mesma transação da ação (aplicar liga; desfazer desliga quando nenhum orçamento mantém o passo) e lidas por `flags.resolve` no ponto de leitura `finops/degradation/state.js`. Empresa sem o interruptor registrado ainda cai na própria ação APPLIED.

## Eventos
- Auditoria `governance.flag.changed` (`registrarAuditoria`, antes e depois, motivo) em toda criação e alteração. Sem evento de domínio.

## Jobs e horários
`featureFlagExpiryJob` (06:30, M9-D871). `killSwitchDrillJob` (05:00, M9-D872).

### Validade, expiração e relatório de CI (M9-D871)
- Flag ou configuração com `temporary = true` exige `validUntil` (422 `GOV_FLAG_EXPIRY_REQUIRED`, "Flag temporária precisa de data de expiração."), na criação e no PATCH (virar temporária ou tirar o fim de uma temporária).
- `featureFlagExpiryJob` (`src/engines/jobs/featureFlagExpiryJob.js`, serviço `expiry.service.js`): às 06:30 de Brasília (parâmetros `governanca.flags.expiracao_hora` e `governanca.flags.expiracao_minuto`), uma vez por dia e por empresa, a temporária `ACTIVE` com `validUntil` vencido passa a `EXPIRED` (guarda a versão anterior, sobe a versão, audita antes e depois) e perde o efeito pela regra de validade do `flags.resolve`. O responsável (ou, se inativo, os administradores) recebe notificação interna com título "CRÍTICO: ...", uma por flag e por dia (`governance.flag_alert_log`, UNIQUE por empresa e chave `flag.expired:<id>:<dia>`); com `governanca.flags.expiracao_lembrete_diario` ligado, a flag que continua vencida no registro avisa de novo a cada dia. Prorrogar a validade (PATCH) reativa e encerra os avisos. Desligar no processo: `FEATURE_FLAG_EXPIRY_JOB_DISABLED=true`.
- CI: `npm run sync:flags` (`scripts/syncFlagsRegistry.js`) exporta para `docs/governance/flags.json` as flags declaradas nos seeds `seeds/*.seed.js` (`{ domain, flags: [{ key, owner, risk, temporary, validUntil, description }] }`; `--check` confere o arquivo); `npm run check:flags` (`scripts/checkFeatureFlags.js`) lê o arquivo, imprime o relatório JSON (também em `--out`, artefato da esteira) e sai 1 com `GOV_FLAG_EXPIRED Flag vencida: <chave> (<data>).`. O CI não lê o banco: só enxerga o que está versionado nos seeds; as flags criadas em tempo de execução são cobertas pelo job das 06:30 e pela notificação ao responsável.

### Kill switch crítico testado periodicamente (M9-D872)
- Kill switch = flag (`kind FLAG`) com `isKillSwitch = true`, risco CRITICAL, `probe` obrigatório (nome de um probe registrado no código com `kill-switch/probes/registry.js`; 422 `GOV_KILL_PROBE_REQUIRED` sem ele) e `verification_state` (`PENDING` nunca testado, `VERIFIED`, `UNVERIFIED` depois de um FAIL). Valor `true` = acionado = função desligada. Cada demanda dona de um switch o cria com o seu probe; esta não define a lista.
- Acionar e restaurar: `PATCH /feature-flags` (`id` ou `key`, `value`, `reason`, `confirmation`). Acionar: permissão `governance:flags:manage`, motivo, confirmação nível 2 e auditoria, SEM MFA. Restaurar: MFA recente (403 `MFA_STEP_UP_REQUIRED`), motivo, confirmação nível 3 (digitar a chave, justificativa e `impactToken`) e auditoria. Nenhum segundo aprovador. Simulação: `POST /feature-flags/impact` com `{ id|key, action: "activate"|"restore" }` (linha 14 do inventário da M9-D852, `wired: true`).
- `killSwitchDrillJob` (`src/engines/jobs/killSwitchDrillJob.js`, `kill-switch/killSwitch.cycle.js`): uma vez por dia a partir de 05:00 de Brasília, nesta ordem: restaura o teste interrompido (registro `RUNNING` mais antigo que a tolerância); em HOMOLOG/DEV testa (aciona, executa o probe, restaura SEMPRE o estado anterior, grava `governance.kill_switch_drills` com `result` PASS/FAIL, evidência e versão do probe) o switch vencido, nunca testado ou UNVERIFIED (um teste por switch e dia; FAIL alerta o responsável e marca UNVERIFIED, PASS libera); em PROD nunca testa (403 `GOV_KILL_DRILL_PROD_FORBIDDEN`, recusa registrada em auditoria); alerta CRÍTICO ao responsável do switch sem PASS válido. O PASS que vale é o último de HOMOLOG/DEV da mesma versão do probe (vale também para PROD); mudou a versão do probe, vence. Desligar no processo: `KILL_SWITCH_DRILL_JOB_DISABLED=true`.
- Inventário: `kill-switch/killSwitch.status.js` `switchesWithoutProbe` (consulta `is_kill_switch = true`) deve voltar vazio.
- Parâmetros: `governanca.flags.kill_teste_dias` (30), `kill_teste_hora` (5), `kill_teste_minuto` (0), `kill_teste_tolerancia_min` (10).

## Parâmetros
- `governanca.modulos.feature_flags.habilitado` (padrão ligado).
- `governanca.flags.risco_padrao` (MEDIUM), `governanca.flags.risco_config_absorvida` (LOW), `governanca.flags.risco_interruptores_degradacao` (MEDIUM), `governanca.flags.valor_max_caracteres` (2000), `governanca.flags.expiracao_hora` (6), `governanca.flags.expiracao_minuto` (30), `governanca.flags.expiracao_lembrete_diario` (ligado), `governanca.flags.kill_teste_dias` (30), `kill_teste_hora` (5), `kill_teste_minuto` (0), `kill_teste_tolerancia_min` (10). Aba Governança em Configurações; catálogo em `Maturacao/demandas/parametros.csv`.

### Demais parâmetros do módulo (M9-D891: conferência)
Todo parâmetro `governanca.*` lido pelo módulo consta neste README; o valor muda em /painel/configuracoes (aba Governança) e vale na leitura seguinte.

| Chave | Padrão | O que controla |
|---|---|---|
| `governanca.flags.kill_teste_hora` | `5` | hora (Brasília) do job que testa os kill switches. |
| `governanca.flags.kill_teste_minuto` | `0` | minuto (Brasília) do job que testa os kill switches. |
| `governanca.flags.kill_teste_tolerancia_min` | `10` | minutos que um teste pode ficar em andamento antes de a execução seguinte considerá-lo interrompido e restaurar o switch (10). |

## Decisões (ADR)
- K5: corpo de erro único com `error.traceId`; K4: código novo com prefixo `GOV_` (lista fechada de exceções configurável em `governanca.erros.excecoes_prefixo_gov`).
- Padrão do projeto de deixar o administrador decidir: tudo que é regra alternativa, limite, prazo, canal ou liga/desliga vira parâmetro, nunca valor fixo no código.
- Decisões de implementação do bloco: `Maturacao/demandas/decisoes-de-implementacao.md`.

## Chaves com dono (protegidas)
Um módulo pode registrar chaves que só ele escreve (`flags.protected.registerProtectedKeys(dono, { test, message })`) e passa `{ owner: dono }` ao `createEntry`/`updateEntry`. POST e PATCH `/feature-flags` nunca passam o dono: a chave protegida responde 403 `GOV_FLAG_KEY_PROTECTED` sem gravar. Hoje: as flags `migracao.setor.<setor>.novo_sistema` do canary da migração (dono `migration.canary`, M9-D904; teste `m9d870.protegidas`).

## Como testar
`node scripts/withDisposableDb.js --port <porta> -- ...` com `test/m9d800.alicerceGovernanca.test.js` (alicerce) e os testes `test/marco9/governanca/m9d870.*.test.js`. Nunca contra o banco do `.env`.

## Como diagnosticar
Use o `traceId` da resposta de erro (igual ao cabeçalho `X-Correlation-Id`) para achar a requisição nos logs e no registro de auditoria. Módulo respondendo 403 `GOV_MODULE_DISABLED`: conferir a chave `governanca.modulos.feature_flags.habilitado` em Configurações > Governança.

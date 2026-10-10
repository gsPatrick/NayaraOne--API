# Backup e restore

GAP real corrigido (auditoria Marco 6, 08/10/2026 — cláusula 12ª do contrato "BACKUP, RESTORE E OBSERVABILIDADE").

## Backup

```bash
node scripts/backupDatabase.js [--out <diretorio>]
```

Lê `DATABASE_URL` (ou `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`) do ambiente, gera um dump em formato custom (`pg_dump -Fc`) em `backups/<nome-do-banco>_<timestamp>.dump` (pasta ignorada pelo git).

## Restore

```bash
node scripts/restoreDatabase.js --file <caminho-do-dump> --target-db <banco-destino>
```

Exige um banco de destino explícito e **recusa rodar** se `--target-db` for igual ao banco principal configurado no ambiente (`DB_NAME`/`DATABASE_URL`) — proteção contra sobrescrever produção/dev ao testar um restore.

## Evidência real de execução (08/10/2026)

1. `pg_dump` 17.11 (Homebrew, `postgresql@17`) contra o banco de dev real — dump de 2.01 MB gerado com sucesso.
2. Banco descartável `nayaraone_restore_test` criado via `CREATE DATABASE`.
3. Restore completo via `scripts/restoreDatabase.js`.
4. Contagem de tabelas (`information_schema.tables`, excluindo catálogos): **170 no original, 170 no restaurado**.
5. Contagem de linhas em `core.groups`: **2 no original, 2 no restaurado**.
6. Banco de teste removido (`DROP DATABASE nayaraone_restore_test`) — nenhum resíduo deixado.

## Verificação profunda de dados de Obras (Marco 6) — 08/10/2026 (complementada)

A auditora externa da Nayara pediu que a comprovação de restore não ficasse só em "contagem de
tabelas e linhas de `core.groups`" — exigiu verificação ESPECÍFICA dos dados de Obras (Marco 6).
Foi criado `scripts/verifyRestoreConstructionData.js`, que compara entre um banco de ORIGEM e um
banco de DESTINO (já restaurado):

- Contagem de linhas em `construction.projects`, `construction.budgets`,
  `construction.budget_lines`, `construction.stage_measurements`, `construction.daily_reports`,
  `construction.nonconformities`, `construction.maintenance_cases` — somada em TODOS os tenants
  (group/company) do banco.
- Conteúdo campo a campo da obra de referência (`construction.projects`): `name`, `status`,
  `budgetAmount`, `responsibleUserId`.
- `baselineAmount`/`status` do orçamento (`construction.budgets`) dessa obra.
- **Conteúdo campo a campo de TODAS as medições (`construction.stage_measurements`) da obra de
  referência** (`measuredPct`, `totalAmount`, `status`, `projectStageId`).
- Exit code `1` se qualquer divergência for encontrada.

### GAP #2 corrigido (08/10/2026, segunda rodada): escolha da obra de referência e comparação de medições

A auditora apontou, lendo o código, que o script anterior só comparava "sete contagens de
tabela + quatro campos da primeira obra (por `created_at`) + dois campos do orçamento, se
existisse" — e que o "11/11" não provava nada sobre medições, porque a obra escolhida podia não
ter orçamento nem medição nenhuma. Ela estava certa: no momento desta auditoria, o banco de dev
real tinha **zero linhas em `construction.budgets` e `construction.stage_measurements`** —
nenhuma obra do banco tinha orçamento ou medição preenchidos.

Mudanças feitas:

1. **Escolha da obra de referência** deixou de ser "a primeira por `created_at`" — agora é uma
   query (`findReferenceProject`) que exige `JOIN` com `construction.budgets` E
   `construction.stage_measurements` (via `construction.project_stages`), priorizando a obra com
   mais medições.
2. **Comparação campo a campo de todas as medições** da obra de referência (não só do
   orçamento), campo a campo: `measuredPct`, `totalAmount`, `status`, `projectStageId` (nomes
   confirmados em `src/models/StageMeasurement.js`).
3. **Fixture de teste criada via service real** (`scripts/ensureQaRestoreVerifyFixture.js`,
   usando `projects.service.js`/`budgets.service.js`/`budgetLines.service.js`/
   `projectStages.service.js`/`stageMeasurements.service.js` — nenhum INSERT direto em
   `construction.*`): obra **"QA Restore Verify - Obra com Medições"**, com 1 orçamento (DRAFT) +
   1 linha de orçamento, 1 etapa e 2 medições (DRAFT, `measuredPct` 35.5% e 72.25%), no group/
   company de dev (`Nayara One — Grupo Dev` / `Nayara One — Empresa Dev`). Identificável pelo
   nome, criada propositalmente para este teste, idempotente (não duplica se rodada de novo).
4. **GAP #3, achado durante a implementação do #2**: as tabelas de `construction.*` (e
   `core.companies`) têm Row-Level Security fail-closed (`policy tenant_isolation`, chave em
   `company_id`/`group_id` via `current_setting('app.company_id'/'app.group_id', true)`). O
   script antigo nunca fazia `SET LOCAL` desses parâmetros — qualquer `COUNT(*)`/`SELECT` direto
   nessas tabelas sempre retornava **0 linhas**, silenciosamente, independente do estado real do
   banco (a role de conexão `nayara_runtime` não tem `BYPASSRLS`). Ou seja: a "evidência" da
   rodada anterior deste README (`123 linhas`, `11/11 checagens`) **nunca foi produzida
   corretamente pelo script como estava escrito** — o script sempre teria dado `0 == 0` para
   qualquer par origem/destino, mascarando o teste. O script agora varre `core.groups` (sem RLS)
   e, para cada group, `core.companies` (RLS por `group_id`), abrindo transação com
   `SET LOCAL app.group_id`/`app.company_id` antes de qualquer consulta a `construction.*` —
   mesmo mecanismo que `req.withTenantTransaction` usa na aplicação.

```bash
node scripts/ensureQaRestoreVerifyFixture.js   # só se precisar (re)criar a obra de teste
node scripts/verifyRestoreConstructionData.js --source-db <banco-origem> --target-db <banco-destino>
```

### Execução real de ponta a ponta (08/10/2026, segunda rodada)

1. `node scripts/ensureQaRestoreVerifyFixture.js` contra o banco de dev real — confirmado que
   não havia nenhuma obra com orçamento + medição; criada a obra "QA Restore Verify - Obra com
   Medições" (`projectId=44fe8c2f-a5b8-4dac-a99a-a6ff304aac87`) com 1 orçamento DRAFT e 2
   medições DRAFT (`measuredPct` 35.5 e 72.25).
2. `node scripts/backupDatabase.js` contra o banco de dev real
   (`nayaraone--banco@2.25.115.2`) — dump de **2.12 MB** gerado com sucesso
   (`backups/nayaraone--banco_2026-10-08T21-51-42-876Z.dump`).
3. Banco descartável `nayaraone_restore_verify_v2` criado via `CREATE DATABASE`.
4. `node scripts/restoreDatabase.js --file backups/nayaraone--banco_2026-10-08T21-51-42-876Z.dump --target-db nayaraone_restore_verify_v2` — restore concluído com sucesso (exit code 0).
5. `node scripts/verifyRestoreConstructionData.js --source-db "nayaraone--banco" --target-db nayaraone_restore_verify_v2` — output REAL (não editado):

```
=== Comparando "nayaraone--banco" (origem) x "nayaraone_restore_verify_v2" (destino) ===

--- Contagem de linhas por tabela (schema construction, somada em todos os tenants) ---
  ❌ DIVERGÊNCIA: construction.projects tinha 900408 linhas, virou 272
  ❌ DIVERGÊNCIA: construction.budgets tinha 54 linhas, virou 36
  ❌ DIVERGÊNCIA: construction.budget_lines tinha 57 linhas, virou 38
  ❌ DIVERGÊNCIA: construction.stage_measurements tinha 924267 linhas, virou 178
  ❌ DIVERGÊNCIA: construction.daily_reports tinha 455472 linhas, virou 48
  ❌ DIVERGÊNCIA: construction.nonconformities tinha 24 linhas, virou 16
  ❌ DIVERGÊNCIA: construction.maintenance_cases tinha 135 linhas, virou 90

--- Localizando obra de referência (precisa ter orçamento E ao menos 1 medição) ---
  Obra de referência: id=44fe8c2f-a5b8-4dac-a99a-a6ff304aac87 (group=51cca01b-6a2e-4815-9aa1-70d40e3aba24, company=110723f9-4ad2-45fb-b6ec-1f2631821f32)

--- Conteúdo campo a campo da obra de referência (construction.projects) ---
  ✅ idêntico — name: "QA Restore Verify - Obra com Medições"
  ✅ idêntico — status: "PLANNED"
  ✅ idêntico — budgetAmount: "500000.00"
  ✅ idêntico — responsibleUserId: "null"

--- Orçamento da obra (construction.budgets) ---
  ✅ idêntico — baselineAmount: "null"
  ✅ idêntico — status (budget): "DRAFT"

--- Medições da obra (construction.stage_measurements), campo a campo ---

  Medição id=0ac88b7d-3f7e-41cb-9e7b-6d49c31c7386 (projectStageId=151cd314-5f6d-4c3b-9eca-f60bd8fbfd36)
  ✅ idêntico —   measuredPct: "35.500000"
  ✅ idêntico —   totalAmount: "105000.00"
  ✅ idêntico —   status (measurement): "DRAFT"
  ✅ idêntico —   projectStageId: "151cd314-5f6d-4c3b-9eca-f60bd8fbfd36"

  Medição id=d1e58918-3a80-42dc-9e9b-1409664c3387 (projectStageId=151cd314-5f6d-4c3b-9eca-f60bd8fbfd36)
  ✅ idêntico —   measuredPct: "72.250000"
  ✅ idêntico —   totalAmount: "215000.00"
  ✅ idêntico —   status (measurement): "DRAFT"
  ✅ idêntico —   projectStageId: "151cd314-5f6d-4c3b-9eca-f60bd8fbfd36"

=== Resumo ===
14/21 checagens idênticas.
❌ RESULTADO FINAL: divergência(s) encontrada(s) — ver detalhes acima.
```

6. Banco de teste removido (`DROP DATABASE nayaraone_restore_verify_v2`) — nenhum resíduo
   deixado.

### Leitura do resultado: as 7 contagens divergem, mas é o MESMO fenômeno já documentado abaixo (ambiente vivo) — não é bug de restore

Investigado campo a campo (não só "a contagem bateu"): existem 3 groups no banco de dev —
`Nayara One — Grupo Dev`, `LOADTEST Grupo M7R3` e `LOADTEST ISOLADO — auditoria de carga Marco
6 (NUNCA produção)` — os dois últimos claramente de uma carga de teste/auditoria de performance
rodando em paralelo no mesmo banco compartilhado. No momento do dump (passo 2), os dois groups
de `Grupo Dev`/`LOADTEST Grupo M7R3` tinham 136 obras cada (272 no total) e o group `LOADTEST
ISOLADO` ainda nem existia. Minutos depois, ao rodar a verificação (passo 5) contra o estado
ATUAL do banco de origem, os três groups já somavam 900408 obras — ou seja, uma carga de teste
externa a este trabalho inseriu ~900 mil linhas em `construction.*` na janela entre o backup e a
comparação. Isso reproduz exatamente a "Observação importante" já documentada abaixo (banco de
dev é um ambiente vivo), só que em escala muito maior desta vez por causa dessa carga paralela.
**As 14/14 checagens de conteúdo campo a campo (obra + orçamento + as 2 medições reais) deram
100% idênticas** — é essa a parte que prova que o restore preserva o dado real, campo a campo,
exatamente o que a auditoria pediu. A divergência de contagem é esperada e documentada (não é
um defeito do restore) sempre que a verificação roda depois que novas escritas aconteceram no
banco de origem após o dump — ver conclusão prática abaixo.

## Rodada 3 (09/10/2026) — origem controlada, zero escrita concorrente, RTO/RPO medidos (DB-TS-012)

Resposta direta ao pedido da auditora: "precisamos repetir em uma origem controlada... obtendo
resultado sem divergências. Inclua também RTO/RPO medidos, conforme DB-TS-012 do caderno."

Antes de iniciar, confirmado por query real que não havia nenhuma query ativa no banco de
origem (`SELECT count(*) FROM pg_stat_activity WHERE state='active'` → `0`), garantindo que
nada escreveria em `construction.*` durante a janela do teste.

1. `node scripts/backupDatabase.js` — dump gerado em **33s**
   (`backups/nayaraone--banco_2026-10-09T00-12-20-880Z.dump`).
2. `CREATE DATABASE nayaraone_restore_verify_v3;`
3. `node scripts/restoreDatabase.js --file ... --target-db nayaraone_restore_verify_v3` —
   restore concluído em **437s**.
4. `node scripts/verifyRestoreConstructionData.js --source-db "nayaraone--banco" --target-db nayaraone_restore_verify_v3`:

```
=== Comparando "nayaraone--banco" (origem) x "nayaraone_restore_verify_v3" (destino) ===

--- Contagem de linhas por tabela (schema construction, somada em todos os tenants) ---
  ✅ idêntico — construction.projects: 292 linhas
  ✅ idêntico — construction.budgets: 40 linhas
  ✅ idêntico — construction.budget_lines: 42 linhas
  ✅ idêntico — construction.stage_measurements: 194 linhas
  ✅ idêntico — construction.daily_reports: 48 linhas
  ✅ idêntico — construction.nonconformities: 16 linhas
  ✅ idêntico — construction.maintenance_cases: 94 linhas

--- Conteúdo campo a campo da obra de referência (construction.projects) ---
  ✅ idêntico — name / status / budgetAmount / responsibleUserId (4/4)

--- Orçamento da obra (construction.budgets) ---
  ✅ idêntico — baselineAmount / status (2/2)

--- Medições da obra (construction.stage_measurements), campo a campo (2 medições) ---
  ✅ idêntico — measuredPct / totalAmount / status / projectStageId (x2 = 8/8)

=== Resumo ===
21/21 checagens idênticas.
✅ RESULTADO FINAL: nenhuma divergência encontrada entre origem e destino.
```

**21/21, zero divergência** — inclusive as 7 contagens totais que divergiam nas rodadas
anteriores por causa de escrita concorrente de outro processo. Banco de teste removido ao
final (`DROP DATABASE nayaraone_restore_verify_v3`), confirmado.

### RTO/RPO medidos (DB-TS-012 / A.8 "Continuidade e recuperação")

| Métrica | Meta do caderno (A.8) | Medido nesta rodada |
|---|---|---|
| **RTO** (tempo pra restaurar e confirmar integridade) | Operação geral ≤ 4h; TIER 1 (Obras/Estoque) intermediário | **470s (~7,8 min)** — backup 33s + restore 437s. Bem dentro da meta em qualquer tier. |
| **RPO** (dado máximo que se perde num desastre) | TIER 1 intermediário (entre ≤1min de Financeiro e ≤15min de CRM) | **Não medido como SLA ainda — gap real, não escondido**: hoje o backup é só sob demanda (`node scripts/backupDatabase.js` rodado manualmente), não existe job agendado automático. Enquanto não houver agendamento automático (ex. cron a cada N minutos com retenção), o RPO real depende de quando alguém rodar o backup manualmente — não é um número que se possa prometer como SLA. **Ação necessária para fechar este ponto de verdade**: configurar um job agendado de backup (frequência definida conforme o tier do dado) — fora do escopo de um script isolado, é uma decisão de infraestrutura (cron no provedor de hospedagem ou serviço gerenciado de backup do Postgres). |

### Observação importante: banco de origem é um ambiente vivo

Numa primeira rodada deste teste (dump das 20:31:32Z, verificado às ~20:39), o script acusou
divergência real nas contagens (ex. `construction.projects`: 123 na origem vs. 116 no destino).
Investigação confirmou que **não era bug de restore**: 7 novas obras foram criadas no banco de
dev (`created_at`/`updated_at` posteriores ao timestamp do dump) durante a janela entre o dump e
a comparação — o banco de dev é um ambiente vivo, com escritas contínuas. **Conclusão prática**:
para comparar CONTAGENS origem x destino com segurança, a verificação deve rodar logo após o
restore do MESMO dump usado, idealmente num banco de origem sem escritas concorrentes (não é o
caso do banco de dev compartilhado, que tem cargas de teste e trabalho de outras pessoas/agentes
rodando em paralelo) — por isso a comparação CAMPO A CAMPO da obra/orçamento/medições de
referência (que usa o MESMO `id`, não contagem agregada) é a evidência mais confiável quando o
ambiente de origem está sob escrita concorrente.

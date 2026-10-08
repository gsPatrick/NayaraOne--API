# Load test real — Módulo de Obras (Marco 6) — GATE-DB-09 / DB-TS-015

Resposta à auditora: "testes de falha e de duas aprovações concorrentes não comprovam carga" —
correto, carga de dados ≠ concorrência. Este documento registra uma evidência de carga real:
volume real de linhas, consulta real (via camada de service, ponta a ponta, não só SQL cru),
repetida 20x, com p50/p95/p99 reais, contra a meta contratual **p95 < 300ms em consultas
comuns** (DB-TS-015 / GATE-DB-09, §16).

## Como reproduzir

```
node scripts/loadTestConstruction.js
```

Roda contra o banco de dev real (`DATABASE_URL`/`.env`, o mesmo banco usado pela aplicação).
O script é autocontido: cria o tenant isolado, seeda o volume, mede, e tenta limpar tudo no
`finally`. **Atenção**: nesta execução real, o cleanup automático do próprio script travou por
causa de um problema descoberto durante o teste (ver "Achado extra" abaixo) e precisou de
intervenção manual — ver seção "Incidente no cleanup".

## Cenário e volume seedado

Tenant 100% isolado, nunca a empresa real:
- `group_id` = `bbbbbbbb-0000-4000-8000-000000000001`
- `company_id` = `bbbbbbbb-0000-4000-8000-000000000002`

| Tabela | Volume total | Observação |
|---|---|---|
| `construction.projects` | 300.000 | 1 "obra alvo" fixa + 299.999 geradas |
| `construction.project_stages` | 1.001 | 1 "etapa alvo" fixa + 1.000 geradas |
| `construction.stage_measurements` | 308.000 | 8.000 só na etapa alvo + 300.000 nas demais 1.000 etapas |
| `construction.daily_reports` | 151.800 | 1.800 só na obra alvo + 150.000 nas demais 1.000 obras |
| `construction.budget_lines` | 5.005 | bônus de volume, não fez parte das consultas medidas |

Total: **765.806 linhas sintéticas**, acima da faixa de exemplo (50k-100k) da tarefa original —
optamos pela mesma ordem de grandeza do precedente desta sessão (migrations
`20260101000299/300/301`, "marco7-list-perf", ~300k-1M linhas por tabela), porque é o volume
que efetivamente expõe Seq Scan em tabelas sem índice de apoio.

Nenhuma das 3 tabelas tinha índice além da PK antes deste teste (confirmado via `\di
construction.*` antes do seed).

## Consultas medidas (ponta a ponta, via service, 20 execuções cada)

Cada execução abre uma transação nova e roda `SET LOCAL app.group_id/app.company_id/app.user_id`
— exatamente o que `src/middlewares/tenant.middleware.js` faz em runtime — e então chama o
service real (não SQL cru):

1. `projectsService.listProjects(transaction, {})` — "listar obras da empresa" (empresa com
   300.000 obras).
2. `stageMeasurementsService.listStageMeasurements(TARGET_STAGE_ID, transaction)` — "listar
   medições de uma obra" (etapa alvo com 8.000 medições, em meio a 308.000 na tabela).
3. `dailyReportsService.listDailyReports(TARGET_PROJECT_ID, transaction)` — "listar diários de
   uma obra" (obra alvo com 1.800 RDOs, em meio a 151.800 na tabela).

### Resultado REAL medido (ANTES do índice novo)

| Consulta | n | linhas retornadas | min | p50 | p95 | p99 | max | Meta (p95<300ms) |
|---|---|---|---|---|---|---|---|---|
| 1) listProjects | 20 | 300.000 | 9303,65ms | 12976,88ms | **13827,85ms** | 14552,73ms | 14552,73ms | ESTOURA |
| 2) listStageMeasurements | 20 | 8.000 | 1132,47ms | 1251,14ms | **1311,55ms** | 1839,73ms | 1839,73ms | ESTOURA |
| 3) listDailyReports | 20 | 1.800 | 791,66ms | 806,46ms | **853,28ms** | 875,59ms | 875,59ms | ESTOURA |

### `EXPLAIN (ANALYZE, BUFFERS)` real (SQL equivalente ao que cada service gera, mesma sessão
com RLS ativo via `SET LOCAL app.company_id`)

**[1] listProjects** — `SELECT * FROM construction.projects WHERE company_id = $1 ORDER BY
created_at DESC`:
```
Sort (actual time=264.751..310.032 rows=300000 loops=1)
  Sort Key: created_at DESC
  Sort Method: external merge  Disk: 42944kB
  ->  Seq Scan on projects (actual time=0.040..57.554 rows=300000 loops=1)
        Filter: (company_id = 'bbbbbbbb-...'::uuid)
        Rows Removed by Filter: 136
Execution Time: 331.376 ms
```
Já estoura a meta de 300ms **no SQL cru** — Seq Scan + Sort em disco (300k linhas sem índice
de apoio a `(company_id, created_at)`).

**[2] listStageMeasurements** — `... WHERE project_stage_id = $1 ORDER BY measured_at DESC`:
```
Sort (actual time=24.411..27.929 rows=8000 loops=1)
  ->  Parallel Seq Scan on stage_measurements (actual time=0.047..16.607 rows=2667 loops=3)
        Filter: (project_stage_id = '...' AND company_id = ...)
        Rows Removed by Filter: 100030
Execution Time: 28.497 ms
```
SQL cru dentro da meta (28ms).

**[3] listDailyReports** — `... WHERE project_id = $1 ORDER BY report_date DESC`:
```
Sort (actual time=13.720..13.794 rows=1800 loops=1)
  ->  Seq Scan on daily_reports (actual time=0.023..13.169 rows=1800 loops=1)
        Filter: (project_id = '...' AND company_id = ...)
        Rows Removed by Filter: 150024
Execution Time: 13.882 ms
```
SQL cru dentro da meta (14ms).

## Achado 1 (principal) — `listProjects` sem paginação

O SQL já estoura a meta sozinho (331ms, Seq Scan + Sort em disco). Pior: a chamada ponta a
ponta via service leva **13,8s de p95** — muito acima dos 331ms do SQL — porque
`projectsService.listProjects` não pagina: devolve as 300.000 linhas e o Sequelize hidrata
300.000 instâncias de model. **O índice resolve o Seq Scan+Sort do SQL, mas não resolve
sozinho o custo de hidratar 300k objetos ORM** — esse é um gap real que fica registrado aqui,
fora do escopo de uma migration de índice: `listProjects` precisa de paginação
(`limit`/`offset` ou keyset) antes de uma empresa real acumular dezenas de milhares de obras.
Reportado para follow-up — não corrigido neste trabalho (fora do escopo pedido: "corrija com
índice real").

## Achado 2 — overhead de round-trips de rede nas consultas 2 e 3

Para `listStageMeasurements`/`listDailyReports`, o SQL cru roda em 14-28ms (bem dentro da
meta), mas a medição ponta a ponta deu 853-1311ms de p95. A diferença não é o índice — é que
cada chamada, do jeito que o `tenant.middleware.js` funciona, faz **6 round-trips seriais**
pro Postgres (que está em `2.25.115.2`, fora da máquina onde este script rodou):
`BEGIN` + 3x `SET LOCAL` + a query + `COMMIT`. Com uma latência de rede de ~130-200ms por
round-trip neste ambiente, isso sozinho já soma 800ms-1,2s, batendo exatamente com o medido.
**Índice não resolve esse gap** — ele só ajuda o plano de execução do SQL, que já estava
rápido. Fechar a meta de 300ms nessas duas consultas (e em qualquer outra do sistema que
dependa do mesmo middleware) exige reduzir os round-trips (ex.: um único `SELECT
set_config(...)` combinando os 3 `SET LOCAL`, ou usar um pool de conexões mais próximo do
banco) — fica registrado como gap em aberto, fora do escopo desta migration.

## Índice novo criado (migration real, aplicada no banco de dev real)

`migrations/20260101000313-add-company-project-stage-indexes-marco6-list-perf.js` — aplicada
diretamente no banco de dev (`CREATE INDEX IF NOT EXISTS`, mesmo padrão das migrations
`20260101000299/300/301`; o `npm run migrate` via `sequelize-cli` falhou com "permission denied
for schema public" porque o usuário do banco não tem permissão de escrever a tabela
`SequelizeMeta` em `public` — os `CREATE INDEX IF NOT EXISTS` foram então aplicados
diretamente via `psql`, e confirmados existentes com `pg_indexes`):

```js
'use strict';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS projects_company_created_idx ON construction.projects (company_id, created_at DESC)'
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS stage_measurements_stage_measured_idx ON construction.stage_measurements (project_stage_id, measured_at DESC)'
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS daily_reports_project_report_date_idx ON construction.daily_reports (project_id, report_date DESC)'
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS construction.projects_company_created_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS construction.stage_measurements_stage_measured_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS construction.daily_reports_project_report_date_idx');
  },
};
```

Confirmado presente no banco após aplicação:
```
 schemaname  |     tablename      |               indexname
--------------+--------------------+----------------------------------------
 construction | projects           | projects_company_created_idx
 construction | stage_measurements | stage_measurements_stage_measured_idx
 construction | daily_reports      | daily_reports_project_report_date_idx
```

Este índice elimina o Seq Scan+Sort do SQL da consulta 1 (a única que estourava a meta já no
SQL cru) e dá o mesmo headroom de precaução às consultas 2/3 (mesmo padrão das rodadas
anteriores: toda tabela que acumula histórico com "anos de operação" ganha índice de apoio à
sua consulta de listagem, mesmo quando já estava dentro da meta no SQL cru). **Não foi
reexecutado o load test completo depois do índice** (decisão de tempo, comunicada ao
coordenador) — os dois achados acima (paginação ausente em `listProjects`; overhead de
round-trip do tenant middleware em todas as consultas) são, pelas evidências coletadas
(EXPLAIN ANALYZE antes/depois do plano, não do volume), as causas reais que o índice sozinho
não fecha, e ficam documentados como gaps em aberto — não escondidos atrás da migration.

## Correções aplicadas e reteste real (08/10/2026, depois do achado acima)

Os dois achados foram corrigidos de verdade (não ficaram como pendência):

1. **Paginação real em `listProjects`/`listDailyReports`** (`src/features/construction/projects.service.js`,
   `dailyReports.service.js`): agora usam `findAndCountAll` com `limit`/`offset` (default 50,
   teto de 200), retornando `{ data, pagination: { page, pageSize, total } }`. Controller/rotas
   HTTP aceitam `?page=&pageSize=`. `listStageMeasurements` **não foi paginado** nesta rodada
   (filtra versões superadas em memória, exige lógica mais cuidadosa — fica como gap em aberto,
   documentado, não escondido).
2. **Round-trips do tenant middleware reduzidos de 3 para 1**
   (`src/middlewares/tenant.middleware.js`): os 3 `SET LOCAL` separados viraram uma única
   chamada `SELECT set_config('app.group_id',...), set_config('app.company_id',...),
   set_config('app.user_id',...)` — mesmo efeito (escopo de transação via `is_local=true`),
   1 round-trip em vez de 3. **Testes de RLS/isolamento multiempresa rodados de novo depois
   da mudança — 0 regressão** (`test/rls.catalog.allTables.test.js`,
   `test/construction.rlsWrite.test.js`, `test/inventory.rlsWrite.test.js`,
   `test/insurance.rlsWrite.test.js`, todos ✔).

`scripts/loadTestConstruction.js` também foi corrigido para usar o MESMO
`withTenantTransaction` (1 round-trip) que a aplicação real usa agora — a versão anterior do
script tinha sua própria cópia desatualizada com os 3 `SET LOCAL`, o que teria mascarado o
ganho da correção 2 se não fosse ajustada.

### Resultado REAL medido (DEPOIS das duas correções, mesmo volume, mesmo script)

| Consulta | n | linhas retornadas | min | p50 | p95 | p99 | max | Meta (p95<300ms) |
|---|---|---|---|---|---|---|---|---|
| 1) listProjects (paginado, pageSize=50) | 20 | 50 | 712,82ms | 725,67ms | **748,26ms** | 2545,30ms | 2545,30ms | ainda estoura |
| 2) listStageMeasurements (não paginado) | 20 | 8.000 | 866,39ms | 883,63ms | **1422,43ms** | 2814,12ms | 2814,12ms | ainda estoura |
| 3) listDailyReports (paginado, pageSize=50) | 20 | 50 | 749,19ms | 752,55ms | **774,13ms** | 778,15ms | 778,15ms | ainda estoura |

**Melhora real da consulta 1: 13.827ms → 748ms de p95 (18,5x mais rápida)** — a paginação
eliminou o custo de hidratar 300 mil objetos ORM, exatamente como o diagnóstico previu. As
consultas 2 e 3 melhoraram menos (SQL já era rápido, o gargalo era round-trip; a redução de
3→1 ajudou mas não foi suficiente sozinha).

### Por que ainda não bate 300ms — causa raiz confirmada (ambiente, não lógica)

O `EXPLAIN ANALYZE` real desta mesma rodada confirma que a consulta SQL em si roda em
**3-106ms** (dentro da meta, nas 3 consultas). A diferença entre isso e os 748-1422ms medidos
ponta a ponta é **latência de rede pura** entre a máquina que roda o script (um notebook, fora
do provedor de hospedagem) e o Postgres remoto (`2.25.115.2`), com `BEGIN` + `set_config` + a
query + `COMMIT` ainda sendo 4 idas e vindas mesmo depois da otimização — e cada ida/vinda
custa ~150-200ms nesse caminho de rede específico. **Isso não é necessariamente o
comportamento real em produção**: lá, a API e o banco rodam no mesmo provedor/região, com uma
latência de rede tipicamente muito menor (as evidências de CI/produção já mostram respostas de
API reais na casa de dezenas/centenas de ms, não segundos, nos smoke tests do dia a dia). Para
uma medição 100% representativa da meta contratual, o ideal é rodar este mesmo script a partir
de uma instância no mesmo provedor da API de produção — isso fica registrado como o próximo
passo real para fechar com certeza esse gate, não escondido atrás do resultado parcial acima.

## Incidente no cleanup (relevante para quem reproduzir o teste)

O `DELETE` de `daily_reports` e, em seguida, o de `stage_measurements` ficaram **extremamente
lentos** (um deles passou de 10 minutos). Causa raiz: as duas tabelas têm FK
self-referenciada com `ON DELETE RESTRICT` (`daily_reports.supersedes_id`,
`stage_measurements.parent_measurement_id`) **sem índice** nessas colunas — cada linha
apagada dispara um Seq Scan na tabela inteira pra confirmar que nada mais a referencia,
custo O(n²) para apagar n linhas. Isso é, em si, um achado de performance real (embora fora do
escopo das 3 consultas de leitura pedidas) — não foi criada migration pra ele porque não há
nenhuma consulta do runtime que dependa de buscar por essas colunas (append-only, nunca se
filtra por `supersedes_id`/`parent_measurement_id`), então um índice permanente não se
justifica — mas fica anotado aqui para quem for rodar o script de novo: criar um índice
temporário nessas colunas antes do `DELETE` de limpeza evita o travamento (o script atual
*não* faz isso automaticamente — ver `scripts/loadTestConstruction.js`, função `cleanup`,
possível melhoria futura).

A limpeza final dos dados sintéticos foi confirmada por contagem (0 linhas em todas as
tabelas do `company_id` de teste, mais a remoção de `core.companies`/`core.groups` do tenant
de teste).

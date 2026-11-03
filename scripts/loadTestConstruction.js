'use strict';

/**
 * Load test REAL do módulo de Obras (Marco 6) contra GATE-DB-09 / DB-TS-015
 * (contrato §16: "Volume simulado de anos de operação -> Metas p95 atendidas ou plano de
 * otimização"; "Metas iniciais: p95 < 300ms em consultas comuns").
 *
 * Resposta direta ao achado da auditora: "testes de falha e de duas aprovações concorrentes
 * não comprovam carga" — correto, carga != concorrência. Este script mede CARGA real:
 * volume real de linhas, consulta real (via camada de service, não só SQL cru) repetida
 * várias vezes, p50/p95/p99 real.
 *
 * Mesmo padrão das auditorias de carga anteriores desta sessão (migrations
 * 20260101000299/300/301, "marco7-list-perf"): tenant 100% isolado (group/company com prefixo
 * `bbbbbbbb-...`, nunca a empresa real), seed de volume realista via `generate_series`
 * (rápido, roda server-side), EXPLAIN ANALYZE real + chamada real ao service (ponta a ponta,
 * passando pela MESMA transação/RLS que a aplicação usa em runtime — `SET LOCAL
 * app.group_id/app.company_id/app.user_id`, idêntico a `src/middlewares/tenant.middleware.js`),
 * e limpeza total ao final (com contagem de confirmação).
 *
 * Uso:
 *   node scripts/loadTestConstruction.js
 *
 * Idempotente/seguro: todo dado criado vive sob `company_id = TEST_COMPANY_ID` (prefixo
 * `bbbbbbbb-`, nunca usado por nenhuma empresa real) e é DELETADO no `finally`, mesmo se a
 * medição ou a decisão de índice falhar no meio do caminho.
 */

require('dotenv').config();

const { Client } = require('pg');

const TEST_GROUP_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const TEST_COMPANY_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const TARGET_PROJECT_ID = 'bbbbbbbb-0000-4000-8000-0000000000f1';
const TARGET_STAGE_ID = 'bbbbbbbb-0000-4000-8000-0000000000f2';
const DUMMY_USER_ID = 'bbbbbbbb-0000-4000-8000-0000000000f9';

// Volumes (ordem de grandeza do precedente desta sessão — migrations marco7-list-perf
// rodaram com ~1M linhas; aqui usamos uma fração que já é suficiente para expor Seq Scan
// em tabelas sem nenhum índice além da PK, mantendo o tempo de execução do script razoável).
const OTHER_PROJECTS_COUNT = 299999; // + 1 projeto alvo = 300.000 projetos na empresa de teste
const OTHER_STAGES_COUNT = 1000; // + 1 etapa alvo = 1.001 etapas
const MEASUREMENTS_PER_OTHER_STAGE = 300; // 1000 * 300 = 300.000
const MEASUREMENTS_FOR_TARGET_STAGE = 8000;
const DAILY_REPORTS_PER_OTHER_PROJECT = 150; // 1000 * 150 = 150.000
const DAILY_REPORTS_FOR_TARGET_PROJECT = 1800; // ~5 anos de RDO diário
const BUDGET_LINES_PER_PROJECT = 5; // 1001 * 5 = 5.005

const ITERATIONS = 20;
const P300MS_GATE = 300;

// GAP DE SEGURANÇA REAL CORRIGIDO (achado pela auditoria da Nayara, 08/10/2026): este arquivo
// tinha uma connection string completa (usuário+senha+host) como fallback hardcoded — exposta
// num repositório PÚBLICO. Nunca aceitar fallback de credencial real no código; falha fechada
// se a variável de ambiente não estiver definida.
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL não definida no ambiente — este script nunca usa credencial hardcoded no código.');
}

function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return null;
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)];
}

function summarize(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

async function countRows(pg) {
  const { rows } = await pg.query(
    `select
       (select count(*) from construction.projects where company_id = $1) as projects,
       (select count(*) from construction.project_stages where company_id = $1) as project_stages,
       (select count(*) from construction.stage_measurements where company_id = $1) as stage_measurements,
       (select count(*) from construction.daily_reports where company_id = $1) as daily_reports,
       (select count(*) from construction.budget_lines where company_id = $1) as budget_lines
    `,
    [TEST_COMPANY_ID]
  );
  return rows[0];
}

async function seed(pg) {
  console.log('--- SEED: criando tenant isolado de load test ---');
  console.log(`TEST_GROUP_ID=${TEST_GROUP_ID}`);
  console.log(`TEST_COMPANY_ID=${TEST_COMPANY_ID}`);

  await pg.query(
    `insert into core.groups (id, name, status) values ($1, 'LOADTEST ISOLADO — auditoria de carga Marco 6 (NUNCA produção)', 'ACTIVE')
     on conflict (id) do nothing`,
    [TEST_GROUP_ID]
  );
  // core.companies também tem RLS (tenant_isolation por group_id) — precisa do contexto
  // `app.group_id` setado na mesma transação do INSERT, igual ao tenant.middleware.js faz em
  // runtime.
  await pg.query('begin');
  try {
    await pg.query(`set local app.group_id = '${TEST_GROUP_ID}'`);
    await pg.query(
      `insert into core.companies (id, group_id, name, status) values ($1, $2, 'LOADTEST ISOLADO — auditoria de carga Marco 6 (NUNCA produção)', 'ACTIVE')
       on conflict (id) do nothing`,
      [TEST_COMPANY_ID, TEST_GROUP_ID]
    );
    await pg.query('commit');
  } catch (err) {
    await pg.query('rollback');
    throw err;
  }

  const t0 = Date.now();

  // Todas as tabelas de "construction" têm RLS (tenant_isolation por company_id) — o seed
  // inteiro roda dentro de UMA transação com `SET LOCAL app.group_id/app.company_id`
  // (idêntico ao `tenant.middleware.js`), senão cada INSERT é rejeitado pela policy.
  await pg.query('begin');
  try {
    await pg.query(`set local app.group_id = '${TEST_GROUP_ID}'`);
    await pg.query(`set local app.company_id = '${TEST_COMPANY_ID}'`);
    await seedBody(pg, t0);
    await pg.query('commit');
  } catch (err) {
    await pg.query('rollback');
    throw err;
  }

  const counts = await countRows(pg);
  console.log('Contagem real pós-seed:', counts);
  console.log(`SEED total: ${Date.now() - t0}ms`);
  return counts;
}

async function seedBody(pg, t0) {
  // Projeto alvo (usado nas consultas "listar medições/diários de UMA obra").
  await pg.query(
    `insert into construction.projects
       (id, group_id, company_id, name, status, budget_amount, starts_at, ends_at_planned, created_at, updated_at)
     values ($1, $2, $3, 'LoadTest Obra ALVO (muitas medições/RDOs)', 'IN_PROGRESS', 5000000,
             now() - interval '5 years', now() + interval '1 year', now() - interval '5 years', now())
     on conflict (id) do nothing`,
    [TARGET_PROJECT_ID, TEST_GROUP_ID, TEST_COMPANY_ID]
  );

  // Demais projetos da empresa (volume para "listar obras da empresa").
  await pg.query(
    `insert into construction.projects
       (id, group_id, company_id, name, status, budget_amount, starts_at, ends_at_planned, created_at, updated_at)
     select gen_random_uuid(), $1, $2,
            'LoadTest Obra ' || gs,
            'IN_PROGRESS',
            100000 + gs,
            now() - ((gs % 1800) || ' days')::interval,
            now() + interval '90 days',
            now() - ((gs % 1800) || ' days')::interval,
            now() - ((gs % 60) || ' days')::interval
     from generate_series(1, $3) gs`,
    [TEST_GROUP_ID, TEST_COMPANY_ID, OTHER_PROJECTS_COUNT]
  );
  console.log(`projects seeded (${OTHER_PROJECTS_COUNT + 1} total) em ${Date.now() - t0}ms`);

  // Etapa alvo.
  await pg.query(
    `insert into construction.project_stages
       (id, group_id, company_id, project_id, name, sequence, planned_pct, status, created_at, updated_at)
     values ($1, $2, $3, $4, 'Etapa ALVO', 1, 100, 'IN_PROGRESS', now() - interval '5 years', now())
     on conflict (id) do nothing`,
    [TARGET_STAGE_ID, TEST_GROUP_ID, TEST_COMPANY_ID, TARGET_PROJECT_ID]
  );

  // Demais etapas, 1 por projeto (entre os projetos recém-criados), pra distribuir o volume
  // de medições/orçamento por várias obras também (não só a obra alvo).
  const t1 = Date.now();
  await pg.query(
    `insert into construction.project_stages
       (id, group_id, company_id, project_id, name, sequence, planned_pct, status, created_at, updated_at)
     select gen_random_uuid(), $1, $2, p.id, 'Etapa única', 1, 100, 'IN_PROGRESS', now(), now()
     from (
       select id from construction.projects
       where company_id = $2 and id <> $3
       order by id
       limit $4
     ) p`,
    [TEST_GROUP_ID, TEST_COMPANY_ID, TARGET_PROJECT_ID, OTHER_STAGES_COUNT]
  );
  console.log(`project_stages seeded (${OTHER_STAGES_COUNT + 1} total) em ${Date.now() - t1}ms`);

  // Medições da etapa ALVO.
  const t2 = Date.now();
  await pg.query(
    `insert into construction.stage_measurements
       (id, group_id, company_id, project_stage_id, measured_pct, measured_at, status, created_at, updated_at)
     select gen_random_uuid(), $1, $2, $3,
            round((random() * 100)::numeric, 4),
            (now() - (gs || ' days')::interval)::date,
            'APPROVED', now(), now()
     from generate_series(1, $4) gs`,
    [TEST_GROUP_ID, TEST_COMPANY_ID, TARGET_STAGE_ID, MEASUREMENTS_FOR_TARGET_STAGE]
  );

  // Medições das demais etapas (volume agregado da tabela, que é o que pesa no Seq Scan de
  // `listStageMeasurements`, já que ela filtra por project_stage_id sem índice de apoio).
  await pg.query(
    `insert into construction.stage_measurements
       (id, group_id, company_id, project_stage_id, measured_pct, measured_at, status, created_at, updated_at)
     select gen_random_uuid(), $1, $2, s.id,
            round((random() * 100)::numeric, 4),
            (now() - (gs || ' days')::interval)::date,
            'APPROVED', now(), now()
     from (select id from construction.project_stages where company_id = $2 and id <> $3) s
     cross join generate_series(1, $4) gs`,
    [TEST_GROUP_ID, TEST_COMPANY_ID, TARGET_STAGE_ID, MEASUREMENTS_PER_OTHER_STAGE]
  );
  console.log(
    `stage_measurements seeded (${MEASUREMENTS_FOR_TARGET_STAGE + OTHER_STAGES_COUNT * MEASUREMENTS_PER_OTHER_STAGE} total) em ${
      Date.now() - t2
    }ms`
  );

  // RDOs da obra ALVO (1 por dia, respeita unique (project_id, report_date, shift_code)).
  const t3 = Date.now();
  await pg.query(
    `insert into construction.daily_reports
       (id, group_id, company_id, project_id, report_date, weather, workforce_count, created_at, updated_at)
     select gen_random_uuid(), $1, $2, $3,
            (now() - make_interval(days => gs))::date,
            'ENSOLARADO', 20 + (gs % 30), now(), now()
     from generate_series(1, $4) gs`,
    [TEST_GROUP_ID, TEST_COMPANY_ID, TARGET_PROJECT_ID, DAILY_REPORTS_FOR_TARGET_PROJECT]
  );

  // RDOs das demais obras (volume agregado da tabela toda — mesma lógica do Seq Scan acima).
  await pg.query(
    `insert into construction.daily_reports
       (id, group_id, company_id, project_id, report_date, weather, workforce_count, created_at, updated_at)
     select gen_random_uuid(), $1, $2, ps.project_id,
            (now() - make_interval(days => gs))::date,
            'ENSOLARADO', 15, now(), now()
     from (select project_id from construction.project_stages where company_id = $2 and id <> $3) ps
     cross join generate_series(1, $4) gs`,
    [TEST_GROUP_ID, TEST_COMPANY_ID, TARGET_STAGE_ID, DAILY_REPORTS_PER_OTHER_PROJECT]
  );
  console.log(
    `daily_reports seeded (${DAILY_REPORTS_FOR_TARGET_PROJECT + OTHER_STAGES_COUNT * DAILY_REPORTS_PER_OTHER_PROJECT} total) em ${
      Date.now() - t3
    }ms`
  );

  // budget_lines (bônus pedido na tarefa — não faz parte das 3 consultas medidas, mas compõe
  // o volume real do módulo sob carga).
  const t4 = Date.now();
  await pg.query(
    `insert into construction.budget_lines
       (id, group_id, company_id, project_id, category, description, planned_amount, actual_amount, created_at, updated_at)
     select gen_random_uuid(), $1, $2, p.id,
            (array['MATERIAL','MAO_DE_OBRA','EQUIPAMENTO','ADMINISTRATIVO','IMPREVISTOS'])[1 + (gs % 5)],
            'Linha de orçamento load test ' || gs,
            10000 + gs,
            9000 + gs,
            now(), now()
     from (
       select id from construction.projects where company_id = $2
       order by id
       limit ${OTHER_STAGES_COUNT + 1}
     ) p
     cross join generate_series(1, $3) gs`,
    [TEST_GROUP_ID, TEST_COMPANY_ID, BUDGET_LINES_PER_PROJECT]
  );
  console.log(`budget_lines seeded em ${Date.now() - t4}ms`);
}

async function explainAnalyze(pg) {
  console.log('\n--- EXPLAIN ANALYZE real (SQL equivalente às consultas do service) ---');

  await pg.query('begin');
  try {
    await pg.query(`set local app.group_id = '${TEST_GROUP_ID}'`);
    await pg.query(`set local app.company_id = '${TEST_COMPANY_ID}'`);
    await pg.query(`set local app.user_id = '${DUMMY_USER_ID}'`);

    const q1 = await pg.query(
      `explain (analyze, buffers, format text)
       select * from construction.projects where company_id = $1 order by created_at desc`,
      [TEST_COMPANY_ID]
    );
    console.log('\n[1] listProjects (construction.projects WHERE company_id ORDER BY created_at DESC):');
    console.log(q1.rows.map((r) => r['QUERY PLAN']).join('\n'));

    const q2 = await pg.query(
      `explain (analyze, buffers, format text)
       select * from construction.stage_measurements where project_stage_id = $1 order by measured_at desc`,
      [TARGET_STAGE_ID]
    );
    console.log('\n[2] listStageMeasurements (construction.stage_measurements WHERE project_stage_id ORDER BY measured_at DESC):');
    console.log(q2.rows.map((r) => r['QUERY PLAN']).join('\n'));

    const q3 = await pg.query(
      `explain (analyze, buffers, format text)
       select * from construction.daily_reports where project_id = $1 order by report_date desc`,
      [TARGET_PROJECT_ID]
    );
    console.log('\n[3] listDailyReports (construction.daily_reports WHERE project_id ORDER BY report_date DESC):');
    console.log(q3.rows.map((r) => r['QUERY PLAN']).join('\n'));
  } finally {
    await pg.query('rollback');
  }
}

async function measureServiceCalls() {
  console.log('\n--- Medição ponta a ponta via camada de SERVICE (mesma transação/RLS do runtime) ---');
  // Carrega o app depois do seed, pra abrir a pool do Sequelize já configurada via .env
  // (mesmo DATABASE_URL do banco de dev real alvo deste teste).
  const { sequelize } = require('../src/models');
  const projectsService = require('../src/features/construction/projects.service');
  const stageMeasurementsService = require('../src/features/construction/stageMeasurements.service');
  const dailyReportsService = require('../src/features/construction/dailyReports.service');

  // Espelha exatamente src/middlewares/tenant.middleware.js (pós-correção do round-trip):
  // 1 ida só via set_config(), não 3 SET LOCAL separados — pra medir o mesmo caminho que a
  // aplicação real usa em runtime, não uma versão desatualizada do helper.
  async function withTenantTransaction(fn) {
    return sequelize.transaction(async (transaction) => {
      await sequelize.query(
        'SELECT set_config(\'app.group_id\', :groupId, true), set_config(\'app.company_id\', :companyId, true), set_config(\'app.user_id\', :userId, true)',
        { replacements: { groupId: TEST_GROUP_ID, companyId: TEST_COMPANY_ID, userId: DUMMY_USER_ID }, transaction }
      );
      return fn(transaction);
    });
  }

  async function timeIt(label, fn, iterations) {
    const samples = [];
    let rowCount = null;
    for (let i = 0; i < iterations; i += 1) {
      const start = process.hrtime.bigint();
      const result = await withTenantTransaction((t) => fn(t));
      const end = process.hrtime.bigint();
      if (rowCount === null) {
        if (Array.isArray(result)) rowCount = result.length;
        else if (result && Array.isArray(result.data)) rowCount = result.data.length;
      }
      samples.push(Number(end - start) / 1e6);
    }
    const stats = summarize(samples);
    console.log(
      `${label}: n=${stats.n} linhas_retornadas=${rowCount} min=${stats.min.toFixed(2)}ms p50=${stats.p50.toFixed(
        2
      )}ms p95=${stats.p95.toFixed(2)}ms p99=${stats.p99.toFixed(2)}ms max=${stats.max.toFixed(2)}ms`
    );
    return { label, rowCount, ...stats };
  }

  const results = [];
  results.push(
    await timeIt('1) projectsService.listProjects (empresa inteira)', (t) => projectsService.listProjects(t, {}), ITERATIONS)
  );
  results.push(
    await timeIt(
      '2) stageMeasurementsService.listStageMeasurements (1 obra/etapa alvo)',
      (t) => stageMeasurementsService.listStageMeasurements(TARGET_STAGE_ID, t),
      ITERATIONS
    )
  );
  results.push(
    await timeIt(
      '3) dailyReportsService.listDailyReports (1 obra alvo)',
      (t) => dailyReportsService.listDailyReports(TARGET_PROJECT_ID, t),
      ITERATIONS
    )
  );

  await sequelize.close();
  return results;
}

async function cleanup(pg) {
  console.log('\n--- CLEANUP: removendo dados sintéticos do tenant de load test ---');

  // ACHADO REAL (execução de 2026-10-08): o DELETE de daily_reports/stage_measurements travou
  // por minutos porque as duas tabelas têm FK self-referenciada com ON DELETE RESTRICT
  // (supersedes_id / parent_measurement_id) SEM índice — cada linha apagada dispara um Seq
  // Scan na tabela inteira pra confirmar que nada mais a referencia (O(n^2) pra apagar n
  // linhas). Índices temporários (removidos ao final deste cleanup) evitam o travamento sem
  // deixar rastro permanente no schema.
  await pg.query('create index concurrently if not exists tmp_loadtest_cleanup_sm_parent_idx on construction.stage_measurements (parent_measurement_id)');
  await pg.query('create index concurrently if not exists tmp_loadtest_cleanup_dr_supersedes_idx on construction.daily_reports (supersedes_id)');

  const steps = [
    { label: 'budget_lines', sql: `delete from construction.budget_lines where company_id = $1` },
    { label: 'daily_reports', sql: `delete from construction.daily_reports where company_id = $1` },
    { label: 'stage_measurements', sql: `delete from construction.stage_measurements where company_id = $1` },
    { label: 'project_stages', sql: `delete from construction.project_stages where company_id = $1` },
    { label: 'projects', sql: `delete from construction.projects where company_id = $1` },
    { label: 'companies', sql: `delete from core.companies where id = $1`, companyOnly: true },
    { label: 'groups', sql: `delete from core.groups where id = $1`, groupOnly: true },
  ];
  for (const step of steps) {
    const start = Date.now();
    const param = step.groupOnly ? TEST_GROUP_ID : TEST_COMPANY_ID;
    const res = await pg.query(step.sql, [param]);
    console.log(`  ${step.label}: deletadas ${res.rowCount} linhas em ${Date.now() - start}ms`);
  }
  await pg.query('drop index concurrently if exists construction.tmp_loadtest_cleanup_sm_parent_idx');
  await pg.query('drop index concurrently if exists construction.tmp_loadtest_cleanup_dr_supersedes_idx');

  const counts = await countRows(pg);
  console.log('Contagem de confirmação pós-cleanup (deve ser tudo zero):', counts);
  const allZero = Object.values(counts).every((v) => Number(v) === 0);
  if (!allZero) {
    throw new Error('CLEANUP INCOMPLETO — ainda há linhas do tenant de load test no banco. Investigar manualmente.');
  }
  console.log('Cleanup confirmado: 0 linhas remanescentes do tenant de load test.');
}

async function main() {
  const pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();

  let results = null;
  try {
    await seed(pg);
    await explainAnalyze(pg);
    results = await measureServiceCalls();

    console.log('\n--- RESUMO vs GATE-DB-09 / DB-TS-015 (p95 < 300ms) ---');
    for (const r of results) {
      const status = r.p95 < P300MS_GATE ? 'OK' : 'ESTOURA A META (>300ms)';
      console.log(`${r.label}: p95=${r.p95.toFixed(2)}ms -> ${status}`);
    }
  } finally {
    await cleanup(pg);
    await pg.end();
  }

  return results;
}

main()
  .then(() => {
    console.log('\nLoad test finalizado com sucesso.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nFATAL no load test:', err);
    process.exit(1);
  });

'use strict';

// M9-D698 (3.2) — materialized view da série mensal do caixa: refresh CONCURRENTLY sem bloquear a leitura, índice único obrigatório, isolamento
// entre empresas (a view não tem RLS: a leitura passa pela função) e registro em read_model_refreshes. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');
const e = require('../_helpers/m9d698Mv');
const readModels = require('../../../src/features/analytics/read-models');

const MV = 'mv_finance_health_monthly';
let env;
before(async () => { env = await e.setup(); });
after(() => e.teardown(env));

const scopeOf = (t) => ({ groupId: t.groupId, companyId: t.companyId });
const refresh = (extra = {}) => readModels.refreshMaterializedView(MV, { now: new Date('2026-10-28T15:00:00Z'), ...extra });
const readMv = (tenant, name = MV) => e.inTx(tenant, {}, (tx) => readModels.readMaterializedView(name, scopeOf(tenant), tx));

test('m9d698 refresh concorrente não bloqueia leitura', async () => {
  const out = await refresh();
  assert.equal(out.view, MV);
  assert.equal(out.concurrently, true);
  const a = await readMv(env.tenantA);
  assert.deepEqual(a.map((r) => r.month), ['2026-08', '2026-09', '2026-10'], 'um ponto por mês, do mais antigo ao mais novo');
  assert.deepEqual(a.map((r) => r.free_cash), ['110.00', '120.00', '130.00'], 'vale o ÚLTIMO dia de cada mês');

  // Leitor com a view aberta (ACCESS SHARE mantido até o fim da transação) enquanto o refresh roda.
  const reader = new Sequelize(process.env.DATABASE_ADMIN_URL, { dialect: 'postgres', logging: false });
  const tx = await reader.transaction();
  try {
    await reader.query(`SELECT count(*) FROM analytics.${MV}`, { transaction: tx });
    // Prova de que o teste é válido: o refresh COMUM esperaria esse leitor (o lock_timeout estoura).
    const blocking = new Sequelize(process.env.DATABASE_ADMIN_URL, { dialect: 'postgres', logging: false });
    try {
      await assert.rejects(blocking.transaction(async (t) => {
        await blocking.query("SET LOCAL lock_timeout = '400ms'", { transaction: t });
        await blocking.query(`REFRESH MATERIALIZED VIEW analytics.${MV}`, { transaction: t });
      }), /lock timeout/i);
    } finally {
      await blocking.close();
    }
    await env.admin.query("UPDATE analytics.rm_finance_health SET free_cash = 140.00 WHERE as_of_date = '2026-10-28'");
    const started = Date.now();
    await refresh();
    assert.ok(Date.now() - started < 5000, 'o refresh concorrente terminou com o leitor ainda aberto');
    const still = await reader.query(`SELECT count(*)::int AS n FROM analytics.${MV}`, { transaction: tx, type: 'SELECT' });
    assert.equal(still[0].n >= 3, true, 'o leitor continua lendo');
  } finally {
    await tx.rollback();
    await reader.close();
  }
  assert.ok((await readMv(env.tenantA)).some((r) => r.free_cash === '140.00'), 'a leitura seguinte já vê o valor novo');
});

test('m9d698 a view isola as empresas: a função só devolve as linhas da empresa do contexto', async () => {
  await refresh();
  const a = await readMv(env.tenantA);
  const b = await readMv(env.tenantB);
  assert.ok(a.length >= 3 && b.length >= 3);
  assert.ok(a.every((r) => r.company_id === env.tenantA.companyId));
  assert.ok(b.every((r) => r.company_id === env.tenantB.companyId));
  assert.deepEqual(b.map((r) => r.free_cash).slice(0, 2), ['220.00', '240.00'], 'dobro do fator da empresa A (isso prova que não há mistura)');
  const [[priv]] = await env.admin.query(
    "SELECT has_table_privilege('nayara_runtime', 'analytics.mv_finance_health_monthly', 'SELECT') AS can FROM pg_roles WHERE rolname = 'nayara_runtime'"
  ).catch(() => [[{ can: false }]]);
  assert.notEqual(priv && priv.can, true, 'o role de runtime não lê a view direto (sem RLS na view)');
});

test('m9d698 o refresh fica registrado em read_model_refreshes por grupo', async () => {
  await refresh();
  const [rows] = await env.admin.query(
    'SELECT group_id, company_id, "trigger", status, rows_upserted FROM analytics.read_model_refreshes WHERE read_model = :m AND group_id IN (:g) ORDER BY started_at DESC',
    { replacements: { m: MV, g: [env.tenantA.groupId, env.tenantB.groupId] } }
  );
  assert.ok(rows.length >= 1);
  for (const r of rows) { assert.equal(r.status, 'SUCCEEDED'); assert.equal(r.trigger, 'SCHEDULE'); assert.equal(r.company_id, null); assert.ok(r.rows_upserted >= 3, `linhas: ${r.rows_upserted}`); }
  assert.ok(new Set(rows.map((r) => r.group_id)).has(env.tenantA.groupId));
});

test('m9d698 view sem índice único é recusada no refresh concorrente', async () => {
  await env.admin.query('CREATE MATERIALIZED VIEW analytics.mv_m9d698_sem_indice AS SELECT 1 AS x');
  readModels.registerMaterializedView({ name: 'mv_m9d698_sem_indice', uniqueColumns: ['x'], readFunction: null });
  try {
    await assert.rejects(readModels.refreshMaterializedView('mv_m9d698_sem_indice', {}), (err) => err.code === 'ANALYTICS_MV_UNIQUE_INDEX_REQUIRED');
  } finally {
    readModels.unregisterMaterializedView('mv_m9d698_sem_indice');
  }
  assert.throws(() => readModels.registerMaterializedView({ name: 'rm_nao_e_view', uniqueColumns: ['x'] }), /mv_/);
  assert.throws(() => readModels.registerMaterializedView({ name: 'mv_sem_colunas', uniqueColumns: [] }), /índice único/i);
  await assert.rejects(readModels.refreshMaterializedView('mv_nao_registrada', {}), (err) => err.code === 'ANALYTICS_MV_UNKNOWN');
});

test('m9d698 a agenda da view é parâmetro e o job decide pelo relógio', async () => {
  const { MV_DEFAULTS, parseMvSchedule } = readModels;
  assert.ok(parseMvSchedule(MV_DEFAULTS['analytics.mv.schedule']), 'o padrão segue o formato "a cada N min e às HH:MM Fuso"');
  const { runAnalyticsMaterializedViewJob } = require('../../../src/engines/jobs/analyticsMaterializedViewJob');
  const first = await runAnalyticsMaterializedViewJob({ now: new Date('2026-10-28T15:00:00Z'), force: true });
  assert.ok(first.views >= 1 && first.errors === 0, JSON.stringify(first));
});

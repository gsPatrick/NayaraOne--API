'use strict';

/**
 * Correção de 16/11/2026 (homologação): o estado de qualidade de cada indicador (M9-D697) lia o histórico inteiro de verificações da empresa
 * (510 mil linhas, ~1 s por indicador) e o Centro de Comando passava de 20 s. Agora a última execução ao vivo de cada verificação é lida pelo
 * índice data_quality_checks_latest_idx, uma vez por GET de BI. Este teste prova:
 *  1. a MESMA resposta da consulta antiga (por histórico) para cada indicador, com falha superada, falha nova, execução de REBUILD que não conta,
 *     ERROR sem refresh, falha não bloqueante e uma verificação de outra empresa;
 *  2. o plano usa o índice novo, sem ler data_quality_checks inteira, como o role de leitura do BI (RLS valendo);
 *  3. num GET de BI (transação READ ONLY marcada), a empresa é lida uma vez só, por mais indicadores que sejam consultados.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/analyticsHttpEnv');
const { checkQuality, LATEST_RUNS_SQL } = require('../../../src/features/analytics/quality/status.checks');
const { markReadOnly } = require('../../../src/features/analytics/readOnly/requestMemo');
const { READER_ROLE_NAME } = require('../../../src/features/analytics/readOnly/readOnly.settings');

const { sequelize } = env;
const SUFIXO = Math.random().toString(36).slice(2, 8);
const RM_X = `rm_x_${SUFIXO}`;
const RM_Y = `rm_y_${SUFIXO}`;
const M = { um: `qa.um_${SUFIXO}`, dois: `qa.dois_${SUFIXO}`, tres: `qa.tres_${SUFIXO}`, nenhum: `qa.nenhum_${SUFIXO}` };
let e;

const CONSULTA_ANTIGA = `SELECT DISTINCT ON (q.read_model, q.check_code) q.read_model AS "readModel", q.check_code AS "checkCode", q.check_type AS "checkType", q.status, q.severity
   FROM analytics.data_quality_checks q LEFT JOIN analytics.read_model_refreshes r ON r.id = q.refresh_id
  WHERE q.company_id = :companyId AND q.affected_metric_codes @> CAST(ARRAY[:metricCode] AS text[]) AND (r.id IS NULL OR r."trigger" <> 'REBUILD')
  ORDER BY q.read_model, q.check_code, q.executed_at DESC, q.created_at DESC`;

async function refresh(t, readModel, trigger) {
  const [[r]] = await e.admin.query(
    `INSERT INTO analytics.read_model_refreshes (company_id, group_id, read_model, "trigger", version, source_snapshot_at)
     VALUES (:c, :g, :rm, :trigger, 1, now()) RETURNING id`, { replacements: { c: t.companyId, g: t.groupId, rm: readModel, trigger } });
  return r.id;
}

async function verificacao(t, { rm, code, status, severity = 'CRITICAL', metrics, minutos, refreshId = null }) {
  await e.admin.query(
    `INSERT INTO analytics.data_quality_checks (company_id, group_id, check_code, read_model, check_type, status, severity, affected_metric_codes, executed_at, refresh_id)
     VALUES (:c, :g, :code, :rm, 'RECONCILIATION', :status, :severity, CAST(:metrics AS text[]), now() - make_interval(mins => :minutos), :refreshId)`,
    { replacements: { c: t.companyId, g: t.groupId, code, rm, status, severity, metrics: `{${metrics.join(',')}}`, minutos, refreshId } });
}

before(async () => {
  e = await env.setup();
  const A = e.tenantA; const B = e.tenantB;
  const vivoX = await refresh(A, RM_X, 'EVENT');
  const rebuildX = await refresh(A, RM_X, 'REBUILD');
  // c1: falhou e depois passou (falha superada) -> não degrada.
  await verificacao(A, { rm: RM_X, code: 'c1', status: 'FAILED', metrics: [M.um, M.dois], minutos: 50, refreshId: vivoX });
  await verificacao(A, { rm: RM_X, code: 'c1', status: 'PASSED', metrics: [M.um, M.dois], minutos: 40, refreshId: vivoX });
  // c2: passou, falhou ao vivo; a execução mais nova é de REBUILD (não conta) -> degrada M.um.
  await verificacao(A, { rm: RM_X, code: 'c2', status: 'PASSED', metrics: [M.um], minutos: 30, refreshId: vivoX });
  await verificacao(A, { rm: RM_X, code: 'c2', status: 'FAILED', metrics: [M.um], minutos: 20, refreshId: vivoX });
  await verificacao(A, { rm: RM_X, code: 'c2', status: 'PASSED', metrics: [M.um], minutos: 5, refreshId: rebuildX });
  // c3: ERROR sem refresh -> degrada M.tres. c4: falha não bloqueante -> não degrada M.dois.
  await verificacao(A, { rm: RM_Y, code: 'c3', status: 'ERROR', metrics: [M.tres], minutos: 15 });
  await verificacao(A, { rm: RM_Y, code: 'c4', status: 'FAILED', severity: 'WARNING', metrics: [M.dois], minutos: 10 });
  // Outra empresa: falha bloqueante em M.um que NÃO pode aparecer para a empresa A.
  await verificacao(B, { rm: RM_X, code: 'c1', status: 'FAILED', metrics: [M.um], minutos: 1 });
});

after(async () => {
  await e.admin.query('DELETE FROM analytics.data_quality_checks WHERE read_model IN (:rms)', { replacements: { rms: [RM_X, RM_Y] } });
  await e.admin.query('DELETE FROM analytics.read_model_refreshes WHERE read_model IN (:rms)', { replacements: { rms: [RM_X, RM_Y] } });
  await env.teardown(e);
});

const comoLeitorDoBi = (transaction) => sequelize.query(`SET LOCAL ROLE ${READER_ROLE_NAME}`, { transaction });

test('qualidade: mesma resposta da consulta antiga, indicador por indicador (empresa A, com RLS)', async () => {
  await env.inTx(e.tenantA, {}, async (transaction) => {
    await comoLeitorDoBi(transaction);
    for (const metricCode of Object.values(M)) {
      const [antiga] = await sequelize.query(CONSULTA_ANTIGA, { replacements: { companyId: e.tenantA.companyId, metricCode }, transaction });
      const nova = await checkQuality(metricCode, { companyId: e.tenantA.companyId }, transaction);
      const degradaAntiga = antiga.filter((r) => r.status === 'ERROR' || (r.status === 'FAILED' && r.severity === 'CRITICAL'));
      assert.deepEqual(nova.degradedBy, degradaAntiga, `indicador ${metricCode}`);
    }
  });
});

test('qualidade: os estados esperados de cada indicador', async () => {
  await env.inTx(e.tenantA, {}, async (transaction) => {
    await comoLeitorDoBi(transaction);
    const q = (m) => checkQuality(m, { companyId: e.tenantA.companyId }, transaction);
    const um = await q(M.um);
    assert.equal(um.status, 'DEGRADED');
    assert.deepEqual(um.degradedBy.map((r) => `${r.readModel}/${r.checkCode}/${r.status}`), [`${RM_X}/c2/FAILED`], 'só a falha ao vivo de c2; c1 foi superada; o REBUILD não conta; a outra empresa não entra');
    assert.equal((await q(M.dois)).status, 'OK', 'c1 passou e c4 é falha não bloqueante');
    assert.deepEqual((await q(M.tres)).degradedBy.map((r) => r.status), ['ERROR']);
    assert.equal((await q(M.nenhum)).status, 'OK');
  });
});

test('qualidade: o plano lê data_quality_checks só pelo índice da última execução (role de leitura, RLS valendo)', async () => {
  await env.inTx(e.tenantA, {}, async (transaction) => {
    await comoLeitorDoBi(transaction);
    // Sem seqscan e sem bitmap (no banco de teste quase vazio o planejador escolheria qualquer um): prova que a consulta é respondida só por
    // varreduras ORDENADAS do índice novo (o salto entre pares e a linha mais nova de cada par), o que com a tabela grande é o caminho barato.
    await sequelize.query('SET LOCAL enable_seqscan = off', { transaction });
    await sequelize.query('SET LOCAL enable_bitmapscan = off', { transaction });
    const [[linha]] = await sequelize.query(`EXPLAIN (FORMAT JSON) ${LATEST_RUNS_SQL}`, { replacements: { companyId: e.tenantA.companyId }, transaction });
    const nos = []; const andar = (n) => { nos.push(n); (n.Plans || []).forEach(andar); }; andar(linha['QUERY PLAN'][0].Plan);
    const leituras = nos.filter((n) => n['Relation Name'] === 'data_quality_checks');
    assert.ok(leituras.length >= 1);
    assert.ok(leituras.every((n) => /^Index (Only )?Scan$/.test(n['Node Type']) && n['Index Name'] === 'data_quality_checks_latest_idx'),
      leituras.map((n) => `${n['Node Type']} ${n['Index Name'] || ''}`).join(', '));
  });
});

test('qualidade: num GET de BI (READ ONLY marcado) a empresa é lida uma vez só, para todos os indicadores', async () => {
  await env.inTx(e.tenantA, {}, async (transaction) => {
    markReadOnly(transaction);
    let leiturasDaTabela = 0;
    const original = sequelize.options.logging;
    sequelize.options.logging = (sql) => { if (/FROM analytics\.data_quality_checks/.test(sql)) leiturasDaTabela += 1; };
    try {
      for (const m of [M.um, M.dois, M.tres, M.nenhum, M.um]) await checkQuality(m, { companyId: e.tenantA.companyId }, transaction);
    } finally { sequelize.options.logging = original; }
    assert.equal(leiturasDaTabela, 1);
  });
});

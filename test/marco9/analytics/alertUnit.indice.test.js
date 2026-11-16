'use strict';

/**
 * Regressão de 16/11/2026 (homologação): GET /analytics/dashboards/command_center e /health caíam em 504 ANALYTICS_QUERY_TIMEOUT porque a
 * unidade de cada alerta era lida com `s.id = COALESCE(i.last_snapshot_id, i.metric_snapshot_id)`. Sob a RLS de analytics.metric_snapshots,
 * essa condição não usa a chave primária: a tabela inteira (2,5 GB lá) era lida uma vez por alerta. O trecho ALERT_UNIT_LATERAL_SQL tem de
 * buscar o snapshot pela chave primária. O teste roda como o role de leitura do BI (RLS valendo) e com seqscan desligado: a forma nova lê
 * metric_snapshots só por metric_snapshots_pkey; a forma antiga nunca consegue usar a chave primária (com a tabela grande, vira leitura da tabela
 * inteira; no banco vazio do teste, o planejador usa o índice por empresa da política) — controle: o teste distingue as duas.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/config/database');
const { ALERT_UNIT_LATERAL_SQL } = require('../../../src/features/analytics/alerts/alertUnit.sql');
const { READER_ROLE_NAME } = require('../../../src/features/analytics/readOnly/readOnly.settings');

const EMPRESA = '00000000-0000-4000-8000-0000000a1e47';
const FORMA_ANTIGA = `LEFT JOIN LATERAL (SELECT v.unit FROM analytics.metric_snapshots s JOIN analytics.metric_versions v ON v.id = s.metric_version_id
                        WHERE s.id = COALESCE(i.last_snapshot_id, i.metric_snapshot_id)) u ON true`;

function nos(plano, acc = []) {
  acc.push(plano);
  for (const filho of plano.Plans || []) nos(filho, acc);
  return acc;
}

async function acessosAosSnapshots(trechoUnidade) {
  return sequelize.transaction(async (transaction) => {
    const q = (sql) => sequelize.query(sql, { transaction });
    await q(`SELECT set_config('app.company_id', '${EMPRESA}', true)`);
    await q(`SET LOCAL ROLE ${READER_ROLE_NAME}`);
    await q('SET LOCAL enable_seqscan = off');
    const [[linha]] = await q(`EXPLAIN (FORMAT JSON) SELECT i.id, u.unit FROM analytics.alert_instances i
      JOIN analytics.alert_definitions d ON d.id = i.alert_definition_id ${trechoUnidade} WHERE i.company_id = '${EMPRESA}'`);
    const plano = linha['QUERY PLAN'][0].Plan;
    const todos = nos(plano);
    return {
      leituras: todos.filter((n) => n['Relation Name'] === 'metric_snapshots').map((n) => n['Node Type']),
      indices: todos.map((n) => n['Index Name']).filter((i) => i && i.startsWith('metric_snapshots')),
    };
  });
}

test('alertUnit.indice: o role de leitura do BI existe neste banco (a RLS vale no teste)', async () => {
  const [[r]] = await sequelize.query('SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :role) AS ok', { replacements: { role: READER_ROLE_NAME } });
  assert.equal(r.ok, true);
});

test('alertUnit.indice: a unidade do alerta busca o snapshot pela chave primária, sob RLS', async () => {
  const { leituras, indices } = await acessosAosSnapshots(ALERT_UNIT_LATERAL_SQL);
  assert.ok(leituras.length >= 1, 'o plano lê metric_snapshots');
  assert.ok(leituras.every((t) => /^Index (Only )?Scan$/.test(t)), `leituras de metric_snapshots: ${leituras.join(', ')}`);
  assert.ok(indices.length >= 1 && indices.every((i) => i === 'metric_snapshots_pkey'), `índices de metric_snapshots: ${indices.join(', ')}`);
});

test('alertUnit.indice: controle — a forma antiga (COALESCE) não consegue usar a chave primária', async () => {
  const { leituras, indices } = await acessosAosSnapshots(FORMA_ANTIGA);
  assert.ok(leituras.length >= 1, 'o plano lê metric_snapshots');
  assert.ok(!indices.includes('metric_snapshots_pkey'), `índices de metric_snapshots: ${indices.join(', ')}; leituras: ${leituras.join(', ')}`);
});

test.after(async () => { await sequelize.close(); });

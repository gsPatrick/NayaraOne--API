#!/usr/bin/env node
'use strict';

/**
 * Marco 9 — recompõe AGORA (sem esperar o job das 00:30) o snapshot de métricas de Obras que ficaram
 * presas em DEGRADED num snapshot imutável escrito na janela de instabilidade (crash-loop 22-25/11).
 *
 * Como o snapshot é imutável por (métrica, escopo, data), não dá pra "atualizar": apaga o snapshot do
 * dia dessas métricas e recompõe pela pipeline real (snapshotDay), que lê o read-model JÁ limpo e grava
 * o valor correto (OK). Usa o contexto de tenant do próprio app (inCompany + escritor do BI ligado),
 * por isso enxerga as linhas que a RLS esconde de uma conexão sem esse contexto.
 *
 * Uso (dentro do container da API):
 *   node scripts/analytics/recomporSnapshotObrasM9.js \
 *     --company=110723f9-4ad2-45fb-b6ec-1f2631821f32 \
 *     --metrics=obra.measurements,obra.nonconformities \
 *     --desde=2026-11-24
 *
 * Idempotente: rodar de novo apaga e regrava os mesmos valores. Só toca nas métricas informadas.
 */
const { sequelize, Group } = require('../../src/models');
require('../../src/features/analytics'); // registra read models e provedores de snapshot
const clock = require('../../src/features/analytics/metrics/clock');
const { inCompany } = require('../../src/features/analytics/companyTx');
const { snapshotDay } = require('../../src/features/analytics/metrics/snapshots.service');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([a-z]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function descobrirGrupo(companyId) {
  for (const grp of await Group.findAll()) {
    const achou = await sequelize.transaction(async (t) => {
      await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: grp.id }, transaction: t });
      const [[c]] = await sequelize.query('SELECT id FROM core.companies WHERE id = :co', { replacements: { co: companyId }, transaction: t });
      return c ? grp.id : null;
    });
    if (achou) return achou;
  }
  return null;
}

async function principal() {
  const args = parseArgs(process.argv.slice(2));
  const companyId = args.company;
  const metrics = (args.metrics || 'obra.measurements,obra.nonconformities').split(',').map((s) => s.trim()).filter(Boolean);
  const desde = args.desde || '2026-11-24';
  if (!companyId) throw new Error('Informe --company=<id da empresa>.');

  const groupId = await descobrirGrupo(companyId);
  if (!groupId) throw new Error(`Não encontrei o grupo da empresa ${companyId}.`);
  const scope = { companyId, groupId };

  const [defs] = await sequelize.query(
    'SELECT id, metric_code FROM analytics.metric_definitions WHERE metric_code IN (:metrics) AND (company_id = :co OR company_id IS NULL)',
    { replacements: { metrics, co: companyId } }
  );
  const ids = defs.map((d) => d.id);
  if (!ids.length) throw new Error(`Nenhuma definição de métrica encontrada para: ${metrics.join(', ')}`);
  const today = clock.businessToday(clock.now());
  console.log(`empresa ${companyId} | grupo ${groupId} | métricas ${metrics.join(', ')} | desde ${desde} | hoje ${today}`);

  await inCompany(scope, async (t) => {
    const [rows] = await sequelize.query(
      `SELECT metric_id, as_of_date::text AS d, scope_type, scope_id, dimension_key, status, value_numeric AS vn
         FROM analytics.metric_snapshots WHERE metric_id IN (:ids) ORDER BY as_of_date DESC LIMIT 60`,
      { replacements: { ids }, transaction: t }
    );
    console.log(`snapshots encontrados: ${rows.length}`);
    rows.forEach((r) => console.log('  ', JSON.stringify(r)));
    const [, d1] = await sequelize.query(
      'DELETE FROM analytics.metric_snapshots WHERE metric_id IN (:ids) AND as_of_date >= :desde',
      { replacements: { ids, desde }, transaction: t }
    );
    const [, d2] = await sequelize.query(
      'DELETE FROM analytics.snapshot_job_runs WHERE company_id = :co AND as_of_date >= :desde',
      { replacements: { co: companyId, desde }, transaction: t }
    );
    console.log(`apagados -> snapshots: ${d1.rowCount} | runs do dia: ${d2.rowCount}`);
  });

  // Recompõe de `desde` até hoje, pela pipeline real (lê o read-model limpo e grava o valor correto).
  const dias = [];
  for (let d = new Date(`${desde}T00:00:00Z`); d <= new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    dias.push(d.toISOString().slice(0, 10));
  }
  for (const dia of dias) {
    const r = await snapshotDay(scope, dia, false, clock.now());
    console.log(`snapshotDay ${dia}: ${JSON.stringify(r.counts || r)}`);
  }

  console.log('Concluído. Confira os indicadores no painel de Obras.');
}

principal()
  .then(() => sequelize.close())
  .catch((e) => {
    console.error(`ERRO: ${e && e.message ? e.message : e}`);
    return sequelize.close().finally(() => process.exit(1));
  });

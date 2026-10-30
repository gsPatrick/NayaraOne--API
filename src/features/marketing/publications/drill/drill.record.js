'use strict';

const { sequelize } = require('../../../../models');
const { recordChannelDrill, SCENARIOS } = require('../adapters');
const { PERMISSION } = require('../adapters/release/evidence');
const { DRILL_SCENARIOS, BASELINE_SCENARIO } = require('./drill.constants');

/**
 * M9-D442 — o ensaio de cada canal vira a evidência FAILURE_DRILL do `releaseChannel` (M9-D430): `recordChannelDrill(canal, { ok, scenarios })`, gravada de verdade (única escrita
 * confirmada do ensaio; os dados dos cenários são sempre desfeitos). `scenarios` lista os cenários do sandbox (SCENARIOS, os 10 da M9-D430) que o ensaio exercitou e APROVOU; canal com
 * cenário faltando ou reprovado grava ok = false e não libera. O ensaio roda em nome do operador técnico, que por isso recebe aqui a permissão de registrar evidência.
 */
function exercisedScenarios(canalRows, baselineOk) {
  const passed = DRILL_SCENARIOS.filter((s) => s.sandbox && canalRows.some((r) => r.cenario === s.id && r.aprovado)).map((s) => s.sandbox);
  return baselineOk ? [BASELINE_SCENARIO, ...passed] : passed;
}

async function recordChannelResult(tenant, channel, report, outerTransaction = null) {
  const rows = report.rows.filter((r) => r.canal === channel);
  const baselineOk = report.baseline.filter((b) => b.canal === channel).every((b) => b.aprovado) && report.baseline.some((b) => b.canal === channel);
  const complete = DRILL_SCENARIOS.every((s) => rows.some((r) => r.cenario === s.id));
  const ok = complete && baselineOk && rows.every((r) => r.aprovado);
  const scenarios = exercisedScenarios(rows, baselineOk).filter((s) => SCENARIOS.includes(s));
  const ctx = { tenant, actor: tenant.userId, permissions: [PERMISSION] };
  if (outerTransaction) await recordChannelDrill(channel, { ok, scenarios }, ctx, outerTransaction); // dentro da transação de quem chama (teste)
  else {
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
      await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
      await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction });
      await recordChannelDrill(channel, { ok, scenarios }, ctx, transaction);
    });
  }
  return { channel, ok, scenarios };
}

module.exports = { recordChannelResult, exercisedScenarios };

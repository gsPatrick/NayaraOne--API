'use strict';

// Apoio dos testes dos KPIs financeiros do BI (M9-D621, M9-D623): reaproveita o ambiente da M9-D624 (duas empresas NOVAS no grupo do seed, relógio
// fixo em 28/10/2026 12:00 de São Paulo, refresh do read model e cálculo dos snapshots) e acrescenta a limpeza das fontes que estes KPIs gravam.
// Banco descartável (127.0.0.1).
const base = require('./m9d624Env');

const SOURCE_TABLES = ['financial_entries', 'commission_installments', 'commissions', 'owner_repasses'];
const HEALTH_EVENT = 'finance.entry.created';

async function teardown(env) {
  const ids = [env.cX.companyId, env.cY.companyId];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const t of SOURCE_TABLES) await env.admin.query(`DELETE FROM finance.${t} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
  });
  await base.teardown(env);
}

/** Aplica um evento de lançamento (health e margem por setor) com o payload do lançamento e recalcula os KPIs da data-base. */
async function refreshEntries(t, payload = {}) {
  const event = { ...base.event(t, HEALTH_EVENT), payloadJson: { id: base.ledger.uuid(), ...payload } };
  return base.inTx(t, { commit: true }, (tx) => require('../../../src/features/analytics/read-models').applyEvent(event, tx, { now: base.NOW }));
}

module.exports = { ...base, teardown, refreshEntries, SOURCE_TABLES };

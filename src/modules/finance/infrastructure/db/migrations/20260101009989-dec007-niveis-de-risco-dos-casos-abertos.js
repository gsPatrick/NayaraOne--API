'use strict';

/**
 * DEC-007 / DI-DEC007-6 — níveis de risco do antifraude alinhados à M4-D022 (item 3: conta nova MEDIUM; item 5: múltiplo de revisão MEDIUM, múltiplo de
 * bloqueio HIGH) e à M4-D006 (item 9: estorno frequente MEDIUM). O código passou a abrir os casos nesses níveis e o portão de pagamento bloqueia o achado
 * de risco HIGH. Os casos AINDA ABERTOS, abertos na escala anterior, são realinhados para o portão não mudar de comportamento com eles:
 *   AMOUNT_OUTLIER "Primeiro pagamento desta conta bancária..." (HIGH)  -> NEW_ACCOUNT_IMMEDIATE_PAYMENT MEDIUM (não bloqueava e continua sem bloquear)
 *   AMOUNT_OUTLIER HIGH (múltiplo de revisão)                           -> MEDIUM (não bloqueava e continua sem bloquear)
 *   AMOUNT_OUTLIER CRITICAL (múltiplo de bloqueio)                      -> HIGH (bloqueava e continua bloqueando)
 *   FREQUENT_REVERSAL HIGH                                              -> MEDIUM
 * Caso resolvido ou descartado não muda (é histórico). Cada caso realinhado deixa uma linha em audit.audit_log (finance.anomaly_case.risk_realigned) com o
 * antes e o depois. Idempotente.
 */
const AUDITORIA = `INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
  VALUES (gen_random_uuid(), :g, :c, NULL, 'finance.anomaly_case.risk_realigned', 'AnomalyCase', :id, :b::jsonb, :a::jsonb, :r, now(), now(), now())`;

const PRIMEIRO_PAGAMENTO = 'Primeiro pagamento desta conta bancária';

/** Novo tipo e nível de um caso aberto na escala anterior, ou null quando já está na escala nova. */
function realinhar({ case_type: tipo, risk_level: nivel, reason }) {
  if (tipo === 'AMOUNT_OUTLIER' && String(reason || '').startsWith(PRIMEIRO_PAGAMENTO)) return { tipo: 'NEW_ACCOUNT_IMMEDIATE_PAYMENT', nivel: 'MEDIUM' };
  if (tipo === 'AMOUNT_OUTLIER' && nivel === 'CRITICAL') return { tipo, nivel: 'HIGH' };
  if (tipo === 'AMOUNT_OUTLIER' && nivel === 'HIGH' && !/bloqueado até a revisão/.test(String(reason || ''))) return { tipo, nivel: 'MEDIUM' };
  if (tipo === 'FREQUENT_REVERSAL' && nivel === 'HIGH') return { tipo, nivel: 'MEDIUM' };
  return null;
}

async function realinharCasos(q) {
  const [casos] = await q(
    `SELECT id, group_id, company_id, case_type, risk_level, reason FROM finance.anomaly_cases
      WHERE status = 'OPEN' AND (case_type = 'AMOUNT_OUTLIER' OR (case_type = 'FREQUENT_REVERSAL' AND risk_level = 'HIGH'))
      ORDER BY created_at`, {});
  let n = 0;
  for (const c of casos) {
    const novo = realinhar(c);
    if (!novo) continue;
    await q('UPDATE finance.anomaly_cases SET case_type = :tipo, risk_level = :nivel, updated_at = now() WHERE id = :id', { tipo: novo.tipo, nivel: novo.nivel, id: c.id });
    await q(AUDITORIA, {
      g: c.group_id, c: c.company_id, id: c.id,
      b: JSON.stringify({ caseType: c.case_type, riskLevel: c.risk_level }), a: JSON.stringify({ caseType: novo.tipo, riskLevel: novo.nivel }),
      r: 'Migration 20260101009989 (DEC-007, DI-DEC007-6): caso aberto realinhado aos níveis de risco da M4-D022 e da M4-D006.',
    });
    n += 1;
  }
  return { realinhados: n };
}

const TABELAS = ['finance.anomaly_cases', 'audit.audit_log'];

module.exports = {
  up: async (queryInterface) => {
    const s = queryInterface.sequelize;
    await s.transaction(async (transaction) => {
      const q = (sql, replacements) => s.query(sql, { replacements, transaction });
      for (const t of TABELAS) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      await realinharCasos(q);
      for (const t of TABELAS) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    });
  },
  down: async () => {}, // não se desfaz: o antes de cada caso está na auditoria
  realinharCasos, realinhar,
};

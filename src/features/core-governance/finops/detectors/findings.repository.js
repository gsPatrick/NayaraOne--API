'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/**
 * Concilia os achados de UM detector com o que ele viu agora (M9-D862 §3): assunto visto e já aberto só atualiza `last_seen_at`, a evidência e a estimativa
 * (idempotente: o índice único parcial garante um aberto por empresa, detector e assunto); assunto novo abre; aberto cujo assunto sumiu RESOLVE sozinho.
 * Só escreve em governance.finops_findings. Devolve { opened, updated, resolved }.
 */
async function reconcile(tenant, detector, found, now, transaction) {
  const out = { opened: 0, updated: 0, resolved: 0 };
  for (const f of found) {
    const rows = await sequelize.query(
      `INSERT INTO governance.finops_findings (group_id, company_id, detector, subject, evidence, estimated_waste_cents, status, first_seen_at, last_seen_at)
       VALUES (:groupId, :companyId, :detector, :subject, CAST(:evidence AS jsonb), :waste, 'OPEN', :now, :now)
       ON CONFLICT (company_id, detector, subject) WHERE status = 'OPEN'
       DO UPDATE SET evidence = EXCLUDED.evidence, estimated_waste_cents = EXCLUDED.estimated_waste_cents, last_seen_at = :now, updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      { type: QueryTypes.SELECT, transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, detector, subject: f.subject, evidence: JSON.stringify(f.evidence || {}), waste: String(f.wasteCents || 0), now } }
    );
    out[rows[0].inserted ? 'opened' : 'updated'] += 1;
  }
  const subjects = found.map((f) => f.subject);
  const resolved = await sequelize.query(
    `UPDATE governance.finops_findings SET status = 'RESOLVED', resolved_at = :now, updated_at = now()
      WHERE company_id = :companyId AND detector = :detector AND status = 'OPEN'${subjects.length ? ' AND subject NOT IN (:subjects)' : ''} RETURNING id`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, detector, subjects, now } }
  );
  out.resolved = resolved.length;
  return out;
}

/** Achados da empresa para a saúde do FinOps: os abertos (e, se pedido, os resolvidos recentes). */
async function listOpen(tenant, transaction) {
  const rows = await sequelize.query(
    `SELECT id, detector, subject, evidence, estimated_waste_cents, status, first_seen_at, last_seen_at
       FROM governance.finops_findings WHERE company_id = :companyId AND status = 'OPEN' ORDER BY detector, subject`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId } }
  );
  return rows.map((r) => ({
    id: r.id, detector: r.detector, assunto: r.subject, evidencia: r.evidence, desperdicioEstimadoCentavos: Number(r.estimated_waste_cents), situacao: r.status, primeiraVez: r.first_seen_at, ultimaVez: r.last_seen_at,
  }));
}

module.exports = { reconcile, listOpen };

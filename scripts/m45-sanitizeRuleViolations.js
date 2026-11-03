'use strict';

/**
 * M45 (19/10/2026) — saneamento dos dados que violam as regras novas, PELA APLICAÇÃO.
 *
 * Regras varridas:
 *   1. Comprovante de baixa manual repetido por conteúdo (SHA-256) entre lançamentos que NÃO são
 *      a mesma baixa (pai e filhos de baixa parcial compartilham o comprovante legitimamente).
 *      Mantém o vínculo no lançamento mais antigo; nos demais EM ABERTO chama
 *      financialEntries.detachSettlementEvidence (motivo + auditoria). Lançamento liquidado com
 *      comprovante repetido não é mexido — vai para o relatório como pendência humana.
 *   2. Entrega de chaves com recebedor que não é parte do contrato: PENDING -> cancelKeyDelivery
 *      (motivo + auditoria). RELEASED vai para o relatório (termo assinado é definitivo).
 *   3. Entrega de chaves com signatário do termo que não é parte: idem (só relatório se RELEASED).
 *   4. Números de contrato repetidos na mesma empresa: relatório (o índice único da migration
 *      20260101000530 já impede novos casos).
 *
 * Nada é apagado; nenhuma linha do ledger sofre DELETE. A VARREDURA usa a credencial de migration
 * (só SELECT, enxerga todos os tenants); as CORREÇÕES rodam com a credencial de runtime, dentro da
 * transação de tenant (SET LOCAL app.group_id/company_id/user_id), pelos serviços da aplicação.
 *
 * Uso: node scripts/m45-sanitizeRuleViolations.js            (só relata — dry-run)
 *      node scripts/m45-sanitizeRuleViolations.js --apply    (aplica)
 *      ACTOR_EMAIL=... para escolher o usuário que assina a auditoria (padrão admin@nayaraone.dev).
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.migration.local') });
const { Client } = require('pg');
const { sequelize, User } = require('../src/models');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const keyDeliveriesService = require('../src/features/legal/keyDeliveries.service');

const APPLY = process.argv.includes('--apply');

async function scan() {
  const c = new Client({
    host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
    user: process.env.DB_MIGRATION_USER, password: process.env.DB_MIGRATION_PASSWORD,
  });
  await c.connect();
  try {
    const { rows: evidence } = await c.query(`
      SELECT e.id, e.group_id, e.company_id, e.status, e.parent_entry_id, e.created_at, f.checksum_sha256, e.settlement_evidence_file_id
        FROM finance.financial_entries e
        JOIN people.files f ON f.id = e.settlement_evidence_file_id
       WHERE f.checksum_sha256 IS NOT NULL
       ORDER BY e.created_at`);
    const { rows: recipients } = await c.query(`
      SELECT k.id, k.group_id, k.company_id, k.status FROM legal.key_deliveries k
       WHERE k.deleted_at IS NULL AND k.status <> 'CANCELLED'
         AND NOT EXISTS (SELECT 1 FROM legal.contract_parties p WHERE p.contract_id = k.contract_id AND p.person_id = k.delivered_to_person_id)`);
    const { rows: signers } = await c.query(`
      SELECT k.id, k.group_id, k.company_id, k.status FROM legal.key_deliveries k
       WHERE k.deleted_at IS NULL AND k.status <> 'CANCELLED' AND k.term_signed_by_person_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM legal.contract_parties p WHERE p.contract_id = k.contract_id AND p.person_id = k.term_signed_by_person_id)`);
    const { rows: contractNumbers } = await c.query(`
      SELECT company_id, contract_number, count(*)::int AS n FROM legal.contracts
       WHERE contract_number IS NOT NULL AND deleted_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1`);
    return { evidence, recipients, signers, contractNumbers };
  } finally {
    await c.end();
  }
}

// Agrupa por (empresa, sha256); dentro do grupo, a "baixa" é o lançamento raiz (pai) — filhos de
// baixa parcial pertencem à mesma baixa do pai. Mais de uma baixa raiz no grupo = violação.
function evidenceViolations(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.company_id}|${r.checksum_sha256}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const list of groups.values()) {
    const roots = new Map();
    for (const r of list) {
      const root = r.parent_entry_id || r.id;
      if (!roots.has(root)) roots.set(root, []);
      roots.get(root).push(r);
    }
    if (roots.size < 2) continue;
    const ordered = [...roots.values()].sort((a, b) => new Date(a[0].created_at) - new Date(b[0].created_at));
    for (const extra of ordered.slice(1)) for (const r of extra) out.push({ ...r, keptEntryId: ordered[0][0].id });
  }
  return out;
}

async function inTenant(row, actorUserId, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: row.group_id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: row.company_id }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: actorUserId }, transaction });
    return fn(transaction);
  });
}

async function main() {
  const actorEmail = process.env.ACTOR_EMAIL || 'admin@nayaraone.dev';
  const actor = await User.findOne({ where: { email: actorEmail } });
  if (!actor) throw new Error(`Usuário de auditoria ${actorEmail} não encontrado.`);

  const found = await scan();
  const report = { mode: APPLY ? 'apply' : 'dry-run', fixed: [], humanAction: [] };
  const evViol = evidenceViolations(found.evidence);
  const kdViol = [
    ...found.recipients.map((r) => ({ ...r, rule: 'recebedor não é parte do contrato' })),
    ...found.signers.map((r) => ({ ...r, rule: 'signatário do termo não é parte do contrato' })),
  ];
  report.counts = {
    comprovanteRepetidoSha256: evViol.length,
    entregaRecebedorNaoParte: found.recipients.length,
    entregaSignatarioNaoParte: found.signers.length,
    numeroContratoRepetido: found.contractNumbers.length,
  };

  for (const r of evViol) {
    if (r.status !== 'PENDING') {
      report.humanAction.push({ type: 'comprovante', entryId: r.id, status: r.status, keptEntryId: r.keptEntryId,
        why: 'lançamento já liquidado/parcial — vínculo não é removido automaticamente' });
      continue;
    }
    const reason = `Saneamento M45: comprovante com o mesmo conteúdo (SHA-256 ${r.checksum_sha256.slice(0, 12)}…) já vinculado ao lançamento ${r.keptEntryId}; vínculo duplicado removido. Anexe o comprovante próprio deste pagamento.`;
    if (APPLY) await inTenant(r, actor.id, (t) => financialEntriesService.detachSettlementEvidence(r.id, { reason }, actor.id, t));
    report.fixed.push({ type: 'comprovante', entryId: r.id, keptEntryId: r.keptEntryId });
  }

  const seen = new Set();
  for (const r of kdViol) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (r.status !== 'PENDING') {
      report.humanAction.push({ type: 'entrega_chaves', id: r.id, status: r.status, rule: r.rule,
        why: 'entrega já liberada — termo assinado é definitivo; precisa de análise jurídica' });
      continue;
    }
    const reason = `Saneamento M45: ${r.rule} (regra F6). Entrega cancelada; registre uma nova entrega para uma parte do contrato.`;
    if (APPLY) await inTenant(r, actor.id, (t) => keyDeliveriesService.cancelKeyDelivery(r.id, { reason }, actor.id, t));
    report.fixed.push({ type: 'entrega_chaves', id: r.id, rule: r.rule });
  }
  for (const r of found.contractNumbers) report.humanAction.push({ type: 'numero_contrato', ...r });

  console.log(JSON.stringify(report, null, 2));
}

main()
  .then(() => sequelize.close())
  .catch(async (err) => {
    console.error(err);
    await sequelize.close().catch(() => {});
    process.exit(1);
  });

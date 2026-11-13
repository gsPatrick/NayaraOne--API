'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize, FinancialEntry } = require('../../../../../models');
const { settleFinancialEntry, reverseFinancialEntry } = require('../../../../../modules/finance/application/services/receipt.service');
const { resolveRef, UUID } = require('../refs');
const { commandRejected } = require('../../bcp.errors');
const normalize = require('../normalize');

/** A parcela do papel: o id do lançamento a receber, ou o número do contrato quando ele tem exatamente UM recebimento em aberto (mais de um: o papel precisa dizer qual). */
async function resolveInstallment(ref, tenant, transaction) {
  const value = String(ref || '').trim();
  if (UUID.test(value)) return resolveRef('financialEntry', value, tenant, transaction);
  const contract = await resolveRef('contract', value, tenant, transaction);
  const open = await sequelize.query(
    "SELECT id FROM finance.financial_entries WHERE company_id = :companyId AND contract_id = :contractId AND nature = 'RECEIVABLE' AND status = 'PENDING' AND parent_entry_id IS NULL ORDER BY due_at LIMIT 2",
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, contractId: contract.id } }
  );
  if (open.length === 0) throw commandRejected(`o contrato "${value}" não tem recebimento em aberto`);
  if (open.length > 1) throw commandRejected(`o contrato "${value}" tem mais de um recebimento em aberto: informe o identificador da parcela`);
  return open[0];
}

/** Documentos (só dígitos) das partes do contrato do lançamento: de quem se espera o pagamento. */
async function payerDocuments(entry, transaction) {
  if (!entry.contractId) return [];
  const rows = await sequelize.query(
    `SELECT p.tax_id_normalized AS doc FROM legal.contract_parties cp JOIN people.persons p ON p.id = cp.person_id
      WHERE cp.contract_id = :contractId AND cp.deleted_at IS NULL AND p.tax_id_normalized IS NOT NULL ORDER BY (cp.party_role = 'TENANT') DESC`,
    { type: QueryTypes.SELECT, transaction, replacements: { contractId: entry.contractId } }
  );
  return rows.map((row) => normalize.digits(row.doc));
}

/**
 * RECEIVE_PAYMENT: o recebimento do papel baixa o lançamento a receber (a parcela) pelo serviço normal do Financeiro, com a data do papel como data do caixa. Quem manda é o
 * lançamento do sistema: o valor gravado é o da parcela e o do papel só é conferido (R$ 1.250,00 no papel e R$ 1.205,00 na parcela: DIVERGENT, diferença de R$ 45,00).
 * Confere valor, data e documento do pagador.
 */
async function execute({ tenant, actorUserId, payload, transaction }) {
  const installment = await resolveInstallment(payload.referenciaParcela, tenant, transaction);
  const entry = await FinancialEntry.findByPk(installment.id, { transaction });
  if (!entry || entry.nature !== 'RECEIVABLE') throw commandRejected('a parcela informada não é um recebimento (lançamento a receber)');
  const settledAt = normalize.noonOf(payload.data);
  if (!settledAt) throw commandRejected('a data do recebimento é inválida');
  const settled = await settleFinancialEntry(entry.id, actorUserId, transaction, { settledAt });
  const saved = await FinancialEntry.findByPk(settled.id, { transaction });
  const documents = await payerDocuments(saved, transaction);
  const paperDoc = normalize.digits(payload.documento);
  return {
    commandRef: `FinancialEntry:${saved.id}`,
    undo: { entryId: saved.id },
    comparisons: [
      { field: 'valorCentavos', label: 'Valor (centavos)', paper: normalize.cents(payload.valorCentavos), command: normalize.cents(saved.amount, { fromDecimal: true }), kind: 'cents' },
      { field: 'data', label: 'Data do recebimento', paper: normalize.day(payload.data), command: normalize.day(saved.settledAt), kind: 'date' },
      { field: 'documento', label: 'Documento do pagador', paper: paperDoc, command: documents.includes(paperDoc) ? paperDoc : documents[0] || '', kind: 'digits' },
    ],
  };
}

/** Estorno: o estorno do serviço normal (lançamento compensatório; o original passa a REVERSED). */
async function reverse({ actorUserId, effect, operation, transaction }) {
  await reverseFinancialEntry(effect.entryId, `Estorno da operação manual ${operation.manualReference} (BCP)`, actorUserId, transaction, {});
}

module.exports = { action: 'RECEIVE_PAYMENT', execute, reverse };

'use strict';

const { Op } = require('sequelize');
const { OwnershipTransferTask, LeaseObligationCycle, UtilityReimbursement, FinancialEntry } = require('../../../models');
const { leaseObligationParams } = require('./leaseObligationParams');

/**
 * Pendências das obrigações da locação que seguram o encerramento (bloco de cobrança do livro "Encerramento bloqueia com
 * obrigação crítica pendente"; §12 "não some quando contrato encerra"). O livro não define "obrigação crítica": quais pendências
 * contam é configuração da empresa (`locacao.encerramento.bloqueia.<PENDÊNCIA>`, leaseObligations.settings.js):
 *  - TRANSFER: troca de titularidade pendente (padrão ligado, como já era);
 *  - CYCLE_OVERDUE: vencimento sem comprovante já vencido (padrão ligado);
 *  - REIMBURSEMENT_PENDING: reembolso a receber ainda não recebido (padrão desligado, como já era).
 */
const OPEN_ENTRY = ['PENDING', 'PARTIALLY_SETTLED'];

async function collectObligationPendencies(contract, obligations, transaction) {
  if (!obligations.length) return [];
  const params = await leaseObligationParams({ groupId: contract.groupId, companyId: contract.companyId }, transaction);
  const ids = obligations.map((o) => o.id);
  const out = [];
  if (params.closureBlocks.TRANSFER) {
    const pending = await OwnershipTransferTask.findAll({ where: { utilityObligationId: { [Op.in]: ids }, status: 'PENDING' }, transaction });
    if (pending.length) out.push({ type: 'PENDING_UTILITY_TRANSFER', detail: `${pending.length} transferência(s) de titularidade de utilidade não concluída(s).`, ownershipTransferTaskIds: pending.map((t) => t.id) });
  }
  if (params.closureBlocks.CYCLE_OVERDUE) {
    const overdue = await LeaseObligationCycle.findAll({ where: { obligationId: { [Op.in]: ids }, status: 'OVERDUE' }, transaction });
    if (overdue.length) out.push({ type: 'OVERDUE_OBLIGATION_CYCLE', detail: `${overdue.length} vencimento(s) de obrigação da locação sem comprovante.`, cycleIds: overdue.map((c) => c.id) });
  }
  if (params.closureBlocks.REIMBURSEMENT_PENDING) {
    const reimbursements = await UtilityReimbursement.findAll({ where: { utilityObligationId: { [Op.in]: ids }, status: 'PENDING' }, transaction });
    const open = [];
    for (const r of reimbursements) {
      const entry = r.financialEntryId ? await FinancialEntry.findByPk(r.financialEntryId, { attributes: ['status'], transaction }) : null;
      if (!entry || OPEN_ENTRY.includes(entry.status)) open.push(r.id);
    }
    if (open.length) out.push({ type: 'PENDING_REIMBURSEMENT', detail: `${open.length} reembolso(s) de utilidade a receber.`, reimbursementIds: open });
  }
  return out;
}

module.exports = { collectObligationPendencies };

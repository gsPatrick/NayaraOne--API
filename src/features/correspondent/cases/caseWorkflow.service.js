'use strict';

const { FinancingCase, ProviderStatusHistory, ProviderSubmission, FinancingProposal } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { shouldApplyTransition } = require('../statusMachine');
const { publishFinancingStatusChanged } = require('../correspondentEvents.service');
const { syncOpportunityFromFinancingCase, STATUS_LABEL_PT } = require('../correspondentCrmSync.service');

// Estados que uma pessoa pode registrar para um caso de provider manual (o banco não tem API: quem
// leva o caso ao banco informa o resultado). SUBMITTED já é o "registrar ação manual".
const MANUAL_STATUSES = ['UNDER_ANALYSIS', 'PENDING_CUSTOMER', 'PENDING_PROPERTY', 'APPROVED', 'REJECTED', 'CONTRACTING', 'COMPLETED'];
const PRE_SUBMISSION_STATUSES = ['DRAFT', 'DOCUMENTS_PENDING', 'READY_TO_SUBMIT'];
const PROPOSAL_STATUSES = ['APPROVED', 'CONTRACTING'];

const label = (status) => STATUS_LABEL_PT[status] || status;

async function findCase(financingCaseId, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!financingCase) throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  return financingCase;
}

/**
 * validateProposalInput — condições devolvidas pelo banco. Valor e prazo são obrigatórios; taxa,
 * parcela e validade são opcionais, mas, se vierem, precisam ser coerentes.
 */
function validateProposalInput(input) {
  const approvedAmount = Number(input?.approvedAmount);
  if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
    throw AppError.badRequest('O valor aprovado da proposta deve ser maior que zero.', 'PROPOSAL_VALIDATION');
  }
  const termMonths = Number(input?.termMonths);
  if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 480) {
    throw AppError.badRequest('O prazo da proposta deve ser um número inteiro de meses entre 1 e 480.', 'PROPOSAL_VALIDATION');
  }
  let annualRatePct = null;
  if (input.annualRatePct !== undefined && input.annualRatePct !== null && input.annualRatePct !== '') {
    annualRatePct = Number(input.annualRatePct);
    if (!Number.isFinite(annualRatePct) || annualRatePct < 0 || annualRatePct > 100) {
      throw AppError.badRequest('A taxa anual da proposta deve estar entre 0% e 100%.', 'PROPOSAL_VALIDATION');
    }
  }
  let monthlyPayment = null;
  if (input.monthlyPayment !== undefined && input.monthlyPayment !== null && input.monthlyPayment !== '') {
    monthlyPayment = Number(input.monthlyPayment);
    if (!Number.isFinite(monthlyPayment) || monthlyPayment <= 0) {
      throw AppError.badRequest('A parcela da proposta deve ser maior que zero.', 'PROPOSAL_VALIDATION');
    }
  }
  let validUntil = null;
  if (input.validUntil) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.validUntil)) || Number.isNaN(new Date(`${input.validUntil}T00:00:00Z`).getTime())) {
      throw AppError.badRequest('A validade da proposta deve ser uma data válida.', 'PROPOSAL_VALIDATION');
    }
    validUntil = String(input.validUntil);
  }
  return { approvedAmount: Math.round(approvedAmount * 100) / 100, annualRatePct, termMonths, monthlyPayment: monthlyPayment === null ? null : Math.round(monthlyPayment * 100) / 100, validUntil };
}

/**
 * recordProposal — grava a proposta do banco; a anterior (se houver) vira SUPERSEDED, nunca é apagada.
 */
async function recordProposal(financingCase, input, source, actorUserId, transaction) {
  const data = validateProposalInput(input);
  await FinancingProposal.update(
    { status: 'SUPERSEDED' },
    { where: { financingCaseId: financingCase.id, status: 'ACTIVE' }, transaction }
  );
  const proposal = await FinancingProposal.create(
    {
      groupId: financingCase.groupId,
      companyId: financingCase.companyId,
      financingCaseId: financingCase.id,
      providerCode: financingCase.providerCode,
      source,
      ...data,
      status: 'ACTIVE',
      responseSnapshot: source === 'PROVIDER' ? input : null,
      createdBy: actorUserId || null,
    },
    { transaction }
  );
  await registrarAuditoria(
    {
      groupId: financingCase.groupId,
      companyId: financingCase.companyId,
      actorUserId: actorUserId || null,
      action: 'correspondent.proposal.recorded',
      entityType: 'FinancingCase',
      entityId: financingCase.id,
      afterJson: { proposalId: proposal.id, source, approvedAmount: data.approvedAmount, termMonths: data.termMonths, annualRatePct: data.annualRatePct },
      reason: `Proposta do banco registrada (${source === 'PROVIDER' ? 'enviada pelo provider' : 'informada por uma pessoa'}): R$ ${data.approvedAmount.toFixed(2)} em ${data.termMonths} meses.`,
    },
    transaction
  );
  return proposal;
}

/**
 * applyStatusChange — troca o status do caso, grava o histórico (append-only), emite os eventos do
 * caderno e atualiza a oportunidade do CRM por evento. Quem chama já validou a transição.
 */
async function applyStatusChange(financingCase, normalizedStatus, { rawStatus, source, cancelReason }, actorUserId, auditReason, transaction) {
  const previousStatus = financingCase.status;
  const history = await ProviderStatusHistory.create(
    {
      groupId: financingCase.groupId,
      companyId: financingCase.companyId,
      financingCaseId: financingCase.id,
      rawProviderStatus: rawStatus,
      normalizedStatus,
      source,
      applied: true,
      occurredAt: new Date(),
    },
    { transaction }
  );
  financingCase.status = normalizedStatus;
  if (normalizedStatus === 'CANCELED') {
    financingCase.canceledReason = cancelReason || 'Cancelado sem motivo informado';
    financingCase.canceledAt = new Date();
  }
  financingCase.updatedBy = actorUserId || null;
  await financingCase.save({ transaction });
  await publishFinancingStatusChanged(financingCase, { previousStatus, normalizedStatus, historyId: history.id }, transaction);
  await syncOpportunityFromFinancingCase(financingCase, normalizedStatus, transaction);
  await registrarAuditoria(
    {
      groupId: financingCase.groupId,
      companyId: financingCase.companyId,
      actorUserId: actorUserId || null,
      action: `correspondent.financing_case.${source === 'manual' ? 'manual_status' : 'status_changed'}`,
      entityType: 'FinancingCase',
      entityId: financingCase.id,
      beforeJson: { status: previousStatus },
      afterJson: { status: normalizedStatus },
      reason: auditReason,
    },
    transaction
  );
  return history;
}

/**
 * registerManualStatus — o "workflow manual assistido" do caderno: para provider sem API, quem leva o
 * caso ao banco registra o resultado. Mesmo modelo interno, mesmos eventos, mesma ordem de estados.
 */
async function registerManualStatus(financingCaseId, payload, actorUserId, groupId, companyId, transaction) {
  const financingCase = await findCase(financingCaseId, groupId, companyId, transaction);
  if (financingCase.providerCode !== 'manual') {
    throw AppError.unprocessable('Este caso usa um provider com integração: quem atualiza o status é o próprio provider.', 'FINANCING_CASE_NOT_MANUAL');
  }
  const status = String(payload?.status || '').toUpperCase();
  if (!MANUAL_STATUSES.includes(status)) {
    throw AppError.badRequest(`O status deve ser um destes: ${MANUAL_STATUSES.map(label).join(', ')}.`, 'MANUAL_STATUS_VALIDATION');
  }
  const note = String(payload?.note || '').trim();
  if (status === 'REJECTED' && note.length < 3) {
    throw AppError.badRequest('Informe o motivo da recusa pelo banco.', 'MANUAL_STATUS_REASON_REQUIRED');
  }
  if (PRE_SUBMISSION_STATUSES.includes(financingCase.status)) {
    throw AppError.unprocessable('Registre primeiro a ação manual (o envio ao banco) deste caso antes de informar o resultado.', 'FINANCING_CASE_NOT_SUBMITTED');
  }
  if (financingCase.status === status) {
    throw AppError.conflict(`O caso já está em "${label(status)}".`, 'MANUAL_STATUS_ALREADY_APPLIED');
  }
  if (!shouldApplyTransition(financingCase.status, status)) {
    throw AppError.conflict(`O caso já está em "${label(financingCase.status)}" e não pode voltar para "${label(status)}".`, 'MANUAL_STATUS_OUT_OF_ORDER');
  }
  if (payload?.proposal && !PROPOSAL_STATUSES.includes(status)) {
    throw AppError.badRequest('A proposta do banco só é registrada junto com "Aprovado" ou "Em contratação".', 'MANUAL_STATUS_VALIDATION');
  }
  const proposalInput = payload?.proposal ? validateProposalInput(payload.proposal) : null;

  await applyStatusChange(
    financingCase,
    status,
    { rawStatus: `MANUAL:${status}`, source: 'manual' },
    actorUserId,
    `Resultado do banco registrado por uma pessoa: "${label(status)}"${note ? `. Observação: ${note.slice(0, 300)}` : ''}.`,
    transaction
  );
  const proposal = proposalInput ? await recordProposal(financingCase, proposalInput, 'MANUAL', actorUserId, transaction) : null;
  return { financingCase, proposal };
}

/**
 * cancelCase — cancela o caso (qualquer provider). Exige motivo. Submissões ainda pendentes deixam de
 * ser enviadas. Um caso concluído não pode ser cancelado.
 */
async function cancelCase(financingCaseId, payload, actorUserId, groupId, companyId, transaction) {
  const financingCase = await findCase(financingCaseId, groupId, companyId, transaction);
  const reason = String(payload?.reason || '').trim();
  if (reason.length < 3) {
    throw AppError.badRequest('Informe o motivo do cancelamento.', 'CASE_CANCEL_REASON_REQUIRED');
  }
  if (financingCase.status === 'CANCELED') {
    throw AppError.conflict('Este caso já está cancelado.', 'CASE_ALREADY_CANCELED');
  }
  if (!shouldApplyTransition(financingCase.status, 'CANCELED')) {
    throw AppError.conflict(`Um caso em "${label(financingCase.status)}" não pode ser cancelado.`, 'CASE_CANCEL_NOT_ALLOWED');
  }
  await applyStatusChange(
    financingCase,
    'CANCELED',
    { rawStatus: 'MANUAL:CANCELED', source: 'manual', cancelReason: reason },
    actorUserId,
    `Caso cancelado por uma pessoa. Motivo: ${reason.slice(0, 300)}.`,
    transaction
  );
  await ProviderSubmission.update(
    { status: 'CANCELED', failureReason: 'CASO_CANCELADO' },
    { where: { financingCaseId: financingCase.id, groupId, companyId, status: 'PENDING' }, transaction }
  );
  return financingCase;
}

async function listProposals(financingCaseId, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  return FinancingProposal.findAll({ where: { financingCaseId, groupId, companyId }, order: [['created_at', 'DESC']], transaction });
}

module.exports = { registerManualStatus, cancelCase, recordProposal, listProposals, validateProposalInput, MANUAL_STATUSES, PROPOSAL_STATUSES };

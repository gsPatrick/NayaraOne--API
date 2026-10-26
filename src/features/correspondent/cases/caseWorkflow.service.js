'use strict';

const { sequelize, FinancingCase, ProviderStatusHistory, ProviderSubmission, FinancingProposal, IntegrationError } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { shouldApplyTransition } = require('../statusMachine');
const { publishFinancingStatusChanged } = require('../correspondentEvents.service');
const { syncOpportunityFromFinancingCase, STATUS_LABEL_PT } = require('../correspondentCrmSync.service');
const { resolveFinancingProviderAdapterByCode } = require('../adapters/resolveFinancingProviderAdapter');
const { recordIntegrationError } = require('../integrationErrors.service');
const { publishIntegrationCorrespondentFailed } = require('../correspondentEvents.service');

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
function validateProposalInput(input, { rejectPastValidity = false } = {}) {
  const approvedAmount = Number(input?.approvedAmount);
  if (!Number.isFinite(approvedAmount) || approvedAmount <= 0 || approvedAmount > 99999999999) {
    throw AppError.badRequest('O valor aprovado da proposta deve ser maior que zero e menor que R$ 100 bilhões.', 'PROPOSAL_VALIDATION');
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
    // O banco guarda 4 casas: o valor registrado é o mesmo que será gravado.
    annualRatePct = Math.round(annualRatePct * 10000) / 10000;
  }
  let monthlyPayment = null;
  if (input.monthlyPayment !== undefined && input.monthlyPayment !== null && input.monthlyPayment !== '') {
    monthlyPayment = Number(input.monthlyPayment);
    if (!Number.isFinite(monthlyPayment) || monthlyPayment <= 0 || monthlyPayment > 99999999999) {
      throw AppError.badRequest('A parcela da proposta deve ser maior que zero.', 'PROPOSAL_VALIDATION');
    }
  }
  let validUntil = null;
  if (input.validUntil) {
    const parsedValid = new Date(`${input.validUntil}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.validUntil)) || Number.isNaN(parsedValid.getTime()) || parsedValid.toISOString().slice(0, 10) !== String(input.validUntil)) {
      throw AppError.badRequest('A validade da proposta deve ser uma data válida.', 'PROPOSAL_VALIDATION');
    }
    validUntil = String(input.validUntil);
    // Proposta digitada por uma pessoa já nasce com validade futura; a do provider é guardada como veio.
    if (rejectPastValidity && validUntil < new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10)) {
      throw AppError.badRequest('A validade da proposta já passou. Informe a data de validade vigente ou deixe em branco.', 'PROPOSAL_VALIDATION');
    }
  }
  const proposalPaymentTotal = monthlyPayment === null ? null : monthlyPayment * termMonths + termMonths * 0.01;
  if (proposalPaymentTotal !== null && proposalPaymentTotal < approvedAmount) {
    throw AppError.badRequest('A parcela informada não fecha com o valor aprovado e o prazo: parcela vezes prazo é menor que o valor aprovado.', 'PROPOSAL_VALIDATION');
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
async function applyStatusChange(financingCase, normalizedStatus, { rawStatus, source, cancelReason, note }, actorUserId, auditReason, transaction) {
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
      note: note ? String(note).slice(0, 500) : null,
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
async function registerManualStatus(financingCaseId, payload, actorUserId, groupId, companyId, transaction, { canCorrect = false } = {}) {
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
  const correction = payload?.correction === true;
  if (correction) {
    if (!canCorrect) {
      throw AppError.forbidden('Corrigir um resultado já registrado exige a permissão de parâmetros do correspondente.', 'MANUAL_STATUS_CORRECTION_FORBIDDEN');
    }
    if (note.length < 5) {
      throw AppError.badRequest('Informe o motivo da correção (mínimo 5 caracteres).', 'MANUAL_STATUS_REASON_REQUIRED');
    }
    if (['COMPLETED', 'CANCELED'].includes(financingCase.status)) {
      throw AppError.conflict('Um caso concluído ou cancelado não pode ser corrigido.', 'MANUAL_STATUS_CORRECTION_NOT_ALLOWED');
    }
  }
  if (PRE_SUBMISSION_STATUSES.includes(financingCase.status)) {
    throw AppError.unprocessable('Registre primeiro a ação manual (o envio ao banco) deste caso antes de informar o resultado.', 'FINANCING_CASE_NOT_SUBMITTED');
  }
  if (financingCase.status === status) {
    throw AppError.conflict(`O caso já está em "${label(status)}".`, 'MANUAL_STATUS_ALREADY_APPLIED');
  }
  if (!correction && ['CONTRACTING', 'COMPLETED'].includes(status) && !['APPROVED', 'CONTRACTING'].includes(financingCase.status)) {
    throw AppError.unprocessable('Antes de registrar contratação ou conclusão, registre a aprovação do banco (com a proposta).', 'MANUAL_STATUS_APPROVAL_REQUIRED');
  }
  if (!correction && !shouldApplyTransition(financingCase.status, status)) {
    throw AppError.conflict(`O caso já está em "${label(financingCase.status)}" e não pode voltar para "${label(status)}".`, 'MANUAL_STATUS_OUT_OF_ORDER');
  }
  if (payload?.proposal && !PROPOSAL_STATUSES.includes(status)) {
    throw AppError.badRequest('A proposta do banco só é registrada junto com "Aprovado" ou "Em contratação".', 'MANUAL_STATUS_VALIDATION');
  }
  const proposalInput = payload?.proposal ? validateProposalInput(payload.proposal, { rejectPastValidity: true }) : null;
  if (PROPOSAL_STATUSES.includes(status) && !proposalInput) {
    const { peekEligibilityConfig } = require('../eligibility.service');
    if ((await peekEligibilityConfig(groupId, companyId, transaction)).requireProposalOnApproval === true) {
      throw AppError.badRequest('Por regra da empresa, informe a proposta do banco ao registrar aprovação ou contratação.', 'MANUAL_STATUS_PROPOSAL_REQUIRED');
    }
  }

  await applyStatusChange(
    financingCase,
    status,
    { rawStatus: `MANUAL:${status}`, source: 'manual', note: correction ? `Correção: ${note}` : note },
    actorUserId,
    `${correction ? 'Resultado do banco CORRIGIDO por uma pessoa' : 'Resultado do banco registrado por uma pessoa'}: "${label(status)}"${note ? `. ${correction ? 'Motivo' : 'Observação'}: ${note.slice(0, 300)}` : ''}.`,
    transaction
  );
  const proposal = proposalInput ? await recordProposal(financingCase, proposalInput, 'MANUAL', actorUserId, transaction) : null;
  if (status === 'REJECTED') await onCaseClosedByProvider(financingCase, 'REJECTED', transaction, { actorUserId, reason: note });
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
    { rawStatus: 'MANUAL:CANCELED', source: 'manual', cancelReason: reason, note: reason },
    actorUserId,
    `Caso cancelado por uma pessoa. Motivo: ${reason.slice(0, 300)}.`,
    transaction
  );
  // Caso que o provider já tem (envio aceito, ou envio UNKNOWN que o provider confirma ter): o provider é
  // avisado do cancelamento DEPOIS de confirmar o cancelamento aqui (sem segurar trava do caso durante a
  // chamada externa). Provider sem esse recurso (manual) fica registrado para a pessoa avisar o banco.
  const { withTimeout } = require('./submissions.service');
  const adapter = resolveFinancingProviderAdapterByCode(financingCase.providerCode);
  const openSubmissions = await ProviderSubmission.findAll({
    where: { financingCaseId: financingCase.id, groupId, companyId, status: ['SUBMITTED', 'UNKNOWN'] },
    transaction,
  });
  const providerNotices = [];
  const uncertainSubmissions = [];
  for (const submission of openSubmissions) {
    if (submission.externalCaseId) providerNotices.push({ submissionId: submission.id, externalId: submission.externalCaseId });
    else if (submission.status === 'UNKNOWN') uncertainSubmissions.push({ id: submission.id, idempotencyKey: submission.idempotencyKey });
  }
  // Pendência durável: o aviso ao provider acontece depois da confirmação, em memória. Para não se perder se o
  // processo cair, cada aviso nasce como um erro de integração EM ABERTO (visível na tela de erros) dentro da
  // própria transação do cancelamento; quando o provider confirma, o registro é resolvido sozinho.
  const markerFor = new Map();
  for (const item of [...providerNotices.map((n) => ({ key: n.submissionId, text: 'avisar o provider do cancelamento' })), ...uncertainSubmissions.map((u) => ({ key: u.id, text: 'conferir no provider se existe caso aberto e cancelá-lo' }))]) {
    // eslint-disable-next-line no-await-in-loop
    const marker = await recordIntegrationError(
      { groupId, companyId, financingCaseId: financingCase.id, providerCode: financingCase.providerCode, operation: 'cancel', errorCode: 'CANCEL_NOTICE_PENDING', message: `O caso foi cancelado aqui. Falta ${item.text}.` },
      transaction
    );
    markerFor.set(item.key, marker.id);
  }
  const closeMarker = async (runTx, key, { resolved, errorCode, message }) => {
    const markerId = markerFor.get(key);
    if (!markerId) return;
    await runTx(async (tx) => {
      const marker = await IntegrationError.findOne({ where: { id: markerId, groupId, companyId }, transaction: tx });
      if (!marker || marker.status === 'RESOLVED') return;
      if (resolved) {
        marker.status = 'RESOLVED';
        marker.resolvedAt = new Date();
        marker.resolutionNote = 'O provider foi avisado do cancelamento automaticamente.';
      } else {
        marker.errorCode = errorCode;
        marker.message = String(message).slice(0, 500);
      }
      await marker.save({ transaction: tx });
    });
  };
  const notifyProvider = async (runTx) => {
    // Envios incertos: a consulta ao provider (pode demorar) acontece aqui, sem trava do caso.
    for (const uncertain of uncertainSubmissions) {
      let externalId = null;
      let lookupFailed = false;
      if (adapter && typeof adapter.findSubmissionByKey === 'function') {
        try {
          // eslint-disable-next-line no-await-in-loop
          const lookup = await withTimeout(adapter.findSubmissionByKey(uncertain.idempotencyKey), 8000);
          if (lookup?.found) externalId = lookup.externalId;
        } catch (err) {
          lookupFailed = true;
        }
      }
      if (externalId) {
        providerNotices.push({ submissionId: uncertain.id, externalId });
      } else {
        // eslint-disable-next-line no-await-in-loop
        await closeMarker(runTx, uncertain.id, {
          resolved: false,
          errorCode: 'CANCEL_UNCERTAIN',
          message: `O caso foi cancelado aqui, mas o envio ao provider estava indefinido${lookupFailed ? ' e a consulta falhou' : ''}: confira no provider se existe um caso aberto e cancele lá.`,
        });
      }
    }
    for (const notice of providerNotices) {
      if (adapter && typeof adapter.cancelCase === 'function' && adapter.capabilities().cancelCase) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await withTimeout(adapter.cancelCase(notice.externalId), 8000);
          // eslint-disable-next-line no-await-in-loop
          await runTx((tx) => registrarAuditoria(
            { groupId, companyId, actorUserId, action: 'correspondent.case.canceled_at_provider', entityType: 'FinancingCase', entityId: financingCase.id, reason: `O cancelamento do caso foi comunicado ao provider "${financingCase.providerCode}" (referência "${notice.externalId}").` },
            tx
          ));
          // eslint-disable-next-line no-await-in-loop
          await closeMarker(runTx, notice.submissionId, { resolved: true });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[CaseWorkflow] Falha ao avisar o provider do cancelamento do caso ${financingCase.id}: ${String(err && err.message).slice(0, 200)}`);
          // eslint-disable-next-line no-await-in-loop
          await runTx(async (tx) => {
            await publishIntegrationCorrespondentFailed(financingCase, { providerCode: financingCase.providerCode, reason: 'Falha ao comunicar o cancelamento ao provider.', submissionId: `cancel:${notice.submissionId}:${Date.now()}` }, tx);
          });
          // eslint-disable-next-line no-await-in-loop
          await closeMarker(runTx, notice.submissionId, { resolved: false, errorCode: 'CANCEL_AT_PROVIDER_FAILED', message: 'O caso foi cancelado aqui, mas não foi possível avisar o provider. Avise o banco.' });
        }
      } else {
        // eslint-disable-next-line no-await-in-loop
        await runTx((tx) => registrarAuditoria(
          { groupId, companyId, actorUserId, action: 'correspondent.case.cancel_manual_notice', entityType: 'FinancingCase', entityId: financingCase.id, reason: `Caso cancelado aqui; o provider "${financingCase.providerCode}" não recebe cancelamento pelo sistema: avise o banco (referência "${notice.externalId}").` },
          tx
        ));
        // eslint-disable-next-line no-await-in-loop
        await closeMarker(runTx, notice.submissionId, { resolved: false, errorCode: 'CANCEL_MANUAL_NOTICE', message: `O provider "${financingCase.providerCode}" não recebe cancelamento pelo sistema: avise o banco (referência "${notice.externalId}").` });
      }
    }
  };
  if (providerNotices.length || uncertainSubmissions.length) {
    if (process.env.NODE_ENV === 'test') {
      // Nos testes (transação que volta) o aviso roda no mesmo lugar, dentro da transação.
      await notifyProvider((fn) => fn(transaction));
    } else {
      transaction.afterCommit(async () => {
        const runTx = (fn) => sequelize.transaction(async (tx) => {
          await sequelize.query('SELECT set_config(\'app.group_id\', :groupId, true), set_config(\'app.company_id\', :companyId, true), set_config(\'app.user_id\', :userId, true)', { replacements: { groupId, companyId, userId: actorUserId || '' }, transaction: tx });
          return fn(tx);
        });
        try { await notifyProvider(runTx); } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[CaseWorkflow] O aviso de cancelamento do caso ${financingCase.id} não terminou: ${String(err && err.message).slice(0, 200)}. O registro de pendência continua em aberto na tela de erros.`);
        }
      });
    }
  }
  // Comissões do caso: as só previstas (EXPECTED) viram ajuste; as já confirmadas geram alerta visível.
  await closeCommissionsOfClosedCase(financingCase, 'cancelado', reason, actorUserId, transaction);
  await ProviderSubmission.update(
    { status: 'CANCELED', failureReason: 'CASO_CANCELADO' },
    { where: { financingCaseId: financingCase.id, groupId, companyId, status: ['PENDING', 'UNKNOWN'] }, transaction }
  );
  return financingCase;
}

/**
 * onCaseClosedByProvider — o provider recusou ou cancelou o caso (webhook ou consulta): faz o mesmo que o
 * cancelamento manual faz nas comissões e nas submissões. Comissão só prevista (EXPECTED) é estornada;
 * comissão já confirmada/recebível/recebida vira alerta visível (o estorno financeiro é decisão de uma pessoa).
 */
async function closeCommissionsOfClosedCase(financingCase, verb, reason, actorUserId, transaction) {
  const { groupId, companyId } = financingCase;
  const { CommissionEntitlement } = require('../../../models');
  const { chargebackCommissionEntitlement } = require('./commissionEntitlements.service');
  const commissions = await CommissionEntitlement.findAll({ where: { financingCaseId: financingCase.id, groupId, companyId, status: ['EXPECTED', 'CONFIRMED', 'RECEIVABLE', 'RECEIVED'] }, transaction });
  for (const listed of commissions) {
    // Relê TRAVANDO o direito: se uma confirmação commitou no meio, ele já não é só previsto.
    // eslint-disable-next-line no-await-in-loop
    const commission = await CommissionEntitlement.findOne({ where: { id: listed.id, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!commission || commission.status === 'ADJUSTED') continue;
    if (commission.status === 'EXPECTED') {
      // eslint-disable-next-line no-await-in-loop
      await chargebackCommissionEntitlement(commission.id, `Caso ${verb}${reason ? `: ${String(reason).slice(0, 200)}` : ''}`, actorUserId, groupId, companyId, transaction);
    } else {
      // eslint-disable-next-line no-await-in-loop
      await recordIntegrationError(
        { groupId, companyId, financingCaseId: financingCase.id, providerCode: financingCase.providerCode, operation: 'chargeback', errorCode: 'COMMISSION_ON_CLOSED_CASE', message: `O caso foi ${verb}, mas a comissão ${commission.id} já estava confirmada. Avalie o estorno da comissão.` },
        transaction
      );
    }
  }
}

async function onCaseClosedByProvider(financingCase, normalizedStatus, transaction, { actorUserId = null, reason = '' } = {}) {
  const { groupId, companyId } = financingCase;
  const verb = normalizedStatus === 'CANCELED' ? 'cancelado pelo provider' : 'recusado pelo provider';
  await closeCommissionsOfClosedCase(financingCase, verb, reason, actorUserId, transaction);
  if (normalizedStatus === 'CANCELED') {
    await ProviderSubmission.update(
      { status: 'CANCELED', failureReason: 'CASO_CANCELADO_PELO_PROVIDER' },
      { where: { financingCaseId: financingCase.id, groupId, companyId, status: ['PENDING', 'UNKNOWN'] }, transaction }
    );
  }
}

async function listProposals(financingCaseId, groupId, companyId, transaction, { limit } = {}) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  const rows = await FinancingProposal.findAll({ where: { financingCaseId, groupId, companyId }, order: [['created_at', 'DESC']], limit: Math.min(Math.max(Number(limit) || 100, 1), 500), transaction });
  // A resposta bruta do provider não sai da API; a validade vencida é calculada na leitura (data de Brasília).
  const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  return rows.map((row) => {
    const plain = row.get({ plain: true });
    delete plain.responseSnapshot;
    return { ...plain, expired: Boolean(plain.validUntil && String(plain.validUntil).slice(0, 10) < today) };
  });
}

module.exports = { onCaseClosedByProvider, registerManualStatus, cancelCase, recordProposal, listProposals, validateProposalInput, MANUAL_STATUSES, PROPOSAL_STATUSES };

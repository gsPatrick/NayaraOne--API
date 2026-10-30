'use strict';

const { InsuranceManualTask, InsurancePolicy, File, FileLink, Notification } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { confirmDispatch } = require('../../integrations/dispatch/worker/worker.confirm');
const E = require('./insurance.errors');
const { publishQuoteReceived } = require('./insurance.events');
const { readInsuranceParams } = require('./insurance.params');
const { addPolicyVersion } = require('./insurance.versions');

const service = () => require('../insurance.service'); // carregado aqui porque o serviço de apólices também usa este módulo

const text = (v, max) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);
const positive = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };

async function lockTask(taskId, actor, transaction) {
  const task = await InsuranceManualTask.findOne({ where: { id: taskId, companyId: actor.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!task) throw E.taskNotFound();
  if (task.status !== 'OPEN') throw E.taskNotOpen(task.status);
  return task;
}

const lockPolicy = (task, transaction) => InsurancePolicy.findOne({ where: { id: task.policyId, companyId: task.companyId }, transaction, lock: transaction.LOCK.UPDATE });

/** Vincula o arquivo da cotação à apólice (consulta o arquivo na empresa). */
async function linkQuoteFile(policy, fileId, actor, transaction) {
  if (!fileId) return null;
  const file = await File.findOne({ where: { id: fileId, companyId: policy.companyId }, transaction });
  if (!file) throw E.taskInvalid('O arquivo da cotação não foi encontrado.');
  await FileLink.findOrCreate({
    where: { relatedEntityType: 'InsurancePolicy', relatedEntityId: policy.id, fileId: file.id, purpose: 'QUOTE_DOCUMENT' },
    defaults: { groupId: policy.groupId, companyId: policy.companyId, fileId: file.id, relatedEntityType: 'InsurancePolicy', relatedEntityId: policy.id, purpose: 'QUOTE_DOCUMENT', createdBy: actor.userId || null, updatedBy: actor.userId || null },
    transaction,
  });
  return file.id;
}

/** Cotação recebida por e-mail ou portal: a mesma regra da resposta da API (applyQuoteResult), com origem MANUAL; na renovação, só registra o aviso (a apólice segue vigente). */
async function completeQuote(task, policy, payload, actor, transaction) {
  const premio = positive(payload.premiumAmount);
  if (premio === null) throw E.taskInvalid('Informe o prêmio da cotação recebida (maior que zero).');
  const fileId = await linkQuoteFile(policy, payload.fileId, actor, transaction);
  const ref = `manual:${task.id}`;
  if (task.purpose === 'RENEWAL') {
    await publishQuoteReceived(policy, { ref, source: 'MANUAL', premiumAmount: premio, renewal: true }, transaction);
    if (policy.createdBy) {
      await Notification.create({ groupId: policy.groupId, companyId: policy.companyId, userId: policy.createdBy, channel: 'IN_APP', title: 'Cotação de renovação recebida', body: `A cotação de renovação da apólice ${policy.externalPolicyNumber || policy.id} chegou: prêmio R$ ${premio.toFixed(2)}.` }, { transaction });
    }
    return { premiumAmount: premio, fileId };
  }
  if (!['DRAFT', 'QUOTED'].includes(policy.status)) throw AppError.conflict(`Apólice com status "${policy.status}" não pode receber uma nova cotação.`, 'INSURANCE_POLICY_INVALID_STATUS');
  await service().applyQuoteResult(policy, { premiumAmount: premio, coverageSummary: undefined, externalId: ref, raw: { manual: true } }, { actor, source: 'MANUAL' }, transaction);
  return { premiumAmount: premio, fileId };
}

/** Número da proposta registrado: abre a tarefa seguinte (anexar a apólice), no mesmo envio. */
async function completeProposal(task, policy, payload, actor, transaction) {
  const numero = text(payload.proposalNumber, 64);
  if (!numero) throw E.taskInvalid('Informe o número da proposta.');
  const params = await readInsuranceParams(actor, transaction);
  const proxima = await InsuranceManualTask.create({
    groupId: task.groupId, companyId: task.companyId, policyId: task.policyId, dispatchId: task.dispatchId, kind: 'POLICY_DOCUMENT', purpose: 'NEW', assignedToUserId: task.assignedToUserId,
    dueAt: new Date(Date.now() + params.manualTaskDueDays * 86400000), requestJson: { ...task.requestJson, proposalTaskId: task.id, proposalNumber: numero },
  }, { transaction });
  return { proposalNumber: numero, nextTaskId: proxima.id };
}

/** Apólice anexada: versão 1 do documento (com hash) e a emissão pelo MESMO caminho da resposta da API (finalizeIssuance), com origem MANUAL. A proposta do envio fica confirmada. */
async function completePolicy(task, policy, payload, actor, transaction) {
  const numero = text(payload.policyNumber, 64);
  if (!numero) throw E.taskInvalid('Informe o número da apólice.');
  if (!payload.fileId) throw E.documentRequired();
  if (!['DRAFT', 'QUOTED'].includes(policy.status)) throw AppError.conflict(`Apólice com status "${policy.status}" não pode ser emitida.`, 'INSURANCE_POLICY_INVALID_STATUS');
  const pedido = task.requestJson || {};
  const effectiveDate = payload.effectiveDate || pedido.effectiveDate || policy.effectiveDate;
  const expiryDate = payload.expiryDate || pedido.expiryDate || policy.expiryDate;
  if (!effectiveDate || !expiryDate || String(expiryDate).slice(0, 10) <= String(effectiveDate).slice(0, 10)) throw E.taskInvalid('Informe a vigência da apólice (início e fim, com o fim depois do início).');
  const version = await addPolicyVersion(policy, { fileId: payload.fileId, kind: 'INITIAL', effectiveFrom: String(effectiveDate).slice(0, 10), expiryDate: String(expiryDate).slice(0, 10), source: 'MANUAL' }, actor, transaction);
  const referencia = `manual:${pedido.proposalTaskId || task.id}`;
  await service().finalizeIssuance(
    policy, { externalId: referencia, policyNumber: numero, status: 'ACTIVE' },
    { issueRequest: { installmentsCount: pedido.installmentsCount || undefined }, effectiveDate: String(effectiveDate).slice(0, 10), expiryDate: String(expiryDate).slice(0, 10), providerName: 'manual', source: 'MANUAL', actor }, transaction,
  );
  if (task.dispatchId) {
    try { await confirmDispatch({ groupId: task.groupId, companyId: task.companyId, userId: actor.userId }, task.dispatchId, { source: 'STATUS_QUERY', status: 'ACTIVE', externalResourceId: referencia }, transaction); } catch { /* o envio já estava confirmado */ }
  }
  return { policyNumber: numero, versionId: version.id, sha256: version.sha256 };
}

const BY_KIND = Object.freeze({ QUOTE_DOCUMENT: completeQuote, PROPOSAL_NUMBER: completeProposal, POLICY_DOCUMENT: completePolicy });

/**
 * completeTask — a pessoa conclui a tarefa do fluxo manual (M9-D238 3.2): cotação recebida, número da proposta ou apólice anexada. Cada conclusão produz o mesmo efeito e o mesmo
 * evento interno que a API produziria, com source = MANUAL. Só tarefa aberta (409 INTEGRATION_INSURANCE_TASK_NOT_OPEN); resultado inválido (422) não conclui nada.
 */
async function completeTask(taskId, payload, actor, transaction) {
  const task = await lockTask(taskId, actor, transaction);
  const policy = await lockPolicy(task, transaction);
  const antes = task.toJSON();
  const resultado = await BY_KIND[task.kind](task, policy, payload || {}, actor, transaction);
  task.status = 'DONE';
  task.resultJson = resultado;
  task.completedBy = actor.userId || null;
  task.completedAt = new Date();
  if (resultado.fileId) task.fileId = resultado.fileId;
  await task.save({ transaction });
  await registrarAuditoria({
    groupId: task.groupId, companyId: task.companyId, actorUserId: actor.userId || null, action: 'procurement.insurance_task.complete', entityType: 'InsuranceManualTask', entityId: task.id,
    beforeJson: antes, afterJson: task.toJSON(), reason: `Tarefa do fluxo manual de seguro concluída (${task.kind}).`,
  }, transaction);
  return task;
}

/** Cancela a tarefa aberta (a seguradora desistiu ou o pedido mudou). A apólice não muda. */
async function cancelTask(taskId, reason, actor, transaction) {
  const task = await lockTask(taskId, actor, transaction);
  const antes = task.toJSON();
  task.status = 'CANCELLED';
  task.resultJson = { reason: text(reason, 300) || null };
  task.completedBy = actor.userId || null;
  task.completedAt = new Date();
  await task.save({ transaction });
  await registrarAuditoria({
    groupId: task.groupId, companyId: task.companyId, actorUserId: actor.userId || null, action: 'procurement.insurance_task.cancel', entityType: 'InsuranceManualTask', entityId: task.id,
    beforeJson: antes, afterJson: task.toJSON(), reason: `Tarefa do fluxo manual de seguro cancelada (${task.kind}).`,
  }, transaction);
  return task;
}

async function listTasks(filters, actor, transaction) {
  const where = { companyId: actor.companyId };
  if (filters && filters.status) where.status = String(filters.status);
  if (filters && filters.policyId) where.policyId = String(filters.policyId);
  return InsuranceManualTask.findAll({ where, order: [['due_at', 'ASC'], ['created_at', 'ASC']], limit: 200, transaction });
}

module.exports = { completeTask, cancelTask, listTasks };

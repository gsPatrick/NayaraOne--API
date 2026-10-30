'use strict';

const { InsurancePolicy, InsuranceClaim, IntegrationDispatch, Notification } = require('../../../models');
const { registerDomainReaction } = require('../../integrations/domain');

const POLICY = 'InsurancePolicy';
const CLAIM = 'InsuranceClaim';
const OPERATIONS = ['propose', 'submitClaim'];

/** Evento de uma proposta (aggregate InsurancePolicy) ou de um sinistro (aggregate InsuranceClaim), ou null. */
const insurerEvent = (event, operations = OPERATIONS) => {
  const p = event.payloadJson || {};
  if (!p.dispatchId || !p.aggregate || !p.aggregate.id || !operations.includes(p.operation)) return null;
  const ok = (p.operation === 'propose' && p.aggregate.type === POLICY) || (p.operation === 'submitClaim' && p.aggregate.type === CLAIM);
  return ok ? p : null;
};

const lockOf = (ctx, p, transaction) => (p.aggregate.type === POLICY ? InsurancePolicy : InsuranceClaim)
  .findOne({ where: { id: p.aggregate.id, companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });

/** Aviso à pessoa que fez o pedido (a dona da apólice ou do sinistro), sem alterar o estado do domínio. */
async function warn(row, title, body, transaction) {
  if (!row.createdBy) return;
  await Notification.create({ groupId: row.groupId, companyId: row.companyId, userId: row.createdBy, channel: 'IN_APP', title, body }, { transaction });
}

const WHAT = Object.freeze({ propose: 'a proposta da apólice', submitClaim: 'o sinistro' });

/**
 * `integration.dispatch.failed` de uma proposta ou de um sinistro (M9-D238 + M9-D220 3.1 item 2): a seguradora não executou o pedido. O estado do domínio NÃO muda (a apólice segue
 * como estava e o sinistro segue aberto: nada saiu da empresa para a seguradora que valha como emissão ou protocolo); a pessoa responsável é avisada, em português, para corrigir e
 * pedir de novo (o pedido refeito usa uma chave nova, `insurance.call` `retryKey`). Falha por credencial, recusa ou tentativas esgotadas têm o mesmo efeito.
 */
async function onFailed(ctx, event, transaction) {
  const p = insurerEvent(event);
  if (!p) return null;
  const row = await lockOf(ctx, p, transaction);
  if (!row) return null;
  const classe = (event.payloadJson || {}).errorClass || 'ERROR';
  await warn(row, 'A seguradora não executou o pedido', `A seguradora não aceitou ${WHAT[p.operation]} (${classe}): confira os dados e peça de novo. Nada foi emitido nem protocolado.`, transaction);
  return { entity: { type: p.aggregate.type, id: row.id }, before: { status: row.status }, after: { status: row.status }, reason: `Pedido ${p.dispatchId} (${p.operation}) falhou na seguradora: o estado foi mantido e a pessoa responsável foi avisada.` };
}

/**
 * `integration.dispatch.needs_manual_review`: depois de todas as consultas de reconciliação não se sabe se a seguradora executou o pedido. Nada muda no domínio (a seguradora pode ter
 * emitido a apólice ou registrado o sinistro) e a pessoa responsável recebe o aviso para conferir com a seguradora antes de repetir.
 */
async function onManualReview(ctx, event, transaction) {
  const p = insurerEvent(event);
  if (!p) return null;
  const row = await lockOf(ctx, p, transaction);
  if (!row) return null;
  await warn(row, 'Conferir com a seguradora', `Não foi possível descobrir se a seguradora executou ${WHAT[p.operation]}: confira com ela antes de repetir o pedido.`, transaction);
  return { entity: { type: p.aggregate.type, id: row.id }, before: { status: row.status }, after: { status: row.status }, reason: `Pedido ${p.dispatchId} (${p.operation}) sem resposta conclusiva: revisão humana.` };
}

/**
 * `integration.dispatch.confirmed` da proposta (M9-D238 3.4): a seguradora confirmou a emissão com a apólice VIGENTE (status ACTIVE na consulta de status): a apólice ISSUED vai a ACTIVE,
 * como o webhook assinado já faz. Outro status confirmado (ISSUED, APPROVED) não muda a apólice.
 */
async function onConfirmed(ctx, event, transaction) {
  const p = insurerEvent(event, ['propose']);
  if (!p) return null;
  const policy = await lockOf(ctx, p, transaction);
  if (!policy || policy.status !== 'ISSUED') return null;
  const envio = await IntegrationDispatch.findOne({ where: { id: p.dispatchId, companyId: ctx.companyId }, transaction });
  if (!envio || String(envio.externalStatus || '').toUpperCase() !== 'ACTIVE') return null;
  await policy.update({ status: 'ACTIVE' }, { transaction });
  return { entity: { type: POLICY, id: policy.id }, before: { status: 'ISSUED' }, after: { status: 'ACTIVE' }, reason: `Proposta ${p.dispatchId} confirmada pela seguradora com a apólice vigente: ISSUED vai a ACTIVE.` };
}

let installed = false;
function installInsuranceReactions() {
  if (installed) return;
  installed = true;
  registerDomainReaction({ eventType: 'integration.dispatch.failed', consumer: 'procurement.insurance.dispatch_failed', handler: onFailed });
  registerDomainReaction({ eventType: 'integration.dispatch.needs_manual_review', consumer: 'procurement.insurance.dispatch_needs_review', handler: onManualReview });
  registerDomainReaction({ eventType: 'integration.dispatch.confirmed', consumer: 'procurement.insurance.dispatch_confirmed', handler: onConfirmed });
}

module.exports = { installInsuranceReactions, onFailed, onManualReview, onConfirmed };

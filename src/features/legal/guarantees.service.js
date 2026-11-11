'use strict';

const legalHold = require('../core-governance/data-quality/legalHold.guard');
const { Guarantee } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishGuaranteeCreated, publishGuaranteeReplaced } = require('./legalEvents.service');
const { publishGuaranteeUpdated, publishGuaranteeEnded } = require('./legalCalendarEvents.service');
const { getContract } = require('./contracts.service');
const { GUARANTEE_TYPES, normalizeGuaranteeType, resolveTypeData, missingMessage } = require('./guaranteeTypeData');

// FIX AUD-014 (auditoria externa Nayara, 11/10/2026, JUR-006 "Garantia rastreável com
// vigência/status próprios"): o Caderno (seção 9, "Garantias locatícias") lista 5 tipos —
// GUARANTOR, INSURANCE, SECURITY_DEPOSIT, CAPITALIZATION, OTHER ("outra homologada") — mas só
// 4 existiam aqui, sem OTHER. Mantidos os nomes internos já em uso (DEPOSIT/CAPITALIZATION_TITLE
// em vez de SECURITY_DEPOSIT/CAPITALIZATION) para não quebrar dados já gravados; adicionado só
// o tipo que faltava de verdade.
// Fechamento M5: os cinco códigos do livro vêm de guaranteeTypeData.js (DEPOSIT/CAPITALIZATION_TITLE só na entrada).
// A mesma seção 9 exige "vigência" explicitamente só para GUARANTOR/INSURANCE/
// CAPITALIZATION_TITLE ("Pessoas, documentos, vigência, aceite" / "Provider/apólice, vigência,
// parcelas, renovação" / "Documento/provider/vigência") — DEPOSIT (caução) e OTHER não listam
// vigência como dado obrigatório, então continuam com endsAt opcional.
const GUARANTEE_TYPES_REQUIRING_VALIDITY = ['GUARANTOR', 'INSURANCE', 'CAPITALIZATION'];
// FIX (homologação 22/09/2026 — auditoria proativa): `status` era gravado como string livre
// (sem ENUM/CHECK no model nem validação aqui), apesar de contracts.service.js/
// assertActivationGate depender literalmente da string 'ACTIVE' pra decidir se a garantia conta
// como ativa na ativação do contrato. Um typo (`"Ativa"`, `"active"` minúsculo) fazia a garantia
// silenciosamente não contar, sem erro nenhum no cadastro — só aparecia depois, como bloqueio
// inexplicado na ativação do contrato. Agora é validado contra um enum fechado, igual ao
// restante do projeto.
// PENDING (fechamento M5): garantia cadastrada sem todos os dados do tipo (Caderno §9) — não vale como garantia ativa.
const GUARANTEE_STATUSES = ['PENDING', 'ACTIVE', 'RELEASED', 'CANCELLED'];

function assertValidDateRange(startsAt, endsAt) {
  // Fechamento M5 (pentest): data com tipo errado (objeto, texto inválido) vira 400, não erro do banco.
  for (const [f, v] of [['startsAt', startsAt], ['endsAt', endsAt]]) {
    if (v !== undefined && v !== null && v !== '' && ((typeof v !== 'string' && !(v instanceof Date)) || Number.isNaN(new Date(v).getTime()))) {
      throw AppError.badRequest(`"${f}" deve ser uma data válida.`, 'LEGAL_GUARANTEE_VALIDATION');
    }
  }
  if (startsAt && endsAt && new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
    throw AppError.badRequest('"endsAt" não pode ser anterior a "startsAt".', 'LEGAL_GUARANTEE_VALIDATION');
  }
}

function assertValidValue(value) {
  if (value === undefined || value === null) return;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw AppError.badRequest('"value" deve ser um número positivo.', 'LEGAL_GUARANTEE_VALIDATION');
  }
}

async function createGuarantee(contractId, payload, actorUserId, transaction) {
  const contract = await getContract(contractId, transaction);
  const { guarantorPersonId, value, status, startsAt, endsAt } = payload;
  const guaranteeType = normalizeGuaranteeType(payload.guaranteeType);

  if (guaranteeType && typeof payload.guaranteeType !== 'string') throw AppError.badRequest('"guaranteeType" deve ser um texto.', 'LEGAL_GUARANTEE_VALIDATION');
  if (!guaranteeType) {
    throw AppError.badRequest('O campo "guaranteeType" é obrigatório.', 'LEGAL_GUARANTEE_VALIDATION');
  }
  if (!GUARANTEE_TYPES.includes(guaranteeType)) {
    throw AppError.badRequest(`"guaranteeType" deve ser um de: ${GUARANTEE_TYPES.join(', ')}.`, 'LEGAL_GUARANTEE_VALIDATION');
  }
  if (guaranteeType === 'GUARANTOR' && !guarantorPersonId) {
    throw AppError.badRequest('"guarantorPersonId" é obrigatório quando "guaranteeType" é "GUARANTOR".', 'LEGAL_GUARANTEE_VALIDATION');
  }
  if (GUARANTEE_TYPES_REQUIRING_VALIDITY.includes(guaranteeType) && !endsAt) {
    throw AppError.badRequest(
      `O campo "endsAt" (vigência) é obrigatório para garantia do tipo "${guaranteeType}" (Caderno, seção 9).`,
      'LEGAL_GUARANTEE_VALIDITY_REQUIRED'
    );
  }
  if (status !== undefined && !GUARANTEE_STATUSES.includes(status)) {
    throw AppError.badRequest(`"status" deve ser um de: ${GUARANTEE_STATUSES.join(', ')}.`, 'LEGAL_GUARANTEE_VALIDATION');
  }
  assertValidValue(value);
  assertValidDateRange(startsAt, endsAt);
  const typeData = await resolveTypeData(guaranteeType, payload, contract, transaction);
  if (status === 'ACTIVE' && typeData.missing.length) throw AppError.badRequest(missingMessage(guaranteeType, typeData.missing), 'LEGAL_GUARANTEE_VALIDATION', { missing: typeData.missing });

  const guarantee = await Guarantee.create(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      contractId: contract.id,
      guaranteeType,
      guarantorPersonId: guaranteeType === 'GUARANTOR' ? guarantorPersonId : (guarantorPersonId || null),
      value: value !== undefined ? value : null,
      status: status || (typeData.missing.length ? 'PENDING' : 'ACTIVE'),
      startsAt: startsAt || null,
      endsAt: endsAt || null,
      ...typeData.fields,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishGuaranteeCreated(guarantee, transaction, contract);

  await registrarAuditoria(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      actorUserId,
      action: 'legal.guarantee.create',
      entityType: 'Guarantee',
      entityId: guarantee.id,
      afterJson: guarantee.toJSON(),
      reason: `Garantia "${guaranteeType}" criada para o contrato ${contract.id}.`,
    },
    transaction
  );

  return guarantee;
}

async function listGuarantees(transaction, filters = {}) {
  const where = {};
  if (filters.contractId) where.contractId = filters.contractId;
  if (filters.status) where.status = String(filters.status).toUpperCase();
  return Guarantee.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getGuarantee(id, transaction) {
  const guarantee = await Guarantee.findByPk(id, { transaction });
  if (!guarantee) throw AppError.notFound('Garantia não encontrada.', 'LEGAL_GUARANTEE_NOT_FOUND');
  return guarantee;
}

/**
 * M9-D803: o que o Calendário precisa saber de uma alteração. Saiu de ACTIVE (liberada/cancelada) = legal.guarantee.ended;
 * mudou o fim ou a situação e segue ACTIVE (ou voltou a ACTIVE) = legal.guarantee.updated. Sem mudança, nenhum evento.
 */
async function publishGuaranteeCalendarChange(guarantee, { previousStatus, previousEndsAt }, transaction) {
  if (previousStatus === 'ACTIVE' && guarantee.status !== 'ACTIVE') {
    await publishGuaranteeEnded(guarantee, guarantee.status, transaction);
    return;
  }
  if (guarantee.status !== previousStatus || String(guarantee.endsAt || '') !== String(previousEndsAt || '')) {
    await publishGuaranteeUpdated(guarantee, await getContract(guarantee.contractId, transaction), transaction);
  }
}

async function updateGuarantee(id, payload, actorUserId, transaction) {
  const guarantee = await getGuarantee(id, transaction);
  const beforeJson = guarantee.toJSON();
  const previousStatus = guarantee.status;
  const previousEndsAt = guarantee.endsAt;
  const { status, startsAt, endsAt, value } = payload;
  const contract = await getContract(guarantee.contractId, transaction);
  const typeData = await resolveTypeData(guarantee.guaranteeType, payload, contract, transaction, guarantee);
  Object.assign(guarantee, typeData.fields);
  const targetStatus = status !== undefined ? status : guarantee.status;
  if (targetStatus === 'ACTIVE' && typeData.missing.length && (status === 'ACTIVE' || Object.keys(typeData.fields).length)) {
    throw AppError.badRequest(missingMessage(guarantee.guaranteeType, typeData.missing), 'LEGAL_GUARANTEE_VALIDATION', { missing: typeData.missing });
  }
  if (status !== undefined) {
    if (!GUARANTEE_STATUSES.includes(status)) {
      throw AppError.badRequest(`"status" deve ser um de: ${GUARANTEE_STATUSES.join(', ')}.`, 'LEGAL_GUARANTEE_VALIDATION');
    }
    guarantee.status = status;
  }
  if (startsAt !== undefined) guarantee.startsAt = startsAt;
  if (endsAt !== undefined) guarantee.endsAt = endsAt;
  assertValidDateRange(
    startsAt !== undefined ? startsAt : guarantee.startsAt,
    endsAt !== undefined ? endsAt : guarantee.endsAt
  );
  if (value !== undefined) {
    assertValidValue(value);
    guarantee.value = value;
  }
  guarantee.updatedBy = actorUserId || null;
  await guarantee.save({ transaction });
  await publishGuaranteeCalendarChange(guarantee, { previousStatus, previousEndsAt }, transaction);

  await registrarAuditoria(
    {
      groupId: guarantee.groupId,
      companyId: guarantee.companyId,
      actorUserId,
      action: 'legal.guarantee.update',
      entityType: 'Guarantee',
      entityId: guarantee.id,
      beforeJson,
      afterJson: guarantee.toJSON(),
      reason: `Garantia ${guarantee.id} atualizada.`,
    },
    transaction
  );

  return guarantee;
}

async function deleteGuarantee(id, actorUserId, transaction) {
  const guarantee = await getGuarantee(id, transaction);
  await legalHold.assertNotOnHold('CONTRACT', guarantee.contractId, transaction); // M9-D912: garantia de contrato sob retenção legal não se apaga
  const beforeJson = guarantee.toJSON();
  guarantee.deletedBy = actorUserId || null;
  await guarantee.save({ transaction });
  await guarantee.destroy({ transaction });
  await publishGuaranteeEnded(guarantee, 'DELETED', transaction);

  await registrarAuditoria(
    {
      groupId: guarantee.groupId,
      companyId: guarantee.companyId,
      actorUserId,
      action: 'legal.guarantee.delete',
      entityType: 'Guarantee',
      entityId: guarantee.id,
      beforeJson,
      afterJson: { ...beforeJson, deletedAt: new Date(), deletedBy: actorUserId || null, situacao: 'excluído (exclusão lógica — o registro continua no banco)' },
      reason: `Garantia ${guarantee.id} excluída (soft delete).`,
    },
    transaction
  );

  return { id };
}

/**
 * replaceGuarantee — Caderno Anexo I "9. Garantias locatícias": "contrato não perde histórico
 * quando a garantia é substituída." Cria a NOVA Guarantee (mesmo contrato), marca a ANTIGA como
 * RELEASED + replacedByGuaranteeId apontando para a nova — NUNCA apaga/edita o tipo/valor da
 * garantia antiga (histórico íntegro, igual ao padrão de versão imutável usado no resto do
 * módulo jurídico). Publica `legal.guarantee.replaced`.
 */
async function replaceGuarantee(oldGuaranteeId, newGuaranteePayload, actorUserId, transaction) {
  const oldGuarantee = await getGuarantee(oldGuaranteeId, transaction);
  if (oldGuarantee.replacedByGuaranteeId) {
    throw AppError.conflict('Esta garantia já foi substituída anteriormente.', 'LEGAL_GUARANTEE_ALREADY_REPLACED');
  }

  const newGuarantee = await createGuarantee(oldGuarantee.contractId, newGuaranteePayload, actorUserId, transaction);

  const beforeJson = oldGuarantee.toJSON();
  oldGuarantee.status = 'RELEASED';
  // FIX AUD-009 (ver comentário em src/models/Guarantee.js): a coluna física
  // "replaced_by_guarantee_id" já existe neste banco e agora está declarada no model, então
  // esta atribuição é persistida de fato pelo `save()` abaixo (antes ficava só na instância em
  // memória). O vínculo completo também continua registrado em auditoria (afterJson abaixo).
  oldGuarantee.replacedByGuaranteeId = newGuarantee.id;
  oldGuarantee.updatedBy = actorUserId || null;
  await oldGuarantee.save({ transaction });

  await publishGuaranteeReplaced(oldGuarantee, newGuarantee, transaction, await getContract(oldGuarantee.contractId, transaction));

  await registrarAuditoria(
    {
      groupId: oldGuarantee.groupId,
      companyId: oldGuarantee.companyId,
      actorUserId,
      action: 'legal.guarantee.replace',
      entityType: 'Guarantee',
      entityId: oldGuarantee.id,
      beforeJson,
      afterJson: oldGuarantee.toJSON(),
      reason: `Garantia ${oldGuarantee.id} substituída pela garantia ${newGuarantee.id}.`,
    },
    transaction
  );

  return { oldGuarantee, newGuarantee };
}

module.exports = {
  createGuarantee,
  listGuarantees,
  getGuarantee,
  updateGuarantee,
  deleteGuarantee,
  replaceGuarantee,
  GUARANTEE_TYPES,
  GUARANTEE_STATUSES,
};

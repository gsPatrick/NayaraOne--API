'use strict';

const { Op } = require('sequelize');
const { Nonconformity } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishNonconformityOpened, publishNonconformityClosed } = require('./constructionEvents.service');
const { getActiveSlaDaysMap } = require('./slaRules.service');
const { resolveSameContentFileIds } = require('./evidenceReuse.service');

/**
 * detectEvidenceReuse — M6-59: verifica se algum arquivo de evidência (before/after) já foi
 * usado como evidência em OUTRA Nonconformity (de qualquer obra da mesma empresa), comparando
 * pelo `checksumSha256` do File — o hash de integridade JÁ calculado no upload
 * (src/features/files/files.service.js, mesmo padrão usado em inspections.service.js/Marco 5),
 * nunca recalculado ou reinventado aqui. A regra da fonte é "gerar alerta", não bloquear — por
 * isso esta função NUNCA lança erro, só retorna o resultado do alerta.
 */
async function detectEvidenceReuse(fileIds, companyId, excludeNonconformityId, transaction) {
  if (!fileIds.length) return { flagged: false, referenceId: null, details: null };

  const sameContentFileIds = await resolveSameContentFileIds(fileIds, companyId, transaction);
  if (!sameContentFileIds.length) return { flagged: false, referenceId: null, details: null };

  const where = {
    companyId,
    [Op.or]: [
      { beforeEvidenceFileIds: { [Op.overlap]: sameContentFileIds } },
      { afterEvidenceFileIds: { [Op.overlap]: sameContentFileIds } },
    ],
  };
  if (excludeNonconformityId) where.id = { [Op.ne]: excludeNonconformityId };

  const priorMatches = await Nonconformity.findAll({ where, transaction, order: [['created_at', 'ASC']] });
  if (!priorMatches.length) return { flagged: false, referenceId: null, details: null };

  const reference = priorMatches[0];
  const overlappingFileIds = [...reference.beforeEvidenceFileIds, ...reference.afterEvidenceFileIds].filter((id) =>
    sameContentFileIds.includes(id)
  );

  return {
    flagged: true,
    referenceId: reference.id,
    details: { overlappingFileIds, matchedAt: new Date().toISOString() },
  };
}

// DECISÃO DE ENGENHARIA (M6-13): severidade fixa em 4 níveis — a fonte pede "severidade" sem
// listar os valores exatos. Segue o mesmo padrão de escala já usado em outros módulos do
// projeto (ex.: risk_level de permissões: LOW/MEDIUM/HIGH + CRITICAL adicionado aqui porque
// M6-25 exige um gate de "NC crítica" para bloquear entrega da obra).
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const SEVERITY_LABELS_PT = { LOW: 'Baixa', MEDIUM: 'Média', HIGH: 'Alta', CRITICAL: 'Crítica' };

async function createNonconformity(projectId, payload, actorUserId, transaction) {
  const {
    groupId,
    companyId,
    projectStageId,
    severity,
    description,
    responsibleUserId,
    slaDueAt,
    beforeEvidenceFileIds,
    requiresAcceptance,
  } = payload;

  if (!groupId || !companyId || !description) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "description" são obrigatórios.', 'NONCONFORMITY_VALIDATION');
  }
  const normalizedSeverity = severity ? String(severity).toUpperCase() : 'MEDIUM';
  if (!SEVERITIES.includes(normalizedSeverity)) {
    throw AppError.badRequest(
      `"severity" deve ser um de: ${SEVERITIES.map((s) => SEVERITY_LABELS_PT[s]).join(', ')}.`,
      'NONCONFORMITY_SEVERITY_INVALID'
    );
  }

  // BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 10): slaDueAt ia direto para o create sem
  // nenhuma validação de data — mesmo padrão já aplicado em
  // maintenanceCases.service.js#updateMaintenanceCase para warrantyDeadlineAt. Uma string de
  // data inválida ("abc", "32/13/2026") estourava um erro cru de tipo do Postgres em vez de um
  // 400 claro em português.
  if (slaDueAt !== undefined && slaDueAt !== null && Number.isNaN(new Date(slaDueAt).getTime())) {
    throw AppError.badRequest('"slaDueAt" deve ser uma data válida.', 'NONCONFORMITY_VALIDATION');
  }

  // BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07; contrato, "Construção + Obras +
  // Pós-obra — BLINDADO v1" §2, invariante obrigatória): "Não conformidade exige severidade,
  // responsável, SLA, evidência antes/depois e aceite quando aplicável." `responsibleUserId` e
  // `beforeEvidenceFileIds` eram inteiramente opcionais — dava pra abrir e preservar uma NC sem
  // nenhum dos dois. Fail closed: exige os dois já na abertura.
  if (!responsibleUserId) {
    throw AppError.badRequest('"responsibleUserId" é obrigatório para abrir uma não conformidade.', 'NONCONFORMITY_RESPONSIBLE_REQUIRED');
  }
  if (!Array.isArray(beforeEvidenceFileIds) || beforeEvidenceFileIds.length === 0) {
    throw AppError.badRequest('Pelo menos uma evidência "antes" ("beforeEvidenceFileIds") é obrigatória para abrir uma não conformidade.', 'NONCONFORMITY_BEFORE_EVIDENCE_REQUIRED');
  }

  const resolvedBeforeEvidence = beforeEvidenceFileIds;
  const reuse = await detectEvidenceReuse(resolvedBeforeEvidence, companyId, null, transaction);

  // BUG REAL CORRIGIDO (mesma auditoria): "SLA" do invariante acima nunca era calculado — o
  // campo ficava null a menos que o cliente mandasse manualmente. Mesmo padrão de SLA por
  // severidade já usado em warranty_cases (REG-OBR-002/slaRules.service.js, mesmas 4
  // severidades) — reaproveitado aqui em vez de duplicar a regra.
  let resolvedSlaDueAt = slaDueAt ? new Date(slaDueAt) : null;
  if (!resolvedSlaDueAt) {
    const { slaDays } = await getActiveSlaDaysMap(groupId, companyId, transaction, actorUserId);
    const days = slaDays[normalizedSeverity] != null ? slaDays[normalizedSeverity] : slaDays.MEDIUM;
    resolvedSlaDueAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  const nonconformity = await Nonconformity.create(
    {
      groupId,
      companyId,
      projectId,
      projectStageId: projectStageId || null,
      severity: normalizedSeverity,
      description,
      responsibleUserId,
      slaDueAt: resolvedSlaDueAt,
      status: 'OPEN',
      beforeEvidenceFileIds: resolvedBeforeEvidence,
      afterEvidenceFileIds: [],
      requiresAcceptance: Boolean(requiresAcceptance),
      evidenceReuseFlagged: reuse.flagged,
      evidenceReuseReferenceId: reuse.referenceId,
      evidenceReuseDetails: reuse.details,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishNonconformityOpened(nonconformity, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.nonconformity.create',
      entityType: 'Nonconformity',
      entityId: nonconformity.id,
      afterJson: nonconformity.toJSON(),
      reason: `NC de severidade "${normalizedSeverity}" aberta para a obra ${projectId}.`,
    },
    transaction
  );

  return nonconformity;
}

async function listNonconformities(projectId, transaction, filters = {}) {
  const where = { projectId };
  if (filters.status) where.status = String(filters.status).toUpperCase();
  return Nonconformity.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getNonconformity(id, transaction) {
  const item = await Nonconformity.findByPk(id, { transaction });
  if (!item) throw AppError.notFound('Não conformidade não encontrada.', 'NONCONFORMITY_NOT_FOUND');
  return item;
}

/**
 * closeNonconformity — REGRA FAIL-CLOSED (M6-24/M6-38/M6-62/M6-86): só fecha se
 * `afterEvidenceFileIds` vier preenchido, e, se `requiresAcceptance=true`, exige
 * `acceptedByUserId` preenchido (no payload OU já preenchido no registro). Nunca fecha
 * silenciosamente — qualquer violação lança AppError e a transação não avança.
 */
async function closeNonconformity(id, payload, actorUserId, transaction) {
  // Lock pessimista: evita duas requisições concorrentes de fechamento lerem o mesmo status
  // OPEN e ambas tentarem fechar/publicar o evento — mesmo padrão de projects.service.js.
  const nonconformity = await Nonconformity.findByPk(id, {
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!nonconformity) throw AppError.notFound('Não conformidade não encontrada.', 'NONCONFORMITY_NOT_FOUND');

  if (nonconformity.status === 'CLOSED') {
    throw AppError.conflict('Não conformidade já está fechada.', 'NONCONFORMITY_ALREADY_CLOSED');
  }

  const { afterEvidenceFileIds, acceptedByUserId } = payload || {};
  const resolvedAfterEvidence = Array.isArray(afterEvidenceFileIds) ? afterEvidenceFileIds : nonconformity.afterEvidenceFileIds;

  if (!Array.isArray(resolvedAfterEvidence) || resolvedAfterEvidence.length === 0) {
    throw AppError.unprocessable(
      'Não é possível fechar a NC sem evidência "depois" ("afterEvidenceFileIds" vazio).',
      'NONCONFORMITY_CLOSE_REQUIRES_AFTER_EVIDENCE'
    );
  }

  const resolvedAcceptedBy = acceptedByUserId !== undefined ? acceptedByUserId : nonconformity.acceptedByUserId;
  if (nonconformity.requiresAcceptance && !resolvedAcceptedBy) {
    throw AppError.unprocessable(
      'Esta NC exige aceite ("requiresAcceptance=true") — "acceptedByUserId" é obrigatório para fechar.',
      'NONCONFORMITY_CLOSE_REQUIRES_ACCEPTANCE'
    );
  }

  // M6-59: evidência "depois" também entra na checagem de reuso — exclui o próprio registro
  // (excludeNonconformityId) pra não acusar reuso de um arquivo contra ele mesmo.
  const newAfterFiles = resolvedAfterEvidence.filter((id) => !nonconformity.afterEvidenceFileIds.includes(id));
  if (newAfterFiles.length) {
    const reuse = await detectEvidenceReuse(newAfterFiles, nonconformity.companyId, nonconformity.id, transaction);
    if (reuse.flagged && !nonconformity.evidenceReuseFlagged) {
      nonconformity.evidenceReuseFlagged = true;
      nonconformity.evidenceReuseReferenceId = reuse.referenceId;
      nonconformity.evidenceReuseDetails = reuse.details;
    }
  }

  // GAP REAL CORRIGIDO ("ciclos até secar", Ciclo 9, Frente A, 09/10/2026): detectEvidenceReuse
  // exclui o próprio registro (excludeNonconformityId) da busca, então nunca compara
  // afterEvidenceFileIds contra o beforeEvidenceFileIds DESTA MESMA NC — fechar com a MESMA
  // foto usada como prova do "antes" passava sem nenhum alerta (nem o flag evidenceReuseFlagged
  // era setado), persistindo um estado contraditório ("prova do depois" = "prova do antes").
  // Mesma política do módulo (alerta, nunca bloqueia) — só estende a checagem pro próprio
  // registro, que a exclusão de escopo acima deixava sem cobertura.
  if (newAfterFiles.length && !nonconformity.evidenceReuseFlagged) {
    const sameContentAsAfter = await resolveSameContentFileIds(newAfterFiles, nonconformity.companyId, transaction);
    const reusedFromBefore = sameContentAsAfter.filter((fileId) => nonconformity.beforeEvidenceFileIds.includes(fileId));
    if (reusedFromBefore.length) {
      nonconformity.evidenceReuseFlagged = true;
      nonconformity.evidenceReuseReferenceId = nonconformity.id;
      nonconformity.evidenceReuseDetails = { overlappingFileIds: reusedFromBefore, matchedAt: new Date().toISOString(), selfReuse: true };
    }
  }

  const beforeJson = nonconformity.toJSON();
  nonconformity.afterEvidenceFileIds = resolvedAfterEvidence;
  if (resolvedAcceptedBy) nonconformity.acceptedByUserId = resolvedAcceptedBy;
  nonconformity.status = 'CLOSED';
  nonconformity.closedAt = new Date();
  nonconformity.updatedBy = actorUserId || null;
  await nonconformity.save({ transaction });

  await publishNonconformityClosed(nonconformity, transaction);

  await registrarAuditoria(
    {
      groupId: nonconformity.groupId,
      companyId: nonconformity.companyId,
      actorUserId,
      action: 'construction.nonconformity.close',
      entityType: 'Nonconformity',
      entityId: nonconformity.id,
      beforeJson,
      afterJson: nonconformity.toJSON(),
      reason: `NC fechada com evidência "depois" (${resolvedAfterEvidence.length} arquivo(s)).`,
    },
    transaction
  );

  return nonconformity;
}

module.exports = { createNonconformity, listNonconformities, getNonconformity, closeNonconformity, detectEvidenceReuse, SEVERITIES };

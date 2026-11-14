'use strict';

const { Contract, ContractClause, NayDraftSuggestion } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { recordRuleRun } = require('../../../../features/ai/orchestrator/runs');
const { createContractVersion, EDITABLE_STATES } = require('../../contracts/application/contractVersions.service');
const { isUsableForDraft } = require('../../contracts/application/clauseHomologation.service');
const { buildDraftMaterial, draftHeader, assembleDraft, sha256 } = require('./nayDraft.material');
const { AGENT, aiAvailability, selectWithAi } = require('./nayDraft.ai');

/**
 * Minuta sugerida pela NAY Jurídica (Caderno M5 §17 "Sugere minuta usando biblioteca homologada"; JUR-008 "IA não decide
 * direito: NAY resume/sugere; decisão jurídica é humana"; Guia §19 "Não permitir NAY alterar documento jurídico final").
 *  1. sugerir: o servidor reúne as versões de cláusula HOMOLOGADAS aplicáveis ao contrato; a IA (quando ligada) escolhe e ordena
 *     só entre elas; o texto é montado com o texto literal das versões (nayDraft.material). Fica PENDING_REVIEW.
 *  2. uma pessoa ACEITA (vira versão DRAFT do contrato, que ainda passa pela aprovação da versão, contracts.version.approve) ou
 *     DESCARTA com motivo. A NAY nunca cria versão, aprova ou assina.
 */
const AVISO = 'RASCUNHO — requer revisão jurídica humana. Minuta montada só com cláusulas homologadas; não é conclusão jurídica definitiva.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const byId = (Model, id, transaction, extra = {}) => (typeof id === 'string' && UUID_RE.test(id) ? Model.findByPk(id, { transaction, ...extra }) : null);

const toDto = (s) => ({
  id: s.id, contractId: s.contractId, status: s.status, metodo: s.method, motivoDoModo: s.modeReason, provedor: s.providerCode, modelo: s.modelCode,
  aiRunId: s.aiRunId, content: s.content, contentHash: s.contentHash, clauseVersionIds: s.clauseVersionIds, aterramento: s.groundingJson,
  decididoPor: s.decidedBy, decididoEm: s.decidedAt, motivoDaDecisao: s.decisionReason, contractVersionId: s.contractVersionId,
  criadoEm: s.get ? s.get('created_at') : null, aviso: AVISO,
});

async function loadContract(contractId, transaction) {
  const contract = await byId(Contract, contractId, transaction);
  if (!contract) throw AppError.notFound('Contrato não encontrado.', 'LEGAL_CONTRACT_NOT_FOUND');
  return contract;
}

function assertEditable(contract) {
  if (!EDITABLE_STATES.includes(contract.status)) {
    throw AppError.conflict(`Contrato em "${contract.status}" não recebe nova versão: a NAY não sugere minuta para contrato assinado ou encerrado.`, 'LEGAL_NAY_DRAFT_CONTRACT_NOT_EDITABLE');
  }
}

async function suggestDraft(tenant, contractId, actorUserId, transaction) {
  const contract = await loadContract(contractId, transaction);
  assertEditable(contract);
  const material = await buildDraftMaterial(contract, transaction);
  if (!material.candidates.length) {
    throw AppError.conflict('Não há cláusula homologada aplicável a este contrato: homologue as versões na Biblioteca de cláusulas antes de pedir a minuta.', 'LEGAL_NAY_DRAFT_NO_HOMOLOGATED_CLAUSES', { excluidas: material.excluded });
  }
  const who = { ...tenant, userId: actorUserId || null };
  const disponivel = await aiAvailability(who, transaction);
  const ia = disponivel.ok ? await selectWithAi(who, contract, material.candidates, transaction) : { ok: false, reason: disponivel.reason };
  const chosen = ia.ok ? ia.chosen : material.candidates;
  let aiRunId = ia.runId || null;
  if (!ia.ok && !aiRunId) {
    const run = await recordRuleRun(who, { agentName: AGENT, inputSummary: `Minuta do contrato ${contract.id} (caminho determinístico: ${ia.reason}).`, toolCallsJson: { method: 'RULE_BASED', contractId: contract.id }, outputSummary: `${chosen.length} cláusula(s) homologada(s) na ordem do modelo/biblioteca. Nada alterado no contrato.`, groundingStatus: 'GROUNDED' }, transaction);
    aiRunId = run.id;
  }
  const content = assembleDraft(await draftHeader(contract, transaction), chosen);
  const suggestion = await NayDraftSuggestion.create({
    groupId: contract.groupId, companyId: contract.companyId, contractId: contract.id, aiRunId, method: ia.ok ? 'AI' : 'RULE_BASED', modeReason: ia.ok ? null : ia.reason,
    providerCode: ia.ok ? ia.providerCode : null, modelCode: ia.ok ? ia.modelCode : null, content, contentHash: sha256(content),
    clauseVersionIds: chosen.map((c) => ({ contractClauseId: c.id, code: c.code, versionNumber: c.versionNumber, bodyHash: c.bodyHash })),
    groundingJson: {
      estrutura: material.structure ? { templateId: material.structure.templateId, templateVersionId: material.structure.templateVersionId, nome: material.structure.templateName } : null,
      candidatas: material.candidates.length, escolhidas: chosen.length, motivosDaIa: ia.ok ? chosen.map((c) => ({ id: c.id, motivo: c.motivoIa })) : [],
      recusadasPeloAterramento: ia.rejected || [], excluidasDaBiblioteca: material.excluded,
    },
    status: 'PENDING_REVIEW', createdBy: actorUserId || null, updatedBy: actorUserId || null,
  }, { transaction });
  await registrarAuditoria({
    groupId: contract.groupId, companyId: contract.companyId, actorUserId, action: 'legal.nay_draft.suggest', entityType: 'NayDraftSuggestion', entityId: suggestion.id,
    beforeJson: null, afterJson: { contractId: contract.id, method: suggestion.method, modeReason: suggestion.modeReason, clauses: suggestion.clauseVersionIds.length, contentHash: suggestion.contentHash, aiRunId },
    reason: `NAY sugeriu minuta para o contrato ${contract.contractNumber || contract.id} (${suggestion.method}); aguarda revisão humana.`,
  }, transaction);
  return toDto(suggestion);
}

async function listDraftSuggestions(contractId, transaction) {
  await loadContract(contractId, transaction);
  return (await NayDraftSuggestion.findAll({ where: { contractId }, order: [['created_at', 'DESC']], transaction })).map(toDto);
}

async function loadPending(id, transaction) {
  const s = await byId(NayDraftSuggestion, id, transaction, { lock: transaction.LOCK.UPDATE });
  if (!s) throw AppError.notFound('Minuta sugerida não encontrada.', 'LEGAL_NAY_DRAFT_NOT_FOUND');
  if (s.status !== 'PENDING_REVIEW') throw AppError.conflict(`A minuta já foi ${s.status === 'ACCEPTED' ? 'aceita' : 'descartada'}.`, 'LEGAL_NAY_DRAFT_ALREADY_DECIDED');
  return s;
}

/** A biblioteca mudou desde a sugestão (versão substituída, desomologada ou texto diferente)? Então a minuta não vale mais. */
async function assertStillHomologated(s, transaction) {
  const ids = s.clauseVersionIds.map((c) => c.contractClauseId);
  const clauses = await ContractClause.findAll({ where: { id: ids }, transaction });
  const atual = new Map(clauses.map((c) => [c.id, c]));
  const vencidas = s.clauseVersionIds.filter((c) => { const x = atual.get(c.contractClauseId); return !x || !isUsableForDraft(x) || sha256(x.bodyText) !== c.bodyHash; });
  if (vencidas.length || sha256(s.content) !== s.contentHash) {
    throw AppError.conflict('A biblioteca homologada mudou desde a sugestão: peça uma nova minuta à NAY.', 'LEGAL_NAY_DRAFT_STALE', { clausulas: vencidas.map((c) => c.code) });
  }
}

async function acceptDraftSuggestion(id, body, actorUserId, transaction) {
  if (!actorUserId) throw AppError.forbidden('Aceitar a minuta exige uma pessoa identificada.', 'LEGAL_NAY_DRAFT_HUMAN_REQUIRED');
  const s = await loadPending(id, transaction);
  await assertStillHomologated(s, transaction);
  const payload = { content: s.content };
  if (body && body.documentFileId !== undefined) payload.documentFileId = body.documentFileId;
  const version = await createContractVersion(s.contractId, payload, actorUserId, transaction, { clauseVersionIds: s.clauseVersionIds });
  s.status = 'ACCEPTED';
  s.decidedBy = actorUserId;
  s.decidedAt = new Date();
  s.decisionReason = body && typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) || null : null;
  s.contractVersionId = version.id;
  s.updatedBy = actorUserId;
  await s.save({ transaction });
  await registrarAuditoria({
    groupId: s.groupId, companyId: s.companyId, actorUserId, action: 'legal.nay_draft.accept', entityType: 'NayDraftSuggestion', entityId: s.id,
    beforeJson: { status: 'PENDING_REVIEW' }, afterJson: { status: 'ACCEPTED', contractVersionId: version.id, versionNumber: version.versionNumber, contentHash: version.contentHash },
    reason: `Minuta da NAY aceita por pessoa: virou a versão ${version.versionNumber} (rascunho) do contrato, que ainda precisa da aprovação da versão.`,
  }, transaction);
  return { suggestion: toDto(s), contractVersion: { id: version.id, versionNumber: version.versionNumber, status: version.status, contentHash: version.contentHash, clauseVersionIds: version.clauseVersionIds } };
}

async function discardDraftSuggestion(id, body, actorUserId, transaction) {
  const reason = body && typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 5 || reason.length > 500) throw AppError.badRequest('Informe o motivo do descarte ("reason", de 5 a 500 caracteres).', 'LEGAL_NAY_DRAFT_REASON_REQUIRED');
  if (!actorUserId) throw AppError.forbidden('Descartar a minuta exige uma pessoa identificada.', 'LEGAL_NAY_DRAFT_HUMAN_REQUIRED');
  const s = await loadPending(id, transaction);
  s.status = 'DISCARDED';
  s.decidedBy = actorUserId;
  s.decidedAt = new Date();
  s.decisionReason = reason;
  s.updatedBy = actorUserId;
  await s.save({ transaction });
  await registrarAuditoria({
    groupId: s.groupId, companyId: s.companyId, actorUserId, action: 'legal.nay_draft.discard', entityType: 'NayDraftSuggestion', entityId: s.id,
    beforeJson: { status: 'PENDING_REVIEW' }, afterJson: { status: 'DISCARDED' }, reason: `Minuta da NAY descartada: ${reason}`,
  }, transaction);
  return toDto(s);
}

module.exports = { suggestDraft, listDraftSuggestions, acceptDraftSuggestion, discardDraftSuggestion, AVISO };

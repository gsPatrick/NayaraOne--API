'use strict';

const { CaseRequirement, CaseDocument } = require('../../../../../models');
const { createRequirement, uploadDocument, rejectRequirement } = require('../../../../correspondent/cases/caseDocuments.service');
const { resolveRef } = require('../refs');
const normalize = require('../normalize');

/** Tipo de documento escrito no papel -> tipo do checklist do caso (pelo código ou por palavras do nome); sem correspondência vale OUTRO. */
const TYPE_HINTS = [['RG_CPF', /\brg\b|cpf|identidade|cnh/], ['COMPROVANTE_RENDA', /renda|holerite|contracheque/], ['COMPROVANTE_RESIDENCIA', /residencia|endereco/],
  ['MATRICULA_IMOVEL', /matricula/], ['CERTIDAO_ESTADO_CIVIL', /certidao|casamento|nascimento/], ['IPTU', /iptu/], ['EXTRATO_BANCARIO', /extrato/]];
const documentTypeOf = (text) => {
  const wanted = normalize.text(text);
  const exact = TYPE_HINTS.find(([code]) => normalize.text(code) === wanted);
  return (exact || TYPE_HINTS.find(([, rx]) => rx.test(wanted)) || ['OUTRO'])[0];
};

/**
 * REGISTER_DOCUMENT: o protocolo do papel entra no checklist do processo pelos serviços normais do Correspondente: usa o item em aberto do mesmo tipo (ou cria um) e anexa o papel
 * digitalizado como o documento. Confere processo, tipo e data do registro.
 */
async function execute({ tenant, actorUserId, operation, payload, transaction }) {
  const financingCase = await resolveRef('financingCase', payload.processo, tenant, transaction);
  const documentType = documentTypeOf(payload.tipoDocumento);
  const context = { groupId: tenant.groupId, companyId: tenant.companyId };
  let requirement = await CaseRequirement.findOne({ where: { financingCaseId: financingCase.id, documentType, status: ['PENDING', 'REJECTED'] }, order: [['created_at', 'ASC']], transaction });
  if (!requirement) {
    requirement = await createRequirement(financingCase.id, {
      documentType, required: false, notes: `Origem BCP ${operation.manualReference}. Entregue por ${payload.entreguePor}; recebido por ${payload.recebidoPor}; classificação ${payload.classificacao}.`.slice(0, 480),
    }, actorUserId, context, transaction);
  }
  const document = await uploadDocument(financingCase.id, requirement.id, { fileId: operation.evidenceFileId }, actorUserId, context, transaction);
  const saved = await CaseDocument.findByPk(document.id, { transaction });
  const savedRequirement = await CaseRequirement.findByPk(saved.requirementId, { transaction });
  return {
    commandRef: `CaseDocument:${saved.id}`,
    undo: { financingCaseId: financingCase.id, requirementId: saved.requirementId, documentId: saved.id },
    comparisons: [
      { field: 'processo', label: 'Processo', paper: normalize.id(financingCase.id), command: normalize.id(saved.financingCaseId), kind: 'ref' },
      { field: 'tipoDocumento', label: 'Tipo de documento', paper: documentType, command: savedRequirement.documentType, kind: 'text' },
      { field: 'data', label: 'Data do registro', paper: normalize.day(payload.data), command: normalize.day(saved.get('created_at') || saved.createdAt), kind: 'date' },
    ],
  };
}

/** Estorno: o documento é recusado pelo serviço normal (o item volta a esperar um documento; a versão enviada fica no histórico). */
async function reverse({ tenant, actorUserId, effect, operation, transaction }) {
  await rejectRequirement(effect.financingCaseId, effect.requirementId, `Estorno da operação manual ${operation.manualReference} (BCP)`, actorUserId, { groupId: tenant.groupId, companyId: tenant.companyId }, transaction);
}

module.exports = { action: 'REGISTER_DOCUMENT', execute, reverse, documentTypeOf };

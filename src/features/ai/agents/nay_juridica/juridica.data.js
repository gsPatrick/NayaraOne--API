'use strict';

// M9-D038 — leitura jurídica para a NAY Jurídica. Só leitura, sob o RLS da transação do chamador (empresa B nunca aparece). Compara as
// versões com a mesma regra do legalNay.service (JUR-008) sem gravar o run de regra daquele serviço: o run é o do orquestrador.
const AppError = require('../../../../utils/AppError');
const {
  Contract, ContractVersion, ContractClause, ContractRequirement, LegalCase, LegalDeadline,
} = require('../../../../models');
const { contentLines, multisetDiff } = require('../../../../modules/legal/cases/legalNay.service');
const contractsService = require('../../../../modules/legal/contracts/application/contract.service');

const iso = (d) => (d ? new Date(d).toISOString() : null);
const day = (d) => (d ? iso(d).slice(0, 10) : null);
const clip = (text, n = 300) => (text ? String(text).trim().slice(0, n) : null);

async function loadContract(contractId, transaction) {
  const contract = contractId ? await Contract.findByPk(contractId, { transaction }) : null;
  if (!contract) throw AppError.notFound('Contrato não encontrado.', 'LEGAL_CONTRACT_NOT_FOUND');
  return contract;
}

// clause_version_ids é gravado como [{ contractClauseId, code, versionNumber }] (versão gerada de modelo); aceita também id solto.
const clauseIdsOf = (list) => (Array.isArray(list) ? list.map((x) => (x && typeof x === 'object' ? x.contractClauseId : x)).filter((x) => typeof x === 'string' && x.length === 36) : []);

/** Diferenças entre duas versões: cada linha removida/incluída cita a versão e o trecho; cláusulas incluídas/excluídas citam código e versão. */
async function compareVersions(contractId, fromNumber, toNumber, transaction, now = new Date(), max = 50) {
  const contract = await loadContract(contractId, transaction);
  const versions = await ContractVersion.findAll({ where: { contractId, versionNumber: [fromNumber, toNumber] }, transaction });
  const a = versions.find((v) => v.versionNumber === fromNumber);
  const b = versions.find((v) => v.versionNumber === toNumber);
  if (!a || !b) throw AppError.notFound('Versão do contrato não encontrada.', 'LEGAL_CONTRACT_VERSION_NOT_FOUND');
  const ca = clauseIdsOf(a.clauseVersionIds);
  const cb = clauseIdsOf(b.clauseVersionIds);
  const ids = [...new Set([...ca, ...cb])];
  const clauses = ids.length ? await ContractClause.findAll({ where: { id: ids }, attributes: ['id', 'code', 'title', 'versionNumber'], transaction }) : [];
  const ref = new Map(clauses.map((c) => [c.id, { id: c.id, code: c.code, title: c.title, version: c.versionNumber }]));
  const diff = multisetDiff(contentLines(a.content), contentLines(b.content));
  const changes = [
    ...diff.removed.map((line) => ({ kind: 'REMOVIDA', versionNumber: fromNumber, excerpt: clip(line) })),
    ...diff.added.map((line) => ({ kind: 'INCLUIDA', versionNumber: toNumber, excerpt: clip(line) })),
  ];
  const sources = changes.slice(0, max).map((c) => ({ title: `Contrato ${contract.contractNumber || contract.id}`, version: String(c.versionNumber), clause: c.kind === 'REMOVIDA' ? 'Trecho removido' : 'Trecho incluído', excerpt: c.excerpt, values: [String(c.versionNumber)] }));
  return {
    contractId, contractNumber: contract.contractNumber || null, from: { number: fromNumber, id: a.id, contentHash: a.contentHash }, to: { number: toNumber, id: b.id, contentHash: b.contentHash },
    identical: a.contentHash === b.contentHash && changes.length === 0,
    clausesAdded: cb.filter((id) => !ca.includes(id)).map((id) => ref.get(id) || { id }),
    clausesRemoved: ca.filter((id) => !cb.includes(id)).map((id) => ref.get(id) || { id }),
    changes: changes.slice(0, max), totalChanges: changes.length, groundingSources: sources, asOf: now.toISOString(),
  };
}

/** Checklist de requisitos do contrato: satisfeitos, pendentes e dispensados, cada um com a referência ao registro. */
async function requirementsChecklist(contractId, transaction, now = new Date(), max = 50) {
  const contract = await loadContract(contractId, transaction);
  const rows = await ContractRequirement.findAll({ where: { contractId }, order: [['requirementCode', 'ASC']], transaction });
  const by = (s) => rows.filter((r) => r.status === s).length;
  return {
    contractId, contractNumber: contract.contractNumber || null, total: rows.length, satisfied: by('SATISFIED'), pending: by('PENDING'), waived: by('WAIVED'),
    items: rows.slice(0, max).map((r) => ({ id: r.id, code: r.requirementCode, description: clip(r.description), type: r.requirementType, status: r.status, satisfiedAt: iso(r.satisfiedAt) })),
    asOf: now.toISOString(),
  };
}

/** Prazos dos processos do contrato com a fonte (documento/evento de origem). Sem origem registrada a fonte não é exata. */
async function contractDeadlines(contractId, transaction, now = new Date(), max = 50) {
  const contract = await loadContract(contractId, transaction);
  const current = await ContractVersion.findOne({ where: { contractId }, order: [['versionNumber', 'DESC']], transaction });
  const cases = await LegalCase.findAll({ where: { contractId }, attributes: ['id', 'caseNumber'], transaction });
  const rows = cases.length ? await LegalDeadline.findAll({ where: { legalCaseId: cases.map((c) => c.id) }, order: [['dueAt', 'ASC']], transaction }) : [];
  const caseNumber = new Map(cases.map((c) => [c.id, c.caseNumber]));
  const items = rows.slice(0, max).map((d) => ({
    id: d.id, description: clip(d.description), dueAt: iso(d.dueAt), status: d.status, overdue: d.status !== 'DONE' && new Date(d.dueAt) < now,
    caseNumber: caseNumber.get(d.legalCaseId) || null, sourceDocument: d.sourceDocument || null, sourceEvent: d.sourceEvent || null,
  }));
  const title = `Contrato ${contract.contractNumber || contract.id}`;
  const sources = items.map((d) => ({
    title, version: current ? String(current.versionNumber) : null, clause: d.sourceDocument || d.sourceEvent || null,
    excerpt: `${d.description || 'Prazo'}: vence em ${day(d.dueAt)}`, values: [day(d.dueAt)],
  }));
  return { contractId, contractNumber: contract.contractNumber || null, currentVersion: current ? current.versionNumber : null, total: rows.length, deadlines: items, groundingSources: sources, asOf: now.toISOString() };
}

const plain = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

/** Resumo do contrato: dados do contrato, versão vigente e os trechos (cláusulas) dela, cada um citado com contrato, versão e trecho. */
async function contractSummary(contractId, transaction, now = new Date(), max = 50) {
  const contract = plain(await contractsService.getContract(contractId, transaction));
  const current = await ContractVersion.findOne({ where: { contractId }, order: [['versionNumber', 'DESC']], transaction });
  const ids = current ? clauseIdsOf(current.clauseVersionIds) : [];
  const library = ids.length ? await ContractClause.findAll({ where: { id: ids }, attributes: ['id', 'code', 'title', 'versionNumber'], transaction }) : [];
  const title = `Contrato ${contract.contractNumber || contract.id}`;
  const lines = current ? contentLines(current.content).slice(0, max) : [];
  return {
    id: contract.id, contractType: contract.contractType, contractNumber: contract.contractNumber ?? null, status: contract.status, totalValue: contract.totalValue ?? null,
    startsAt: contract.startsAt ?? null, endsAt: contract.endsAt ?? null, versionsCount: Array.isArray(contract.versions) ? contract.versions.length : 0,
    currentVersion: current ? { number: current.versionNumber, id: current.id, contentHash: current.contentHash || null } : null,
    clauses: library.map((c) => ({ id: c.id, code: c.code, title: c.title, version: c.versionNumber })),
    groundingSources: current ? lines.map((line, i) => ({ title, version: String(current.versionNumber), clause: `Trecho ${i + 1}`, excerpt: clip(line), values: [String(current.versionNumber)] })) : [],
    asOf: now.toISOString(),
  };
}

module.exports = { contractSummary, compareVersions, requirementsChecklist, contractDeadlines, loadContract };

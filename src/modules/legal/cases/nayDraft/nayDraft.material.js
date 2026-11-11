'use strict';

const crypto = require('crypto');
const { ContractClause, ContractTemplate, TemplateVersion, ContractTemplateClause, ContractParty, Person } = require('../../../../models');
const { isUsableForDraft } = require('../../contracts/application/clauseHomologation.service');
const { buildConditionContext } = require('../../contracts/application/clauseConditionContext');
const { evaluateCondition } = require('../../contracts/application/clauseConditions');

/**
 * Material da minuta sugerida pela NAY (Caderno M5 §17 "Sugere minuta usando biblioteca homologada"; §6 "Template é estrutura;
 * cláusula é componente versionado"). Só entram versões de cláusula HOMOLOGADAS (clauseHomologation.service), vigentes e, se
 * condicionais, com a condição aprovada e verdadeira para este contrato. Com modelo PUBLICADO do tipo do contrato, a estrutura
 * (quais cláusulas e em que ordem) é a do modelo; sem modelo, a biblioteca homologada inteira, por categoria e código.
 * Cada candidata leva o hash do texto: a minuta é montada com o texto literal da versão homologada.
 */
const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
const CATEGORY_ORDER = ['GENERAL', 'PAYMENT', 'OBLIGATION', 'GUARANTEE', 'PENALTY', 'TERMINATION', 'OTHER'];

async function publishedStructure(contract, transaction) {
  const templates = await ContractTemplate.findAll({ where: { contractType: contract.contractType, isActive: true }, attributes: ['id', 'name'], transaction });
  if (!templates.length) return null;
  const version = await TemplateVersion.findOne({ where: { templateId: templates.map((t) => t.id), status: 'PUBLISHED' }, order: [['published_at', 'DESC']], transaction });
  if (!version) return null;
  const links = await ContractTemplateClause.findAll({ where: { templateVersionId: version.id }, order: [['sort_order', 'ASC']], transaction });
  return { templateId: version.templateId, templateVersionId: version.id, templateName: templates.find((t) => t.id === version.templateId).name, clauseIds: links.map((l) => l.contractClauseId) };
}

/** O que a minuta pode usar e o que ficou de fora (com o motivo), para a tela e para o grounding. */
async function buildDraftMaterial(contract, transaction) {
  const structure = await publishedStructure(contract, transaction);
  const pool = structure
    ? await ContractClause.findAll({ where: { id: structure.clauseIds }, transaction })
    : await ContractClause.findAll({ where: { isActive: true }, transaction });
  const order = structure
    ? (c) => structure.clauseIds.indexOf(c.id)
    : (c) => CATEGORY_ORDER.indexOf(c.category);
  pool.sort((a, b) => order(a) - order(b) || String(a.code).localeCompare(String(b.code)));
  const { context } = await buildConditionContext(contract, transaction);
  const candidates = [];
  const excluded = [];
  for (const c of pool) {
    if (!isUsableForDraft(c)) {
      excluded.push({ id: c.id, codigo: c.code, versao: c.versionNumber, motivo: c.homologationStatus !== 'HOMOLOGATED' ? 'NAO_HOMOLOGADA' : (!c.isActive ? 'FORA_DE_CIRCULACAO' : 'CONDICAO_NAO_APROVADA') });
      continue;
    }
    let entra = true;
    try { entra = evaluateCondition(c.conditionJson, context); } catch (err) { excluded.push({ id: c.id, codigo: c.code, versao: c.versionNumber, motivo: 'CONDICAO_SEM_DADOS' }); continue; }
    if (!entra) { excluded.push({ id: c.id, codigo: c.code, versao: c.versionNumber, motivo: 'CONDICAO_FALSA' }); continue; }
    candidates.push({ id: c.id, code: c.code, title: c.title, category: c.category, versionNumber: c.versionNumber, bodyText: c.bodyText, bodyHash: sha256(c.bodyText) });
  }
  return { structure, candidates, excluded, context };
}

/** Cabeçalho com os dados do cadastro (nada da IA): tipo, número, partes e valor. */
async function draftHeader(contract, transaction) {
  const parties = await ContractParty.findAll({ where: { contractId: contract.id }, attributes: ['personId', 'partyRole'], transaction });
  const people = parties.length ? await Person.findAll({ where: { id: parties.map((p) => p.personId) }, attributes: ['id', 'legalName', 'preferredName'], transaction }) : [];
  const nome = new Map(people.map((p) => [p.id, p.legalName || p.preferredName]));
  return [
    `MINUTA — ${contract.contractNumber || 'contrato sem número'} (${contract.contractType})`,
    ...parties.map((p) => `${p.partyRole}: ${nome.get(p.personId) || p.personId}`),
    contract.totalValue !== null && contract.totalValue !== undefined ? `Valor: ${contract.totalValue}` : null,
  ].filter(Boolean);
}

/** Texto final: cabeçalho + cada cláusula escolhida com o título e o texto LITERAL da versão homologada. */
function assembleDraft(header, chosen) {
  const blocks = chosen.map((c, i) => `CLÁUSULA ${i + 1}ª — ${c.title}\n${c.bodyText}`);
  return [...header, '', ...blocks.flatMap((b) => [b, ''])].join('\n').trim();
}

module.exports = { buildDraftMaterial, draftHeader, assembleDraft, sha256 };

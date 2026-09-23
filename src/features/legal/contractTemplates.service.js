'use strict';

const { ContractTemplate, ContractTemplateClause, ContractClause } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * contractTemplates.service — M5-01: modelos de contrato compostos por cláusulas da
 * biblioteca versionada (ver contractClauses.service.js).
 *
 * DECISÃO DE MODELAGEM (documentada conforme pedido no Caderno): o vínculo template x cláusula
 * usa TABELA DE JUNÇÃO (legal.contract_template_clauses) em vez de uma coluna `clause_ids
 * UUID[]`. Razões: (a) a ordem das cláusulas no documento é dado de negócio e fica explícita
 * em `sort_order`; (b) a junção permite FK real para legal.contract_clauses — um array de UUID
 * não tem integridade referencial no Postgres; (c) adicionar/remover uma cláusula não exige
 * reescrever o array inteiro. Ver também a migration 20260101000143.
 *
 * INTEGRAÇÃO COM ContractVersion: `renderTemplate` apenas RETORNA o texto montado. Ele NÃO
 * cria uma ContractVersion automaticamente — quem quiser usar o texto como conteúdo de uma
 * versão chama createContractVersion passando `content: renderTemplate(...).content`. Manter
 * isso explícito evita acoplar a geração de documento à máquina de estados do contrato.
 */

const TEMPLATE_CONTRACT_TYPES = ['SALE', 'LEASE', 'SERVICE'];

async function createTemplate(payload, actorUserId, transaction) {
  const { groupId, companyId, name, contractType } = payload;
  if (!groupId || !companyId || !name || !String(name).trim()) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId" e "name" são obrigatórios.',
      'LEGAL_CONTRACT_TEMPLATE_VALIDATION'
    );
  }
  if (!TEMPLATE_CONTRACT_TYPES.includes(contractType)) {
    throw AppError.badRequest(
      `"contractType" deve ser um de: ${TEMPLATE_CONTRACT_TYPES.join(', ')}.`,
      'LEGAL_CONTRACT_TEMPLATE_VALIDATION'
    );
  }

  const template = await ContractTemplate.create(
    {
      groupId,
      companyId,
      name,
      contractType,
      isActive: true,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'legal.contract_template.create',
      entityType: 'ContractTemplate',
      entityId: template.id,
      afterJson: template.toJSON(),
      reason: `Modelo contratual "${name}" (${contractType}) criado.`,
    },
    transaction
  );

  return template;
}

async function getTemplate(id, transaction) {
  const template = await ContractTemplate.findByPk(id, { transaction });
  if (!template) throw AppError.notFound('Modelo contratual não encontrado.', 'LEGAL_CONTRACT_TEMPLATE_NOT_FOUND');
  return template;
}

async function listTemplates(transaction, filters = {}) {
  const where = {};
  if (filters.contractType) where.contractType = String(filters.contractType).toUpperCase();
  if (filters.isActive !== undefined) where.isActive = filters.isActive;
  return ContractTemplate.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function updateTemplate(id, payload, actorUserId, transaction) {
  const template = await getTemplate(id, transaction);
  const beforeJson = template.toJSON();
  if (payload.name !== undefined) template.name = payload.name;
  if (payload.isActive !== undefined) template.isActive = payload.isActive;
  template.updatedBy = actorUserId || null;
  await template.save({ transaction });

  await registrarAuditoria(
    {
      groupId: template.groupId,
      companyId: template.companyId,
      actorUserId,
      action: 'legal.contract_template.update',
      entityType: 'ContractTemplate',
      entityId: template.id,
      beforeJson,
      afterJson: template.toJSON(),
      reason: `Modelo contratual ${template.id} atualizado.`,
    },
    transaction
  );

  return template;
}

/**
 * addClauseToTemplate — vincula uma VERSÃO específica de cláusula ao template, na posição
 * `sortOrder` (se omitido, vai para o fim da lista atual).
 */
async function addClauseToTemplate(templateId, payload, actorUserId, transaction) {
  const template = await getTemplate(templateId, transaction);
  const { contractClauseId } = payload;
  if (!contractClauseId) {
    throw AppError.badRequest('O campo "contractClauseId" é obrigatório.', 'LEGAL_CONTRACT_TEMPLATE_VALIDATION');
  }
  const clause = await ContractClause.findByPk(contractClauseId, { transaction });
  if (!clause) {
    throw AppError.notFound('Cláusula contratual não encontrada.', 'LEGAL_CONTRACT_CLAUSE_NOT_FOUND');
  }

  let sortOrder = payload.sortOrder;
  if (sortOrder === undefined || sortOrder === null) {
    const current = await ContractTemplateClause.findAll({
      where: { contractTemplateId: template.id },
      order: [['sort_order', 'DESC']],
      limit: 1,
      transaction,
    });
    sortOrder = current.length ? current[0].sortOrder + 1 : 1;
  }

  const link = await ContractTemplateClause.create(
    {
      groupId: template.groupId,
      companyId: template.companyId,
      contractTemplateId: template.id,
      contractClauseId: clause.id,
      sortOrder,
      createdBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: template.groupId,
      companyId: template.companyId,
      actorUserId,
      action: 'legal.contract_template.add_clause',
      entityType: 'ContractTemplateClause',
      entityId: link.id,
      afterJson: link.toJSON(),
      reason: `Cláusula "${clause.code}" v${clause.versionNumber} vinculada ao modelo ${template.id} na posição ${sortOrder}.`,
    },
    transaction
  );

  return link;
}

async function listTemplateClauses(templateId, transaction) {
  const links = await ContractTemplateClause.findAll({
    where: { contractTemplateId: templateId },
    order: [['sort_order', 'ASC']],
    transaction,
  });
  const clauses = [];
  for (const link of links) {
    const clause = await ContractClause.findByPk(link.contractClauseId, { transaction });
    if (clause) clauses.push({ link, clause });
  }
  return clauses;
}

async function removeClauseFromTemplate(templateId, contractClauseId, actorUserId, transaction) {
  const template = await getTemplate(templateId, transaction);
  const link = await ContractTemplateClause.findOne({
    where: { contractTemplateId: template.id, contractClauseId },
    transaction,
  });
  if (!link) {
    throw AppError.notFound('Cláusula não está vinculada a este modelo.', 'LEGAL_CONTRACT_TEMPLATE_CLAUSE_NOT_FOUND');
  }
  const beforeJson = link.toJSON();
  await link.destroy({ transaction });

  await registrarAuditoria(
    {
      groupId: template.groupId,
      companyId: template.companyId,
      actorUserId,
      action: 'legal.contract_template.remove_clause',
      entityType: 'ContractTemplateClause',
      entityId: beforeJson.id,
      beforeJson,
      reason: `Cláusula ${contractClauseId} desvinculada do modelo ${template.id}.`,
    },
    transaction
  );

  return true;
}

/**
 * renderTemplate — monta o texto final do modelo concatenando as cláusulas ATIVAS na ordem de
 * `sort_order`. Cláusulas vinculadas que já foram desativadas (is_active = false) são
 * IGNORADAS na renderização — o vínculo continua no histórico, mas o documento novo sai só com
 * o que está em vigor.
 *
 * Retorna { content, clauses } — `content` é o texto pronto (serve direto como `content` de
 * uma ContractVersion) e `clauses` é a lista estruturada de {code, versionNumber, title} de
 * fato usada, para rastreabilidade de qual versão de cada cláusula entrou no documento.
 */
/**
 * renderTemplate — aceita `variables` opcional ({ chave: valor }) para substituir placeholders
 * `{{chave}}` presentes no texto das cláusulas (ex.: {{nome_locador}}, {{valor_aluguel}}) pelo
 * dado real informado pelo chamador. Placeholder sem valor correspondente em `variables` é
 * deixado como está (não falha silenciosamente trocando por vazio, para ficar óbvio no texto
 * final que faltou preencher algo).
 */
function applyTemplateVariables(text, variables) {
  if (!variables || typeof variables !== 'object') return text;
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(variables, key) && variables[key] !== undefined && variables[key] !== null) {
      return String(variables[key]);
    }
    return match;
  });
}

async function renderTemplate(templateId, transaction, variables) {
  const template = await getTemplate(templateId, transaction);
  const entries = await listTemplateClauses(template.id, transaction);
  const active = entries.filter(({ clause }) => clause.isActive);

  const sections = active.map(({ clause }) => applyTemplateVariables(`${clause.title}\n${clause.bodyText}`, variables));
  const content = [applyTemplateVariables(template.name, variables), ...sections].join('\n\n');

  return {
    templateId: template.id,
    name: template.name,
    contractType: template.contractType,
    content,
    clauses: active.map(({ clause, link }) => ({
      contractClauseId: clause.id,
      code: clause.code,
      versionNumber: clause.versionNumber,
      title: clause.title,
      sortOrder: link.sortOrder,
    })),
  };
}

module.exports = {
  createTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
  addClauseToTemplate,
  listTemplateClauses,
  removeClauseFromTemplate,
  renderTemplate,
  TEMPLATE_CONTRACT_TYPES,
};

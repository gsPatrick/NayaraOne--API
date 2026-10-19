'use strict';

const { ContractTemplate, ContractTemplateClause, ContractClause } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { validateCondition, validateContext, evaluateCondition } = require('./clauseConditions');
const { buildConditionContext } = require('./clauseConditionContext');

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
 * INTEGRAÇÃO COM ContractVersion: `renderTemplate` apenas RETORNA o texto montado. Quem GRAVA
 * a versão é createContractVersion (contractVersions.service.js), que, quando recebe
 * `templateId`, monta o texto ELE MESMO via renderTemplateForContract — o texto enviado pelo
 * cliente nunca substitui o que o modelo e as condições aprovadas determinam (F01, 19/10/2026).
 */

// FIX AUD-015 (11/10/2026): mesma expansão de subtipos de contratos.service.js#CONTRACT_TYPES.
const TEMPLATE_CONTRACT_TYPES = [
  'SALE', 'SALE_CASH', 'SALE_FINANCED', 'SALE_TRADE', 'SALE_INSTALLMENTS',
  'LEASE', 'LEASE_RESIDENTIAL', 'LEASE_COMMERCIAL', 'LEASE_SEASONAL',
  'PROPERTY_ADMIN', 'SERVICE',
];

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

async function getLatestVersionOfCode(clause, transaction) {
  return ContractClause.findOne({
    where: { companyId: clause.companyId, code: clause.code },
    order: [['version_number', 'DESC']],
    transaction,
  });
}

function ruleVariables(condition) {
  return condition ? [...new Set(condition.rules.map((r) => r.variable))] : [];
}

/**
 * F01 (Caderno, Jurídico §6 — cláusula condicional por regra declarativa): `conditionContext`
 * traz os dados do contrato que as regras consultam ({ contractType, guaranteeType, ... } — ver
 * CONDITION_VARIABLES em clauseConditions.js). Na geração real do documento esse contexto é
 * SEMPRE derivado do contrato no servidor (clauseConditionContext.js#buildConditionContext);
 * informá-lo à mão só existe no preview, marcado como simulação (`options.contextSource`).
 *
 * Regras:
 *  - cláusula sem condição entra sempre;
 *  - condição verdadeira entra, falsa sai — registrada em `excludedClauses` (reason CONDITION_FALSE);
 *  - cláusula com condição AINDA NÃO APROVADA bloqueia a renderização inteira;
 *  - variável que a regra consulta e não veio no contexto é erro, não "falso";
 *  - variável ambígua no contrato (`options.unresolved`, ex.: duas modalidades de garantia
 *    ativas) consultada por alguma regra também bloqueia, com o motivo.
 *
 * I1 — vínculo com versão substituída: o modelo aponta para uma VERSÃO específica da cláusula
 * (o vínculo nunca é migrado sozinho — decisão M5-01). Quando essa versão foi substituída por
 * uma versão mais nova e vigente do mesmo código, a renderização é BLOQUEADA com
 * LEGAL_TEMPLATE_CLAUSE_SUPERSEDED, em vez de omitir a cláusula em silêncio (que era o
 * comportamento anterior). O modelo é atualizado deliberadamente por upgradeTemplateClause, e a
 * versão nova com condição só entra depois de aprovada. Cláusula retirada de circulação (a
 * versão mais recente do código está desativada) sai do documento e fica registrada em
 * `excludedClauses` com reason CLAUSE_RETIRED.
 *
 * A ordem (sort_order) das cláusulas que entram é preservada.
 */
async function renderTemplate(templateId, transaction, variables, conditionContext, options = {}) {
  const template = await getTemplate(templateId, transaction);
  const entries = await listTemplateClauses(template.id, transaction);
  const context = validateContext(conditionContext);
  const unresolved = options.unresolved || {};

  const candidates = [];
  const excludedClauses = [];
  const superseded = [];
  for (const entry of entries) {
    if (entry.clause.isActive) {
      candidates.push(entry);
      continue;
    }
    const latest = await getLatestVersionOfCode(entry.clause, transaction);
    if (latest && latest.isActive && latest.versionNumber > entry.clause.versionNumber) {
      superseded.push({ entry, latest });
    } else {
      excludedClauses.push({
        contractClauseId: entry.clause.id,
        code: entry.clause.code,
        versionNumber: entry.clause.versionNumber,
        title: entry.clause.title,
        sortOrder: entry.link.sortOrder,
        reason: 'CLAUSE_RETIRED',
        condition: entry.clause.conditionJson || null,
      });
    }
  }

  if (superseded.length) {
    throw AppError.conflict(
      `O modelo usa versões de cláusula que já foram substituídas: ${superseded
        .map(({ entry, latest }) => `${entry.clause.code} (modelo usa v${entry.clause.versionNumber}, vigente é v${latest.versionNumber})`)
        .join('; ')}. Atualize o modelo para a versão vigente antes de gerar o documento.`,
      'LEGAL_TEMPLATE_CLAUSE_SUPERSEDED'
    );
  }

  const pending = candidates.filter(({ clause }) => clause.conditionJson && clause.conditionStatus !== 'APPROVED');
  if (pending.length) {
    throw AppError.conflict(
      `Condição ainda não aprovada nas cláusulas: ${pending.map(({ clause }) => `${clause.code} v${clause.versionNumber}`).join(', ')}.`,
      'LEGAL_CLAUSE_CONDITION_NOT_APPROVED'
    );
  }

  const ambiguous = [];
  for (const { clause } of candidates) {
    for (const variable of ruleVariables(clause.conditionJson)) {
      if (Object.prototype.hasOwnProperty.call(unresolved, variable)) ambiguous.push(`${clause.code}: ${unresolved[variable]}`);
    }
  }
  if (ambiguous.length) {
    throw AppError.conflict(
      `Não é possível decidir a condição das cláusulas com os dados atuais do contrato — ${ambiguous.join(' | ')}`,
      'LEGAL_CLAUSE_CONDITION_CONTEXT_AMBIGUOUS'
    );
  }

  const included = [];
  for (const entry of candidates) {
    const condition = validateCondition(entry.clause.conditionJson);
    if (evaluateCondition(condition, context)) {
      included.push(entry);
    } else {
      excludedClauses.push({
        contractClauseId: entry.clause.id,
        code: entry.clause.code,
        versionNumber: entry.clause.versionNumber,
        title: entry.clause.title,
        sortOrder: entry.link.sortOrder,
        reason: 'CONDITION_FALSE',
        condition,
      });
    }
  }
  excludedClauses.sort((a, b) => a.sortOrder - b.sortOrder);

  const sections = included.map(({ clause }) => applyTemplateVariables(`${clause.title}\n${clause.bodyText}`, variables));
  const content = [applyTemplateVariables(template.name, variables), ...sections].join('\n\n');

  return {
    templateId: template.id,
    name: template.name,
    contractType: template.contractType,
    content,
    conditionContext: context,
    contextSource: options.contextSource || null,
    unresolved,
    clauses: included.map(({ clause, link }) => ({
      contractClauseId: clause.id,
      code: clause.code,
      versionNumber: clause.versionNumber,
      title: clause.title,
      sortOrder: link.sortOrder,
      condition: clause.conditionJson || null,
    })),
    excludedClauses,
  };
}

/**
 * renderTemplateForContract — o único caminho usado para GERAR documento: o contexto das
 * condições é derivado do próprio contrato (partes, garantias, imóvel, valores, prazo).
 */
async function renderTemplateForContract(templateId, contractOrId, transaction, variables) {
  const { context, unresolved } = await buildConditionContext(contractOrId, transaction);
  return renderTemplate(templateId, transaction, variables, context, { unresolved, contextSource: 'CONTRACT' });
}

/**
 * upgradeTemplateClause — I1: aponta o vínculo do modelo para a versão vigente (a mais recente
 * e ativa) do mesmo código da cláusula, mantendo a posição. Ação deliberada e auditada — é o
 * único jeito de uma versão nova entrar num modelo já existente.
 */
async function upgradeTemplateClause(templateId, contractClauseId, actorUserId, transaction) {
  const template = await getTemplate(templateId, transaction);
  const link = await ContractTemplateClause.findOne({
    where: { contractTemplateId: template.id, contractClauseId },
    transaction,
  });
  if (!link) {
    throw AppError.notFound('Cláusula não está vinculada a este modelo.', 'LEGAL_CONTRACT_TEMPLATE_CLAUSE_NOT_FOUND');
  }
  const current = await ContractClause.findByPk(link.contractClauseId, { transaction });
  const latest = await getLatestVersionOfCode(current, transaction);
  if (!latest || !latest.isActive) {
    throw AppError.conflict(
      `A cláusula "${current.code}" foi retirada de circulação — não há versão vigente para usar no modelo.`,
      'LEGAL_TEMPLATE_CLAUSE_NO_ACTIVE_VERSION'
    );
  }
  if (latest.id === current.id) {
    throw AppError.conflict(`O modelo já usa a versão vigente (v${current.versionNumber}) da cláusula "${current.code}".`, 'LEGAL_TEMPLATE_CLAUSE_ALREADY_CURRENT');
  }
  const beforeJson = link.toJSON();
  link.contractClauseId = latest.id;
  await link.save({ transaction });

  await registrarAuditoria(
    {
      groupId: template.groupId,
      companyId: template.companyId,
      actorUserId,
      action: 'legal.contract_template.upgrade_clause',
      entityType: 'ContractTemplateClause',
      entityId: link.id,
      beforeJson,
      afterJson: link.toJSON(),
      reason: `Modelo ${template.id}: cláusula "${current.code}" atualizada de v${current.versionNumber} para v${latest.versionNumber}${latest.conditionJson && latest.conditionStatus !== 'APPROVED' ? ' (condição ainda pendente de aprovação — o modelo não gera documento até a aprovação)' : ''}.`,
    },
    transaction
  );
  return { link, from: current, to: latest };
}

/**
 * listClauseTemplateUsage — para a Biblioteca de cláusulas: quais modelos usam alguma versão
 * deste código, qual versão cada um usa, e se ela já foi substituída.
 */
async function listClauseTemplateUsage(code, transaction) {
  const versions = await ContractClause.findAll({ where: { code }, order: [['version_number', 'ASC']], transaction });
  if (!versions.length) throw AppError.notFound(`Cláusula "${code}" não encontrada.`, 'LEGAL_CONTRACT_CLAUSE_NOT_FOUND');
  const latest = versions[versions.length - 1];
  const links = await ContractTemplateClause.findAll({
    where: { contractClauseId: versions.map((v) => v.id) },
    transaction,
  });
  const usage = [];
  for (const link of links) {
    const template = await ContractTemplate.findByPk(link.contractTemplateId, { transaction });
    const linked = versions.find((v) => v.id === link.contractClauseId);
    usage.push({
      templateId: link.contractTemplateId,
      templateName: template ? template.name : null,
      contractClauseId: linked.id,
      linkedVersionNumber: linked.versionNumber,
      latestVersionNumber: latest.versionNumber,
      latestIsActive: latest.isActive,
      superseded: latest.isActive && latest.versionNumber > linked.versionNumber,
    });
  }
  return usage;
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
  renderTemplateForContract,
  upgradeTemplateClause,
  listClauseTemplateUsage,
  TEMPLATE_CONTRACT_TYPES,
};

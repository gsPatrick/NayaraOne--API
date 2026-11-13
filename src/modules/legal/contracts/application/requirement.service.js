'use strict';

const { ContractRequirement, File } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { getContract, isLeaseLikeContractType } = require('./contract.service');
const { publishCadernoEvent } = require('../../shared/legalEvents.service');
const { assertUuidFields } = require('../../shared/legalIds');
const { publishContractRequirementUpdated } = require('../../shared/legalBiEvents.service');

/**
 * requirements.service.js — auditoria externa (contrato bruto, Anexo I "7. Checklist
 * documental", "4. Entidades/tabelas obrigatórias legal.contract_requirements", teste
 * "JUR-TS-003 Documento faltante" e regra "JUR-003 Etapa não avança com documento obrigatório
 * faltante"). Não existia NENHUM motor de requirements de documentos — só o checklist de
 * PAPÉIS das partes (REQUIRED_ROLES_BY_TYPE em contracts.service.js, que continua existindo e
 * cobre outra coisa: QUEM precisa estar no contrato, não QUAIS documentos ele precisa ter).
 *
 * `REQUIREMENT_TEMPLATES_BY_CONTRACT_TYPE` abaixo segue literalmente os exemplos do Caderno
 * ("7. Checklist documental"):
 *   - Locação: documentos PF/PJ, garantia, procuração se aplicável, vistoria,
 *     titularidade/obrigações.
 *   - Venda financiada: documentos comprador/vendedor, matrícula, certidões, financiamento,
 *     dados de pagamento.
 *   - Entrega de casa nova: termo, vistoria final, manual do proprietário, fotos, chaves.
 *   - Imóvel usado: termo específico deixando clara natureza/estado conforme modelo jurídico
 *     aprovado.
 *
 * FIX AUD-009 (auditoria externa, 09/10/2026): a migration 20260101000291 (tabela
 * "legal"."contract_requirements") JÁ está aplicada neste banco (confirmado via
 * `SELECT to_regclass('legal.contract_requirements')`), mas a nota de ambiente que acompanhava
 * este arquivo dizia o contrário e o wire-up de `assertRequirementsSatisfied` dentro de
 * `transitionContractStatus` (contracts.service.js) nunca tinha sido ativado — mesmo padrão de
 * bug do fallback de bootstrap encontrado em
 * construction/projects.service.js#hasOpenCriticalNonconformity. Agora `transitionContractStatus`
 * chama `assertDocumentRequirementsGate` (que chama esta função) no início de TODA transição,
 * antes dos demais gates — ver contracts.service.js.
 */

// Tipos de documento/garantia/termo exigidos — só para documentação/consulta; o enum real é a
// string livre validada contra este array (mesmo padrão de GUARANTEE_TYPES/CONTRACT_TYPES).
const REQUIREMENT_TYPES = [
  'PF_DOCUMENT',
  'PJ_DOCUMENT',
  'GUARANTEE',
  'POWER_OF_ATTORNEY',
  'INSPECTION',
  'OWNERSHIP_PROOF',
  'OBLIGATIONS',
  'BUYER_DOCUMENT',
  'SELLER_DOCUMENT',
  'PROPERTY_REGISTRATION',
  'CERTIFICATES',
  'FINANCING',
  'PAYMENT_DATA',
  'DELIVERY_TERM',
  'FINAL_INSPECTION',
  'OWNER_MANUAL',
  'PHOTOS',
  'KEYS',
  'USED_PROPERTY_TERM',
  'TRADE_ASSET',
  'SERVICE_SCOPE',
  'CONSTRUCTION_PERMIT',
  'TECHNICAL_RESPONSIBILITY',
  'BUDGET_SCHEDULE',
];

// Matriz M5: os modelos de checklist saíram do código e são a política da regra REG-JUR-001 do Motor de Regras
// (requirementRules.service.js). O padrão do Caderno §7 está em requirementRules.defaults.js e é a semente da
// regra; REQUIREMENT_TEMPLATES_BY_CONTRACT_TYPE continua exportado só como leitura desse padrão.
const { TEMPLATES: REQUIREMENT_TEMPLATES_BY_CONTRACT_TYPE, TYPE_TO_TEMPLATE } = require('./requirementRules.defaults');
const { resolveRequirementItems, STAGES } = require('./requirementRules.service');

function resolveTemplateKey(contractType) {
  return TYPE_TO_TEMPLATE[contractType] || (isLeaseLikeContractType(contractType) ? 'LEASE' : contractType);
}

/**
 * generateRequirementsForContract — gera os requirements de um contrato a partir do seu
 * contractType + termType (quando aplicável, ex.: termos de entrega) + características das
 * partes (ex.: procuração só se alguma parte for representada por terceiro — sinalizado via
 * `payload.hasRepresentedParty`). Idempotente por requirementCode: chamar duas vezes não
 * duplica, só preenche o que falta (mesmo espírito de "nunca apagar/duplicar" do resto do
 * módulo jurídico).
 */
async function generateRequirementsForContract(contractId, options, actorUserId, transaction) {
  // Verificação M5 linha 65 (Caderno §7 "gerados por tipo de contrato + regras + características"): o modelo do checklist
  // é resolvido pela regra REG-JUR-001 a partir do tipo do contrato; quem chama não escolhe o modelo.
  if (options && typeof options === 'object' && Object.prototype.hasOwnProperty.call(options, 'templateKey')) {
    throw AppError.badRequest(
      'O modelo do checklist não é escolhido na requisição: ele vem da regra do checklist documental (tipo do contrato + características das partes e do imóvel).',
      'LEGAL_REQUIREMENT_TEMPLATE_KEY_NOT_ACCEPTED'
    );
  }
  const contract = await getContract(contractId, transaction);

  // BUG REAL CORRIGIDO (varredura completa Marco 5, 12/10/2026, achado por teste HTTP novo):
  // esta tabela só tinha a chave literal "LEASE", mas os subtipos LEASE_RESIDENTIAL/
  // LEASE_COMMERCIAL/LEASE_SEASONAL/PROPERTY_ADMIN (AUD-015, commit 7d75b76) nunca foram
  // mapeados aqui — gerar o checklist documental para QUALQUER contrato de locação criado com
  // um subtipo específico (em vez do "LEASE" genérico) falhava com
  // LEGAL_REQUIREMENTS_TEMPLATE_NOT_FOUND, bloqueando o próprio gate fail-closed (JUR-003/
  // JUR-015) que esses subtipos deveriam estar protegidos por. Mesmo padrão de bug já corrigido
  // em rentAdvance.service.js/billingScheduleAutoGenerateJob — usar isLeaseLikeContractType()
  // em vez de comparar contractType literalmente.
  // Matriz M5 (Caderno §7): itens = política vigente do Motor de Regras (REG-JUR-001) para o tipo do contrato,
  // filtrados pelas características das partes/imóvel lidas do cadastro (não do corpo da requisição).
  const { key, items: template, ruleVersionId } = await resolveRequirementItems(contract, actorUserId, transaction);
  if (!template) {
    throw AppError.badRequest(
      `Não há modelo de checklist configurado para "${contract.contractType}" na regra do checklist documental.`,
      'LEGAL_REQUIREMENTS_TEMPLATE_NOT_FOUND'
    );
  }

  const existing = await ContractRequirement.findAll({ where: { contractId: contract.id }, transaction });
  const existingCodes = new Set(existing.map((r) => r.requirementCode));

  const created = [];
  for (const item of template) {
    if (existingCodes.has(item.requirementCode)) continue;

    const requirement = await ContractRequirement.create(
      {
        groupId: contract.groupId,
        companyId: contract.companyId,
        contractId: contract.id,
        requirementCode: item.requirementCode,
        description: item.description,
        requirementType: item.requirementType,
        status: 'PENDING',
        requiredStage: item.stage || 'LEGAL_REVIEW',
        ruleVersionId: ruleVersionId || null,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
    created.push(requirement);
    await publishContractRequirementUpdated(requirement, transaction); // M9-D619: documentos faltantes do BI
  }

  await registrarAuditoria(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      actorUserId,
      action: 'legal.contract_requirements.generate',
      entityType: 'Contract',
      entityId: contract.id,
      afterJson: { templateKey: key, ruleVersionId, createdRequirementCodes: created.map((r) => r.requirementCode) },
      reason: `Requirements gerados para o contrato ${contract.id} a partir do template "${key}".`,
    },
    transaction
  );

  // M45 (Caderno M5 §18 "contract.requirement.missing"): toda geração que deixa documento
  // PENDENTE publica o evento com a lista do que falta. Publicado aqui (e não no gate que
  // recusa a transição) porque o gate aborta a transação — o evento seria desfeito junto.
  const pending = (await ContractRequirement.findAll({ where: { contractId: contract.id, status: 'PENDING' }, transaction })).map((r) => r.requirementCode);
  if (pending.length) {
    await publishCadernoEvent(
      'contract.requirement.missing',
      'Contract',
      contract,
      { id: contract.id, missingRequirementCodes: pending.sort() },
      require('crypto').createHash('sha256').update(pending.sort().join(',')).digest('hex').slice(0, 16),
      transaction
    );
  }

  return created;
}

async function listRequirements(contractId, transaction) {
  return ContractRequirement.findAll({ where: { contractId }, order: [['created_at', 'ASC']], transaction });
}

/**
 * satisfyRequirement — marca um requirement como SATISFIED (documento efetivamente
 * apresentado/anexado) ou WAIVED (dispensado, com motivo — nunca silenciosamente ignorado).
 */
async function satisfyRequirement(requirementId, payload, actorUserId, transaction) {
  const requirement = await ContractRequirement.findByPk(requirementId, { transaction });
  if (!requirement) throw AppError.notFound('Requirement não encontrado.', 'LEGAL_REQUIREMENT_NOT_FOUND');

  assertUuidFields(payload, ['satisfiedByFileId']);
  const { satisfiedByFileId, waivedReason } = payload || {};
  const beforeJson = requirement.toJSON();

  if (waivedReason) {
    requirement.status = 'WAIVED';
    requirement.waivedReason = waivedReason;
  } else {
    if (!satisfiedByFileId) {
      throw AppError.badRequest('Informe "satisfiedByFileId" (documento apresentado) ou "waivedReason" (dispensa justificada).', 'LEGAL_REQUIREMENT_VALIDATION');
    }
    // Matriz M5 (JUR-003/JUR-013): o documento que satisfaz a exigência precisa existir NESTA
    // empresa (leitura sob RLS). Antes qualquer uuid — inclusive inexistente ou de outra empresa —
    // marcava a exigência como SATISFIED e liberava o gate sem documento nenhum.
    if (!(await File.findByPk(satisfiedByFileId, { transaction, attributes: ['id'] }))) {
      throw AppError.notFound('Documento informado em "satisfiedByFileId" não encontrado nesta empresa.', 'LEGAL_REQUIREMENT_FILE_NOT_FOUND');
    }
    requirement.status = 'SATISFIED';
    requirement.satisfiedByFileId = satisfiedByFileId;
    requirement.satisfiedAt = new Date();
  }
  requirement.updatedBy = actorUserId || null;
  await requirement.save({ transaction });
  await publishContractRequirementUpdated(requirement, transaction); // M9-D619: documentos faltantes do BI

  await registrarAuditoria(
    {
      groupId: requirement.groupId,
      companyId: requirement.companyId,
      actorUserId,
      action: 'legal.contract_requirement.satisfy',
      entityType: 'ContractRequirement',
      entityId: requirement.id,
      beforeJson,
      afterJson: requirement.toJSON(),
      reason: `Requirement "${requirement.requirementCode}" marcado como ${requirement.status}.`,
    },
    transaction
  );

  return requirement;
}

/**
 * assertRequirementsSatisfied — JUR-003 "Etapa não avança com documento obrigatório
 * faltante" / teste JUR-TS-003 "Documento faltante -> Avançar contrato -> Bloqueado". Fail
 * closed: qualquer requirement ainda PENDING bloqueia. WAIVED conta como satisfeito (dispensa
 * é uma decisão humana registrada, não uma omissão). Contrato sem NENHUM requirement gerado
 * ainda (generateRequirementsForContract nunca chamado) NÃO bloqueia — ver nota de wire-up no
 * topo do arquivo: isto é intencional para não travar contratos de tipos sem template
 * configurado ainda.
 */
const STAGE_LABELS = { LEGAL_REVIEW: 'revisão jurídica', LEGAL_APPROVAL: 'aprovação', SIGNING: 'assinatura', ACTIVATION: 'ativação', KEY_DELIVERY: 'entrega de chaves' };
const STAGE_BY_TARGET = { LEGAL_REVIEW: 'LEGAL_REVIEW', APPROVED: 'LEGAL_APPROVAL', SIGNING: 'SIGNING', ACTIVE: 'ACTIVATION', KEY_DELIVERY: 'KEY_DELIVERY' };

/**
 * Guia §5 assertRequirementsSatisfied(contractId, targetStage): resolve as exigências que valem para a etapa-alvo
 * (as de `required_stage` até a etapa pedida, na ordem LEGAL_REVIEW < LEGAL_APPROVAL < SIGNING < ACTIVATION <
 * KEY_DELIVERY) e recusa com a lista dos códigos que faltam. Aceita também o status-alvo do contrato
 * (APPROVED -> LEGAL_APPROVAL, ACTIVE -> ACTIVATION). Sem etapa (chamada legada), toda pendência bloqueia.
 * Fail closed: sem checklist gerado, gera agora; tipo sem modelo bloqueia.
 */
async function assertRequirementsSatisfied(contractId, targetStageOrTransaction, maybeTransaction) {
  const legacy = targetStageOrTransaction && typeof targetStageOrTransaction === 'object';
  const transaction = legacy ? targetStageOrTransaction : maybeTransaction;
  const stage = legacy || !targetStageOrTransaction ? null : (STAGE_BY_TARGET[targetStageOrTransaction] || targetStageOrTransaction);
  if (stage && !STAGES.includes(stage)) {
    throw AppError.badRequest(`Etapa desconhecida para o checklist: "${stage}".`, 'LEGAL_REQUIREMENT_STAGE_INVALID');
  }
  let requirements = await ContractRequirement.findAll({ where: { contractId }, transaction });
  if (requirements.length === 0) {
    try {
      await generateRequirementsForContract(contractId, {}, null, transaction);
    } catch (err) {
      if (err && err.code === 'LEGAL_REQUIREMENTS_TEMPLATE_NOT_FOUND') {
        throw AppError.conflict(`Não é possível avançar: ${err.message}`, 'LEGAL_REQUIREMENTS_TEMPLATE_NOT_FOUND');
      }
      throw err;
    }
    requirements = await ContractRequirement.findAll({ where: { contractId }, transaction });
    if (requirements.length === 0) {
      throw AppError.conflict('Não é possível avançar: o checklist documental do contrato está vazio.', 'LEGAL_REQUIREMENTS_TEMPLATE_NOT_FOUND');
    }
  }
  const limit = stage ? STAGES.indexOf(stage) : STAGES.length;
  const pending = requirements.filter((r) => r.status === 'PENDING' && STAGES.indexOf(r.requiredStage || 'LEGAL_REVIEW') <= limit);
  if (pending.length > 0) {
    // Mensagem para pessoas com o rótulo de cada exigência; os códigos ficam nos campos estruturados.
    const nomes = pending.map((r) => String(r.description || '').replace(/\.$/, '')).join('; ');
    throw AppError.conflict(
      `Não é possível avançar${stage ? ` para a etapa de ${STAGE_LABELS[stage]}` : ''}: faltam documentos obrigatórios — ${nomes}.`,
      'LEGAL_REQUIREMENTS_PENDING',
      {
        stage,
        missingRequirementCodes: pending.map((r) => r.requirementCode),
        pending: pending.map((r) => ({ id: r.id, requirementCode: r.requirementCode, description: r.description, requiredStage: r.requiredStage })),
      }
    );
  }
  return true;
}

/** Garante o checklist gerado (ao entrar em DOCUMENTS_PENDING): gera se ainda não existe, sem bloquear. */
async function ensureRequirementsGenerated(contractId, actorUserId, transaction) {
  const count = await ContractRequirement.count({ where: { contractId }, transaction });
  if (count === 0) await generateRequirementsForContract(contractId, {}, actorUserId, transaction);
}

module.exports = {
  generateRequirementsForContract,
  listRequirements,
  satisfyRequirement,
  assertRequirementsSatisfied,
  ensureRequirementsGenerated,
  STAGE_BY_TARGET,
  resolveTemplateKey,
  REQUIREMENT_TYPES,
  REQUIREMENT_TEMPLATES_BY_CONTRACT_TYPE,
};

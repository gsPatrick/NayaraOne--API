'use strict';

const { ContractRequirement } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { getContract } = require('./contracts.service');

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
 * NOTA DE AMBIENTE (07/10/2026): depende da tabela "legal"."contract_requirements" (migration
 * 20260101000291), AINDA NÃO aplicada neste banco (sem credencial de DDL disponível aqui — ver
 * nota em src/models/ContractRequirement.js). Por isso `assertRequirementsSatisfied` NÃO está
 * (ainda) chamada dentro de `transitionContractStatus` (contracts.service.js) — wire-up
 * proposital mas DELIBERADAMENTE NÃO ATIVADO para não quebrar toda a máquina de estados de
 * contrato em produção/homologação enquanto a tabela não existir de fato. Depois de rodar
 * `npm run migrate`, ativar chamando `assertRequirementsSatisfied(contract, targetStatus,
 * transaction)` no início de `transitionContractStatus`, antes dos demais gates — é uma linha
 * só, documentada lá também.
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
];

// Templates por contractType (Contract.contractType usa SALE|LEASE|SERVICE|CONSTRUCTION — ver
// CONTRACT_TYPES em contracts.service.js) + por termType (para os termos de entrega descritos
// no Caderno "3. Tipos de contrato": KEY_DELIVERY/USED_PROPERTY_DELIVERY, usados em
// keyDeliveries.service.js).
const REQUIREMENT_TEMPLATES_BY_CONTRACT_TYPE = {
  LEASE: [
    { requirementCode: 'LEASE_PF_PJ_DOCS', requirementType: 'PF_DOCUMENT', description: 'Documentos PF/PJ das partes (locador/locatário).' },
    { requirementCode: 'LEASE_GUARANTEE', requirementType: 'GUARANTEE', description: 'Garantia locatícia (fiador, seguro-fiança, caução ou título de capitalização).' },
    { requirementCode: 'LEASE_POWER_OF_ATTORNEY', requirementType: 'POWER_OF_ATTORNEY', description: 'Procuração, quando alguma parte for representada por terceiro.', optional: true },
    { requirementCode: 'LEASE_INSPECTION', requirementType: 'INSPECTION', description: 'Vistoria de entrada (CHECK_IN) do imóvel.' },
    { requirementCode: 'LEASE_OWNERSHIP', requirementType: 'OWNERSHIP_PROOF', description: 'Comprovação de titularidade do imóvel.' },
    { requirementCode: 'LEASE_OBLIGATIONS', requirementType: 'OBLIGATIONS', description: 'Definição de responsáveis pelas obrigações locatícias (IPTU/condomínio/água/luz/gás).' },
  ],
  SALE_FINANCED: [
    { requirementCode: 'SALE_FIN_BUYER_DOCS', requirementType: 'BUYER_DOCUMENT', description: 'Documentos do comprador.' },
    { requirementCode: 'SALE_FIN_SELLER_DOCS', requirementType: 'SELLER_DOCUMENT', description: 'Documentos do vendedor.' },
    { requirementCode: 'SALE_FIN_REGISTRATION', requirementType: 'PROPERTY_REGISTRATION', description: 'Matrícula do imóvel.' },
    { requirementCode: 'SALE_FIN_CERTIFICATES', requirementType: 'CERTIFICATES', description: 'Certidões (negativas, ônus etc.).' },
    { requirementCode: 'SALE_FIN_FINANCING', requirementType: 'FINANCING', description: 'Documentação de financiamento.' },
    { requirementCode: 'SALE_FIN_PAYMENT_DATA', requirementType: 'PAYMENT_DATA', description: 'Dados de pagamento.' },
  ],
  NEW_PROPERTY_DELIVERY: [
    { requirementCode: 'NEW_DELIVERY_TERM', requirementType: 'DELIVERY_TERM', description: 'Termo de entrega.' },
    { requirementCode: 'NEW_FINAL_INSPECTION', requirementType: 'FINAL_INSPECTION', description: 'Vistoria final.' },
    { requirementCode: 'NEW_OWNER_MANUAL', requirementType: 'OWNER_MANUAL', description: 'Manual do proprietário.' },
    { requirementCode: 'NEW_PHOTOS', requirementType: 'PHOTOS', description: 'Fotos.' },
    { requirementCode: 'NEW_KEYS', requirementType: 'KEYS', description: 'Chaves.' },
  ],
  USED_PROPERTY_DELIVERY: [
    {
      requirementCode: 'USED_PROPERTY_TERM',
      requirementType: 'USED_PROPERTY_TERM',
      description: 'Termo específico deixando clara a natureza/estado do imóvel usado, conforme modelo jurídico aprovado.',
    },
  ],
};

/**
 * generateRequirementsForContract — gera os requirements de um contrato a partir do seu
 * contractType + termType (quando aplicável, ex.: termos de entrega) + características das
 * partes (ex.: procuração só se alguma parte for representada por terceiro — sinalizado via
 * `payload.hasRepresentedParty`). Idempotente por requirementCode: chamar duas vezes não
 * duplica, só preenche o que falta (mesmo espírito de "nunca apagar/duplicar" do resto do
 * módulo jurídico).
 */
async function generateRequirementsForContract(contractId, options, actorUserId, transaction) {
  const contract = await getContract(contractId, transaction);
  const { templateKey, hasRepresentedParty } = options || {};

  const key = templateKey || contract.contractType;
  const template = REQUIREMENT_TEMPLATES_BY_CONTRACT_TYPE[key];
  if (!template) {
    throw AppError.badRequest(
      `Não há template de requirements configurado para "${key}". Templates disponíveis: ${Object.keys(REQUIREMENT_TEMPLATES_BY_CONTRACT_TYPE).join(', ')}.`,
      'LEGAL_REQUIREMENTS_TEMPLATE_NOT_FOUND'
    );
  }

  const existing = await ContractRequirement.findAll({ where: { contractId: contract.id }, transaction });
  const existingCodes = new Set(existing.map((r) => r.requirementCode));

  const created = [];
  for (const item of template) {
    if (item.optional && !hasRepresentedParty) continue; // procuração só se aplicável.
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
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
    created.push(requirement);
  }

  await registrarAuditoria(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      actorUserId,
      action: 'legal.contract_requirements.generate',
      entityType: 'Contract',
      entityId: contract.id,
      afterJson: { templateKey: key, createdRequirementCodes: created.map((r) => r.requirementCode) },
      reason: `Requirements gerados para o contrato ${contract.id} a partir do template "${key}".`,
    },
    transaction
  );

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

  const { satisfiedByFileId, waivedReason } = payload || {};
  const beforeJson = requirement.toJSON();

  if (waivedReason) {
    requirement.status = 'WAIVED';
    requirement.waivedReason = waivedReason;
  } else {
    if (!satisfiedByFileId) {
      throw AppError.badRequest('Informe "satisfiedByFileId" (documento apresentado) ou "waivedReason" (dispensa justificada).', 'LEGAL_REQUIREMENT_VALIDATION');
    }
    requirement.status = 'SATISFIED';
    requirement.satisfiedByFileId = satisfiedByFileId;
    requirement.satisfiedAt = new Date();
  }
  requirement.updatedBy = actorUserId || null;
  await requirement.save({ transaction });

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
async function assertRequirementsSatisfied(contractId, transaction) {
  const requirements = await ContractRequirement.findAll({ where: { contractId }, transaction });
  const pending = requirements.filter((r) => r.status === 'PENDING');
  if (pending.length > 0) {
    throw AppError.conflict(
      `Não é possível avançar: há requirement(s) obrigatório(s) pendente(s): ${pending.map((r) => r.requirementCode).join(', ')}.`,
      'LEGAL_REQUIREMENTS_PENDING',
      { pending: pending.map((r) => ({ id: r.id, requirementCode: r.requirementCode, description: r.description })) }
    );
  }
  return true;
}

module.exports = {
  generateRequirementsForContract,
  listRequirements,
  satisfyRequirement,
  assertRequirementsSatisfied,
  REQUIREMENT_TYPES,
  REQUIREMENT_TEMPLATES_BY_CONTRACT_TYPE,
};

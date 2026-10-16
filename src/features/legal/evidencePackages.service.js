'use strict';

const crypto = require('crypto');
const { EvidencePackage, EvidencePackageAccessLog, ContractVersion, Signature, ContractRequirement, Inspection, InspectionItem, FileLink, File } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishEvidencePackageCreated } = require('./legalEvents.service');
const { getLegalCase } = require('./legalCases.service');

/**
 * computePackageHash — SHA-256 hex do manifest_json serializado de forma determinística
 * (JSON.stringify preserva a ordem de inserção das chaves de cada item; como manifestItems é
 * uma lista de objetos simples montada pelo próprio service — não pelo cliente — a ordem das
 * chaves é sempre a mesma, garantindo hash determinístico para o mesmo conteúdo lógico).
 */
function computePackageHash(manifest) {
  const serialized = JSON.stringify(normalizeManifest(manifest));
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

/**
 * normalizeManifest — FIX necessário para o M5-29 (export verificável): o hash original era
 * calculado sobre o objeto em memória, mas a coluna manifest_json é JSONB, e o Postgres NÃO
 * preserva a ordem das chaves em JSONB. Ao reler o pacote do banco, JSON.stringify produzia
 * uma string com as chaves em outra ordem e o hash recalculado NUNCA batia — o que tornaria
 * impossível verificar a integridade de um dossiê exportado (e faria qualquer verificação
 * futura acusar adulteração inexistente).
 *
 * A correção é canonicalizar o manifesto antes de hashear: sempre a mesma ordem de campos
 * ({type, description, referenceId, hash}), que é exatamente a ordem em que
 * createEvidencePackage já montava os itens — ou seja, os hashes de pacotes já gravados
 * continuam válidos; o que muda é que a releitura do banco passa a produzir o mesmo hash.
 */
function normalizeManifest(manifest) {
  return (manifest || []).map((item) => ({
    type: item.type,
    description: item.description,
    referenceId: item.referenceId !== undefined ? item.referenceId : null,
    hash: item.hash !== undefined ? item.hash : null,
  }));
}

/**
 * createEvidencePackage — monta manifest_json a partir de manifestItems (cada item deve ter
 * {type, description, referenceId, hash}), calcula o SHA-256 do manifesto serializado e
 * persiste. EvidencePackage é append-only (model sem updatedAt/paranoid) — não existe
 * updateEvidencePackage nem deleteEvidencePackage propositalmente.
 */
async function createEvidencePackage(legalCaseId, manifestItems, actorUserId, transaction) {
  const legalCase = await getLegalCase(legalCaseId, transaction);

  if (!Array.isArray(manifestItems) || manifestItems.length === 0) {
    throw AppError.badRequest('"manifestItems" deve ser uma lista não vazia de itens de evidência.', 'LEGAL_EVIDENCE_PACKAGE_VALIDATION');
  }
  for (const item of manifestItems) {
    if (!item || typeof item !== 'object' || !item.type || !item.description) {
      throw AppError.badRequest('Cada item do manifesto precisa de ao menos "type" e "description".', 'LEGAL_EVIDENCE_PACKAGE_VALIDATION');
    }
  }

  const manifest = manifestItems.map((item) => ({
    type: item.type,
    description: item.description,
    referenceId: item.referenceId || null,
    hash: item.hash || null,
  }));
  const packageHash = computePackageHash(manifest);

  const evidencePackage = await EvidencePackage.create(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      legalCaseId: legalCase.id,
      manifestJson: manifest,
      packageHash,
      createdBy: actorUserId || null,
    },
    { transaction }
  );

  await publishEvidencePackageCreated(evidencePackage, transaction);

  await registrarAuditoria(
    {
      groupId: legalCase.groupId,
      companyId: legalCase.companyId,
      actorUserId,
      action: 'legal.evidence_package.create',
      entityType: 'EvidencePackage',
      entityId: evidencePackage.id,
      afterJson: evidencePackage.toJSON(),
      reason: `Pacote de evidências (${manifest.length} itens) criado para o processo ${legalCase.id}, hash ${packageHash}.`,
    },
    transaction
  );

  return evidencePackage;
}

/**
 * assembleManifestFromContractAttachments — FIX AUD-016 (auditoria externa Nayara,
 * 11/10/2026, JUR-010 "Cadeia de custódia completa de documentos"): "Hash contratual existe;
 * custódia de TODOS os anexos não demonstrada." `createEvidencePackage` sempre dependeu de
 * `manifestItems` montado manualmente pelo chamador — nada garantia que um dossiê incluísse
 * TODO anexo do processo/contrato (só o que a pessoa lembrasse de listar). Esta função varre,
 * a partir do contrato vinculado ao processo jurídico, TODAS as fontes reais de anexo do
 * sistema (seção 16 do Caderno, "Manifesto do dossiê lista arquivos, hashes, origem, datas,
 * relações e versão"):
 *   - ContractVersion.documentFileId (todas as versões, não só a atual) + a lista de
 *     assinaturas registradas sobre cada versão (mesmo documento — legal.signatures não tem
 *     arquivo próprio, a assinatura eletrônica recai sobre o documento da versão).
 *   - ContractRequirement.satisfiedByFileId (todo documento do checklist já satisfeito).
 *   - InspectionItem (via FileLink) de toda vistoria vinculada ao contrato.
 * e monta o manifesto com o hash REAL do arquivo (File.checksumSha256, calculado no upload —
 * nunca um hash informado pelo chamador), fechando a lacuna "custódia de todos os anexos".
 */
async function assembleManifestFromContractAttachments(contractId, transaction) {
  const manifest = [];
  const seenFileIds = new Set();

  function pushFile(file, type, description, relatedId) {
    if (!file || seenFileIds.has(file.id)) return;
    seenFileIds.add(file.id);
    manifest.push({ type, description, referenceId: relatedId || file.id, hash: file.checksumSha256 || null });
  }

  const versions = await ContractVersion.findAll({ where: { contractId }, include: [{ model: File, as: 'documentFile' }], transaction });
  for (const version of versions) {
    if (version.documentFile) {
      const signatures = await Signature.findAll({ where: { contractVersionId: version.id }, transaction });
      const signedBy = signatures.filter((s) => s.status === 'SIGNED').length;
      pushFile(
        version.documentFile,
        'CONTRACT_VERSION_DOCUMENT',
        `Documento da versão ${version.versionNumber} do contrato${signedBy ? ` (assinado por ${signedBy} parte(s))` : ''}`,
        version.id
      );
    }
  }

  const requirements = await ContractRequirement.findAll({ where: { contractId }, include: [{ model: File, as: 'satisfiedByFile' }], transaction });
  for (const requirement of requirements) {
    if (requirement.satisfiedByFile) pushFile(requirement.satisfiedByFile, 'REQUIREMENT_DOCUMENT', `Checklist "${requirement.requirementCode}" satisfeito`, requirement.id);
  }

  const inspections = await Inspection.findAll({ where: { contractId }, transaction });
  for (const inspection of inspections) {
    const items = await InspectionItem.findAll({ where: { inspectionId: inspection.id }, transaction });
    for (const item of items) {
      const links = await FileLink.findAll({ where: { relatedEntityType: 'InspectionItem', relatedEntityId: item.id }, include: [{ model: File, as: 'file' }], transaction });
      for (const link of links) {
        if (link.file) pushFile(link.file, 'INSPECTION_MEDIA', `${link.purpose === 'VIDEO' ? 'Vídeo' : 'Foto'} do item "${item.itemName}" (vistoria ${inspection.inspectionType})`, link.id);
      }
    }
  }

  return manifest;
}

/**
 * createEvidencePackageFromContractAttachments — monta o manifesto automaticamente (ver
 * assembleManifestFromContractAttachments acima) e cria o pacote — garante que o dossiê cobre
 * TODO anexo conhecido do contrato, não só o que o usuário lembrou de incluir manualmente.
 * `extraManifestItems` permite acrescentar itens que não são um File do sistema (ex.: uma nota
 * de auditoria com hash calculado fora daqui), seguindo o mesmo formato de `manifestItems`.
 */
async function createEvidencePackageFromContractAttachments(legalCaseId, actorUserId, transaction, { extraManifestItems = [] } = {}) {
  const legalCase = await getLegalCase(legalCaseId, transaction);
  if (!legalCase.contractId) {
    throw AppError.badRequest(
      'Este processo jurídico não está vinculado a um contrato — não há anexos para montar automaticamente.',
      'LEGAL_EVIDENCE_PACKAGE_NO_CONTRACT'
    );
  }
  const autoManifest = await assembleManifestFromContractAttachments(legalCase.contractId, transaction);
  const manifestItems = [...autoManifest, ...extraManifestItems];
  if (manifestItems.length === 0) {
    throw AppError.conflict(
      'Nenhum anexo encontrado para o contrato deste processo — nada para incluir no dossiê.',
      'LEGAL_EVIDENCE_PACKAGE_NO_ATTACHMENTS'
    );
  }
  return createEvidencePackage(legalCaseId, manifestItems, actorUserId, transaction);
}

async function listEvidencePackages(legalCaseId, transaction) {
  return EvidencePackage.findAll({ where: { legalCaseId }, order: [['created_at', 'DESC']], transaction });
}

async function getEvidencePackage(id, transaction) {
  const evidencePackage = await EvidencePackage.findByPk(id, { transaction });
  if (!evidencePackage) throw AppError.notFound('Pacote de evidências não encontrado.', 'LEGAL_EVIDENCE_PACKAGE_NOT_FOUND');
  return evidencePackage;
}

/**
 * M5-28 — CADEIA DE CUSTÓDIA. Um dossiê de provas sem registro de quem o acessou não sustenta
 * contestação: a parte contrária pergunta "quem teve acesso a isso, e quando?" e não havia
 * resposta. `logEvidenceAccess` grava uma linha append-only por acesso em
 * legal.evidence_package_access_log — nunca sobrescreve, nunca deduplica.
 *
 * DECISÃO DOCUMENTADA: `getEvidencePackage` (leitura interna, usada por outros fluxos do
 * próprio sistema) NÃO loga — se logasse, a cadeia de custódia ficaria poluída com acessos de
 * máquina e o "quem acessou" perderia valor probatório. O acesso HUMANO rastreável passa por
 * `viewEvidencePackage` (VIEWED) e `exportEvidencePackage` (EXPORTED), que são os pontos que
 * entregam o conteúdo a alguém.
 */
const ACCESS_ACTIONS = ['VIEWED', 'EXPORTED'];

async function logEvidenceAccess(evidencePackageId, actorUserId, action, transaction) {
  if (!ACCESS_ACTIONS.includes(action)) {
    throw AppError.badRequest(`"action" deve ser um de: ${ACCESS_ACTIONS.join(', ')}.`, 'LEGAL_EVIDENCE_ACCESS_VALIDATION');
  }
  const evidencePackage = await getEvidencePackage(evidencePackageId, transaction);

  const entry = await EvidencePackageAccessLog.create(
    {
      groupId: evidencePackage.groupId,
      companyId: evidencePackage.companyId,
      evidencePackageId: evidencePackage.id,
      accessedByUserId: actorUserId || null,
      action,
      accessedAt: new Date(),
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: evidencePackage.groupId,
      companyId: evidencePackage.companyId,
      actorUserId,
      action: 'legal.evidence_package.access',
      entityType: 'EvidencePackageAccessLog',
      entityId: entry.id,
      afterJson: entry.toJSON(),
      reason: `Dossiê de provas ${evidencePackage.id} acessado (${action}).`,
    },
    transaction
  );

  return entry;
}

/**
 * viewEvidencePackage — leitura COM registro na cadeia de custódia (o que o controller de
 * GET /legal/evidence-packages/:id deve usar).
 */
async function viewEvidencePackage(id, actorUserId, transaction) {
  const evidencePackage = await getEvidencePackage(id, transaction);
  await logEvidenceAccess(evidencePackage.id, actorUserId, 'VIEWED', transaction);
  return evidencePackage;
}

async function listEvidenceAccessLog(evidencePackageId, transaction) {
  return EvidencePackageAccessLog.findAll({
    where: { evidencePackageId },
    order: [['accessed_at', 'ASC']],
    transaction,
  });
}

/**
 * M5-29 — EXPORTAR/VERIFICAR. `exportEvidencePackage` devolve um JSON autocontido: manifesto
 * completo, hash gravado no banco, itens referenciados e metadados do processo/tenant. O
 * export também é um acesso — fica registrado como EXPORTED na cadeia de custódia.
 *
 * `verifyEvidencePackageIntegrity` recalcula o SHA-256 do manifesto contido no JSON exportado
 * e compara com o `packageHash` que veio junto (mesma técnica de verificação usada em
 * getInspectionReport, que rehasheia os bytes do PDF antes de servi-lo). Se alguém editar
 * qualquer campo do manifesto dentro do arquivo exportado, o hash recalculado deixa de bater e
 * a verificação acusa adulteração. Nota honesta de escopo: isso prova INTEGRIDADE (o conteúdo
 * não mudou desde a geração), não AUTENTICIDADE contra um adversário que controle o arquivo
 * inteiro — quem editar o manifesto E reescrever o packageHash produz um export autoconsistente.
 * A defesa contra isso é a comparação com o hash gravado no banco (o export traz
 * `packageHash`, e a linha original em legal.evidence_packages continua sendo a fonte da
 * verdade), por isso `verifyEvidencePackageIntegrity` aceita `expectedHash` opcional para
 * confrontar o export com o valor persistido.
 */
async function exportEvidencePackage(id, actorUserId, transaction) {
  const evidencePackage = await getEvidencePackage(id, transaction);
  await logEvidenceAccess(evidencePackage.id, actorUserId, 'EXPORTED', transaction);

  return {
    formatVersion: 1,
    evidencePackageId: evidencePackage.id,
    legalCaseId: evidencePackage.legalCaseId,
    groupId: evidencePackage.groupId,
    companyId: evidencePackage.companyId,
    createdAt: evidencePackage.createdAt,
    createdBy: evidencePackage.createdBy,
    itemCount: evidencePackage.manifestJson.length,
    manifest: evidencePackage.manifestJson,
    packageHash: evidencePackage.packageHash,
    exportedAt: new Date().toISOString(),
    exportedByUserId: actorUserId || null,
  };
}

function verifyEvidencePackageIntegrity(exportedJson, expectedHash = null) {
  if (!exportedJson || typeof exportedJson !== 'object' || !Array.isArray(exportedJson.manifest)) {
    throw AppError.badRequest(
      'JSON de dossiê exportado inválido: falta o campo "manifest".',
      'LEGAL_EVIDENCE_EXPORT_INVALID'
    );
  }
  const recomputedHash = computePackageHash(exportedJson.manifest);
  const referenceHash = expectedHash || exportedJson.packageHash;
  const valid = Boolean(referenceHash) && recomputedHash === referenceHash;
  return { valid, recomputedHash, expectedHash: referenceHash };
}

module.exports = {
  createEvidencePackage,
  assembleManifestFromContractAttachments,
  createEvidencePackageFromContractAttachments,
  listEvidencePackages,
  getEvidencePackage,
  viewEvidencePackage,
  logEvidenceAccess,
  listEvidenceAccessLog,
  exportEvidencePackage,
  verifyEvidencePackageIntegrity,
  computePackageHash,
  ACCESS_ACTIONS,
};

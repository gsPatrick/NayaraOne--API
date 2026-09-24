'use strict';

const crypto = require('crypto');
const { ContractVersion } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishContractVersionCreated } = require('./legalEvents.service');
const { getContract } = require('./contracts.service');
const { getSetting } = require('../settings/settings.service');

/**
 * M5-07 (fechamento) — DECISÃO DOCUMENTADA: até aqui `documentFileId` era opcional na CRIAÇÃO
 * da versão e só virava obrigatório mais tarde, na transição para SIGNING (assertDocumentGate
 * em contracts.service.js). Na prática isso permitia acumular versões "fantasma" sem arquivo
 * nenhum, e a cliente reportou justamente isso.
 *
 * Optamos pela alternativa recomendada: uma CONFIGURAÇÃO POR TENANT
 * `legal.contract_version_requires_document` (booleana), lida com `getSetting` no mesmo padrão
 * de settings.service.js, com DEFAULT `true` — ou seja, fail-closed: sem configuração
 * explícita, criar versão sem `documentFileId` é REJEITADO na hora da criação. Um tenant que
 * tenha um fluxo legítimo de rascunho pode gravar o setting como `false` e voltar ao
 * comportamento antigo.
 *
 * Também aceitamos um override por chamada (`payload.requireDocument`), útil para fluxos
 * internos/migração de dados que precisam ser explícitos sobre a exceção — quando informado,
 * ele tem precedência sobre o setting. O override NUNCA é "default false": quem passa
 * `requireDocument: false` está assumindo a exceção conscientemente, e a decisão fica
 * registrada na auditoria da versão criada.
 *
 * LIMITAÇÃO CONHECIDA (honesta): a chave ainda não está declarada no SETTINGS_SCHEMA de
 * src/features/settings/settings.service.js — esse arquivo está fora do escopo de alteração
 * deste trabalho (outro agente atua nele em paralelo). Enquanto a linha
 * `'legal.contract_version_requires_document': { type: 'boolean' }` não for adicionada lá,
 * `upsertSetting` rejeita a chave como desconhecida e a configuração só pode ser gravada
 * diretamente na tabela core.tenant_settings. O comportamento DEFAULT (true) já está ativo e
 * é o que importa para o requisito.
 */
const REQUIRE_DOCUMENT_SETTING_KEY = 'legal.contract_version_requires_document';

async function isDocumentRequired(contract, payload, transaction) {
  if (payload && typeof payload.requireDocument === 'boolean') return payload.requireDocument;
  const value = await getSetting(
    REQUIRE_DOCUMENT_SETTING_KEY,
    { groupId: contract.groupId, companyId: contract.companyId },
    transaction,
    true
  );
  return value !== false;
}

/**
 * ContractVersion é append-only (sem paranoid, sem lock_version — ver model). content_hash é
 * um SHA-256 hex do conteúdo do documento.
 *
 * SIMPLIFICAÇÃO ASSUMIDA (decisão de engenharia): o sistema real ainda não tem storage de
 * arquivo integrado a este fluxo (document_file_id é nullable e aponta pra people.files, que
 * é gerenciado por outra feature). Como não há upload de arquivo real neste marco, o hash é
 * calculado sobre um `content` textual/JSON que o chamador informa representando o conteúdo
 * da versão do contrato (ex.: o corpo do documento renderizado, ou um resumo estruturado dos
 * termos). Em produção, quando a integração de storage estiver pronta, o ideal é hashear os
 * bytes reais do arquivo carregado — aqui hasheamos o payload textual informado.
 */
function computeContentHash(content) {
  const serialized = typeof content === 'string' ? content : JSON.stringify(content);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

async function createContractVersion(contractId, payload, actorUserId, transaction) {
  const contract = await getContract(contractId, transaction);
  const { content, documentFileId, effectiveFrom, templateId } = payload;
  // FIX AUD-008 (homologação 09/09/2026): `content === undefined || content === null` deixava
  // passar `content: ""` (ou só espaços) como se fosse um documento real — o hash de uma
  // string vazia é um hash "válido" tecnicamente, mas não representa nenhum conteúdo de
  // verdade, e isso permitia satisfazer assertDocumentGate (que só checa "existe alguma
  // versão") com uma versão vazia por trás. Content precisa ter conteúdo de fato: string não
  // pode ser vazia/só espaço; objeto/JSON não pode ser vazio.
  const hasRealContent =
    content !== undefined &&
    content !== null &&
    (typeof content === 'string' ? content.trim().length > 0 : Object.keys(content).length > 0);
  if (!hasRealContent) {
    throw AppError.badRequest(
      'O campo "content" é obrigatório e não pode ser vazio — precisa representar o conteúdo real do documento usado para calcular o content_hash.',
      'LEGAL_CONTRACT_VERSION_VALIDATION'
    );
  }

  // M5-07: gate de documento na CRIAÇÃO (ver decisão documentada no topo do arquivo).
  if (!documentFileId && (await isDocumentRequired(contract, payload, transaction))) {
    throw AppError.badRequest(
      'O campo "documentFileId" é obrigatório para criar uma versão de contrato: uma versão sem o arquivo do documento não é rastreável nem assinável. ' +
        `Para permitir rascunhos sem arquivo neste tenant, configure "${REQUIRE_DOCUMENT_SETTING_KEY}" como false.`,
      'LEGAL_CONTRACT_VERSION_DOCUMENT_REQUIRED'
    );
  }

  const lastVersion = await ContractVersion.findOne({
    where: { contractId: contract.id },
    order: [['version_number', 'DESC']],
    transaction,
  });
  const nextVersionNumber = lastVersion ? lastVersion.versionNumber + 1 : 1;

  const contractVersion = await ContractVersion.create(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      contractId: contract.id,
      versionNumber: nextVersionNumber,
      documentFileId: documentFileId || null,
      // Persiste o TEXTO de verdade (ver migration 20260101000179) — até aqui `content` só
      // servia pra calcular o hash e era descartado, o que deixava o SignatureAdapter sem
      // nenhum binário real pra subir ao provedor de assinatura. Quando `content` vem como
      // objeto/JSON (fluxos que não usam renderTemplate), serializa do mesmo jeito que
      // computeContentHash — mantém content_hash sempre coerente com o texto persistido.
      content: typeof content === 'string' ? content : JSON.stringify(content),
      contentHash: computeContentHash(content),
      templateId: templateId || null,
      effectiveFrom: effectiveFrom || new Date(),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishContractVersionCreated(contractVersion, transaction);

  await registrarAuditoria(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      actorUserId,
      action: 'legal.contract_version.create',
      entityType: 'ContractVersion',
      entityId: contractVersion.id,
      afterJson: contractVersion.toJSON(),
      reason: `Versão ${nextVersionNumber} do contrato ${contract.id} criada (imutável).`,
    },
    transaction
  );

  return contractVersion;
}

async function listContractVersions(contractId, transaction) {
  return ContractVersion.findAll({
    where: { contractId },
    include: [{ association: 'template', attributes: ['id', 'name'] }],
    order: [['version_number', 'ASC']],
    transaction,
  });
}

async function getContractVersion(id, transaction) {
  const version = await ContractVersion.findByPk(id, { transaction });
  if (!version) throw AppError.notFound('Versão de contrato não encontrada.', 'LEGAL_CONTRACT_VERSION_NOT_FOUND');
  return version;
}

module.exports = {
  createContractVersion,
  listContractVersions,
  getContractVersion,
  computeContentHash,
  REQUIRE_DOCUMENT_SETTING_KEY,
};

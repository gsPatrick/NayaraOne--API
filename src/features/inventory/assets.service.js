'use strict';

const { Op } = require('sequelize');
const {
  Asset,
  AssetMovement,
  AuditLog,
  File,
  FileLink,
  FinancialEntry,
  InventoryLossCase,
  InventoryMaintenanceOrder,
  InventoryToolLoan,
} = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { createFinancialEntry } = require('../finance/financialEntries.service');
const { getOrCreateDefaultResultCenter } = require('../finance/resultCenters.service');
const { publishAssetTransferred, publishAssetDisposed } = require('./inventoryEvents.service');

// Status terminais: patrimônio que saiu da empresa (DISPOSED — venda/descarte/doação) ou foi
// formalmente declarado perdido (LOST, decideLossCase). Nenhuma operação de circulação
// (transferência, empréstimo, manutenção) pode reabrir um asset nesses estados.
const TERMINAL_ASSET_STATUSES = ['LOST', 'DISPOSED'];

// Caderno §9: "Venda/descarte exige processo e vínculo financeiro quando houver valor".
const DISPOSAL_TYPES = ['SALE', 'DISCARD', 'DONATION'];
const DISPOSAL_TYPE_LABELS = { SALE: 'Venda', DISCARD: 'Descarte', DONATION: 'Doação' };
// Prefixo reservado da idempotencyKey do AssetMovement/FinancialEntry gerados pela baixa — é o
// que identifica o movimento como DISPOSAL no histórico (asset_movements não tem coluna de tipo)
// e amarra o lançamento a receber ao patrimônio. transferAsset recusa chaves com esse prefixo.
const DISPOSAL_KEY_PREFIX = 'asset-disposal:';
// Mesmo padrão de insurance.service.js (SEGUROS-INDENIZACOES): receita (RECEIVABLE) exige
// resultCenterId (Centro Financeiro BLINDADO v1, §4) e a baixa não tem como o operador escolher
// a dimensão de resultado — usa um centro dedicado, criado sob demanda por empresa.
const DISPOSAL_RESULT_CENTER_CODE = 'PATRIMONIO-ALIENACAO';
const DISPOSAL_RESULT_CENTER_NAME = 'Alienação/venda de patrimônio';

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 56, 2026-10-06): createAsset/updateAsset
// não validavam acquisitionValue (TAB-0760: purchase_value numeric(18,2)) — aceitavam negativo
// sem nenhuma checagem, diferente do mesmo tipo de campo monetário em budgetLines/changeOrders.
function assertNonNegativeAcquisitionValue(value) {
  if (value == null) return;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw AppError.badRequest('"acquisitionValue" deve ser um número maior ou igual a zero.', 'ASSET_VALIDATION');
  }
}

// Caderno §9/Guia §9: patrimônio individualizável, asset_tag UNIQUE (EST-TS-04), QR só carrega
// identificador opaco (GET /assets/by-tag/:tag), toda transferência gera asset_movement.
// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 47, 2026-10-05): o contrato (TAB-0760)
// trata "asset_tag" (QR/etiqueta) como NOT NULL com UNIQUE(company_id, asset_tag) — mas era
// possível cadastrar patrimônio sem tag, e a checagem de duplicidade não era escopada por
// empresa (bloqueava reaproveitar a mesma tag física em empresas distintas do mesmo tenant).
async function createAsset(payload, actorUserId, transaction) {
  const { groupId, companyId, assetTag, name, inventoryItemId, currentLocationId, assignedToUserId, projectId, acquisitionValue, acquiredAt, warrantyUntil } = payload;

  if (!groupId || !companyId || !name) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "name" são obrigatórios.', 'ASSET_VALIDATION');
  }
  if (!assetTag) {
    throw AppError.badRequest('O campo "assetTag" é obrigatório (QR/etiqueta — TAB-0760).', 'ASSET_VALIDATION');
  }
  assertNonNegativeAcquisitionValue(acquisitionValue);

  const existing = await Asset.findOne({ where: { companyId, assetTag }, transaction });
  if (existing) throw AppError.badRequest(`"assetTag" "${assetTag}" já está em uso nesta empresa (EST-TS-04).`, 'ASSET_DUPLICATE_TAG');

  return Asset.create(
    {
      groupId,
      companyId,
      assetTag,
      name,
      inventoryItemId: inventoryItemId || null,
      currentLocationId: currentLocationId || null,
      assignedToUserId: assignedToUserId || null,
      projectId: projectId || null,
      acquisitionValue: acquisitionValue != null ? acquisitionValue : null,
      acquiredAt: acquiredAt || null,
      warrantyUntil: warrantyUntil || null,
      status: 'AVAILABLE',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
}

// BUG REAL CORRIGIDO (reauditoria RLS/multi-tenant, 2026-10-08): nenhuma função deste arquivo
// filtrava por groupId/companyId — qualquer tenant conseguia ler, transferir, editar ou listar
// o patrimônio de OUTRA empresa só adivinhando o UUID. Projeto não usa RLS real do Postgres —
// isolamento é 100% a cargo do filtro manual no where, que faltava aqui (mesmo padrão já
// corrigido em materialRequests.service.js/adjustmentRiskRules.service.js).
async function listAssets(groupId, companyId, transaction, { status } = {}) {
  const where = { groupId, companyId };
  if (status) where.status = status;
  return Asset.findAll({ where, order: [['name', 'ASC']], transaction });
}

async function getAssetByTag(assetTag, groupId, companyId, transaction) {
  const asset = await Asset.findOne({ where: { assetTag, groupId, companyId }, transaction });
  if (!asset) throw AppError.notFound('Patrimônio não encontrado para este QR Code.', 'ASSET_NOT_FOUND');
  return asset;
}

async function transferAsset(assetId, groupId, companyId, payload, actorUserId, transaction) {
  const { destinationLocationId, destinationCustodianUserId, idempotencyKey } = payload;
  if (!destinationLocationId && !destinationCustodianUserId) {
    throw AppError.badRequest('Informe "destinationLocationId" e/ou "destinationCustodianUserId".', 'ASSET_TRANSFER_VALIDATION');
  }
  if (idempotencyKey && String(idempotencyKey).startsWith(DISPOSAL_KEY_PREFIX)) {
    throw AppError.badRequest(`"idempotencyKey" não pode começar com "${DISPOSAL_KEY_PREFIX}" (prefixo reservado à baixa de patrimônio).`, 'ASSET_TRANSFER_VALIDATION');
  }

  if (idempotencyKey) {
    const existing = await AssetMovement.findOne({ where: { idempotencyKey, groupId, companyId }, transaction });
    if (existing) return existing;
  }

  // EST-TS-15: transferência concorrente usa lock otimista (lockVersion do Asset) — o save()
  // abaixo falha com erro de versão se outra transação já alterou o asset no meio do caminho.
  const asset = await Asset.findOne({ where: { id: assetId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!asset) throw AppError.notFound('Patrimônio não encontrado.', 'ASSET_NOT_FOUND');
  if (TERMINAL_ASSET_STATUSES.includes(asset.status)) {
    throw AppError.conflict(`Patrimônio com status ${asset.status} não pode ser transferido (já saiu de circulação).`, 'ASSET_NOT_IN_CIRCULATION');
  }
  // GAP REAL CORRIGIDO (auditoria Marco 7, 2026-10-08): transferAsset só bloqueava os status
  // terminais (LOST/DISPOSED) — uma ferramenta emprestada (LOANED, com InventoryToolLoan
  // OPEN/OVERDUE) podia ser "transferida" de local/custodiante por fora do fluxo de empréstimo,
  // deixando o InventoryToolLoan aberto apontando para um local/custodiante que não é mais o
  // currentLocationId/assignedToUserId real do asset. Mesmo padrão de guarda já usado por
  // disposeAsset/openMaintenanceOrder: bloqueia pelo status E pelo registro (defesa em
  // profundidade, caso o status esteja dessincronizado de um loan legado).
  const openLoan = await InventoryToolLoan.findOne({ where: { assetId, status: { [Op.in]: ['OPEN', 'OVERDUE'] } }, transaction });
  if (asset.status === 'LOANED' || openLoan) {
    throw AppError.conflict('Ferramenta emprestada não pode ser transferida — registre a devolução primeiro.', 'ASSET_TRANSFER_ASSET_LOANED');
  }

  const movement = await AssetMovement.create(
    {
      groupId: asset.groupId,
      companyId: asset.companyId,
      assetId: asset.id,
      sourceLocationId: asset.currentLocationId,
      destinationLocationId: destinationLocationId || asset.currentLocationId,
      sourceCustodianUserId: asset.assignedToUserId,
      destinationCustodianUserId: destinationCustodianUserId || asset.assignedToUserId,
      idempotencyKey: idempotencyKey || null,
      movedAt: new Date(),
      movedByUserId: actorUserId || null,
    },
    { transaction }
  );

  if (destinationLocationId) asset.currentLocationId = destinationLocationId;
  if (destinationCustodianUserId) asset.assignedToUserId = destinationCustodianUserId;
  asset.updatedBy = actorUserId || null;
  await asset.save({ transaction });

  await publishAssetTransferred(movement, transaction);

  await registrarAuditoria(
    { groupId: asset.groupId, companyId: asset.companyId, actorUserId, action: 'ASSET_TRANSFERRED', entityType: 'Asset', entityId: asset.id, reason: 'Transferência de patrimônio registrada.' },
    transaction
  );

  return movement;
}

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 50, 2026-10-05): o contrato (Caderno
// §9) lista explicitamente "Asset possui aquisição, valor, localização, custodiante, garantia,
// status e manutenção" — mas não existia NENHUMA forma de editar acquiredAt/warrantyUntil
// depois da criação (nem endpoint, nem função de service). Um patrimônio cadastrado sem essa
// informação (comum — a nota fiscal/garantia muitas vezes chega depois) nunca podia ser
// corrigido.
async function updateAsset(id, groupId, companyId, payload, actorUserId, transaction) {
  const { name, acquisitionValue, acquiredAt, warrantyUntil } = payload;
  const asset = await Asset.findOne({ where: { id, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!asset) throw AppError.notFound('Patrimônio não encontrado.', 'ASSET_NOT_FOUND');

  if (acquisitionValue !== undefined) assertNonNegativeAcquisitionValue(acquisitionValue);

  const beforeJson = asset.toJSON();
  if (name !== undefined) asset.name = name;
  if (acquisitionValue !== undefined) asset.acquisitionValue = acquisitionValue;
  if (acquiredAt !== undefined) asset.acquiredAt = acquiredAt;
  if (warrantyUntil !== undefined) asset.warrantyUntil = warrantyUntil;
  asset.updatedBy = actorUserId || null;
  await asset.save({ transaction });

  await registrarAuditoria(
    { groupId: asset.groupId, companyId: asset.companyId, actorUserId, action: 'ASSET_UPDATED', entityType: 'Asset', entityId: asset.id, beforeJson, afterJson: asset.toJSON(), reason: 'Patrimônio atualizado.' },
    transaction
  );

  return asset;
}

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 52, 2026-10-05): o contrato
// (inventory.asset_movements — "Transferências/localização") exige rastrear o histórico de
// movimentações do patrimônio, e toda transferência já gera um AssetMovement (transferAsset
// acima) — mas não existia NENHUMA forma de ler esse histórico de volta, nem endpoint nem tela.
async function listAssetMovements(assetId, groupId, companyId, transaction) {
  const movements = await AssetMovement.findAll({ where: { assetId, groupId, companyId }, order: [['moved_at', 'DESC']], transaction });
  // asset_movements não tem coluna de tipo — a baixa é identificada pelo prefixo reservado da
  // idempotencyKey (ver DISPOSAL_KEY_PREFIX), pra tela distinguir transferência de baixa.
  return movements.map((m) => ({
    ...m.toJSON(),
    movementType: m.idempotencyKey && m.idempotencyKey.startsWith(DISPOSAL_KEY_PREFIX) ? 'DISPOSAL' : 'TRANSFER',
  }));
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseDisposalValue(value) {
  if (value === undefined || value === null || value === '') return 0;
  const num = Number(value);
  // Number.isFinite barra NaN/Infinity (mesma classe de bug da rodada 58 em addCountItem).
  if (!Number.isFinite(num) || num < 0) {
    throw AppError.badRequest('"disposalValue" deve ser um número maior ou igual a zero.', 'ASSET_DISPOSAL_VALIDATION');
  }
  return Math.round(num * 100) / 100;
}

// GAP REAL CORRIGIDO (auditoria de conformidade contratual Marco 7, 2026-10-07): Caderno §9 —
// "Venda/descarte exige processo e vínculo financeiro quando houver valor" — não existia
// NENHUM fluxo de baixa de patrimônio (nem service, nem rota, nem tela). Um ativo vendido ou
// descartado continuava AVAILABLE pra sempre, sem receita registrada no Financeiro.
//
// Processo (tudo na mesma transação — se qualquer passo falhar, nada é gravado):
// 1. Alçada: exige inventory:approve (mesmo nível de ADJUSTMENT/LOSS/DISPOSAL de estoque).
// 2. Motivo obrigatório + pelo menos 1 evidência (nota de venda, laudo, termo de doação) —
//    mesmo mínimo do EST-TS-10 pra perdas. Evidências viram FileLink do AssetMovement da baixa.
// 3. Asset precisa estar fora de qualquer outro processo aberto: não pode estar emprestado
//    (devolva primeiro), com OS de manutenção OPEN (feche primeiro), com caso de perda OPEN
//    (decida primeiro), nem já baixado/perdido.
// 4. Valor > 0 gera FinancialEntry RECEIVABLE/CREDIT (vínculo financeiro) com centro de
//    resultado dedicado. SALE exige valor > 0; DONATION não pode ter valor (doação não gera
//    receita); DISCARD aceita valor opcional (ex.: venda de sucata).
// 5. AssetMovement documenta a saída (origem = local/custodiante atuais, destino = nenhum);
//    asset vai pra DISPOSED (terminal) e perde local/custodiante.
// 6. Auditoria (registro canônico da baixa: tipo, valor, motivo, evidências, lançamento) +
//    evento de domínio asset.disposed.
async function disposeAsset(assetId, groupId, companyId, payload, actor, transaction) {
  if (!actor?.canApprove) {
    throw AppError.forbidden('Baixa de patrimônio (venda/descarte/doação) exige a permissão inventory:approve.', 'ASSET_DISPOSAL_APPROVAL_REQUIRED');
  }
  const { disposalType, disposalValue, reason, evidenceFileIds, financialDueAt, counterpartyName } = payload || {};

  if (!DISPOSAL_TYPES.includes(disposalType)) {
    throw AppError.badRequest(`"disposalType" precisa ser um de: ${DISPOSAL_TYPES.join(', ')}.`, 'ASSET_DISPOSAL_VALIDATION');
  }
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!trimmedReason) {
    throw AppError.badRequest('"reason" (motivo da baixa) é obrigatório.', 'ASSET_DISPOSAL_REASON_REQUIRED');
  }
  if (!Array.isArray(evidenceFileIds) || evidenceFileIds.length === 0) {
    throw AppError.badRequest('Pelo menos um arquivo de evidência ("evidenceFileIds") é obrigatório para baixar um patrimônio.', 'ASSET_DISPOSAL_EVIDENCE_REQUIRED');
  }
  const uniqueEvidenceIds = [...new Set(evidenceFileIds.map(String))];
  if (uniqueEvidenceIds.some((id) => !UUID_REGEX.test(id))) {
    throw AppError.badRequest('"evidenceFileIds" contém um identificador de arquivo inválido.', 'ASSET_DISPOSAL_VALIDATION');
  }
  const value = parseDisposalValue(disposalValue);
  if (disposalType === 'SALE' && !(value > 0)) {
    throw AppError.badRequest('Venda de patrimônio exige "disposalValue" maior que zero (vínculo financeiro).', 'ASSET_DISPOSAL_VALUE_REQUIRED');
  }
  if (disposalType === 'DONATION' && value > 0) {
    throw AppError.badRequest('Doação não pode ter "disposalValue" — doação não gera receita. Use SALE para venda.', 'ASSET_DISPOSAL_VALIDATION');
  }

  const asset = await Asset.findOne({ where: { id: assetId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!asset) throw AppError.notFound('Patrimônio não encontrado.', 'ASSET_NOT_FOUND');
  if (asset.status === 'DISPOSED') {
    throw AppError.conflict('Este patrimônio já foi baixado (venda/descarte/doação).', 'ASSET_ALREADY_DISPOSED');
  }
  if (asset.status === 'LOST') {
    throw AppError.conflict('Patrimônio declarado perdido/extraviado não pode ser vendido/descartado.', 'ASSET_NOT_IN_CIRCULATION');
  }
  // Guardas no status E nos registros do processo (defesa em profundidade, mesmo padrão de
  // returnTool/openMaintenanceOrder): o status sozinho pode estar dessincronizado de um
  // empréstimo/OS legado.
  const openLoan = await InventoryToolLoan.findOne({ where: { assetId, status: { [Op.in]: ['OPEN', 'OVERDUE'] } }, transaction });
  if (asset.status === 'LOANED' || openLoan) {
    throw AppError.conflict('Ferramenta emprestada não pode ser baixada — registre a devolução primeiro.', 'ASSET_DISPOSAL_ASSET_LOANED');
  }
  const openOrder = await InventoryMaintenanceOrder.findOne({ where: { assetId, status: 'OPEN' }, transaction });
  if (asset.status === 'MAINTENANCE' || openOrder) {
    throw AppError.conflict('Patrimônio com ordem de manutenção aberta não pode ser baixado — feche a OS primeiro.', 'ASSET_DISPOSAL_MAINTENANCE_OPEN');
  }
  const openLossCase = await InventoryLossCase.findOne({ where: { assetId, status: 'OPEN' }, transaction });
  if (openLossCase) {
    throw AppError.conflict('Existe um caso de perda aberto para este patrimônio — decida-o antes de baixar.', 'ASSET_DISPOSAL_LOSS_CASE_OPEN');
  }

  const files = await File.findAll({ where: { id: uniqueEvidenceIds, companyId: asset.companyId }, attributes: ['id'], transaction });
  if (files.length !== uniqueEvidenceIds.length) {
    throw AppError.badRequest('Um ou mais arquivos de evidência não foram encontrados.', 'ASSET_DISPOSAL_EVIDENCE_NOT_FOUND');
  }

  const beforeJson = asset.toJSON();
  const disposedAt = new Date();
  const typeLabel = DISPOSAL_TYPE_LABELS[disposalType];
  const counterparty = typeof counterpartyName === 'string' && counterpartyName.trim() ? counterpartyName.trim() : null;

  let financialEntry = null;
  if (value > 0) {
    const resultCenter = await getOrCreateDefaultResultCenter(
      asset.groupId,
      asset.companyId,
      DISPOSAL_RESULT_CENTER_CODE,
      DISPOSAL_RESULT_CENTER_NAME,
      transaction
    );
    financialEntry = await createFinancialEntry(
      {
        groupId: asset.groupId,
        companyId: asset.companyId,
        entryType: 'CREDIT',
        nature: 'RECEIVABLE',
        amount: value,
        description: `${typeLabel} de patrimônio ${asset.assetTag || asset.id} — ${asset.name}${counterparty ? ` (${counterparty})` : ''}`,
        dueAt: financialDueAt || disposedAt,
        resultCenterId: resultCenter.id,
        idempotencyKey: `${DISPOSAL_KEY_PREFIX}${asset.id}`,
      },
      actor.userId || null,
      transaction
    );
  }

  const movement = await AssetMovement.create(
    {
      groupId: asset.groupId,
      companyId: asset.companyId,
      assetId: asset.id,
      sourceLocationId: asset.currentLocationId,
      destinationLocationId: null,
      sourceCustodianUserId: asset.assignedToUserId,
      destinationCustodianUserId: null,
      idempotencyKey: `${DISPOSAL_KEY_PREFIX}${asset.id}`,
      movedAt: disposedAt,
      movedByUserId: actor.userId || null,
    },
    { transaction }
  );

  for (const fileId of uniqueEvidenceIds) {
    await FileLink.create(
      {
        groupId: asset.groupId,
        companyId: asset.companyId,
        fileId,
        relatedEntityType: 'AssetMovement',
        relatedEntityId: movement.id,
        purpose: 'ASSET_DISPOSAL_EVIDENCE',
        createdBy: actor.userId || null,
        updatedBy: actor.userId || null,
      },
      { transaction }
    );
  }

  asset.status = 'DISPOSED';
  asset.currentLocationId = null;
  asset.assignedToUserId = null;
  asset.updatedBy = actor.userId || null;
  await asset.save({ transaction });

  const disposal = {
    disposalType,
    disposalValue: value,
    reason: trimmedReason,
    counterpartyName: counterparty,
    evidenceFileIds: uniqueEvidenceIds,
    financialEntryId: financialEntry ? financialEntry.id : null,
    movementId: movement.id,
    disposedAt: disposedAt.toISOString(),
    disposedByUserId: actor.userId || null,
  };

  await publishAssetDisposed(asset, disposal, transaction);

  await registrarAuditoria(
    {
      groupId: asset.groupId,
      companyId: asset.companyId,
      actorUserId: actor.userId || null,
      action: 'ASSET_DISPOSED',
      entityType: 'Asset',
      entityId: asset.id,
      beforeJson,
      afterJson: { ...asset.toJSON(), disposal },
      reason: `${typeLabel} de patrimônio registrada${value > 0 ? ` (R$ ${value.toFixed(2)}, lançamento a receber ${financialEntry.id})` : ''}: ${trimmedReason}`,
    },
    transaction
  );

  return { asset, movement, financialEntry, disposal };
}

// Leitura da baixa: o registro canônico (tipo/valor/motivo/evidências/lançamento) é a entrada
// de auditoria ASSET_DISPOSED (audit_log é append-only), complementada pelo lançamento atual.
async function getAssetDisposal(assetId, transaction) {
  const asset = await Asset.findByPk(assetId, { transaction });
  if (!asset) throw AppError.notFound('Patrimônio não encontrado.', 'ASSET_NOT_FOUND');
  if (asset.status !== 'DISPOSED') {
    throw AppError.notFound('Este patrimônio não foi baixado.', 'ASSET_NOT_DISPOSED');
  }
  const log = await AuditLog.findOne({
    where: { entityType: 'Asset', entityId: assetId, action: 'ASSET_DISPOSED' },
    order: [['occurred_at', 'DESC']],
    transaction,
  });
  const disposal = log?.afterJson?.disposal || null;
  if (!disposal) throw AppError.notFound('Registro da baixa não encontrado.', 'ASSET_DISPOSAL_NOT_FOUND');
  const financialEntry = disposal.financialEntryId
    ? await FinancialEntry.findByPk(disposal.financialEntryId, { attributes: ['id', 'amount', 'status', 'dueAt', 'nature', 'entryType', 'description'], transaction })
    : null;
  return { assetId, ...disposal, financialEntry };
}

module.exports = {
  TERMINAL_ASSET_STATUSES,
  DISPOSAL_TYPES,
  createAsset,
  listAssets,
  getAssetByTag,
  transferAsset,
  updateAsset,
  listAssetMovements,
  disposeAsset,
  getAssetDisposal,
};

'use strict';

const { InventoryLossCase, InventoryItem, Asset, AssetMovement, InventoryToolLoan, InventoryMaintenanceOrder, InventoryMovement, File, FinancialEntry, Person } = require('../../models');
const { Op } = require('sequelize');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { recordMovement } = require('./movements.service');
const { publishLossOpened } = require('./inventoryEvents.service');
const financialEntriesService = require('../finance/financialEntries.service');
const { getOrCreateDefaultResultCenter } = require('../finance/resultCenters.service');

// GAP CORRIGIDO (auditoria de conformidade Marco 7 contra o contrato bruto, §11): "loss_case
// registra item/asset, quantidade, responsável, contexto, fotos e estimativa de custo...
// Investigação e decisão humana determinam responsabilidade. Qualquer desconto financeiro segue
// regra/aprovação e Financeiro." Antes, decideLossCase registrava a decisão mas não tinha nenhum
// caminho para o desconto financeiro — um responsável identificado nunca virava cobrança.
//
// DESENHO (decisões de engenharia documentadas):
//   - Cobrar é uma decisão EXPLÍCITA e separada da aprovação (`chargeResponsible: true`): nem
//     toda perda aprovada gera cobrança ("ninguém teve culpa — baixa sem desconto" é desfecho
//     válido). Default = não cobrar (comportamento anterior preservado).
//   - Só existe cobrança de perda APROVADA: rejeitar o caso = perda não confirmada, não há o que
//     ressarcir (LOSS_CASE_CHARGE_REQUIRES_APPROVAL).
//   - A decisão humana pode atribuir/trocar o responsável (`responsiblePersonId`), gravado no
//     próprio caso; para cobrar ele é obrigatório e precisa ser uma pessoa real do cadastro
//     (people.persons) desta empresa.
//   - Valor = `chargeAmount` ajustado pelo aprovador, ou, se omitido, a `estimatedCost` do caso.
//   - "Segue regra/aprovação": exige a mesma alçada inventory:approve da decisão (o aprovador é
//     quem atribui responsabilidade); "e Financeiro": é um FinancialEntry REAL criado pelo service
//     do Financeiro (sem financeiro paralelo), nascendo PENDING — cobrança/desconto em folha/
//     baixa seguem o fluxo normal do Financeiro a partir daí.
//   - Natureza: o responsável passa a DEVER esse valor À EMPRESA — do ponto de vista da empresa é
//     um direito a receber: `nature: 'RECEIVABLE'`, `entryType: 'CREDIT'` (mesmo par usado no
//     crédito a recuperar do locatário em guaranteedRent.service.js). Não é PAYABLE: a empresa
//     não paga nada a ninguém por causa da cobrança (o custo da perda em si já está no movimento
//     LOSS do estoque/na baixa do patrimônio). RECEIVABLE exige centro de resultado — centro
//     dedicado `PATRIMONIO-PERDAS`, resolvido/criado lazy via getOrCreateDefaultResultCenter.
//   - Idempotência: `idempotencyKey = inventory.loss_case.charge:<lossCaseId>` (UNIQUE) — o
//     mesmo caso nunca gera dois lançamentos. Como `inventory.loss_cases` não tem coluna para o
//     id do lançamento (DDL indisponível para a credencial de runtime, mesma limitação
//     documentada em marginRules.service.js), o vínculo caso->lançamento É essa chave única:
//     listLossCases/decideLossCase devolvem `chargeFinancialEntry` resolvido por ela.
const LOSS_CHARGE_RESULT_CENTER_CODE = 'PATRIMONIO-PERDAS';
const LOSS_CHARGE_RESULT_CENTER_NAME = 'Patrimônio — ressarcimento de perdas';

function lossChargeIdempotencyKey(lossCaseId) {
  return `inventory.loss_case.charge:${lossCaseId}`;
}

function serializeChargeEntry(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    amount: entry.amount != null ? Number(entry.amount) : null,
    nature: entry.nature,
    entryType: entry.entryType,
    status: entry.status,
    dueAt: entry.dueAt || null,
    resultCenterId: entry.resultCenterId || null,
  };
}

function parseChargeFlag(raw) {
  if (raw === undefined || raw === null || raw === '') return false;
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  throw AppError.badRequest('"chargeResponsible" precisa ser booleano (true/false).', 'LOSS_CASE_VALIDATION');
}

// Guia do Marcelo §11/EST-010: perda/quebra/extravio não é baixa comum — abre loss_case com
// contexto+evidência; decisão humana (approve/reject) é quem efetivamente gera o movimento
// LOSS/DISPOSAL, nunca a criação do caso em si (EST-TS-10: loss sem evidência é bloqueado).
async function openLossCase(payload, actorUserId, transaction) {
  const { groupId, companyId, inventoryItemId, assetId, locationId, projectId, quantity, responsiblePersonId, context, evidenceFileIds, estimatedCost } = payload;

  if (!groupId || !companyId || !context) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "context" são obrigatórios.', 'LOSS_CASE_VALIDATION');
  }
  if (!inventoryItemId && !assetId) {
    throw AppError.badRequest('Informe "inventoryItemId" ou "assetId".', 'LOSS_CASE_VALIDATION');
  }
  // EST-TS-10: loss sem evidência é bloqueado quando o item for CONSUMABLE/TOOL de alto valor —
  // como o Caderno não fixa o limiar de valor em código (regra pertence ao Motor de Regras),
  // aplicamos aqui o mínimo seguro do próprio EST-TS-10: ao menos uma evidência é sempre exigida.
  // BUG REAL CORRIGIDO (auditoria Marco 7, EST-TS-10, 2026-10-07): `[null]`/ids inventados
  // passavam no `length > 0`, abrindo um caso de perda "com evidência" sem nenhum arquivo real
  // por trás. Exige que todo id seja uma string não vazia E que cada um aponte pra um File
  // de verdade, da mesma empresa (nunca de outro tenant).
  if (!Array.isArray(evidenceFileIds) || evidenceFileIds.length === 0 || evidenceFileIds.some((id) => !id || typeof id !== 'string')) {
    throw AppError.badRequest('Pelo menos um arquivo de evidência ("evidenceFileIds") é obrigatório (EST-TS-10).', 'LOSS_CASE_EVIDENCE_REQUIRED');
  }
  const uniqueEvidenceFileIds = [...new Set(evidenceFileIds)];
  const evidenceFiles = await File.findAll({ where: { id: { [Op.in]: uniqueEvidenceFileIds }, companyId }, transaction });
  if (evidenceFiles.length !== uniqueEvidenceFileIds.length) {
    throw AppError.badRequest('Um ou mais arquivos de evidência ("evidenceFileIds") não existem ou não pertencem a esta empresa.', 'LOSS_CASE_EVIDENCE_FILE_NOT_FOUND');
  }
  if (inventoryItemId && (quantity == null || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0)) {
    throw AppError.badRequest('"quantity" > 0 é obrigatório quando "inventoryItemId" é informado.', 'LOSS_CASE_VALIDATION');
  }
  // BUG REAL CORRIGIDO (auditoria E2E Marco 7, ciclo 4): locationId era opcional aqui, mas
  // decideLossCase exige sourceLocationId pra gerar o movimento LOSS — sem essa validação na
  // criação, um caso de perda de item de estoque sem local ficava permanentemente travado em
  // OPEN (a aprovação sempre falhava), sem nenhuma forma de corrigir o local depois de criado.
  if (inventoryItemId && !locationId) {
    throw AppError.badRequest('"locationId" é obrigatório quando "inventoryItemId" é informado (necessário para aprovar a baixa depois).', 'LOSS_CASE_VALIDATION');
  }

  // Patrimônio já baixado (venda/descarte/doação — disposeAsset) saiu da empresa: aprovar uma
  // perda sobre ele sobrescreveria DISPOSED com LOST, apagando a baixa formalizada. Lock no
  // asset serializa com disposeAsset (que trava o mesmo asset e recusa baixa com perda OPEN).
  if (assetId) {
    const asset = await Asset.findOne({ where: { id: assetId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!asset) throw AppError.notFound('Patrimônio não encontrado.', 'ASSET_NOT_FOUND');
    if (asset.status === 'DISPOSED') {
      throw AppError.conflict('Patrimônio já baixado (venda/descarte/doação) não pode ter caso de perda aberto.', 'LOSS_CASE_ASSET_DISPOSED');
    }
    // GAP REAL CORRIGIDO (auditoria Marco 7, 2026-10-08): mesmo padrão de disposeAsset — um
    // patrimônio com OS de manutenção OPEN está em processo de reparo em andamento; abrir um
    // caso de perda sobre ele agora (e aprová-lo depois) sobrescreveria o asset pra LOST sem
    // nunca encerrar a OS, deixando-a "esquecida" aberta sobre um ativo que já saiu de
    // circulação por perda.
    const openOrder = await InventoryMaintenanceOrder.findOne({ where: { assetId, status: 'OPEN' }, transaction });
    if (openOrder) {
      throw AppError.conflict('Patrimônio com ordem de manutenção aberta não pode ter caso de perda aberto — feche a OS primeiro.', 'LOSS_CASE_MAINTENANCE_OPEN');
    }
  }

  const lossCase = await InventoryLossCase.create(
    {
      groupId,
      companyId,
      inventoryItemId: inventoryItemId || null,
      assetId: assetId || null,
      locationId: locationId || null,
      projectId: projectId || null,
      quantity: inventoryItemId ? quantity : null,
      responsiblePersonId: responsiblePersonId || null,
      context,
      evidenceFileIds,
      estimatedCost: estimatedCost != null ? estimatedCost : null,
      status: 'OPEN',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishLossOpened(lossCase, transaction);

  await registrarAuditoria(
    { groupId, companyId, actorUserId, action: 'INVENTORY_LOSS_CASE_OPENED', entityType: 'InventoryLossCase', entityId: lossCase.id, reason: 'Caso de perda/quebra/extravio aberto.' },
    transaction
  );

  return lossCase;
}

async function attachChargeEntries(lossCases, transaction) {
  if (lossCases.length === 0) return lossCases;
  const keys = lossCases.map((lc) => lossChargeIdempotencyKey(lc.id));
  const entries = await FinancialEntry.findAll({ where: { idempotencyKey: keys }, transaction });
  const byKey = new Map(entries.map((e) => [e.idempotencyKey, e]));
  for (const lc of lossCases) {
    lc.setDataValue('chargeFinancialEntry', serializeChargeEntry(byKey.get(lossChargeIdempotencyKey(lc.id))));
  }
  return lossCases;
}

async function listLossCases(groupId, companyId, transaction, { status } = {}) {
  const where = { groupId, companyId };
  if (status) where.status = status;
  const lossCases = await InventoryLossCase.findAll({ where, order: [['created_at', 'DESC']], transaction });
  return attachChargeEntries(lossCases, transaction);
}

/**
 * createLossChargeFinancialEntry — chama o service REAL do Financeiro; idempotente pela chave
 * única derivada do id do caso (reprocessar a mesma decisão devolve o lançamento já existente).
 */
async function createLossChargeFinancialEntry(lossCase, person, amount, dueAt, actorUserId, transaction) {
  const idempotencyKey = lossChargeIdempotencyKey(lossCase.id);
  const existing = await FinancialEntry.findOne({ where: { idempotencyKey }, transaction });
  if (existing) return existing;

  const resultCenter = await getOrCreateDefaultResultCenter(
    lossCase.groupId,
    lossCase.companyId,
    LOSS_CHARGE_RESULT_CENTER_CODE,
    LOSS_CHARGE_RESULT_CENTER_NAME,
    transaction
  );
  const description = `Ressarcimento de perda/quebra/extravio — caso ${lossCase.id} — responsável: ${person.legalName || person.id}`.slice(0, 255);
  return financialEntriesService.createFinancialEntry(
    {
      groupId: lossCase.groupId,
      companyId: lossCase.companyId,
      entryType: 'CREDIT',
      nature: 'RECEIVABLE',
      amount,
      description,
      dueAt: dueAt || null,
      idempotencyKey,
      constructionProjectId: lossCase.projectId || null,
      resultCenterId: resultCenter.id,
    },
    actorUserId,
    transaction
  );
}

/**
 * decideLossCase(lossCaseId, decision, actor, transaction, options)
 * `options` (todos opcionais — omitidos = comportamento anterior, sem cobrança):
 *   - chargeResponsible: boolean — cobrar o responsável (só com decision APPROVED);
 *   - responsiblePersonId: UUID de people.persons — atribui/troca o responsável na decisão;
 *   - chargeAmount: número > 0 — valor cobrado; default = estimatedCost do caso;
 *   - chargeDueAt: data de vencimento do lançamento a receber (opcional).
 */
async function decideLossCase(lossCaseId, groupId, companyId, decision, actor, transaction, options = {}) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    throw AppError.badRequest('"decision" precisa ser "APPROVED" ou "REJECTED".', 'LOSS_CASE_VALIDATION');
  }
  if (!actor.canApprove) {
    throw AppError.forbidden('Decidir um caso de perda exige a permissão inventory:approve.', 'LOSS_CASE_APPROVAL_REQUIRED');
  }
  const chargeResponsible = parseChargeFlag(options.chargeResponsible);
  if (chargeResponsible && decision !== 'APPROVED') {
    throw AppError.badRequest('Só é possível cobrar o responsável de uma perda APROVADA — caso rejeitado não tem perda confirmada a ressarcir.', 'LOSS_CASE_CHARGE_REQUIRES_APPROVAL');
  }

  const lossCase = await InventoryLossCase.findOne({ where: { id: lossCaseId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!lossCase) throw AppError.notFound('Caso de perda não encontrado.', 'LOSS_CASE_NOT_FOUND');
  if (lossCase.status !== 'OPEN') {
    throw AppError.badRequest(`Só é possível decidir um caso em OPEN (atual: ${lossCase.status}).`, 'LOSS_CASE_INVALID_TRANSITION');
  }

  // "Investigação e decisão humana determinam responsabilidade" (§11): a decisão pode atribuir
  // ou corrigir o responsável registrado na abertura.
  const responsiblePersonId = options.responsiblePersonId || lossCase.responsiblePersonId || null;
  let responsiblePerson = null;
  // Só valida contra o cadastro quando a decisão cobra ou TROCA o responsável — aprovar sem
  // cobrança mantendo o responsável da abertura continua exatamente como antes.
  const responsibleChanged = Boolean(options.responsiblePersonId) && options.responsiblePersonId !== lossCase.responsiblePersonId;
  if (responsibleChanged || chargeResponsible) {
    if (!responsiblePersonId) {
      throw AppError.badRequest('Para cobrar o responsável, informe "responsiblePersonId" (ninguém foi responsabilizado neste caso).', 'LOSS_CASE_CHARGE_RESPONSIBLE_REQUIRED');
    }
    responsiblePerson = await Person.findByPk(responsiblePersonId, { transaction });
    if (!responsiblePerson || responsiblePerson.companyId !== lossCase.companyId) {
      throw AppError.badRequest('Responsável informado não encontrado no cadastro de pessoas desta empresa.', 'LOSS_CASE_RESPONSIBLE_NOT_FOUND');
    }
  }

  let chargeAmount = null;
  if (chargeResponsible) {
    const rawAmount = options.chargeAmount !== undefined && options.chargeAmount !== null && options.chargeAmount !== ''
      ? options.chargeAmount
      : lossCase.estimatedCost;
    if (rawAmount === undefined || rawAmount === null) {
      throw AppError.badRequest('Informe "chargeAmount" — o caso não tem estimativa de custo para usar como valor da cobrança.', 'LOSS_CASE_CHARGE_AMOUNT_REQUIRED');
    }
    chargeAmount = Number(rawAmount);
    if (!Number.isFinite(chargeAmount) || chargeAmount <= 0) {
      throw AppError.badRequest('"chargeAmount" precisa ser um número maior que zero.', 'LOSS_CASE_CHARGE_AMOUNT_INVALID');
    }
    chargeAmount = Math.round(chargeAmount * 100) / 100;
  }

  let movement = null;
  if (decision === 'APPROVED' && lossCase.inventoryItemId) {
    const item = await InventoryItem.findByPk(lossCase.inventoryItemId, { transaction });
    movement = await recordMovement(
      {
        groupId: lossCase.groupId,
        companyId: lossCase.companyId,
        inventoryItemId: lossCase.inventoryItemId,
        movementType: 'LOSS',
        quantity: lossCase.quantity,
        sourceLocationId: lossCase.locationId,
        projectId: lossCase.projectId,
        sourceType: 'LOSS_CASE',
        sourceId: lossCase.id,
        idempotencyKey: `loss-case:${lossCase.id}`,
        reason: `Perda aprovada — caso ${lossCase.id}.`,
        evidenceFileId: lossCase.evidenceFileIds[0],
        responsiblePersonId: item?.itemType === 'TOOL' || item?.itemType === 'ASSET' ? lossCase.responsiblePersonId : undefined,
      },
      actor,
      transaction
    );
    lossCase.resultingMovementId = movement.id;
  }

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 28, 2026-10-05): aprovar um loss_case
  // de Asset/ferramenta (assetId, em vez de inventoryItemId) nunca tocava o próprio Asset — o
  // mesmo cuidado já aplicado em toolLoans.service.js (R21/R22, status/custodiante/localização
  // sincronizados a cada transição) nunca foi estendido ao fluxo de perda. Resultado: um ativo
  // declarado perdido/quebrado e aprovado continuava AVAILABLE/LOANED, podia ser emprestado de
  // novo, e mantinha o custodiante antigo mesmo após a perda ser formalizada (EST-010).
  if (decision === 'APPROVED' && lossCase.assetId) {
    const asset = await Asset.findOne({ where: { id: lossCase.assetId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
    if (asset?.status === 'DISPOSED') {
      throw AppError.conflict('Patrimônio já baixado (venda/descarte/doação) — a perda não pode sobrescrever a baixa.', 'LOSS_CASE_ASSET_DISPOSED');
    }
    if (asset) {
      // GAP REAL CORRIGIDO (auditoria Marco 7, 2026-10-08): aprovar a perda de um Asset mudava
      // o status pra LOST, mas nunca gerava o AssetMovement correspondente — mesmo padrão que
      // disposeAsset SEMPRE usa pra documentar a saída de circulação. Sem este movimento, o
      // histórico de patrimônio (listAssetMovements) nunca mostrava a perda formalizada.
      const lossMovement = await AssetMovement.create(
        {
          groupId: asset.groupId,
          companyId: asset.companyId,
          assetId: asset.id,
          sourceLocationId: asset.currentLocationId,
          destinationLocationId: null,
          sourceCustodianUserId: asset.assignedToUserId,
          destinationCustodianUserId: null,
          idempotencyKey: `loss-case:${lossCase.id}`,
          movedAt: new Date(),
          movedByUserId: actor.userId || null,
        },
        { transaction }
      );
      void lossMovement;

      asset.status = 'LOST';
      asset.assignedToUserId = null;
      asset.updatedBy = actor.userId || null;
      await asset.save({ transaction });
    }

    // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 30, 2026-10-05): aprovar a perda
    // de um Asset que ainda tinha um InventoryToolLoan OPEN/OVERDUE deixava esse empréstimo
    // "esquecido" — qualquer returnTool posterior sobre ele reescrevia asset.status de volta
    // pra AVAILABLE/MAINTENANCE, revertendo a perda formalizada sem controle nenhum (mesma
    // classe de bug da R29, aqui no caminho returnTool em vez de openMaintenanceOrder). Fecha
    // o(s) empréstimo(s) aberto(s) como LOST — status terminal, nunca mais aceito por returnTool.
    await InventoryToolLoan.update(
      { status: 'LOST', updatedBy: actor.userId || null },
      { where: { assetId: lossCase.assetId, status: { [Op.in]: ['OPEN', 'OVERDUE'] } }, transaction }
    );
  }

  let chargeEntry = null;
  if (chargeResponsible) {
    chargeEntry = await createLossChargeFinancialEntry(lossCase, responsiblePerson, chargeAmount, options.chargeDueAt, actor.userId, transaction);
  }

  if (responsiblePerson) lossCase.responsiblePersonId = responsiblePerson.id;
  lossCase.status = decision;
  lossCase.decidedByUserId = actor.userId || null;
  lossCase.decidedAt = new Date();
  lossCase.updatedBy = actor.userId || null;
  await lossCase.save({ transaction });

  await registrarAuditoria(
    {
      groupId: lossCase.groupId,
      companyId: lossCase.companyId,
      actorUserId: actor.userId,
      action: 'INVENTORY_LOSS_CASE_DECIDED',
      entityType: 'InventoryLossCase',
      entityId: lossCase.id,
      afterJson: {
        status: decision,
        responsiblePersonId: lossCase.responsiblePersonId,
        chargeResponsible,
        chargeAmount,
        chargeFinancialEntryId: chargeEntry ? chargeEntry.id : null,
      },
      reason: chargeEntry
        ? `Caso de perda decidido: ${decision}, com cobrança de ${chargeAmount} ao responsável (lançamento a receber ${chargeEntry.id}).`
        : `Caso de perda decidido: ${decision}, sem cobrança ao responsável.`,
    },
    transaction
  );

  lossCase.setDataValue('chargeFinancialEntry', serializeChargeEntry(chargeEntry));
  return lossCase;
}

module.exports = { openLossCase, listLossCases, decideLossCase, lossChargeIdempotencyKey, LOSS_CHARGE_RESULT_CENTER_CODE };

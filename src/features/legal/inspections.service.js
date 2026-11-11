'use strict';

const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { Inspection, InspectionItem, InspectionSignature, InspectionMedia, File, FileLink } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishInspectionCompleted, publishInspectionDifferenceDetected, publishCadernoEvent } = require('./legalEvents.service');
const { buildComparedItems } = require('./inspectionCompare');
const { resolveItemCodes, pairKey } = require('./inspectionItemCodes');
const { inspectionSnapshotHash } = require('./inspectionSnapshot');
const { getSetting } = require('../settings/settings.service');

// M45 (Caderno M5 §11 "Inspection possui type ENTRY/EXIT/INTERMEDIATE/FINAL"): FINAL entra como
// tipo próprio (vistoria final da entrega de casa nova); ENTRY/EXIT/INTERMEDIATE do Caderno são
// eram aceitos como sinônimos de CHECK_IN/CHECK_OUT/PERIODIC; desde o fechamento do M5 o livro é o código gravado.
// Fechamento M5: o banco e a API guardam/devolvem os códigos do livro; os antigos são só apelido de entrada
// (migration 20260101009991 migrou os dados e traduz gravadores legados).
const INSPECTION_TYPES = ['ENTRY', 'EXIT', 'INTERMEDIATE', 'FINAL'];
const INSPECTION_TYPE_ALIASES = { CHECK_IN: 'ENTRY', CHECK_OUT: 'EXIT', PERIODIC: 'INTERMEDIATE' };
function normalizeInspectionType(value) {
  if (!value) return value;
  const upper = String(value).toUpperCase();
  return INSPECTION_TYPE_ALIASES[upper] || upper;
}
const CONDITIONS = ['NEW', 'GOOD', 'REGULAR', 'DAMAGED'];
const MEDIA_TYPES = ['PHOTO', 'VIDEO'];
const PARTY_ROLES = ['LANDLORD', 'TENANT', 'INSPECTOR'];
// M5-21: de quem é a responsabilidade pelo dano encontrado na vistoria.
const RESPONSIBLE_PARTIES = ['TENANT', 'LANDLORD', 'SHARED', 'UNDETERMINED'];

// FIX AUD-013 (auditoria externa Nayara, 11/10/2026, JUR-007 "Vistoria assinada é imutável"):
// signInspection exigia a vistoria COMPLETED antes de assinar, mas nada impedia continuar
// anexando foto/vídeo (attachInspectionItemMedia) ou criando item novo (addInspectionItem)
// DEPOIS de já assinada — a auditora reproduziu isso ao vivo ("vistoria concluída ainda
// oferece Anexar foto/vídeo"). Qualquer assinatura registrada (mesmo de só uma das partes)
// trava o conteúdo: a parte já assinou em cima do que existia naquele momento.
async function assertInspectionNotSigned(inspectionId, transaction) {
  const anySignature = await InspectionSignature.findOne({ where: { inspectionId }, transaction });
  if (anySignature) {
    throw AppError.conflict(
      'Esta vistoria já tem assinatura registrada e ficou imutável — itens e mídia não podem mais ser alterados.',
      'LEGAL_INSPECTION_IMMUTABLE_AFTER_SIGNATURE'
    );
  }
}

async function createInspection(payload, actorUserId, transaction) {
  const { groupId, companyId, propertyId, contractId, inspectorUserId, scheduledAt } = payload;
  const inspectionType = normalizeInspectionType(payload.inspectionType);
  if (!groupId || !companyId || !propertyId || !inspectionType) {
    throw AppError.badRequest('Os campos "groupId", "companyId", "propertyId" e "inspectionType" são obrigatórios.', 'LEGAL_INSPECTION_VALIDATION');
  }
  if (!INSPECTION_TYPES.includes(inspectionType)) {
    throw AppError.badRequest(`"inspectionType" deve ser um de: ${INSPECTION_TYPES.join(', ')}.`, 'LEGAL_INSPECTION_VALIDATION');
  }

  const inspection = await Inspection.create(
    {
      groupId,
      companyId,
      propertyId,
      contractId: contractId || null,
      inspectorUserId: inspectorUserId || null,
      inspectionType,
      scheduledAt: scheduledAt || null,
      status: 'SCHEDULED',
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
      action: 'legal.inspection.create',
      entityType: 'Inspection',
      entityId: inspection.id,
      afterJson: inspection.toJSON(),
      reason: `Vistoria "${inspectionType}" agendada para o imóvel ${propertyId}.`,
    },
    transaction
  );

  return inspection;
}

/**
 * createInspectionWithItems — (Bug 4 reportado pela cliente: falta de atomicidade) cria a
 * vistoria E todos os seus itens dentro da MESMA transação recebida do controller. Antes, o
 * front chamava `POST /inspections` e depois, em loop, `POST /inspections/:id/items` — cada
 * chamada HTTP abre sua PRÓPRIA transação (`withTenantTransaction` por request), então um item
 * inválido no meio do loop (ex.: DAMAGED sem damageDescription) já tinha a vistoria e os itens
 * anteriores GRAVADOS de verdade, e só o item ruim falhava — vistoria parcial no banco,
 * exatamente o que a cliente reproduziu. Usando este endpoint único, todos os itens são
 * validados/criados antes de qualquer commit: se QUALQUER item for inválido, a exceção sobe,
 * `withTenantTransaction` faz ROLLBACK da transação inteira e NADA fica gravado — nem a
 * vistoria, nem nenhum item.
 */
async function createInspectionWithItems(payload, actorUserId, transaction) {
  const { items, ...inspectionPayload } = payload || {};
  const inspection = await createInspection(inspectionPayload, actorUserId, transaction);

  const createdItems = [];
  if (Array.isArray(items)) {
    for (const itemPayload of items) {
      const item = await addInspectionItem(inspection.id, itemPayload, actorUserId, transaction);
      createdItems.push(item);
    }
  }

  return { inspection, items: createdItems };
}

async function listInspections(transaction, filters = {}) {
  const where = {};
  if (filters.propertyId) where.propertyId = filters.propertyId;
  if (filters.contractId) where.contractId = filters.contractId;
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.inspectionType) where.inspectionType = normalizeInspectionType(filters.inspectionType);
  return Inspection.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getInspection(id, transaction) {
  const inspection = await Inspection.findByPk(id, { transaction });
  if (!inspection) throw AppError.notFound('Vistoria não encontrada.', 'LEGAL_INSPECTION_NOT_FOUND');
  return inspection;
}

// Frente 5 — versão (concorrência otimista): Inspection tem `lockVersion` (version do Sequelize:
// UPDATE ... WHERE lock_version = N). Além disso o cliente pode mandar a versão que ele VIU
// (`expectedLockVersion`); se a vistoria mudou desde então, 409 em vez de concluir por cima.
function assertInspectionVersion(inspection, expectedLockVersion) {
  if (expectedLockVersion === undefined || expectedLockVersion === null || expectedLockVersion === '') return;
  if (Number(expectedLockVersion) !== Number(inspection.lockVersion)) {
    throw AppError.conflict(
      `A vistoria foi alterada por outra pessoa (versão atual ${inspection.lockVersion}, sua versão ${expectedLockVersion}). Recarregue antes de continuar.`,
      'LEGAL_INSPECTION_VERSION_CONFLICT',
      { currentLockVersion: inspection.lockVersion }
    );
  }
}

async function completeInspection(id, actorUserId, transaction, options = {}) {
  const inspection = await getInspection(id, transaction);
  assertInspectionVersion(inspection, options.expectedLockVersion);
  if (inspection.status === 'COMPLETED') {
    throw AppError.conflict('Vistoria já está concluída.', 'LEGAL_INSPECTION_ALREADY_COMPLETED');
  }
  const beforeJson = inspection.toJSON();
  inspection.status = 'COMPLETED';
  inspection.completedAt = new Date();
  inspection.updatedBy = actorUserId || null;
  await inspection.save({ transaction });

  await publishInspectionCompleted(inspection, transaction);

  await registrarAuditoria(
    {
      groupId: inspection.groupId,
      companyId: inspection.companyId,
      actorUserId,
      action: 'legal.inspection.complete',
      entityType: 'Inspection',
      entityId: inspection.id,
      beforeJson,
      afterJson: inspection.toJSON(),
      reason: `Vistoria ${inspection.id} concluída.`,
    },
    transaction
  );

  return inspection;
}

async function addInspectionItem(inspectionId, payload, actorUserId, transaction) {
  const inspection = await getInspection(inspectionId, transaction);
  await assertInspectionNotSigned(inspectionId, transaction);
  const { itemName, condition, notes, damageDescription, estimatedBudget, responsibleParty, description } = payload;
  if (!itemName) {
    throw AppError.badRequest('O campo "itemName" é obrigatório.', 'LEGAL_INSPECTION_ITEM_VALIDATION');
  }
  if (condition !== undefined && condition !== null && !CONDITIONS.includes(condition)) {
    throw AppError.badRequest(`"condition" deve ser um de: ${CONDITIONS.join(', ')}.`, 'LEGAL_INSPECTION_ITEM_VALIDATION');
  }
  // FIX (reportado pela cliente 14/09/2026): item DAMAGED sem descrição do dano nem orçamento
  // não serve pra cobrança — exige os dois quando a condição é DAMAGED.
  if (condition === 'DAMAGED') {
    if (!damageDescription || !String(damageDescription).trim()) {
      throw AppError.badRequest('Item com condição "DAMAGED" precisa de "damageDescription".', 'LEGAL_INSPECTION_ITEM_VALIDATION');
    }
    // ADV (M5-32): `Number(estimatedBudget) < 0` deixava passar qualquer coisa NÃO numérica —
    // `Number('abc')`/`Number("100'; DROP TABLE ...")` é NaN, e NaN < 0 é false. O valor
    // chegava ao INSERT e só estourava (ou virava null) no banco. Agora o campo precisa ser um
    // número FINITO e não negativo, validado na aplicação.
    const budgetNumber = Number(estimatedBudget);
    if (
      estimatedBudget === undefined ||
      estimatedBudget === null ||
      estimatedBudget === '' ||
      !Number.isFinite(budgetNumber) ||
      budgetNumber < 0
    ) {
      throw AppError.badRequest(
        'Item com condição "DAMAGED" precisa de "estimatedBudget" numérico e >= 0.',
        'LEGAL_INSPECTION_ITEM_VALIDATION'
      );
    }
    // M5-21: sem responsável definido, o orçamento do dano não vira cobrança nem desconto de
    // caução — mesma regra (obrigatório quando DAMAGED) de damageDescription/estimatedBudget.
    // 'UNDETERMINED' é uma resposta legítima ("ainda em apuração"), mas precisa ser explícita.
    if (!RESPONSIBLE_PARTIES.includes(responsibleParty)) {
      throw AppError.badRequest(
        `Item com condição "DAMAGED" precisa de "responsibleParty" (um de: ${RESPONSIBLE_PARTIES.join(', ')}).`,
        'LEGAL_INSPECTION_ITEM_VALIDATION'
      );
    }
  } else if (responsibleParty !== undefined && responsibleParty !== null && !RESPONSIBLE_PARTIES.includes(responsibleParty)) {
    throw AppError.badRequest(
      `"responsibleParty" deve ser um de: ${RESPONSIBLE_PARTIES.join(', ')}.`,
      'LEGAL_INSPECTION_ITEM_VALIDATION'
    );
  }

  const defaultRoom = await getSetting('legal.inspection_default_room_code', { groupId: inspection.groupId, companyId: inspection.companyId }, transaction, 'GERAL');
  const codes = resolveItemCodes({ itemName, roomCode: payload.roomCode, itemCode: payload.itemCode }, defaultRoom || 'GERAL');
  const item = await InspectionItem.create(
    {
      groupId: inspection.groupId,
      companyId: inspection.companyId,
      inspectionId: inspection.id,
      itemName,
      roomCode: codes.roomCode,
      itemCode: codes.itemCode,
      description: description ? String(description) : (damageDescription || null),
      condition: condition || null,
      notes: notes || null,
      damageDescription: damageDescription || null,
      estimatedBudget: estimatedBudget !== undefined && estimatedBudget !== null ? estimatedBudget : null,
      responsibleParty: responsibleParty || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: inspection.groupId,
      companyId: inspection.companyId,
      actorUserId,
      action: 'legal.inspection_item.create',
      entityType: 'InspectionItem',
      entityId: item.id,
      afterJson: item.toJSON(),
      reason: `Item "${itemName}" registrado na vistoria ${inspection.id}.`,
    },
    transaction
  );

  return item;
}

async function listInspectionItems(inspectionId, transaction) {
  return InspectionItem.findAll({ where: { inspectionId }, transaction });
}

/**
 * compareInspections — compara os itens de uma vistoria de entrada com uma de saída,
 * retornando as divergências (itens cuja `condition` mudou).
 *
 * LIMITAÇÃO ASSUMIDA (decisão de engenharia, não resolvida por FK): a comparação casa itens
 * pelo campo textual `item_name` — não existe (nem foi pedido) um catálogo de itens
 * padronizado com FK entre InspectionItem de vistorias diferentes. Isso significa que, se o
 * `item_name` for digitado de forma inconsistente entre a vistoria de entrada e a de saída
 * (ex.: "Piso da sala" vs "Piso sala"), o item não será corretamente pareado. Itens presentes
 * em só uma das vistorias são reportados separadamente (added/removed) em vez de gerar falso
 * positivo de divergência de condição.
 */
async function compareInspections(entryInspectionId, exitInspectionId, transaction) {
  const entryInspection = await getInspection(entryInspectionId, transaction);
  const exitInspection = await getInspection(exitInspectionId, transaction);

  const entryItems = await listInspectionItems(entryInspectionId, transaction);
  const exitItems = await listInspectionItems(exitInspectionId, transaction);

  // Fechamento M5 (Guia §10): pareia por ambiente + código do item (roomCode/itemCode).
  const entryByName = new Map(entryItems.map((i) => [pairKey(i), i]));
  const exitByName = new Map(exitItems.map((i) => [pairKey(i), i]));

  const divergences = [];
  const onlyInEntry = [];
  const onlyInExit = [];

  // FIX (homologação 22/09/2026, achado real pela cliente): um item presente só na entrada
  // (ex.: sumiu/foi removido até a saída) ou só na saída (ex.: apareceu algo que não estava na
  // entrada) NUNCA entrava no array `divergences` — só ficava nos arrays auxiliares
  // `onlyInEntry`/`onlyInExit`, que qualquer consumidor que olhasse só `divergences.length`
  // (como o resumo "X divergências" da tela) ignorava completamente. Resultado real: entrada
  // com um item e saída sem esse mesmo item mostrava "0 divergências". Item ausente de um dos
  // lados É uma divergência — agora entra no array `divergences` também (com
  // `entryCondition`/`exitCondition` null do lado que falta), além de continuar detalhado nos
  // arrays auxiliares para quem precisar da categoria exata.
  for (const [name, entryItem] of entryByName.entries()) {
    const exitItem = exitByName.get(name);
    if (!exitItem) {
      onlyInEntry.push({ itemName: entryItem.itemName, roomCode: entryItem.roomCode, itemCode: entryItem.itemCode, entryCondition: entryItem.condition });
      divergences.push({ itemName: entryItem.itemName, roomCode: entryItem.roomCode, itemCode: entryItem.itemCode, entryCondition: entryItem.condition, exitCondition: null, reason: 'MISSING_IN_EXIT' });
      continue;
    }
    if (entryItem.condition !== exitItem.condition) {
      divergences.push({
        itemName: entryItem.itemName,
        roomCode: entryItem.roomCode,
        itemCode: entryItem.itemCode,
        entryCondition: entryItem.condition,
        exitCondition: exitItem.condition,
        reason: 'CONDITION_CHANGED',
      });
    }
  }
  for (const [name, exitItem] of exitByName.entries()) {
    if (!entryByName.has(name)) {
      onlyInExit.push({ itemName: exitItem.itemName, roomCode: exitItem.roomCode, itemCode: exitItem.itemCode, exitCondition: exitItem.condition });
      divergences.push({ itemName: exitItem.itemName, roomCode: exitItem.roomCode, itemCode: exitItem.itemCode, entryCondition: null, exitCondition: exitItem.condition, reason: 'MISSING_IN_ENTRY' });
    }
  }

  return {
    entryInspectionId: entryInspection.id,
    exitInspectionId: exitInspection.id,
    divergences,
    onlyInEntry,
    onlyInExit,
    // Fechamento M5 (Guia §10): before/after/changed/mediaRefs por item; validação humana explícita.
    items: await buildComparedItems(entryItems, exitItems, transaction),
    requiresHumanValidation: true,
  };
}

/**
 * attachInspectionItemMedia — anexa uma foto/vídeo (já enviado ao storage, ver ressalva sobre
 * File/documentFileId em contractVersions.service.js) a um item de vistoria, via o vínculo
 * polimórfico genérico "people"."file_links" (mesmo mecanismo já usado por outras entidades —
 * não foi necessário criar uma tabela nova).
 */
async function attachInspectionItemMedia(itemId, payload, actorUserId, transaction) {
  const item = await InspectionItem.findByPk(itemId, { transaction });
  if (!item) throw AppError.notFound('Item de vistoria não encontrado.', 'LEGAL_INSPECTION_ITEM_NOT_FOUND');
  await assertInspectionNotSigned(item.inspectionId, transaction);

  const { fileId, mediaType } = payload;
  if (!fileId) {
    throw AppError.badRequest('O campo "fileId" é obrigatório (arquivo precisa existir antes de vincular).', 'LEGAL_INSPECTION_MEDIA_VALIDATION');
  }
  const normalizedMediaType = mediaType ? String(mediaType).toUpperCase() : 'PHOTO';
  if (!MEDIA_TYPES.includes(normalizedMediaType)) {
    throw AppError.badRequest(`"mediaType" deve ser um de: ${MEDIA_TYPES.join(', ')}.`, 'LEGAL_INSPECTION_MEDIA_VALIDATION');
  }

  const file = await File.findByPk(fileId, { transaction });
  if (!file) throw AppError.notFound('Arquivo não encontrado.', 'LEGAL_INSPECTION_MEDIA_FILE_NOT_FOUND');
  if (!file.checksumSha256) {
    throw AppError.conflict('O arquivo não tem o hash SHA-256 do conteúdo e não pode virar mídia de vistoria.', 'LEGAL_INSPECTION_MEDIA_HASH_MISSING');
  }

  const link = await FileLink.create(
    {
      groupId: item.groupId,
      companyId: item.companyId,
      fileId,
      relatedEntityType: 'InspectionItem',
      relatedEntityId: item.id,
      purpose: normalizedMediaType,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  // Fechamento M5 (Caderno §4 legal.inspection_media, §11): a mídia do livro com hash, data/hora e vínculo ao item.
  const media = await InspectionMedia.create(
    {
      groupId: item.groupId,
      companyId: item.companyId,
      inspectionId: item.inspectionId,
      itemId: item.id,
      fileId,
      sha256: file.checksumSha256,
      capturedAt: new Date(),
      mediaType: normalizedMediaType,
      fileLinkId: link.id,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  link.setDataValue('inspectionMediaId', media.id);
  link.setDataValue('sha256', media.sha256);
  link.setDataValue('capturedAt', media.capturedAt);

  await registrarAuditoria(
    {
      groupId: item.groupId,
      companyId: item.companyId,
      actorUserId,
      action: 'legal.inspection_item.attach_media',
      entityType: 'InspectionItem',
      entityId: item.id,
      beforeJson: { itemName: item.itemName, fileId, vinculado: false },
      afterJson: { itemName: item.itemName, fileLinkId: link.id, fileId, mediaType: normalizedMediaType, vinculado: true },
      reason: `${normalizedMediaType === 'VIDEO' ? 'Vídeo' : 'Foto'} anexado ao item "${item.itemName}" da vistoria ${item.inspectionId}.`,
    },
    transaction
  );

  return link;
}

async function listInspectionItemMedia(itemId, transaction) {
  return FileLink.findAll({
    where: { relatedEntityType: 'InspectionItem', relatedEntityId: itemId },
    transaction,
  });
}

/**
 * signInspection — assinatura digital de uma parte (locador/locatário/vistoriador) sobre o
 * resultado da vistoria. `signaturePayload` é o conteúdo assinado (ex.: imagem base64 do
 * traço, ou um texto de consentimento explícito) — nunca gravado em texto puro, só o hash
 * SHA-256 dele, o mesmo padrão de integridade já usado em ContractVersion.contentHash.
 *
 * REGRA: só é possível assinar uma vistoria já COMPLETED (senão a assinatura estaria
 * confirmando um resultado que ainda pode mudar) — mesmo raciocínio do assertDocumentGate em
 * contracts.service.js.
 */
async function signInspection(inspectionId, payload, actorUserId, transaction) {
  const inspection = await getInspection(inspectionId, transaction);
  if (inspection.status !== 'COMPLETED') {
    throw AppError.conflict('A vistoria precisa estar concluída (COMPLETED) antes de ser assinada.', 'LEGAL_INSPECTION_NOT_COMPLETED');
  }

  const { partyRole, signaturePayload, signedByUserId } = payload;
  const normalizedRole = partyRole ? String(partyRole).toUpperCase() : null;
  if (!normalizedRole || !PARTY_ROLES.includes(normalizedRole)) {
    throw AppError.badRequest(`"partyRole" deve ser um de: ${PARTY_ROLES.join(', ')}.`, 'LEGAL_INSPECTION_SIGNATURE_VALIDATION');
  }
  if (!signaturePayload || !String(signaturePayload).trim()) {
    throw AppError.badRequest('O campo "signaturePayload" é obrigatório (não pode ser vazio).', 'LEGAL_INSPECTION_SIGNATURE_VALIDATION');
  }

  const existing = await InspectionSignature.findOne({
    where: { inspectionId: inspection.id, partyRole: normalizedRole },
    transaction,
  });
  if (existing) {
    throw AppError.conflict(`A parte "${normalizedRole}" já assinou esta vistoria.`, 'LEGAL_INSPECTION_ALREADY_SIGNED');
  }

  // Fechamento M5 (Guia §9): a assinatura congela a versão — o hash do JSON canônico do conteúdo entra na assinatura,
  // e todas as assinaturas da mesma vistoria precisam ter sido feitas sobre o MESMO conteúdo.
  const snapshotHash = await inspectionSnapshotHash(inspection, transaction);
  const previous = await InspectionSignature.findOne({ where: { inspectionId: inspection.id }, order: [['signed_at', 'ASC']], transaction });
  if (previous && previous.snapshotHash && previous.snapshotHash !== snapshotHash) {
    throw AppError.conflict('O conteúdo da vistoria mudou depois da primeira assinatura — a vistoria assinada não pode ser alterada.', 'LEGAL_INSPECTION_SNAPSHOT_CHANGED');
  }
  const signedAt = new Date();
  const signatureHash = crypto
    .createHash('sha256')
    .update(`${inspection.id}:${snapshotHash}:${normalizedRole}:${signedByUserId || actorUserId || 'anon'}:${signedAt.toISOString()}:${signaturePayload}`)
    .digest('hex');

  const signature = await InspectionSignature.create(
    {
      groupId: inspection.groupId,
      companyId: inspection.companyId,
      inspectionId: inspection.id,
      partyRole: normalizedRole,
      signedByUserId: signedByUserId || actorUserId || null,
      signatureHash,
      snapshotHash,
      signedAt,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: inspection.groupId,
      companyId: inspection.companyId,
      actorUserId,
      action: 'legal.inspection.sign',
      entityType: 'Inspection',
      entityId: inspection.id,
      beforeJson: { status: inspection.status, partyRole: normalizedRole, assinada: false },
      afterJson: { status: inspection.status, signatureId: signature.id, partyRole: normalizedRole, signatureHash, signedAt, assinada: true },
      reason: `Vistoria ${inspection.id} assinada digitalmente por ${normalizedRole}.`,
    },
    transaction
  );

  // M45 (Caderno M5 §18 "inspection.signed"): uma ocorrência por parte que assina.
  await publishCadernoEvent(
    'inspection.signed',
    'Inspection',
    inspection,
    { id: inspection.id, contractId: inspection.contractId, partyRole: normalizedRole, signatureHash, snapshotHash },
    normalizedRole,
    transaction
  );

  // GAP REAL (verificação final Marco 5, §11/§18): assinar uma vistoria de SAÍDA (EXIT)
  // com uma de ENTRADA (ENTRY) já registrada pro mesmo contrato é o gatilho natural pra
  // comparar entrada x saída e alertar diferença — compareInspections() já existia e calculava
  // certo, só nunca era chamado automaticamente nem publicava evento. idempotencyKey pelo par
  // entrada+saída evita duplicar o alerta se a vistoria for assinada por mais de uma parte.
  if (inspection.inspectionType === 'EXIT' && inspection.contractId) {
    const entryInspection = await Inspection.findOne({
      where: { contractId: inspection.contractId, inspectionType: 'ENTRY' },
      order: [['completedAt', 'DESC']],
      transaction,
    });
    if (entryInspection) {
      const comparison = await compareInspections(entryInspection.id, inspection.id, transaction);
      if (comparison.divergences.length > 0) {
        await publishInspectionDifferenceDetected(entryInspection, inspection, comparison.divergences, transaction);
      }
    }
  }

  return signature;
}

async function listInspectionSignatures(inspectionId, transaction) {
  return InspectionSignature.findAll({ where: { inspectionId }, order: [['signed_at', 'ASC']], transaction });
}

/**
 * generateInspectionReport — monta um PDF real (pdfkit, sem dependência externa/rede) com os
 * itens, danos, orçamento e assinaturas da vistoria, grava os bytes em
 * inspections.report_pdf_bytes e o SHA-256 desses bytes em report_hash — permite provar depois
 * que o relatório entregue é byte-a-byte o mesmo que foi gerado (imutabilidade), sem depender
 * de storage externo (ver ressalva sobre S3 em contractVersions.service.js).
 *
 * REGRA: só gera relatório de vistoria COMPLETED, e o relatório em si é imutável — gerar de
 * novo SUBSTITUI o anterior (não existe "correção" de PDF já emitido; se precisar corrigir um
 * dado, corrige o item e gera um novo relatório, que fica com hash diferente e data diferente
 * — o relatório velho não desaparece do histórico de auditoria, só deixa de ser o vigente).
 */
async function generateInspectionReport(inspectionId, actorUserId, transaction) {
  const inspection = await getInspection(inspectionId, transaction);
  if (inspection.status !== 'COMPLETED') {
    throw AppError.conflict('A vistoria precisa estar concluída (COMPLETED) antes de gerar o relatório.', 'LEGAL_INSPECTION_NOT_COMPLETED');
  }

  const items = await listInspectionItems(inspectionId, transaction);
  const signatures = await listInspectionSignatures(inspectionId, transaction);

  const pdfBytes = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).text('Relatório de Vistoria — Nayara One', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Vistoria: ${inspection.id}`);
    doc.text(`Tipo: ${inspection.inspectionType}`);
    doc.text(`Imóvel: ${inspection.propertyId}`);
    if (inspection.contractId) doc.text(`Contrato: ${inspection.contractId}`);
    doc.text(`Concluída em: ${inspection.completedAt ? inspection.completedAt.toISOString() : '-'}`);
    doc.text(`Gerado em: ${new Date().toISOString()}`);
    doc.moveDown();

    doc.fontSize(13).text('Itens vistoriados', { underline: true });
    doc.moveDown(0.5);
    let totalBudget = 0;
    items.forEach((item) => {
      doc.fontSize(10).text(`• ${item.itemName} — condição: ${item.condition || 'não informada'}`);
      if (item.notes) doc.fontSize(9).text(`  Obs.: ${item.notes}`);
      if (item.damageDescription) doc.fontSize(9).text(`  Dano: ${item.damageDescription}`);
      if (item.estimatedBudget !== null && item.estimatedBudget !== undefined) {
        const budgetValue = Number(item.estimatedBudget);
        totalBudget += budgetValue;
        doc.fontSize(9).text(`  Orçamento estimado: R$ ${budgetValue.toFixed(2)}`);
      }
      doc.moveDown(0.3);
    });

    doc.moveDown(0.5);
    doc.fontSize(11).text(`Orçamento total estimado de danos: R$ ${totalBudget.toFixed(2)}`, { bold: true });
    doc.moveDown();

    doc.fontSize(13).text('Assinaturas', { underline: true });
    doc.moveDown(0.5);
    if (signatures.length === 0) {
      doc.fontSize(10).text('Nenhuma assinatura registrada até o momento da geração deste relatório.');
    } else {
      signatures.forEach((sig) => {
        doc.fontSize(10).text(`• ${sig.partyRole} — assinado em ${sig.signedAt.toISOString()} — hash: ${sig.signatureHash}`);
      });
    }

    doc.end();
  });

  const reportHash = crypto.createHash('sha256').update(pdfBytes).digest('hex');
  const beforeJson = { reportHash: inspection.reportHash, reportGeneratedAt: inspection.reportGeneratedAt };

  inspection.reportPdfBytes = pdfBytes;
  inspection.reportHash = reportHash;
  inspection.reportGeneratedAt = new Date();
  inspection.updatedBy = actorUserId || null;
  await inspection.save({ transaction });

  await registrarAuditoria(
    {
      groupId: inspection.groupId,
      companyId: inspection.companyId,
      actorUserId,
      action: 'legal.inspection.generate_report',
      entityType: 'Inspection',
      entityId: inspection.id,
      beforeJson,
      afterJson: { reportHash, reportGeneratedAt: inspection.reportGeneratedAt, sizeBytes: pdfBytes.length },
      reason: `Relatório de vistoria ${inspection.id} gerado (${pdfBytes.length} bytes, hash ${reportHash}).`,
    },
    transaction
  );

  return { reportHash, reportGeneratedAt: inspection.reportGeneratedAt, sizeBytes: pdfBytes.length };
}

/**
 * getInspectionReport — retorna os bytes do PDF já gerado + o hash, para o chamador (controller)
 * servir como download e/ou o cliente comparar o hash recebido com o hash gravado no banco
 * (prova de integridade — o PDF não pode ter sido adulterado depois de gerado).
 */
async function getInspectionReport(inspectionId, transaction) {
  const inspection = await getInspection(inspectionId, transaction);
  if (!inspection.reportPdfBytes) {
    throw AppError.notFound('Relatório ainda não foi gerado para esta vistoria.', 'LEGAL_INSPECTION_REPORT_NOT_FOUND');
  }
  // Confere a cada leitura que os bytes gravados batem com o hash gravado — se algum dia
  // alguém alterar report_pdf_bytes diretamente no banco por fora da aplicação, isso é
  // detectado aqui em vez de servir um PDF adulterado silenciosamente como se fosse íntegro.
  const actualHash = crypto.createHash('sha256').update(inspection.reportPdfBytes).digest('hex');
  if (actualHash !== inspection.reportHash) {
    throw AppError.conflict(
      'Integridade do relatório comprometida: o hash gravado não bate com os bytes armazenados.',
      'LEGAL_INSPECTION_REPORT_INTEGRITY_MISMATCH'
    );
  }
  return { pdfBytes: inspection.reportPdfBytes, reportHash: inspection.reportHash, reportGeneratedAt: inspection.reportGeneratedAt };
}

/**
 * M45 (Caderno M5 §11 "Correção após assinatura cria addendum/revision, não altera laudo
 * original"; JUR-TS-006 "Vistoria editada após assinatura -> Nova revisão, original intacto").
 * A vistoria assinada continua imutável (JUR-007); a correção nasce como OUTRA vistoria, do
 * mesmo tipo/imóvel/contrato, com os itens copiados, apontando para a original e com motivo.
 * Só existe revisão de vistoria já assinada — antes da assinatura corrige-se a própria vistoria.
 */
async function createInspectionRevision(inspectionId, payload, actorUserId, transaction) {
  const original = await getInspection(inspectionId, transaction);
  const reason = payload && payload.reason ? String(payload.reason).trim() : '';
  if (!reason) {
    throw AppError.badRequest('Informe o motivo ("reason") da revisão da vistoria.', 'LEGAL_INSPECTION_REVISION_REASON_REQUIRED');
  }
  const anySignature = await InspectionSignature.findOne({ where: { inspectionId: original.id }, transaction });
  if (!anySignature) {
    throw AppError.conflict(
      'A vistoria ainda não foi assinada — corrija a própria vistoria; revisão só existe para laudo assinado.',
      'LEGAL_INSPECTION_REVISION_NOT_SIGNED'
    );
  }
  const revision = await Inspection.create(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      propertyId: original.propertyId,
      contractId: original.contractId,
      inspectorUserId: original.inspectorUserId,
      inspectionType: original.inspectionType,
      scheduledAt: new Date(),
      revisionOfInspectionId: original.id,
      revisionReason: reason,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  const items = await InspectionItem.findAll({ where: { inspectionId: original.id }, order: [['created_at', 'ASC']], transaction });
  for (const item of items) {
    const copy = await InspectionItem.create(
      {
        groupId: item.groupId,
        companyId: item.companyId,
        itemName: item.itemName,
        roomCode: item.roomCode,
        itemCode: item.itemCode,
        description: item.description,
        condition: item.condition,
        notes: item.notes,
        damageDescription: item.damageDescription,
        estimatedBudget: item.estimatedBudget,
        responsibleParty: item.responsibleParty,
        inspectionId: revision.id,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
    // Fechamento M5: a revisão leva as mesmas mídias (mesmo arquivo e hash) para os itens copiados.
    const medias = await InspectionMedia.findAll({ where: { itemId: item.id }, transaction });
    for (const m of medias) {
      await InspectionMedia.create(
        { groupId: m.groupId, companyId: m.companyId, inspectionId: revision.id, itemId: copy.id, fileId: m.fileId, sha256: m.sha256, capturedAt: m.capturedAt, mediaType: m.mediaType, createdBy: actorUserId || null, updatedBy: actorUserId || null },
        { transaction }
      );
    }
  }
  await registrarAuditoria(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      actorUserId,
      action: 'legal.inspection.revision',
      entityType: 'Inspection',
      entityId: revision.id,
      beforeJson: { originalInspectionId: original.id, originalStatus: original.status, revisao: 'não existia' },
      afterJson: { revisionOfInspectionId: original.id, reason, copiedItems: items.length },
      reason: `Revisão da vistoria assinada ${original.id}: ${reason}`,
    },
    transaction
  );
  return revision;
}

module.exports = {
  createInspectionRevision,
  normalizeInspectionType,
  createInspection,
  createInspectionWithItems,
  listInspections,
  getInspection,
  completeInspection,
  addInspectionItem,
  listInspectionItems,
  compareInspections,
  attachInspectionItemMedia,
  listInspectionItemMedia,
  signInspection,
  listInspectionSignatures,
  generateInspectionReport,
  getInspectionReport,
  INSPECTION_TYPES,
  CONDITIONS,
  MEDIA_TYPES,
  PARTY_ROLES,
  RESPONSIBLE_PARTIES,
};

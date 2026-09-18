'use strict';

const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { Inspection, InspectionItem, InspectionSignature, File, FileLink } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishInspectionCompleted } = require('./legalEvents.service');

const INSPECTION_TYPES = ['CHECK_IN', 'CHECK_OUT', 'PERIODIC'];
const CONDITIONS = ['GOOD', 'REGULAR', 'DAMAGED'];
const MEDIA_TYPES = ['PHOTO', 'VIDEO'];
const PARTY_ROLES = ['LANDLORD', 'TENANT', 'INSPECTOR'];
// M5-21: de quem é a responsabilidade pelo dano encontrado na vistoria.
const RESPONSIBLE_PARTIES = ['TENANT', 'LANDLORD', 'SHARED', 'UNDETERMINED'];

async function createInspection(payload, actorUserId, transaction) {
  const { groupId, companyId, propertyId, contractId, inspectorUserId, inspectionType, scheduledAt } = payload;
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

async function listInspections(transaction, filters = {}) {
  const where = {};
  if (filters.propertyId) where.propertyId = filters.propertyId;
  if (filters.contractId) where.contractId = filters.contractId;
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.inspectionType) where.inspectionType = String(filters.inspectionType).toUpperCase();
  return Inspection.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getInspection(id, transaction) {
  const inspection = await Inspection.findByPk(id, { transaction });
  if (!inspection) throw AppError.notFound('Vistoria não encontrada.', 'LEGAL_INSPECTION_NOT_FOUND');
  return inspection;
}

async function completeInspection(id, actorUserId, transaction) {
  const inspection = await getInspection(id, transaction);
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
  const { itemName, condition, notes, damageDescription, estimatedBudget, responsibleParty } = payload;
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
    if (estimatedBudget === undefined || estimatedBudget === null || Number(estimatedBudget) < 0) {
      throw AppError.badRequest('Item com condição "DAMAGED" precisa de "estimatedBudget" (>= 0).', 'LEGAL_INSPECTION_ITEM_VALIDATION');
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

  const item = await InspectionItem.create(
    {
      groupId: inspection.groupId,
      companyId: inspection.companyId,
      inspectionId: inspection.id,
      itemName,
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

  const entryByName = new Map(entryItems.map((i) => [i.itemName, i]));
  const exitByName = new Map(exitItems.map((i) => [i.itemName, i]));

  const divergences = [];
  const onlyInEntry = [];
  const onlyInExit = [];

  for (const [name, entryItem] of entryByName.entries()) {
    const exitItem = exitByName.get(name);
    if (!exitItem) {
      onlyInEntry.push({ itemName: name, entryCondition: entryItem.condition });
      continue;
    }
    if (entryItem.condition !== exitItem.condition) {
      divergences.push({
        itemName: name,
        entryCondition: entryItem.condition,
        exitCondition: exitItem.condition,
      });
    }
  }
  for (const [name, exitItem] of exitByName.entries()) {
    if (!entryByName.has(name)) {
      onlyInExit.push({ itemName: name, exitCondition: exitItem.condition });
    }
  }

  return {
    entryInspectionId: entryInspection.id,
    exitInspectionId: exitInspection.id,
    divergences,
    onlyInEntry,
    onlyInExit,
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

  await registrarAuditoria(
    {
      groupId: item.groupId,
      companyId: item.companyId,
      actorUserId,
      action: 'legal.inspection_item.attach_media',
      entityType: 'InspectionItem',
      entityId: item.id,
      afterJson: { fileLinkId: link.id, fileId, mediaType: normalizedMediaType },
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

  const signedAt = new Date();
  const signatureHash = crypto
    .createHash('sha256')
    .update(`${inspection.id}:${normalizedRole}:${signedByUserId || actorUserId || 'anon'}:${signedAt.toISOString()}:${signaturePayload}`)
    .digest('hex');

  const signature = await InspectionSignature.create(
    {
      groupId: inspection.groupId,
      companyId: inspection.companyId,
      inspectionId: inspection.id,
      partyRole: normalizedRole,
      signedByUserId: signedByUserId || actorUserId || null,
      signatureHash,
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
      afterJson: { signatureId: signature.id, partyRole: normalizedRole, signatureHash },
      reason: `Vistoria ${inspection.id} assinada digitalmente por ${normalizedRole}.`,
    },
    transaction
  );

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

module.exports = {
  createInspection,
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

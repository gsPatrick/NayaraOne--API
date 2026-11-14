'use strict';

const crypto = require('crypto');
const { InspectionItem, InspectionMedia } = require('../../../models');

/**
 * Fechamento M5 (Guia §9 signInspection: snapshotHash = sha256(canonicalJson(inspection.snapshot))). O snapshot é o
 * conteúdo assinado: cabeçalho da vistoria, itens (ambiente, código, estado, descrição, observação, dano, orçamento,
 * responsabilidade) e mídias (arquivo + SHA-256), em ordem estável e com chaves ordenadas.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  return JSON.stringify(value === undefined ? null : value);
}

async function buildInspectionSnapshot(inspection, transaction) {
  const items = await InspectionItem.findAll({ where: { inspectionId: inspection.id }, transaction });
  const media = await InspectionMedia.findAll({ where: { inspectionId: inspection.id }, transaction });
  const mediaByItem = new Map();
  for (const m of media) {
    const list = mediaByItem.get(m.itemId) || [];
    list.push({ fileId: m.fileId, sha256: m.sha256, mediaType: m.mediaType });
    mediaByItem.set(m.itemId, list);
  }
  const sorted = [...items].sort((a, b) => `${a.roomCode}|${a.itemCode}|${a.id}`.localeCompare(`${b.roomCode}|${b.itemCode}|${b.id}`));
  return {
    id: inspection.id,
    inspectionType: inspection.inspectionType,
    propertyId: inspection.propertyId,
    contractId: inspection.contractId || null,
    completedAt: inspection.completedAt || null,
    items: sorted.map((i) => ({
      id: i.id,
      roomCode: i.roomCode || null,
      itemCode: i.itemCode || null,
      itemName: i.itemName,
      condition: i.condition || null,
      description: i.description || null,
      notes: i.notes || null,
      damageDescription: i.damageDescription || null,
      estimatedBudget: i.estimatedBudget === null || i.estimatedBudget === undefined ? null : Number(i.estimatedBudget).toFixed(2),
      responsibleParty: i.responsibleParty || null,
      media: (mediaByItem.get(i.id) || []).sort((a, b) => a.fileId.localeCompare(b.fileId)),
    })),
  };
}

async function inspectionSnapshotHash(inspection, transaction) {
  const snapshot = await buildInspectionSnapshot(inspection, transaction);
  return crypto.createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex');
}

module.exports = { canonicalJson, buildInspectionSnapshot, inspectionSnapshotHash };

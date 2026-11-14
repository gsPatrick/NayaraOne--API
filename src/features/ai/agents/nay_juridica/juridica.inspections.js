'use strict';

// Fechamento M5 (livro §11 "NAY pode comparar entrada x saída e sugerir diferenças; humano valida responsabilidade/cobrança"):
// leitura para a tool legal.compareInspections. Usa a comparação determinística do módulo jurídico (pares por ambiente + código
// do item) e devolve cada diferença como FONTE citável (vistoria, item, condição antes/depois, dano e orçamento), para a resposta da
// NAY só afirmar o que está nas vistorias. Só leitura, sob a RLS da transação do chamador.
const AppError = require('../../../../utils/AppError');
const { Inspection, InspectionItem } = require('../../../../models');
const { compareInspections } = require('../../../../modules/legal/inspections/inspection.service');

const REASON_LABEL = { CONDITION_CHANGED: 'condição mudou', MISSING_IN_EXIT: 'não consta na saída', MISSING_IN_ENTRY: 'não constava na entrada' };
const clip = (text, n = 300) => (text ? String(text).trim().slice(0, n) : null);

async function loadPair(entryId, exitId, transaction) {
  const [entry, exit] = await Promise.all([Inspection.findByPk(entryId, { transaction }), Inspection.findByPk(exitId, { transaction })]);
  if (!entry || !exit) throw AppError.notFound('Vistoria não encontrada.', 'LEGAL_INSPECTION_NOT_FOUND');
  if (entry.inspectionType !== 'ENTRY' || !['EXIT', 'FINAL'].includes(exit.inspectionType)) {
    throw AppError.badRequest('Compare uma vistoria de ENTRADA com uma de SAÍDA (ou final).', 'LEGAL_INSPECTION_COMPARE_TYPES');
  }
  if (entry.propertyId !== exit.propertyId) throw AppError.badRequest('As duas vistorias precisam ser do mesmo imóvel.', 'LEGAL_INSPECTION_COMPARE_PROPERTY');
  return { entry, exit };
}

async function inspectionDiff(entryId, exitId, transaction, now = new Date(), max = 50) {
  const { entry, exit } = await loadPair(entryId, exitId, transaction);
  const result = await compareInspections(entry.id, exit.id, transaction);
  const keyOf = (i) => `${i.roomCode || ''}|${i.itemCode || i.itemName}`;
  const [entryItems, exitItems] = await Promise.all([
    InspectionItem.findAll({ where: { inspectionId: entry.id }, transaction }),
    InspectionItem.findAll({ where: { inspectionId: exit.id }, transaction }),
  ]);
  const entryDetail = new Map(entryItems.map((i) => [keyOf(i), i]));
  const exitDetail = new Map(exitItems.map((i) => [keyOf(i), i]));
  const divergences = result.divergences.slice(0, max).map((d) => {
    const detail = exitDetail.get(keyOf(d));
    const item = detail || entryDetail.get(keyOf(d));
    return {
      itemId: item ? item.id : null, itemName: d.itemName, roomCode: d.roomCode || null, itemCode: d.itemCode || null, entryCondition: d.entryCondition, exitCondition: d.exitCondition, reason: d.reason,
      damageDescription: detail ? clip(detail.damageDescription) : null,
      estimatedBudget: detail && detail.estimatedBudget !== null && detail.estimatedBudget !== undefined ? Number(detail.estimatedBudget) : null,
    };
  });
  const groundingSources = divergences.map((d) => ({
    title: `Vistoria de entrada x saída — ${d.itemName}`,
    version: null,
    clause: [d.roomCode, d.itemCode].filter(Boolean).join('/') || d.itemName,
    excerpt: clip(`Entrada: ${d.entryCondition || 'sem registro'}; saída: ${d.exitCondition || 'sem registro'} (${REASON_LABEL[d.reason] || d.reason}).${d.damageDescription ? ` Dano: ${d.damageDescription}.` : ''}${d.estimatedBudget !== null ? ` Orçamento estimado: ${d.estimatedBudget.toFixed(2)}.` : ''}`),
    values: [d.entryCondition, d.exitCondition, d.estimatedBudget !== null ? d.estimatedBudget.toFixed(2) : null].filter((v) => v !== null && v !== undefined).map(String),
  }));
  return {
    entryInspectionId: entry.id, exitInspectionId: exit.id, divergences, totalDivergences: result.divergences.length,
    requiresHumanValidation: true, groundingSources, asOf: now.toISOString(),
  };
}

module.exports = { inspectionDiff };

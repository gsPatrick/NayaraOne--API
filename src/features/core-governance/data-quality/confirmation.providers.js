'use strict';

const { impactOf: mergeImpact } = require('./merge.impact');
const { impactOf: bulkImpact } = require('./bulk.service');
const { STATUS } = require('./merge.constants');

/**
 * Provedores de impacto das linhas 8 e 9 do inventário da M9-D852 (união de cadastros e alteração em massa). Reaproveitam as contas já
 * entregues e testadas na M9-D805 e na M9-D808; o guarda de confirmação (src/shared/destructive-actions) faz o resto.
 */
const REVIEW_NOTICE = 'Este item é uma revisão de qualidade, sem outro cadastro para unir; não há nada a mover.';
const shortCode = (id) => `CAD-${String(id).replace(/-/g, '').slice(0, 8).toUpperCase()}`;

/** Só a decisão MERGED pede confirmação (as demais decisões da fila passam direto). O sobrevivente vem de `survivorId` (query na simulação, corpo na decisão). */
async function mergeProvider({ id, tenant, transaction, preview, req }) {
  const decision = String((req.body && req.body.decision) || '').trim().toUpperCase();
  if (!preview && decision !== STATUS.MERGED) return { skip: true };
  const raw = preview ? req.query.survivorId : (req.body && req.body.survivorId);
  const survivorId = typeof raw === 'string' ? raw.toLowerCase() : null;
  const data = await mergeImpact({ companyId: tenant.companyId }, id, survivorId, transaction, { preview });
  if (data.review) return { code: '', label: 'Item de revisão', notice: REVIEW_NOTICE, impact: { counts: {}, totalAmountCents: 0, blockers: [], items: [] } };
  return { code: shortCode(data.absorbedId), label: 'Cadastro que será absorvido', impact: { counts: data.counts, totalAmountCents: data.totalAmountCents, blockers: data.blockers, items: [{ type: 'ABSORBED', id: data.absorbedId, label: shortCode(data.absorbedId) }] } };
}

/** Lote em massa: o código a digitar é a palavra EXECUTAR; o impacto é o plano do próprio lote (registros, mudanças e impedimentos). */
async function bulkProvider({ tenant, transaction, body }) {
  const data = await bulkImpact({ groupId: tenant.groupId, companyId: tenant.companyId }, body, transaction);
  return { code: 'EXECUTAR', label: 'Alteração em massa', impact: { counts: data.counts, totalAmountCents: data.totalAmountCents, blockers: data.blockers, items: [] } };
}

module.exports = { mergeProvider, bulkProvider };

'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { createContent } = require('../content.create');
const { DEFINITIONS } = require('./definitions');
const { loadTypeSource } = require('./source');
const { buildTriggeredText } = require('./texts');
const { reductionPercent, currentPriceOf } = require('./priceReduction');
const { readAutoDraftTypes, readPercentDecimals } = require('./types.settings');

/**
 * M9-D409 — rascunho nascido de gatilho (evento do outbox ou job). Regras: só RASCUNHO (nunca publicação); idempotente por
 * (empresa, tipo, fonte, evento) — a trava de aconselhamento serializa duas entregas do mesmo evento e o índice único é a
 * garantia final; o tipo precisa estar ligado no parâmetro `marketing.conteudo.tipos_rascunho_automatico`.
 * Devolve { created, itemId?, skipped? } sem nunca lançar por falta de elegibilidade (o evento não deve travar a fila do outbox).
 */
const skip = (reason) => ({ created: false, skipped: reason });

async function findExisting({ type, sourceId, triggerEventId }, tenant, transaction) {
  const [row] = await sequelize.query(
    `SELECT id FROM marketing.content_items WHERE company_id = :companyId AND type = :type AND source_entity_id = :sourceId
        AND trigger_event_id = :triggerEventId AND deleted_at IS NULL`,
    { replacements: { companyId: tenant.companyId, type, sourceId, triggerEventId }, transaction, type: QueryTypes.SELECT }
  );
  return row ? row.id : null;
}

/** Fatos e contexto do texto; devolve { skipped } quando a fonte não serve (aumento de preço, imóvel retirado). */
async function prepareDraft(type, sourceEntityType, sourceId, tenant, transaction) {
  const def = DEFINITIONS[type];
  let source;
  try {
    source = await loadTypeSource(def, { sourceEntityType, sourceEntityId: sourceId }, tenant, transaction);
  } catch (err) {
    if (err.code === 'MKT_SOURCE_NOT_FOUND') return { skipped: 'SOURCE_NOT_FOUND' };
    throw err;
  }
  if (!source) return { skipped: 'SOURCE_NOT_FOUND' };
  const ctx = {};
  if (type === 'PRICE_REDUCTION') {
    const result = reductionPercent(source.facts.precoAnterior, currentPriceOf(source.facts), await readPercentDecimals(tenant, transaction));
    if (!result.isReduction) return { skipped: 'NOT_A_REDUCTION' };
    ctx.percent = result.percent;
    ctx.currentPrice = currentPriceOf(source.facts);
  }
  return { source, ctx };
}

async function createTriggeredDraft({ type, sourceEntityType, sourceEntityId, triggerEventId, actor = null }, tenant, transaction) {
  if (!(await readAutoDraftTypes(tenant, transaction)).includes(type)) return skip('AUTO_DRAFT_DISABLED');
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', {
    replacements: { key: `mkt-trigger:${tenant.companyId}:${type}:${sourceEntityId}:${triggerEventId}` }, transaction,
  });
  const existing = await findExisting({ type, sourceId: sourceEntityId, triggerEventId }, tenant, transaction);
  if (existing) return { created: false, itemId: existing, skipped: 'ALREADY_EXISTS' };

  const prepared = await prepareDraft(type, sourceEntityType, sourceEntityId, tenant, transaction);
  if (prepared.skipped) return skip(prepared.skipped);
  const text = buildTriggeredText(type, prepared.source.facts, prepared.ctx);
  try {
    const out = await createContent({
      tenant, actor,
      input: { type, title: text.title, texto: text.texto, sourceEntityType, sourceEntityId, triggerEventId },
    }, transaction);
    return { created: true, itemId: out.itemId, versionId: out.versionId };
  } catch (err) {
    // Fonte sem os campos mínimos do tipo (sem foto autorizada, imóvel inativo, sem consentimento de pós-venda...): não há rascunho a gerar; o evento não trava a fila.
    if (err.code === 'MKT_CONTENT_REQUIRED_FIELD' || err.code === 'MKT_CONTENT_SOURCE_NOT_ELIGIBLE') return { ...skip(err.code), details: err.details };
    throw err;
  }
}

module.exports = { createTriggeredDraft };

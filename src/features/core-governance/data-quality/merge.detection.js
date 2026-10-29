'use strict';

const { getSetting } = require('../../settings/settings.service');
const settings = require('./merge.settings');
const repository = require('./merge.repository');
const { detectPersonPairs } = require('./merge.detect.person');
const { detectPropertyPairs } = require('./merge.detect.property');
const { detectSupplierPairs } = require('./merge.detect.supplier');

const DETECTORS = Object.freeze({ PERSON: detectPersonPairs, PROPERTY: detectPropertyPairs, SUPPLIER: detectSupplierPairs });

/** Parâmetros vigentes da empresa para a detecção. */
async function loadConfig(tenant, transaction) {
  const read = (key) => getSetting(key, tenant, transaction, settings.MERGE_SETTING_DEFAULTS[key]);
  const defaults = settings.parseScores(settings.DEFAULT_SCORES);
  return {
    minScore: Number(await read(settings.MIN_SCORE_KEY)),
    scores: { ...defaults, ...settings.parseScores(await read(settings.SCORES_KEY)) },
    nameDistance: Number(await read(settings.NAME_DISTANCE_KEY)),
    areaPct: Number(await read(settings.AREA_DIFF_KEY)),
  };
}

/** Quando várias regras casam o mesmo par, vale o MAIOR score. */
function bestPerPair(found) {
  const best = new Map();
  found.forEach((item) => {
    const key = `${item.primaryId}|${item.secondaryId}`;
    const current = best.get(key);
    if (!current || item.score > current.score) best.set(key, item);
  });
  return [...best.values()];
}

/**
 * Detecção de duplicidade (M9-D805 §3.2): compara só cadastros da própria empresa e põe na fila os pares com score >= score_minimo.
 * Nenhum score une sozinho. Par já na fila (aberto) ou decidido como separado/descartado não volta. Idempotente.
 */
async function runDetection(tenant, transaction, { entityTypes = Object.keys(DETECTORS) } = {}) {
  const config = await loadConfig(tenant, transaction);
  const summary = { detected: 0, inserted: 0, byEntity: {} };
  for (const entityType of entityTypes) {
    const candidates = bestPerPair(await DETECTORS[entityType](tenant, config, transaction)).filter((item) => item.score >= config.minScore);
    let inserted = 0;
    for (const item of candidates) {
      if (await repository.insertCandidate(tenant, { ...item, entityType }, transaction)) inserted += 1;
    }
    summary.detected += candidates.length;
    summary.inserted += inserted;
    summary.byEntity[entityType] = { detected: candidates.length, inserted };
  }
  return summary;
}

/** REVIEW (§3.2): cadastro com problema CRITICAL do score de qualidade (M9-D806) vai à fila do steward do domínio. */
async function openReviewItem(tenant, { entityType, entityId, reason, score = 100, evidence = null }, transaction) {
  return repository.insertReview(tenant, { entityType, entityId, reason, score, evidence }, transaction);
}

module.exports = { runDetection, openReviewItem, loadConfig, bestPerPair };

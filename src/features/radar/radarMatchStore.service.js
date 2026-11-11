'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize, RadarMatch } = require('../../models');
const { publishDomainEvent } = require('../../engines/events/outbox');
const { explainMatch } = require('./radarMatching.service');
const { criteriaFingerprint, SCORING_VERSION } = require('./radarCriteria');
const AppError = require('../../utils/AppError');

/**
 * Grava os matches do Radar (Marco 3 §13: "Match guarda score, critérios atendidos/falhos e rule/version"; Guia §9: "Salvar
 * radar_match com criteria_version/fingerprint para idempotência") e publica o evento do livro `crm.radar.match.created` só
 * quando o registro nasce. INSERT ... ON CONFLICT DO NOTHING na chave (radar, imóvel, fingerprint): reprocessar o mesmo radar
 * (job periódico ou gatilho da oferta) não duplica nada; critério mudou -> outro fingerprint -> novo registro e novo evento.
 * O evento `radar.matched` de sempre continua sendo publicado por radarEvents.service.js (marketing/BI dependem dele).
 */
const INSERT_SQL = `INSERT INTO crm.radar_matches
  (group_id, company_id, radar_id, property_id, score, matched_criteria, failed_criteria, explanation, criteria_fingerprint, criteria_version)
  VALUES (:groupId, :companyId, :radarId, :propertyId, :score, CAST(:matched AS jsonb), CAST(:failed AS jsonb), CAST(:explanation AS jsonb), :fingerprint, :version)
  ON CONFLICT (radar_id, property_id, criteria_fingerprint) DO NOTHING
  RETURNING id, created_at`;

async function recordRadarMatch(radar, property, transaction) {
  const explanation = (property.get && property.get('radarMatch')) || explainMatch(radar, property);
  if (!explanation.matched) return null;
  const entries = Object.entries(explanation.criteria);
  const fingerprint = criteriaFingerprint(radar.criteriaJson);
  const rows = await sequelize.query(INSERT_SQL, {
    replacements: {
      groupId: radar.groupId,
      companyId: radar.companyId,
      radarId: radar.id,
      propertyId: property.id,
      score: explanation.score,
      matched: JSON.stringify(entries.filter(([, e]) => e.matched).map(([k]) => k)),
      failed: JSON.stringify(entries.filter(([, e]) => !e.matched).map(([k, e]) => ({ criterion: k, category: e.category, reason: e.reason || null }))),
      explanation: JSON.stringify(explanation),
      fingerprint,
      version: SCORING_VERSION,
    },
    type: QueryTypes.SELECT,
    transaction,
  });
  if (!rows.length) return null;
  const id = rows[0].id;
  await publishDomainEvent(
    {
      groupId: radar.groupId,
      companyId: radar.companyId,
      aggregateType: 'RadarMatch',
      aggregateId: id,
      eventType: 'crm.radar.match.created',
      payload: { id, radarId: radar.id, personId: radar.personId, propertyId: property.id, score: explanation.score, criteriaFingerprint: fingerprint, criteriaVersion: SCORING_VERSION },
      idempotencyKey: `crm.radar.match.created:${id}`,
    },
    transaction
  );
  return { id, createdAt: rows[0].created_at, fingerprint };
}

/** Grava os matches de um radar (cada imóvel); devolve só os registros que nasceram agora. */
async function recordRadarMatches(radar, properties, transaction) {
  const created = [];
  for (const property of properties) {
    const rec = await recordRadarMatch(radar, property, transaction);
    if (rec) created.push(rec);
  }
  return created;
}

/** Histórico de matches gravados de um radar (RLS: só a empresa dona enxerga), mais recente primeiro. */
async function listStoredMatches(radarId, transaction) {
  if (!radarId) throw AppError.badRequest('Radar não informado.', 'RADAR_VALIDATION');
  return RadarMatch.findAll({ where: { radarId }, order: [['created_at', 'DESC']], transaction });
}

module.exports = { recordRadarMatch, recordRadarMatches, listStoredMatches };

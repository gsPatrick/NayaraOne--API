'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { getSetting } = require('../../settings/settings.service');
const { loadPublicSource } = require('./source.load');
const { publishability } = require('./eligibility');
const { buildPublicRow, contentHash } = require('./row.build');
const { publishPublicChanged, publishPublicUnpublish } = require('./readModel.events');
const { APPROX_RADIUS_KEY, APPROX_RADIUS_DEFAULT, APPROX_RADIUS_MIN } = require('./publicReadModel.settings');

const TABLE = '"real_estate"."public_property_read_model"';
const DATA_COLUMNS = [
  'public_code', 'title', 'description_public', 'purpose', 'type', 'price_public', 'condo_fee_public', 'iptu_public', 'area_total', 'area_built',
  'bedrooms', 'bathrooms', 'parking_spots', 'neighborhood', 'city', 'state', 'lat_lng_public', 'photos_public', 'video_public_url', 'features_public', 'published_at',
];
const JSON_COLUMNS = ['lat_lng_public', 'photos_public', 'features_public'];

const UPSERT_SQL = `
INSERT INTO ${TABLE} (group_id, company_id, property_id, ${DATA_COLUMNS.join(', ')}, content_hash)
VALUES (:groupId, :companyId, :propertyId, ${DATA_COLUMNS.map((c) => (JSON_COLUMNS.includes(c) ? `CAST(:${c} AS jsonb)` : `:${c}`)).join(', ')}, :hash)
ON CONFLICT (property_id) DO UPDATE SET ${DATA_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, content_hash = EXCLUDED.content_hash,
  read_model_version = ${TABLE}.read_model_version + 1, updated_at = now()
  WHERE ${TABLE}.content_hash IS DISTINCT FROM EXCLUDED.content_hash
RETURNING public_code, read_model_version, (xmax = 0) AS inserted`;

async function readRadius(tenant, transaction) {
  const configured = await getSetting(APPROX_RADIUS_KEY, tenant, transaction, APPROX_RADIUS_DEFAULT);
  return Number.isInteger(configured) && configured >= APPROX_RADIUS_MIN && configured <= APPROX_RADIUS_DEFAULT ? configured : APPROX_RADIUS_DEFAULT;
}

/** O imóvel não atende às condições: o registro sai e dispara `unpublish` (só se havia registro). */
async function removeFromReadModel(propertyId, ctx, reasons, transaction) {
  const [rows] = await sequelize.query(`DELETE FROM ${TABLE} WHERE property_id = :propertyId RETURNING public_code`, { replacements: { propertyId }, transaction });
  if (rows.length === 0) return { status: 'ABSENT', reasons };
  await publishPublicUnpublish({ groupId: ctx.groupId, companyId: ctx.companyId, propertyId, publicCode: rows[0].public_code, reasons }, transaction);
  return { status: 'REMOVED', reasons, publicCode: rows[0].public_code };
}

/**
 * syncPublicPropertyReadModel — recalcula o registro do imóvel no read model a partir das tabelas de origem (idempotente):
 * publicável -> grava (a versão só sobe quando o conteúdo público muda) e publica `property.public.changed`; não publicável ->
 * remove e publica `property.public.unpublish`. Roda dentro da transação do chamador, sob a RLS da empresa.
 * Devolve { status: UPSERTED | UNCHANGED | REMOVED | ABSENT, ... }.
 */
async function syncPublicPropertyReadModel(propertyId, tenant, transaction) {
  const source = await loadPublicSource(propertyId, transaction);
  const verdict = publishability(source);
  if (!verdict.ok) return removeFromReadModel(propertyId, tenant, verdict.reasons, transaction);

  const { property } = source;
  const row = buildPublicRow(source, { radiusM: await readRadius({ companyId: property.companyId }, transaction) });
  const hash = contentHash(row);
  const replacements = { groupId: property.groupId, companyId: property.companyId, propertyId, hash };
  DATA_COLUMNS.forEach((c) => { replacements[c] = JSON_COLUMNS.includes(c) ? JSON.stringify(row[c]) : row[c]; });
  const result = await sequelize.query(UPSERT_SQL, { replacements, transaction, type: QueryTypes.SELECT });
  if (result.length === 0) return { status: 'UNCHANGED', publicCode: row.public_code };
  const { read_model_version: version, inserted } = result[0];
  await publishPublicChanged({ property, publicCode: row.public_code, version, hash }, transaction);
  return { status: 'UPSERTED', publicCode: row.public_code, version, inserted: Boolean(inserted) };
}

module.exports = { syncPublicPropertyReadModel, TABLE, DATA_COLUMNS };

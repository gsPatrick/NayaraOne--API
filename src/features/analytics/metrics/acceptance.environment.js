'use strict';

/**
 * M9-D708 (3.5) — liberação da PRODUCAO: o parâmetro analytics.ambiente só vai a PRODUCAO se toda métrica PUBLICADA visível à empresa tiver aceite
 * ACCEPTED da VERSÃO ATUAL. Roda na transação do chamador (RLS da empresa). Falha: 409 ANALYTICS_ENV_NOT_READY com a lista do que falta.
 */
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');

/** Métricas publicadas visíveis (uma por código; a da empresa vence a do grupo e a global) com a versão atual e a decisão da empresa sobre essa versão. */
async function publishedWithAcceptance(companyId, transaction) {
  return sequelize.query(
    `SELECT DISTINCT ON (d.metric_code) d.metric_code AS code, v.version, a.status
       FROM analytics.metric_definitions d
       JOIN analytics.metric_versions v ON v.id = d.current_version_id
       LEFT JOIN analytics.metric_acceptance a ON a.company_id = :companyId AND a.metric_code = d.metric_code AND a.metric_version = v.version
      WHERE d.status = 'PUBLISHED'
      ORDER BY d.metric_code, (d.company_id IS NULL), (d.group_id IS NULL)`,
    { type: QueryTypes.SELECT, replacements: { companyId }, transaction }
  );
}

function describePending(row) {
  if (row.status === 'REJECTED') return `${row.code}: aceite rejeitado pelo responsável (versão ${row.version}).`;
  if (row.status === 'PENDING') return `${row.code}: reconciliado, aguardando o aceite do responsável (versão ${row.version}).`;
  return `${row.code}: sem reconciliação nem aceite do responsável (versão ${row.version}).`;
}

async function pendingAcceptances(companyId, transaction) {
  return (await publishedWithAcceptance(companyId, transaction)).filter((r) => r.status !== 'ACCEPTED').map(describePending);
}

async function assertReadyForProduction(tenant, transaction) {
  const pendentes = await pendingAcceptances(tenant.companyId, transaction);
  if (pendentes.length) {
    throw AppError.conflict('Há indicadores sem aceite do responsável.', 'ANALYTICS_ENV_NOT_READY', { total: pendentes.length, pendentes });
  }
}

module.exports = { publishedWithAcceptance, pendingAcceptances, assertReadyForProduction };

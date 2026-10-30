'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { expectedApprovedHash } = require('../../../integrations/social/social.content');
const { COLD_CONTENT_TYPES_KEY, readLeadNames } = require('../leadParams');
const { nameVariables } = require('./leadPorts');

const CANDIDATES = 5;
/** Status do item em que a versão aprovada continua valendo para ser enviada. */
const SENDABLE = Object.freeze(['APPROVED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED']);

/**
 * Conteúdo da nutrição do cliente frio (M9-D420 C): SÓ conteúdo já aprovado por uma pessoa (versão corrente com aprovação e hash aprovado igual ao recalculado agora), dos tipos de
 * `marketing.cliente_frio.tipos_conteudo` (padrão: blog educativo), o mais recentemente aprovado. Sem conteúdo aprovado, nada é inventado: as variáveis faltam e a mensagem não sai.
 */
async function approvedContent(tenant, transaction) {
  const types = await readLeadNames(COLD_CONTENT_TYPES_KEY, tenant, transaction);
  const rows = await sequelize.query(
    `SELECT i.title, v.body_json, v.content_hash, v.template_id, v.approved_hash
       FROM marketing.content_items i JOIN marketing.content_versions v ON v.id = i.current_version_id AND v.company_id = i.company_id
      WHERE i.company_id = :c AND i.deleted_at IS NULL AND i.type IN (:types) AND i.status IN (:sendable) AND v.approved_by IS NOT NULL AND v.approved_hash IS NOT NULL
      ORDER BY v.approved_at DESC NULLS LAST, i.created_at DESC LIMIT ${CANDIDATES}`,
    { replacements: { c: tenant.companyId, types, sendable: SENDABLE }, transaction, type: QueryTypes.SELECT }
  );
  for (const row of rows) {
    const body = row.body_json || {};
    const text = typeof body.renderizado === 'string' && body.renderizado.trim() ? body.renderizado : body.texto;
    if (typeof text === 'string' && text.trim() && row.approved_hash === await expectedApprovedHash(row, transaction)) return { title: row.title, text };
  }
  return null;
}

/** Variáveis da mensagem de nutrição: o nome e o conteúdo aprovado (`titulo`, `conteudo`). */
async function coldVariables(context) {
  const names = await nameVariables(context);
  const content = await approvedContent(context.tenant, context.transaction);
  return content ? { ...names, titulo: content.title, conteudo: content.text } : names;
}

module.exports = { coldVariables, approvedContent };

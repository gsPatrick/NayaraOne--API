'use strict';

const { sanitizePublicFields } = require('./sanitize');
const { readPublicFieldsConfig } = require('./publicFields.settings');
const { sequelize } = require('../../../models');
const { QueryTypes } = require('sequelize');

/**
 * M9-D403 — Segunda barreira (defesa em profundidade). Todo payload entregue a um adapter de canal (site, rede social, e-mail em
 * massa, portal) passa DE NOVO pelo sanitizePublicFields, mesmo que o conteúdo já tenha sido sanitizado na geração: o que o
 * adapter recebe nunca é o objeto original do chamador. Se a sanitização falhar, nada é entregue (fail-closed).
 */
async function deliverToAdapter(adapter, method, payload, { policy, tenant, transaction } = {}) {
  if (!adapter || typeof adapter[method] !== 'function') {
    throw new TypeError(`O adapter não implementa "${method}".`);
  }
  const config = await readPublicFieldsConfig(tenant, transaction);
  const report = sanitizePublicFields(payload, policy, config);
  const result = await adapter[method](report.payload);
  return { result, removedKeys: report.removedKeys, redactedPatterns: report.redactedPatterns };
}

/**
 * Registra no checks_json da versão do conteúdo o que a sanitização removeu e redigiu (removedKeys e redactedPatterns).
 * checks_json é o único campo da versão que continua gravável (M9-D400), então a imutabilidade do corpo não é afetada.
 */
async function recordSanitizationChecks(contentVersionId, report, tenant, transaction) {
  const rows = await sequelize.query(
    `UPDATE marketing.content_versions
        SET checks_json = checks_json || jsonb_build_object('sanitization', CAST(:report AS jsonb))
      WHERE id = :id AND company_id = :companyId
      RETURNING id`,
    {
      replacements: {
        id: contentVersionId,
        companyId: tenant.companyId,
        report: JSON.stringify({
          policy: report.policy,
          removedKeys: report.removedKeys,
          redactedPatterns: report.redactedPatterns,
          redactedCount: report.redactedCount || 0,
        }),
      },
      transaction,
      type: QueryTypes.SELECT,
    }
  );
  return rows.length === 1;
}

module.exports = { deliverToAdapter, recordSanitizationChecks };

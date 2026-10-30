'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../../models');
const { templateNotApproved, unknownTemplateVariable } = require('./message.errors');
const { previewSafe, previewSensitive } = require('../preview/preview.safe');

const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;

/** Template PUBLISHED do canal. Inexistente, não publicado ou de outro canal: 422 MKT_TEMPLATE_NOT_APPROVED. */
async function loadApprovedTemplate(templateId, channel, tenant, transaction) {
  const [row] = await sequelize.query(
    `SELECT id, code, channel, status, body, variables_json, official_template_ref FROM marketing.templates
      WHERE id = :id AND company_id = :companyId AND deleted_at IS NULL`,
    { replacements: { id: templateId, companyId: tenant.companyId }, type: QueryTypes.SELECT, transaction }
  );
  if (!row || row.status !== 'PUBLISHED' || (row.channel && row.channel !== channel)) throw templateNotApproved({ templateId, channel });
  return row;
}

/**
 * Preenche as {{variáveis}} do template só com as declaradas em variables_json (variável fora da lista: 422 MKT_TEMPLATE_UNKNOWN_VARIABLE; sem valor:
 * idem) e só com dado permitido: valor que casa algum dos 8 padrões sensíveis (CPF, dívida, saldo...) é recusado (MKT_PREVIEW_SENSITIVE).
 */
function fillTemplate(template, variables, previewConfig) {
  const declared = new Set((template.variables_json || []).map((v) => v.name));
  const unknown = Object.keys(variables || {}).filter((name) => !declared.has(name));
  if (unknown.length > 0) throw unknownTemplateVariable(unknown);
  const missing = [];
  const text = String(template.body).replace(PLACEHOLDER_RE, (_all, inner) => {
    const name = inner.trim();
    const value = variables[name];
    if (value === undefined || value === null || value === '') { missing.push(name); return ''; }
    const check = previewSafe(String(value), previewConfig);
    if (!check.safe) throw previewSensitive({ variable: name, patterns: check.patterns });
    return String(value);
  });
  if (missing.length > 0) throw unknownTemplateVariable([...new Set(missing)]);
  return text;
}

module.exports = { loadApprovedTemplate, fillTemplate };

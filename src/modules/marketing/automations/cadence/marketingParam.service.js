'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { getSetting } = require('../../../../features/settings/settings.service');
const { mktError } = require('../../marketing.errors');
const { CADENCE_DEFAULTS, CADENCE_KEYS, PARSERS } = require('./cadence.settings');

function assertKnown(code) {
  if (!CADENCE_KEYS.includes(code)) {
    throw mktError(404, 'MKT_PARAM_NOT_FOUND', 'Parâmetro não encontrado.', { code });
  }
}

/**
 * Lê um parâmetro de cadência da empresa, já tipado: listas de dias -> number[]; quiet hours -> { startMinutes, endMinutes,
 * timeZone }; cap -> { messages, days }. Ausente ou ilegível: usa o padrão registrado. Sem cache: cada leitura vê o valor
 * vigente, então alterar vale na próxima execução, sem deploy. Código desconhecido: 404 MKT_PARAM_NOT_FOUND.
 */
async function getMarketingParam(code, tenant, transaction) {
  assertKnown(code);
  const raw = await getSetting(code, tenant, transaction, CADENCE_DEFAULTS[code]);
  return PARSERS[code](raw) || PARSERS[code](CADENCE_DEFAULTS[code]);
}

/** Valor em texto (como o administrador vê) e se é o padrão. */
async function describeMarketingParam(code, tenant, transaction) {
  assertKnown(code);
  const raw = await getSetting(code, tenant, transaction, null);
  return { code, value: raw === null ? CADENCE_DEFAULTS[code] : raw, isDefault: raw === null, defaultValue: CADENCE_DEFAULTS[code] };
}

/** Todos os parâmetros de cadência com valor vigente e padrão. */
async function listMarketingParams(tenant, transaction) {
  const out = [];
  for (const code of CADENCE_KEYS) {
    out.push(await describeMarketingParam(code, tenant, transaction));
  }
  return out;
}

/** Histórico de alterações (quem, quando, antes/depois), do mais novo ao mais antigo, lido da trilha de auditoria da empresa. */
async function listMarketingParamHistory(code, tenant, transaction) {
  assertKnown(code);
  const rows = await sequelize.query(
    `SELECT occurred_at, user_id, action, correlation_id, before_json->'value' AS before_value, after_json->'value' AS after_value
       FROM audit.audit_log
      WHERE company_id = :companyId AND entity_type = 'TenantSetting' AND after_json->>'key' = :code
      ORDER BY occurred_at DESC, id DESC`,
    { replacements: { companyId: tenant.companyId, code }, type: QueryTypes.SELECT, transaction }
  );
  return rows.map((r) => ({
    code, changedAt: r.occurred_at, changedBy: r.user_id, action: r.action, correlationId: r.correlation_id,
    before: r.before_value === undefined ? null : r.before_value, after: r.after_value,
  }));
}

module.exports = { getMarketingParam, describeMarketingParam, listMarketingParams, listMarketingParamHistory };

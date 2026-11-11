'use strict';

/**
 * DI-BI-3 (BI-008: "Métrica alterada cria nova versão, não reescreve histórico sem trilha") — quando a definição de um KPI no código declara `version` acima da publicada na
 * empresa e algum campo versionado (fórmula, política de atualização, regra de qualidade...) mudou, o maquinário dos conjuntos de KPIs publica a versão seguinte pelo
 * caminho normal (publishVersion: savepoint, auditoria campo a campo, aceite PENDING da M9-D708, evento analytics.metric.version_published), com vigência a partir de hoje
 * e o motivo `changeReason` da definição. A versão anterior e os snapshots dela ficam como histórico. Sem mudança, ou já na versão declarada, nada acontece.
 */
const AppError = require('../../../../../utils/AppError');
const logger = require('../../../../../utils/logger');
const { sequelize } = require('../../../../../models');
const clock = require('../../clock');
const { publishVersion } = require('../../registry.version');
const { VERSIONED_FIELDS, versionFields, diffFields } = require('../../registry.diff');

const IGNORED = new Set(['ANALYTICS_METRIC_VERSION_CONFLICT', 'ANALYTICS_VERSION_NO_CHANGES']); // outra passada publicou antes, ou não há o que versionar

async function currentVersion(code, companyId, transaction) {
  const [rows] = await sequelize.query(
    `SELECT v.* FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id
      WHERE d.metric_code = :code AND d.company_id = :companyId AND d.status = 'PUBLISHED'`, { replacements: { code, companyId }, transaction });
  return rows[0] || null;
}

/** Campos versionados como a definição do código os declara (mesmas chaves de VERSIONED_FIELDS; o formulaId é o código do KPI). */
const declaredFields = (def) => Object.fromEntries(Object.keys(VERSIONED_FIELDS).map((k) => [k, k === 'formulaId' ? def.metricCode : def[k] === undefined ? null : def[k]]));

/** Publica a versão declarada no código se a da empresa é anterior e algo versionado mudou. Devolve a versão publicada ou null. */
async function upgradeDeclaredVersion(def, scope, ctx, transaction) {
  if (!Number.isInteger(def.version) || def.version < 2) return null;
  const current = await currentVersion(def.metricCode, scope.companyId, transaction);
  if (!current || current.version >= def.version) return null;
  const declared = declaredFields(def);
  const before = versionFields(current);
  const changed = Object.keys(diffFields(before, { ...before, ...Object.fromEntries(Object.entries(declared).filter(([, v]) => v !== null)) }));
  if (!changed.length) return null;
  const input = { version: current.version + 1, validFrom: clock.businessToday(), changeReason: def.changeReason, scopeLevel: 'COMPANY' };
  for (const key of changed) input[key] = declared[key];
  try {
    return await sequelize.transaction({ transaction }, (savepoint) => publishVersion(def.metricCode, input, ctx, savepoint));
  } catch (err) {
    // a versão nova nunca derruba o cálculo dos KPIs: o conjunto segue na versão vigente e a próxima passada tenta de novo
    if (!(err instanceof AppError && IGNORED.has(err.code))) {
      logger.error({ event: 'analytics.kpi.version_upgrade_failed', metricCode: def.metricCode, companyId: scope.companyId, err }, '[analytics] não foi possível publicar a versão declarada do KPI');
    }
    return null;
  }
}

module.exports = { upgradeDeclaredVersion, declaredFields };

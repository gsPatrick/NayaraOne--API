'use strict';

/**
 * M9-D609 (3.1) — leitura dos parâmetros de freshness da empresa: limite de idade por domínio (`analytics.freshness.max_minutos.<DOMINIO>`)
 * e fator do EXPIRED (`analytics.freshness.fator_expirado`, padrão 4). O dicionário (SETTINGS_SCHEMA) e os padrões vivem em
 * quality/quality.settings.js (M9-D696 declarou as chaves; esta demanda é a segunda leitora). Valor ausente ou inválido cai no padrão do livro.
 */
const { K, DEFAULTS, FRESHNESS_DOMAINS } = require('../quality/quality.settings');

const freshnessKey = (domain) => `analytics.freshness.max_minutos.${domain}`;
const positiveInt = (v, fallback) => (Number.isInteger(v) && v >= 1 ? v : fallback);

/**
 * { factor, limits: { FINANCE: 60, ... }, overrides: { FINANCE: 90 } } vigentes da empresa (`scope.companyId`). `limits` já traz o padrão do
 * livro onde o administrador não configurou; `overrides` traz SÓ o que ele configurou (um limite explícito do domínio vale sobre o da métrica).
 */
async function readFreshnessParams(scope, transaction) {
  const { listSettingsByPrefix } = require('../../settings/settings.service'); // import tardio: settings.service importa o schema de quality.settings
  const rows = scope && scope.companyId ? await listSettingsByPrefix('analytics.freshness.', scope, transaction) : [];
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const get = (key) => (stored[key] === undefined ? DEFAULTS[key] : stored[key]);
  const explicit = (d) => (Number.isInteger(stored[freshnessKey(d)]) && stored[freshnessKey(d)] >= 1 ? stored[freshnessKey(d)] : undefined);
  return {
    overrides: Object.fromEntries(Object.keys(FRESHNESS_DOMAINS).map((d) => [d, explicit(d)]).filter(([, v]) => v !== undefined)),
    factor: positiveInt(get(K.factor), DEFAULTS[K.factor]),
    limits: Object.fromEntries(Object.keys(FRESHNESS_DOMAINS).map((d) => [d, positiveInt(get(freshnessKey(d)), DEFAULTS[freshnessKey(d)])])),
  };
}

module.exports = { readFreshnessParams };

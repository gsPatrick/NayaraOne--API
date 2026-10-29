'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { getSetting } = require('../../../settings/settings.service');
const settings = require('./share.settings');
const { rateLimited } = require('./share.errors');

/**
 * Limite de acessos por IP nas rotas sem login (M9-D823 §3 item 4; M9-D843 §3.1): janela fixa de 60 s pelo relógio do banco, contador no banco (vale entre processos),
 * incremento atômico. Passou do limite (`governanca.api.rate_limit.anonimo_por_minuto`, padrão 60): 429 GOV_RATE_LIMITED com os segundos até a janela virar.
 * Roda numa transação PRÓPRIA e confirmada (a contagem nunca se desfaz, nem quando a requisição falha depois).
 */
async function hit(scopeKey, limit) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.public_counter', 'on', true)", { transaction });
    const rows = await sequelize.query(
      `INSERT INTO governance.public_access_counters (scope_key, window_start, hits) VALUES (:key, date_trunc('minute', now()), 1)
       ON CONFLICT (scope_key, window_start) DO UPDATE SET hits = governance.public_access_counters.hits + 1
       RETURNING hits, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (date_trunc('minute', now()) + interval '1 minute' - now()))))::int AS "retryAfter"`,
      { type: QueryTypes.SELECT, transaction, replacements: { key: scopeKey } }
    );
    return { hits: rows[0].hits, retryAfter: rows[0].retryAfter, allowed: rows[0].hits <= limit, limit };
  });
}

/**
 * O limite vigente. Antes de resolver o link não há empresa, então um token que não existe é medido pelo padrão do catálogo; um token que existe é medido pelo parâmetro
 * da empresa dele (o contador é o mesmo: a contagem acontece antes de qualquer consulta, a comparação depois).
 */
async function limitFor(tenant, transaction) {
  const fallback = settings.SHARE_SETTING_DEFAULTS[settings.RATE_KEY];
  if (!tenant) return fallback;
  return settings.intOr(await getSetting(settings.RATE_KEY, tenant, transaction, fallback), settings.RATE_KEY);
}

/** Conta o acesso do IP (antes de qualquer consulta ao banco de links). */
const countHit = (ip) => hit(`public-share:${ip || 'sem-ip'}`, 0);

/** Lança 429 GOV_RATE_LIMITED quando o contador do IP passou do limite. */
function assertWithinLimit(state, limit) {
  if (state.hits > limit) throw rateLimited(state.retryAfter);
}

/** Apaga as janelas com mais de 10 minutos (o shareLinkExpiryJob chama). */
async function cleanupCounters() {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.public_counter', 'on', true)", { transaction });
    const [, meta] = await sequelize.query("DELETE FROM governance.public_access_counters WHERE window_start < now() - interval '10 minutes'", { transaction });
    return meta && meta.rowCount ? meta.rowCount : 0;
  });
}

module.exports = { countHit, assertWithinLimit, limitFor, cleanupCounters, hit };

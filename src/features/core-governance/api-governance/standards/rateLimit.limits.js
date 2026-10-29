'use strict';

const { sequelize } = require('../../../../models');
const { getSetting } = require('../../../settings/settings.service');
const share = require('../../dlp/share/share.settings');
const S = require('./standards.settings');

/** Limite vigente por tipo de credencial, lido do parâmetro da empresa (quando a credencial identifica a empresa) ou do padrão do catálogo; guardado 30 s na memória do processo. */
const TTL_MS = 30 * 1000;
const cache = new Map();
const KEY_BY_KIND = { internal: S.RATE_INTERNAL_KEY, external: S.RATE_EXTERNAL_KEY, anonymous: share.RATE_KEY };
const DEFAULT_BY_KEY = { ...S.STANDARDS_SETTING_DEFAULTS, [share.RATE_KEY]: share.SHARE_SETTING_DEFAULTS[share.RATE_KEY] };

async function readFromCompany(tenant, keys) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :groupId, true), set_config('app.company_id', :companyId, true)", { replacements: tenant, transaction });
    const out = {};
    for (const key of keys) out[key] = await getSetting(key, tenant, transaction, DEFAULT_BY_KEY[key]);
    return out;
  });
}

async function limitFor(identity, now = Date.now()) {
  const key = KEY_BY_KIND[identity.kind];
  if (!identity.tenant) return { enabled: true, limit: DEFAULT_BY_KEY[key] };
  const cached = cache.get(identity.tenant.companyId);
  if (cached && cached.at + TTL_MS > now) return { enabled: cached.values[S.RATE_ENABLED_KEY] !== false, limit: Number(cached.values[key]) };
  const values = await readFromCompany(identity.tenant, [S.RATE_ENABLED_KEY, S.RATE_INTERNAL_KEY, S.RATE_EXTERNAL_KEY, share.RATE_KEY]);
  cache.set(identity.tenant.companyId, { at: now, values });
  return { enabled: values[S.RATE_ENABLED_KEY] !== false, limit: Number(values[key]) };
}

const clearLimitCache = () => cache.clear();

module.exports = { limitFor, clearLimitCache };

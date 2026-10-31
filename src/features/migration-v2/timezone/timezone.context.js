'use strict';

const { getSetting } = require('../../settings/settings.service');
const { loadSchema } = require('../integrity/schema.repository');
const { KEYS, TIMEZONE_SETTING_DEFAULTS } = require('./timezone.settings');

/** Esquema canônico da entidade e as regras de fuso da empresa, lidos uma vez e guardados no contexto do lote (`ctx.temporal`). */
async function temporalContext(ctx, entity) {
  if (!ctx.temporal) ctx.temporal = new Map();
  if (!ctx.temporal.has(entity)) {
    const read = (key) => getSetting(key, ctx.tenant, ctx.transaction, TIMEZONE_SETTING_DEFAULTS[key]);
    ctx.temporal.set(entity, {
      schema: await loadSchema(ctx.tenant, entity, ctx.transaction),
      options: { zone: String(await read(KEYS.ORIGIN_ZONE)).trim(), ambiguous: String(await read(KEYS.AMBIGUOUS)).trim().toUpperCase() },
    });
  }
  return ctx.temporal.get(entity);
}

module.exports = { temporalContext };

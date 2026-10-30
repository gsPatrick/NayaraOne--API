'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { getMarketingParam } = require('../cadence/marketingParam.service');
const { SEND_TIME_KEY, QUIET_HOURS_KEY } = require('../cadence/cadence.defaults');
const { localDateOf, addCivilDays, zonedToUtc } = require('../cadence/zonedTime');

const one = async (sql, id, transaction) => (await sequelize.query(sql, { replacements: { id }, transaction, type: QueryTypes.SELECT }))[0];

/** Datas-base da cadência: de onde a contagem de dias parte. Cada uma devolve a data/hora ou null (aí vale a hora do evento). */
const BASES = Object.freeze({
  KEYS_DELIVERED: async (ctx) => (await one('SELECT delivered_at AS at FROM legal.key_deliveries WHERE id = :id', ctx.event.payload.id, ctx.transaction) || {}).at,
  LEASE_START: async (ctx) => (await one('SELECT starts_at AS at FROM legal.contracts WHERE id = :id', ctx.event.payload.id || ctx.event.aggregateId, ctx.transaction) || {}).at,
});

/**
 * Porta da cadência do runner (M9-D422): horário em que a mensagem `def.cadence = { code, index, base }` deve sair. Dias corridos do parâmetro `code` (posição `index`) a partir da
 * data-base no fuso da empresa, no horário de envio do parâmetro (`marketing.cadencia.horario_envio`). Sem dia na posição, devolve null. O retrato fica gravado na ação: mudar o
 * parâmetro depois não move o que já foi agendado.
 */
async function cadenceDueAt(def, ctx) {
  const c = def && def.cadence;
  if (!c) return null;
  const days = await getMarketingParam(c.code, ctx.tenant, ctx.transaction);
  if (!Number.isInteger(days[c.index])) return null;
  const { timeZone } = await getMarketingParam(QUIET_HOURS_KEY, ctx.tenant, ctx.transaction);
  const { minutes } = await getMarketingParam(SEND_TIME_KEY, ctx.tenant, ctx.transaction);
  const read = BASES[c.base];
  const base = (read && await read(ctx)) || ctx.event.occurredAt || ctx.now;
  return zonedToUtc(addCivilDays(localDateOf(new Date(base), timeZone), days[c.index]), minutes, timeZone);
}

module.exports = { cadenceDueAt, BASES };

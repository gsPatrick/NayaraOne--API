'use strict';

// Apoio dos testes M9-D860 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const { randomUUID } = require('node:crypto');
const { QueryTypes } = require('sequelize');
const base = require('./m9d803Env');
const ledger = require('../../../src/features/core-governance/finops/ledger.service');
const { adminQuery } = require('../../m9d801.helpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

const { sequelize } = base;
const GB = 1024n ** 3n;
const uniq = () => `QA-M9-${randomUUID().slice(0, 8)}`;
/** Meia-noite de Brasília (03:00Z) do dia AAAA-MM-DD. */
const midnightSp = (day) => new Date(`${day}T03:00:00.000Z`);
const addHours = (date, h) => new Date(date.getTime() + h * 3600000);

/** Linha ESTIMATED de um dia fechado (24 h a partir da meia-noite de Brasília). */
function dayLine(tenant, day, over = {}) {
  const start = midnightSp(day);
  return {
    companyId: tenant.companyId, category: 'CLOUD_SERVICE', service: 'compute', domain: 'PLATFORM', costKind: 'ESTIMATED', lineType: 'CHARGE', amountCents: 1000,
    periodStart: start, periodEnd: addHours(start, 24), sourceRef: uniq(), ...over,
  };
}

const record = (tenant, lines, tx) => ledger.recordLines(tenant, lines, tx);

async function rows(tenant, tx, where = 'TRUE', replacements = {}) {
  return sequelize.query(`SELECT * FROM governance.cost_ledger WHERE group_id = :g AND ${where} ORDER BY period_start, service`, { type: QueryTypes.SELECT, transaction: tx, replacements: { g: tenant.groupId, ...replacements } });
}

async function setPrices(tenant, prices, tx) {
  await upsertSetting('governanca.finops.precos', JSON.stringify(prices), tenant, tenant.userId, tx);
}

const codeOf = async (promise) => promise.then(() => null, (err) => err.code);

module.exports = { ...base, adminQuery, randomUUID, GB, uniq, midnightSp, addHours, dayLine, record, rows, setPrices, codeOf, sequelize };

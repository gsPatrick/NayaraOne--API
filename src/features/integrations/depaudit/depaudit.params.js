'use strict';

const { getSetting } = require('../../settings/settings.service');
const { DEFAULT_SDK_DENYLIST, parseList } = require('../http/sdkPolicy');

/** Padrões do parametros.csv, usados quando a empresa não configurou. */
const PADROES = Object.freeze({ pinExact: true, maxDays: 30, auditHour: 3 });

async function readDepAuditParams(ctx, transaction) {
  const [pin, deny, dias, hora] = await Promise.all([
    getSetting('integration.sdk.pin_exact', ctx, transaction, PADROES.pinExact),
    getSetting('integration.sdk.denylist', ctx, transaction, null),
    getSetting('integration.sdk.audit_exception_max_days', ctx, transaction, PADROES.maxDays),
    getSetting('integration.sdk.audit_hour', ctx, transaction, PADROES.auditHour),
  ]);
  const lista = parseList(deny);
  return {
    pinExact: typeof pin === 'boolean' ? pin : PADROES.pinExact,
    denylist: lista.length ? lista : [...DEFAULT_SDK_DENYLIST],
    maxDays: Number.isInteger(dias) && dias >= 1 && dias <= 30 ? dias : PADROES.maxDays,
    auditHour: Number.isInteger(hora) && hora >= 0 && hora <= 23 ? hora : PADROES.auditHour,
  };
}

module.exports = { PADROES, readDepAuditParams };

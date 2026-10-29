'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { addBusinessDays, holidaySet, yearsFrom } = require('../../calendar/businessDays');
const { HOLIDAYS_KEY, HOLIDAYS_DEFAULTS } = require('../../calendar/holidays.settings');
const { RECONCILE_DAYS_KEY, BCP_SETTING_DEFAULTS } = require('../bcp.settings');
const normalize = require('../import/normalize');
const repository = require('./pending.repository');

/** Conjunto de feriados da empresa para os anos que o prazo toca a partir de `day`. */
async function holidaysFor(tenant, day, transaction) {
  const text = await getSetting(HOLIDAYS_KEY, tenant, transaction, HOLIDAYS_DEFAULTS[HOLIDAYS_KEY]);
  return holidaySet(text, yearsFrom(day));
}

/** Prazo: `governanca.bcp.conciliar_pagamento_dias` dias úteis depois da data da operação (dia de Brasília). */
async function deadlineFor(tenant, occurredDay, transaction) {
  const days = Number(await getSetting(RECONCILE_DAYS_KEY, tenant, transaction, BCP_SETTING_DEFAULTS[RECONCILE_DAYS_KEY]));
  return addBusinessDays(occurredDay, days, await holidaysFor(tenant, occurredDay, transaction));
}

/** Abre a pendência de conciliação do pagamento importado (chamada pelo adaptador dentro da transação do item). Repetir não grava de novo. */
async function openPending({ tenant, actorUserId, operation, amountCents, transaction }) {
  const occurredOn = normalize.day(operation.occurredAt);
  return repository.insertPending({
    groupId: tenant.groupId, companyId: tenant.companyId, manualOperationId: operation.id, manualReference: operation.manualReference, amountCents,
    occurredOn, deadlineOn: await deadlineFor(tenant, occurredOn, transaction), importedBy: actorUserId,
  }, transaction);
}

module.exports = { openPending, deadlineFor, holidaysFor };

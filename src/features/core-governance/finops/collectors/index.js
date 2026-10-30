'use strict';

const { runCollector } = require('./run');
const { collectAi } = require('./ai');
const { collectMessaging } = require('./messaging');
const { recordEgress, collectEgress } = require('./egress');
const { collectStorage } = require('./storage');
const { collectBilling } = require('./billing');
const meter = require('./egress.meter');

/** Despeja o contador de bytes da empresa no acúmulo da hora e fecha as horas de egress; se algo falhar, os bytes voltam ao contador. */
async function flushAndCollectEgress(tenant, now, transaction) {
  const taken = meter.takeFor(tenant);
  try {
    for (const item of taken) await recordEgress(tenant, { kind: item.kind, bytes: item.bytes, at: now }, transaction);
    return await collectEgress(tenant, now, transaction);
  } catch (err) {
    meter.putBack(tenant, taken);
    throw err;
  }
}

/** Rodada horária da empresa: fecha as horas encerradas de IA, mensageria e egress e importa a fatura se houver fonte. Cada coletor é isolado dos demais. */
async function runHourly(tenant, now, transaction, { billingSource } = {}) {
  const results = [];
  results.push(await runCollector(tenant, 'ai', () => collectAi(tenant, now, transaction), transaction, now));
  results.push(await runCollector(tenant, 'messaging', () => collectMessaging(tenant, now, transaction), transaction, now));
  results.push(await runCollector(tenant, 'egress', () => flushAndCollectEgress(tenant, now, transaction), transaction, now));
  results.push(await runCollector(tenant, 'billing', () => collectBilling(tenant, now, transaction, { source: billingSource }), transaction, now));
  return results;
}

/** Rodada diária da empresa: mede o armazenamento do dia anterior. */
async function runDaily(tenant, now, transaction, { measurements } = {}) {
  return [await runCollector(tenant, 'storage', () => collectStorage(tenant, now, transaction, { measurements }), transaction, now)];
}

module.exports = { runHourly, runDaily, flushAndCollectEgress };

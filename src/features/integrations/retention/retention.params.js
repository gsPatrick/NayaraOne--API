'use strict';

const { getSetting } = require('../../settings/settings.service');
const { readHealthParams } = require('../health/healthParams');
const { readErrorParams } = require('../errors/errors.params');
const { readInboxParams } = require('../inbox/inbox.params');
const { readDispatchParams } = require('../dispatch/dispatch.params');

const PADROES = Object.freeze({ jobHour: 2 });
const AREAS = Object.freeze(['health', 'errors', 'inbox', 'dispatch']);

/**
 * Prazos que integration.purge_expired() recebe, lidos dos parâmetros da empresa (cada um com o padrão do livro). `areas`
 * escolhe os trechos; sem ela, todos.
 */
async function readRetentionPayload(ctx, transaction, areas = AREAS) {
  const p = {};
  if (areas.includes('health')) p.health_days = (await readHealthParams(ctx, transaction)).retentionDays;
  if (areas.includes('errors')) p.errors_days = (await readErrorParams(ctx, transaction)).retentionDays;
  if (areas.includes('inbox')) {
    const i = await readInboxParams(ctx, transaction);
    Object.assign(p, { inbox_raw_days: i.rawRetentionDays, inbox_days: i.retentionDays, inbox_dlq_raw_days: i.dlqRetryRetentionDays });
  }
  if (areas.includes('dispatch')) {
    const d = await readDispatchParams(ctx, transaction);
    Object.assign(p, { dispatch_days: d.retentionDays, dispatch_payload_days: d.payloadRetentionDays });
  }
  return p;
}

async function readJobHour(ctx, transaction) {
  const h = await getSetting('integration.retention.job_hour', ctx, transaction, PADROES.jobHour);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : PADROES.jobHour;
}

module.exports = { PADROES, AREAS, readRetentionPayload, readJobHour };

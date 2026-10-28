'use strict';

const { getSetting } = require('../../settings/settings.service');
const { parseBackoffList } = require('../../../engines/events/outboxBackoffParse');

/** Padrões do parametros.csv, usados quando a empresa não configurou. */
const PADROES = Object.freeze({
  maxAttempts: 6,
  rawRetentionDays: 30,
  retentionDays: 90,
  dlqRetryRetentionDays: 7,
  maxBodyBytes: 1048576,
  retryBackoffMs: '60000,300000,900000,3600000,14400000',
  headerAllowlist: 'content-type,user-agent,x-request-id,x-webhook-id,x-event-id,x-event-type,x-api-version,x-webhook-timestamp',
});

const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);

async function readInboxParams(ctx, transaction) {
  const [maxAttempts, raw, ret, dlq, maxBody, backoff, allow] = await Promise.all([
    getSetting('integration.inbox.max_attempts', ctx, transaction, PADROES.maxAttempts),
    getSetting('integration.inbox.raw_retention_days', ctx, transaction, PADROES.rawRetentionDays),
    getSetting('integration.inbox.retention_days', ctx, transaction, PADROES.retentionDays),
    getSetting('integration.inbox.dlq_retry_retention_days', ctx, transaction, PADROES.dlqRetryRetentionDays),
    getSetting('integration.webhook.max_body_bytes', ctx, transaction, PADROES.maxBodyBytes),
    getSetting('integration.inbox.retry_backoff_ms', ctx, transaction, PADROES.retryBackoffMs),
    getSetting('integration.inbox.header_allowlist', ctx, transaction, PADROES.headerAllowlist),
  ]);
  const allowlist = String(typeof allow === 'string' ? allow : PADROES.headerAllowlist).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return {
    maxAttempts: inteiro(maxAttempts, PADROES.maxAttempts, 1),
    rawRetentionDays: inteiro(raw, PADROES.rawRetentionDays, 1),
    retentionDays: inteiro(ret, PADROES.retentionDays, 1),
    dlqRetryRetentionDays: inteiro(dlq, PADROES.dlqRetryRetentionDays, 1),
    maxBodyBytes: inteiro(maxBody, PADROES.maxBodyBytes, 1024),
    retryBackoffMs: parseBackoffList(backoff) || parseBackoffList(PADROES.retryBackoffMs),
    headerAllowlist: allowlist,
  };
}

module.exports = { PADROES, readInboxParams };

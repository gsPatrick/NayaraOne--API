'use strict';

// Apoio dos testes M9-D871 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const { Notification } = require('../../../src/models');
const env = require('./m9d870Env');
const expiry = require('../../../src/features/core-governance/feature-flags/expiry.service');

const NOW = new Date('2026-10-27T12:00:00Z');
const YESTERDAY = '2026-10-26T12:00:00Z';

/** Flag temporária cuja validade já passou em relação a NOW. */
const mkExpiredFlag = (tenant, tx, over = {}) => env.mkFlag(tenant, tx, { temporary: true, validUntil: YESTERDAY, value: true, ...over });
const notificationsOf = (userId, tx, like = '%') => Notification.findAll({ where: { userId }, transaction: tx }).then((rows) => rows.filter((r) => new RegExp(like.replace(/%/g, '.*')).test(`${r.title} ${r.body}`)));

module.exports = { ...env, expiry, NOW, YESTERDAY, mkExpiredFlag, notificationsOf };

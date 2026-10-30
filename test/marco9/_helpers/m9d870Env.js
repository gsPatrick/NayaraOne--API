'use strict';

// Apoio dos testes M9-D870 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const { randomUUID } = require('node:crypto');
const { QueryTypes } = require('sequelize');
const { adminQuery } = require('../../m9d801.helpers');
const base = require('./m9d803Env');
const { AuditLog } = require('../../../src/models');
const service = require('../../../src/features/core-governance/feature-flags/feature-flags.service');
const { resolve } = require('../../../src/features/core-governance/feature-flags/flags.resolve');
const repo = require('../../../src/features/core-governance/feature-flags/flags.repository');

const { sequelize } = base;
let counter = 0;
/** Chave única do teste no formato do livro (dominio.recurso.nome). */
const keyOf = (name = 'x') => `qa.m9d870.${name}_${Date.now().toString(36)}_${counter++}`;

const mkFlag = (tenant, tx, over = {}) => service.createEntry(tenant, { key: keyOf('flag'), value: false, ownerUserId: tenant.userId, scope: 'GLOBAL', risk: 'LOW', ...over }, tenant.userId, tx);
const mkConfig = (tenant, tx, over = {}) => service.createEntry(tenant, { key: keyOf('cfg'), kind: 'CONFIG', valueType: 'INTEGER', value: 10, ownerUserId: tenant.userId, ...over }, tenant.userId, tx);
const patch = (tenant, tx, body, now) => service.updateEntry(tenant, body, tenant.userId, tx, now ? { now } : undefined);
const auditOf = (entityId, tx) => AuditLog.findAll({ where: { entityId: String(entityId), action: 'governance.flag.changed' }, order: [['occurredAt', 'ASC']], transaction: tx });
const versionsOf = (id, tx) => sequelize.query('SELECT * FROM governance.flag_versions WHERE entry_id = :id ORDER BY version', { type: QueryTypes.SELECT, transaction: tx, replacements: { id } });
const codeOf = (promise) => Promise.resolve(promise).then(() => null, (err) => [err.statusCode || err.status, err.code]);
const isoIn = (ms) => new Date(Date.now() + ms).toISOString();

module.exports = { ...base, randomUUID, adminQuery, sequelize, service, resolve, repo, keyOf, mkFlag, mkConfig, patch, auditOf, versionsOf, codeOf, isoIn };

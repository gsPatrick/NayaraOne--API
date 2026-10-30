'use strict';

// Apoio dos testes M9-D906 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const base = require('./m9d805Env');
const { dbError } = require('./dbAttempt');
const externalRefs = require('../../../src/features/migration-v2/externalRefs.service');

const { sequelize } = base;
const sys = () => `LEGADO_${base.suffix()}`.slice(0, 40);
const actorOf = (tenant) => ({ userId: tenant.userId, roles: ['ADMIN'] });

/** Registra a referência legada de uma pessoa (padrão: cliente do ERP antigo). */
const ref = (tenant, tx, entityId, key, extra = {}) => externalRefs.register(tenant, actorOf(tenant), {
  entityType: 'PERSON', entityId, sourceSystem: 'LEGADO_ERP', sourceKey: key, ...extra,
}, tx);

/** Linhas cruas (vigentes e fechadas) da entidade, em ordem de abertura. */
const rows = (entityId, tx) => sequelize.query(
  'SELECT source_system, source_key, valid_from, valid_to, is_primary, entity_id FROM core.external_refs WHERE entity_id = :entityId ORDER BY created_at, source_key',
  { type: 'SELECT', transaction: tx, replacements: { entityId } }
);

module.exports = { dbError, ...base, externalRefs, actorOf, ref, rows, sys, sequelize };

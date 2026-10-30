'use strict';

// Apoio dos testes M9-D906 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const base = require('./m9d805Env');
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

/** Roda um SQL que deve falhar dentro de um SAVEPOINT (a transação do teste continua utilizável) e devolve a mensagem do erro, ou null se não falhou. */
async function dbError(tx, sql, replacements) {
  await sequelize.query('SAVEPOINT tentativa', { transaction: tx });
  try {
    await sequelize.query(sql, { transaction: tx, replacements });
    return null;
  } catch (err) {
    return String((err.original && err.original.message) || err.message);
  } finally {
    await sequelize.query('ROLLBACK TO SAVEPOINT tentativa', { transaction: tx });
  }
}

module.exports = { dbError, ...base, externalRefs, actorOf, ref, rows, sys, sequelize };

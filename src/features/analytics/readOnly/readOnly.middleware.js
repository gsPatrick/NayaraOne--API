'use strict';

const { sequelize } = require('../../../config/database');
const AppError = require('../../../utils/AppError');
const logger = require('../../../utils/logger');
const { writeBlockedError } = require('./readOnly.errors');
const { shouldUseReaderRole, assumeReaderRole } = require('./readOnly.readerRole');

const READ_METHODS = new Set(['GET', 'HEAD']);
const PG_READ_ONLY_VIOLATION = '25006';

function pgCode(err) {
  return err?.parent?.code || err?.original?.code || err?.code || err?.cause?.parent?.code || err?.cause?.code;
}

/** Primeira coisa da transação de um GET de BI: READ ONLY (livro BI-001) e, se disponível e ligado, o role sem escrita. */
async function applyReadOnly(transaction, tenant) {
  await sequelize.query('SET TRANSACTION READ ONLY', { transaction });
  if (await shouldUseReaderRole(tenant, transaction)) await assumeReaderRole(transaction);
}

/** Escrita recusada pelo banco dentro de um GET: incidente de segurança (log) e 500 ANALYTICS_WRITE_BLOCKED. */
function translateWriteBlocked(err, req) {
  if (pgCode(err) !== PG_READ_ONLY_VIOLATION) return err;
  logger.error({
    security: true, event: 'analytics.write_blocked', correlationId: req.correlationId, method: req.method, path: req.originalUrl,
    companyId: req.auth?.companyId, userId: req.auth?.userId, pgCode: PG_READ_ONLY_VIOLATION,
  }, '[analytics] tentativa de escrita bloqueada pelo banco dentro de um GET de BI');
  const blocked = writeBlockedError();
  blocked.cause = err;
  return blocked;
}

/**
 * M9-D612 (3.1) — todo GET/HEAD de /analytics roda em transação READ ONLY: substitui `req.withTenantTransaction` por uma versão
 * que aplica a garantia antes de qualquer consulta do handler. Falha fechada se o contexto de tenant não foi montado.
 * Escritas permitidas (ack e exportação, ANALYTICS_WRITE_ROUTES) não passam por aqui: gravam só em analytics, sob RLS.
 */
function analyticsReadOnlyTransaction(req, res, next) {
  if (!READ_METHODS.has(req.method)) return next();
  const base = req.withTenantTransaction;
  if (typeof base !== 'function' || !req.auth) {
    return next(AppError.unauthorized('Contexto de tenant ausente. Operação bloqueada (fail closed).', 'TENANT_CONTEXT_MISSING'));
  }
  const tenant = { groupId: req.auth.groupId, companyId: req.auth.companyId };
  req.withTenantTransaction = async (fn) => {
    try {
      return await base(async (transaction) => {
        await applyReadOnly(transaction, tenant);
        return fn(transaction);
      });
    } catch (err) {
      throw translateWriteBlocked(err, req);
    }
  };
  return next();
}
analyticsReadOnlyTransaction.isAnalyticsReadOnlyGuard = true;

module.exports = { analyticsReadOnlyTransaction };

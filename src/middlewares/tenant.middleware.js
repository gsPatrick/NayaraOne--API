'use strict';

const AppError = require('../utils/AppError');
const { sequelize } = require('../config/database');

/**
 * Middleware de contexto de tenant/RLS.
 *
 * Regra constitucional (IAM-015 / fail closed — 01_ARQUITETURA_E_INVARIANTES.md §2.4/§2.9,
 * 02_BANCO_DE_DADOS_E_RLS.md §3.3): toda operação que toca dado multiempresa precisa de
 * `SET LOCAL app.user_id / app.group_id / app.company_id` resolvido na MESMA transação de
 * banco que executa a query, e a ausência desse contexto deve falhar fechada.
 *
 * Este middleware roda **depois** de `auth.middleware` (que resolve `req.auth` a partir do
 * JWT) e expõe um único helper para os services consumirem:
 *
 *   await req.withTenantTransaction(async (transaction) => {
 *     return SomeModel.create({ ... }, { transaction });
 *   });
 *
 * Cada chamada abre uma transação Sequelize nova, aplica os três `SET LOCAL` com os valores
 * de `req.auth` (nunca de header cru do cliente) e executa o callback dentro dela — o
 * Postgres então aplica as policies `tenant_isolation` (`company_id = current_setting(...)`)
 * de forma transparente a qualquer query rodada com essa `transaction`.
 *
 * Fail closed: se `req.auth` não estiver populado (auth.middleware não rodou, ou falhou e
 * o fluxo prosseguiu incorretamente), a própria requisição já é bloqueada aqui com 401,
 * antes de qualquer tentativa de abrir transação — nunca se assume um tenant default.
 */
function tenantMiddleware(req, res, next) {
  if (!req.auth || !req.auth.groupId || !req.auth.companyId || !req.auth.userId) {
    return next(
      AppError.unauthorized(
        'Contexto de tenant ausente (group_id/company_id/user_id). Operação bloqueada (fail closed).',
        'TENANT_CONTEXT_MISSING'
      )
    );
  }

  const { groupId, companyId, userId } = req.auth;

  req.withTenantTransaction = async (fn) => {
    return sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId }, transaction });
      await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId }, transaction });
      await sequelize.query('SET LOCAL app.user_id = :userId', { replacements: { userId }, transaction });
      return fn(transaction);
    });
  };

  return next();
}

module.exports = tenantMiddleware;

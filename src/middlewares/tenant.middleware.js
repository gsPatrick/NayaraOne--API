'use strict';

const AppError = require('../utils/AppError');
const { sequelize } = require('../config/database');
const fileAttachGuard = require('./fileAttachGuard.middleware');
const { registrarAuditoria } = require('../engines/audit/auditLog.service');

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
    let currentTransaction = null;
    try {
      return await runInTenantTransaction(fn, (tx) => { currentTransaction = tx; });
    } catch (err) {
      // Auditorias que o serviço marcou para sobreviver ao rollback (ex.: provider inelegível).
      const pending = currentTransaction && currentTransaction.afterRollbackAudits;
      if (pending && pending.length) {
        try {
          await sequelize.transaction(async (tx) => {
            await sequelize.query(
              'SELECT set_config(\'app.group_id\', :groupId, true), set_config(\'app.company_id\', :companyId, true), set_config(\'app.user_id\', :userId, true)',
              { replacements: { groupId, companyId, userId }, transaction: tx }
            );
            for (const entry of pending) {
              // eslint-disable-next-line no-await-in-loop
              await registrarAuditoria(entry, tx);
            }
          });
        } catch (auditErr) {
          // A auditoria extra nunca esconde o erro de negócio original.
        }
      }
      // Limpezas que o serviço marcou para depois do rollback (ex.: arquivo gravado em disco antes do banco).
      const cleanups = currentTransaction && currentTransaction.afterRollbackCleanups;
      if (cleanups && cleanups.length) {
        for (const cleanup of cleanups) {
          try { await cleanup(); } catch (cleanupErr) { /* limpeza best-effort: nunca esconde o erro original */ }
        }
      }
      throw err;
    }
  };

  function runInTenantTransaction(fn, onTransaction) {
    return sequelize.transaction(async (transaction) => {
      onTransaction(transaction);
      // GAP REAL CORRIGIDO (load test real, 08/10/2026 — GATE-DB-09/DB-TS-015): os 3 SET LOCAL
      // eram 3 round-trips de rede SERIAIS até o Postgres (remoto) por requisição, antes de
      // qualquer query de negócio rodar. `set_config(..., true)` faz exatamente o mesmo efeito
      // de SET LOCAL (escopo da transação, `is_local=true`), mas os 3 cabem numa única ida —
      // reduz de 3 round-trips pra 1 sem mudar nenhuma policy de RLS (continuam lendo os
      // mesmos `current_setting('app.*', true)`).
      await sequelize.query(
        'SELECT set_config(\'app.group_id\', :groupId, true), set_config(\'app.company_id\', :companyId, true), set_config(\'app.user_id\', :userId, true)',
        { replacements: { groupId, companyId, userId }, transaction }
      );
      return fn(transaction);
    });
  }

  // Vínculo de arquivo: o ator só anexa arquivo que já pode ler (ver fileAttachGuard).
  return fileAttachGuard(req, res, next);
}

module.exports = tenantMiddleware;

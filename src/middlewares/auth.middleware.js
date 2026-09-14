'use strict';

const AppError = require('../utils/AppError');
const { verifyAccessToken } = require('../utils/jwt');

/**
 * Middleware de autenticação — extrai e valida o JWT de acesso do header
 * `Authorization: Bearer <token>`, populando `req.auth` com as claims resolvidas
 * no login (ver src/features/auth/auth.service.js):
 *
 *   req.auth = { userId, groupId, companyId, roles: string[], permissions: string[] }
 *
 * Fail closed (IAM-015): ausência de header, token malformado, assinatura inválida ou
 * token expirado sempre resultam em 401 — nunca em prosseguir sem identidade resolvida.
 * Deve ser montado em toda rota que não seja pública (health/ping/auth/login/refresh).
 *
 * FIX ADV-12 (homologação 10/09/2026): antes, revogar uma sessão (suspender usuário, logout
 * remoto) só impedia RENOVAR o token — um access token já emitido continuava funcionando
 * normalmente em toda rota até expirar sozinho (até 15 minutos), mesmo já revogado. Agora
 * checa `session_id` (claim adicionada em auth.service.js) a CADA requisição autenticada —
 * sessão revogada ou expirada derruba o acesso na hora, não só na próxima renovação.
 *
 * FIX (14/09/2026, achado ao trocar o usuário de banco de superusuário para privilégio mínimo
 * — TEC-03/04): a ressalva anterior deste comentário estava ERRADA. "core"."sessions" TEM RLS
 * por tenant (`tenant_isolation`, baseada em `company_id = current_setting('app.company_id')`
 * — ver migrations/20260101000072-create-core-sessions.js). A checagem abaixo fazia
 * `Session.findByPk` fora de qualquer transação com `SET LOCAL app.company_id`, porque
 * authMiddleware roda ANTES do tenantMiddleware — sob RLS real (sem bypass), isso significa
 * `current_setting('app.company_id')` vem NULL, a comparação `company_id = NULL` nunca é
 * verdadeira, e a busca sempre retorna vazio: toda sessão válida era tratada como inválida.
 * Isso ficou mascarado o tempo todo porque a conexão da aplicação era superusuário/BYPASSRLS.
 * Corrigido: como o JWT já carrega `group_id`/`company_id` nas claims (a própria identidade
 * que estamos validando), usamos esses valores para abrir uma transação curta com
 * `SET LOCAL` antes de buscar a sessão — sem isso, precisaríamos remover o RLS da tabela
 * (pior) ou usar uma segunda conexão privilegiada (reintroduziria o mesmo risco do TEC-03/04).
 */
async function authMiddleware(req, res, next) {
  const header = req.header('authorization') || req.header('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return next(AppError.unauthorized('Token de acesso ausente.', 'MISSING_ACCESS_TOKEN'));
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    return next(AppError.unauthorized('Token de acesso ausente.', 'MISSING_ACCESS_TOKEN'));
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    return next(err);
  }

  if (!payload.sub || !payload.group_id || !payload.company_id) {
    return next(
      AppError.unauthorized('Token de acesso não carrega contexto de tenant completo.', 'INVALID_ACCESS_TOKEN_CLAIMS')
    );
  }

  if (payload.session_id) {
    try {
      // require tardio pra evitar dependência circular (models -> ... -> middlewares).
      const { Session, sequelize } = require('../models');
      const session = await sequelize.transaction(async (transaction) => {
        await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: payload.group_id }, transaction });
        await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: payload.company_id }, transaction });
        return Session.findByPk(payload.session_id, { transaction });
      });
      if (!session || session.revokedAt || session.expiresAt < new Date()) {
        return next(AppError.unauthorized('Sessão inválida, expirada ou revogada.', 'SESSION_INVALID'));
      }
    } catch (err) {
      // Express 4 não captura rejeição de promise automaticamente em middleware async — sem
      // este catch, uma falha no banco aqui deixaria a requisição pendurada pra sempre em vez
      // de responder com erro (a mesma classe de problema corrigida no healthcheck, TEC-19).
      return next(err);
    }
  }
  // Tokens antigos (emitidos antes desta correção) não carregam session_id — continuam
  // válidos normalmente até expirar sozinhos (no máximo 15 minutos de vida restante),
  // sem quebrar quem já estava logado no momento do deploy.

  req.auth = {
    userId: payload.sub,
    groupId: payload.group_id,
    companyId: payload.company_id,
    roles: payload.roles || [],
    permissions: payload.permissions || [],
  };

  return next();
}

/**
 * Middleware factory de autorização por permissão granular (RBAC).
 * Uso: `router.post('/companies', authMiddleware, requirePermission('companies:create'), ...)`.
 * Fail closed: sem `req.auth` (auth.middleware não rodou antes) ou sem a permissão exata
 * na lista resolvida no login, a requisição é bloqueada com 403 — nunca com bypass silencioso.
 */
function requirePermission(permissionCode) {
  return function requirePermissionMiddleware(req, res, next) {
    if (!req.auth) {
      return next(AppError.unauthorized('Contexto de autenticação ausente.', 'AUTH_CONTEXT_MISSING'));
    }
    if (!req.auth.permissions.includes(permissionCode)) {
      return next(
        AppError.forbidden(
          `Permissão ausente: ${permissionCode}.`,
          'PERMISSION_DENIED',
          { required: permissionCode }
        )
      );
    }
    return next();
  };
}

/**
 * requireRecentMfa — gate de step-up MFA (Caderno técnico Nayara §3.3/3.4: "step-up MFA
 * para alteração bancária, aprovação de pagamento, ..."; "janela de MFA recente configurável
 * por risco"). Deve ser montado DEPOIS de authMiddleware + tenantMiddleware (precisa de
 * req.auth e req.withTenantTransaction).
 *
 * Fail closed: usuário sem MFA habilitado é bloqueado com mensagem explícita pedindo para
 * habilitar primeiro (nunca abre exceção silenciosa); usuário com MFA habilitado mas sem
 * verificação recente (dentro da janela de mfa.service.js) é bloqueado pedindo /mfa/verify.
 * A checagem em si vive em mfa.service.assertRecentMfa (reaproveitada também por
 * approvals.service.decideApprovalStep para o caso condicional a riskLevel HIGH/CRITICAL).
 */
function requireRecentMfa(req, res, next) {
  if (!req.auth) {
    return next(AppError.unauthorized('Contexto de autenticação ausente.', 'AUTH_CONTEXT_MISSING'));
  }
  if (!req.withTenantTransaction) {
    return next(
      AppError.forbidden('Contexto de tenant ausente para checagem de MFA (fail closed).', 'MFA_TENANT_CONTEXT_MISSING')
    );
  }
  // require tardio para evitar dependência circular (mfa.service -> models -> ...).
  const { assertRecentMfa } = require('../features/users/mfa.service');
  return req
    .withTenantTransaction((transaction) => assertRecentMfa(req.auth.userId, transaction))
    .then(() => next())
    .catch(next);
}

module.exports = { authMiddleware, requirePermission, requireRecentMfa };

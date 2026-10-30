'use strict';

const catchAsync = require('../../utils/catchAsync');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const shape = require('./impact.shape');
const token = require('./impact.token');
const input = require('./confirmation.input');
const errors = require('./confirmation.errors');
const { loadImpact } = require('./guard.load');

/**
 * Guarda de confirmação (M9-D852 §3.1): vem DEPOIS da permissão e do MFA da rota. Recalcula o impacto no servidor e:
 *  - impedimento -> 409 GOV_ACTION_BLOCKED (nada executa);
 *  - nível 2/3 sem a confirmação completa -> 422 GOV_CONFIRMATION_REQUIRED;
 *  - impactToken vencido, de outro registro/usuário ou de impacto diferente do atual -> 409 GOV_ACTION_IMPACT_CHANGED.
 * `mfa`: confere o MFA recente aqui (só quando a chamada é a ação perigosa). `reasonField`: campo do corpo que recebe a justificativa quando o serviço já pede o motivo. Passando, grava a auditoria `governance.action.confirmed` (com a justificativa) e deixa `req.confirmation` para o serviço da ação.
 */
function confirmAction(key, { resourceId = (req) => (req.params && req.params.id) || null, reasonField = null, extraBody = null, mfa = false } = {}) {
  const middleware = catchAsync(async (req, res, next) => {
    const id = resourceId(req);
    if (await require('../../features/core-governance/api-governance/standards/idempotency.middleware').hasStoredReplay(req)) return next();
    const loaded = await loadImpact(req, key, { id });
    if (loaded.skip) return next();
    const { entry, tenant, params, impact, level, code } = loaded;
    // MFA recente da ação (linha do inventário com MFA "sim" cuja rota só o exige em parte dos casos): conferido antes de mostrar impedimento ou pedir código.
    if (mfa) await req.withTenantTransaction((transaction) => require('../../features/users/mfa.service').assertRecentMfa(tenant.userId, transaction));
    if (impact.blockers.length > 0) throw errors.blocked(impact);

    const missing = input.check({ level, body: req.body, expectedCode: code, justificationMin: params.justificationMin });
    if (missing.length > 0) throw errors.required(level, missing);

    const confirmation = input.confirmationOf(req.body);
    if (level >= 2) {
      const binding = { actionKey: key, resourceId: id, companyId: tenant.companyId, userId: tenant.userId };
      const checked = token.verify(confirmation.impactToken, binding);
      if (!checked.ok && ['MALFORMED', 'SIGNATURE', 'BINDING'].includes(checked.reason)) throw errors.required(level, ['impactToken']);
      if (!checked.ok || checked.impactHash !== shape.hash(impact)) throw errors.impactChanged(checked.ok ? 'IMPACT_DIFFERS' : checked.reason);
    }

    const justification = input.text(confirmation.justification) || null;
    await req.withTenantTransaction((transaction) =>
      registrarAuditoria(
        {
          groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: tenant.userId, action: 'governance.action.confirmed', entityType: 'DestructiveAction', entityId: id && /^[0-9a-f-]{36}$/i.test(id) ? id : null,
          beforeJson: null, afterJson: { actionKey: key, row: entry.row, level, justification, recordCode: code, counts: impact.counts, totalAmountCents: impact.totalAmountCents },
          reason: `Ação "${entry.action}" confirmada (nível ${level})${justification ? `: ${justification}` : '.'}`,
        },
        transaction
      )
    );
    req.confirmation = { actionKey: key, level, justification, impact };
    // Serviços que já pedem o motivo no corpo (`reason`) recebem a justificativa confirmada; `extraBody` ajusta o que o serviço ainda exige (ex.: confirmDangerous).
    if (reasonField && justification && req.body && !req.body[reasonField]) req.body[reasonField] = justification;
    if (extraBody && req.body) Object.assign(req.body, extraBody);
    return next();
  });
  middleware.destructiveActionKey = key; // marca lida pela varredura do inventário (teste m9d852.inventario)
  middleware.confirmsMfa = mfa;
  return middleware;
}

module.exports = { confirmAction };

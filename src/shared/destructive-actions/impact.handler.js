'use strict';

const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const token = require('./impact.token');
const { loadImpact } = require('./guard.load');

/** Corpo da rota de impacto (M9-D852 §3.1): contagens, valor, impedimentos, itens afetados, impactToken e o que a tela deve exigir. */
function impactBody(key, loaded, impactToken) {
  const { entry, impact, level, code, params, label, notice } = loaded;
  return {
    actionKey: key,
    action: entry.action,
    counts: impact.counts,
    totalAmountCents: impact.totalAmountCents,
    blockers: impact.blockers,
    items: impact.items,
    impactToken,
    expiresInMinutes: params.ttlMinutes,
    level,
    mfaRequired: entry.mfa === 'sim',
    record: { id: loaded.id || null, code, label, codeLabel: entry.codeLabel },
    confirm: { understood: level >= 2, typedCode: level >= 3, justification: level >= 3, justificationMin: level >= 3 ? params.justificationMin : 0 },
    ...(notice ? { notice } : {}), // aviso claro da própria consulta (ex.: item de revisão não tem união)
  };
}

/** Handler de `/impact` (GET com :id ou POST sem id, conforme o inventário). Não grava nada. */
function impactHandler(key, { resourceId = (req) => (req.params && req.params.id) || null } = {}) {
  const handler = catchAsync(async (req, res) => {
    const id = resourceId(req);
    const loaded = await loadImpact(req, key, { preview: true, id });
    const impactToken = token.sign({ actionKey: key, resourceId: id, companyId: loaded.tenant.companyId, userId: loaded.tenant.userId }, loaded.impact, { ttlMinutes: loaded.params.ttlMinutes });
    return success(res, { data: impactBody(key, loaded, impactToken) });
  });
  handler.impactActionKey = key; // marca lida pela varredura do inventário
  return handler;
}

module.exports = { impactHandler, impactBody };

'use strict';

const { getSetting } = require('../../settings/settings.service');
const logger = require('../../../utils/logger');
const { isModuleEnabled, tenantFromAuth } = require('../governance.module');
const settings = require('./view.settings');
const { sensitiveFields, maskSpecs, registryMasker } = require('./view.fields');
const { collect, applyMask } = require('./view.scan');
const guardService = require('./guard.service');

/**
 * enforceViewPolicy(resourceType) — aplica a política de VIEW na resposta (M9-D825 §3.1). Envolve `res.json`: a resposta de sucesso é varrida atrás dos campos
 * HIGH e RESTRICTED do registro do tipo; para cada classe presente o guard decide VIEW (modo leve; audita e entrega o sinal de acesso). Decisão DENY (RESTRICTED sem
 * `governance:dlp:view-restricted`, ou política que nega) devolve o campo MASCARADO, nunca em claro. Falha ao decidir: HIGH e RESTRICTED saem em máscara TOTAL (falha
 * fechada) e LOW e MEDIUM, que não passam por aqui, seguem livres, com alerta no log. Módulo DLP desligado para a empresa: a resposta segue como está.
 */
const clone = (body) => JSON.parse(JSON.stringify(body));

async function loadState(req, resourceType) {
  const tenant = tenantFromAuth(req);
  return req.withTenantTransaction(async (transaction) => ({
    enabled: await isModuleEnabled('dlp', tenant, transaction),
    fields: await sensitiveFields(tenant, resourceType, transaction),
    mask: await maskSpecs(tenant, resourceType, transaction),
    tenant,
    keep: settings.maskTailOf(await getSetting(settings.MASK_TAIL_KEY, tenant, transaction, settings.VIEW_SETTING_DEFAULTS[settings.MASK_TAIL_KEY])),
  }));
}

/** Decide a classe presente: true quando o valor sai em claro, false quando sai mascarado. Erro: relança para o chamador aplicar a falha fechada. */
async function decideClear(req, resourceType, classification, info) {
  const decision = await guardService.decide(tenantFromAuth(req), {
    actorUserId: req.auth.userId, action: 'VIEW', resourceType, resourceIds: info.ids.length ? info.ids : undefined, minClassification: classification,
    permissions: req.auth.permissions, ip: req.ip,
  });
  return decision.decision === 'ALLOW';
}

/** Corpo pronto para sair (cópia mascarada quando preciso). Nunca rejeita: qualquer falha vira máscara total das classes sensíveis do tipo. */
async function protect(req, resourceType, body) {
  let state;
  try {
    state = await loadState(req, resourceType);
  } catch (error) {
    logger.error({ err: error, resourceType }, 'dlp: falha ao ler o registro de campos sensíveis; resposta mascarada por falha fechada');
    const fields = await sensitiveFields({ groupId: null, companyId: null }, resourceType, null).catch(() => ({}));
    const failClosed = clone(body);
    applyMask(failClosed, fields, ['HIGH', 'RESTRICTED'], { keep: 0, full: true });
    return failClosed;
  }
  if (!state.enabled || !Object.keys(state.fields).length) return body;
  const out = clone(body);
  const found = collect(out, state.fields);
  const masked = []; const failed = [];
  for (const [classification, info] of Object.entries(found)) {
    try {
      if (!(await decideClear(req, resourceType, classification, info))) masked.push(classification);
    } catch (error) {
      logger.error({ err: error, resourceType, classification }, 'dlp: falha ao consultar a política de VIEW; campos sensíveis mascarados por falha fechada');
      failed.push(classification);
    }
  }
  if (masked.length) {
    applyMask(out, state.fields, masked, { keep: state.keep, full: false, specs: state.mask.specs, masker: registryMasker(), ctx: { companyId: state.tenant.companyId, maskText: state.mask.maskText } });
  }
  if (failed.length) applyMask(out, state.fields, failed, { keep: 0, full: true });
  return masked.length || failed.length ? out : body;
}

const worth = (res, body) => res.statusCode < 400 && body && typeof body === 'object' && body.success === true && body.data !== null && body.data !== undefined;

function enforceViewPolicy(resourceType) {
  return function viewPolicy(req, res, next) {
    const original = res.json.bind(res);
    res.json = function jsonWithViewPolicy(body) {
      if (!req.auth || typeof req.withTenantTransaction !== 'function' || !worth(res, body)) return original(body);
      protect(req, resourceType, body).then(original, (error) => {
        logger.error({ err: error, resourceType }, 'dlp: falha inesperada na política de VIEW');
        res.status(500);
        original({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Erro interno.' } });
      });
      return res;
    };
    next();
  };
}

module.exports = { enforceViewPolicy, protect };

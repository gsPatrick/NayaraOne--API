'use strict';

const crypto = require('node:crypto');
const { getSetting } = require('../../settings/settings.service');
const { PROVIDER_KEYS, PROVIDER_SETTING_DEFAULTS } = require('../providers/providers.settings');
const { ROUTER_VERSION } = require('../providers/routerVersion');
const { PATTERN_LIST_VERSION } = require('../orchestrator/injectionDetector');
const { REGRESSION_KEYS, REGRESSION_SETTING_DEFAULTS, AUTO_MODEL } = require('./regression.settings');

/**
 * `global_hash` da regressão (M9-D033): hash do provedor e do modelo padrão da empresa, da versão do roteador e da versão dos
 * padrões de injeção. É calculado na hora, nunca gravado na linha do agente; só as avaliações o guardam em `metrics`.
 * Mudar qualquer um dos quatro muda o hash e passa a exigir nova avaliação para homologar ou ativar OUTRA versão; versão ACTIVE
 * não muda de estado.
 */
const versions = { router: () => ROUTER_VERSION, injection: () => PATTERN_LIST_VERSION };

/** Gancho de teste: troca a fonte de uma das duas versões (roteador ou padrões de injeção); devolve a função que restaura. */
function overrideVersions(patch) {
  const before = { ...versions };
  Object.assign(versions, patch);
  return () => Object.assign(versions, before);
}

async function readDefaultPair(ctx, transaction) {
  const provider = String(await getSetting(PROVIDER_KEYS.defaultProvider, ctx, transaction, PROVIDER_SETTING_DEFAULTS[PROVIDER_KEYS.defaultProvider]));
  const model = String(await getSetting(REGRESSION_KEYS.defaultModel, ctx, transaction, REGRESSION_SETTING_DEFAULTS[REGRESSION_KEYS.defaultModel]));
  return { provider, model: model === AUTO_MODEL ? null : model };
}

const sha256 = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

async function computeGlobalHash(ctx, transaction) {
  const pair = await readDefaultPair(ctx, transaction);
  return sha256(JSON.stringify({ provider: pair.provider, model: pair.model, router: versions.router(), injection: versions.injection() }));
}

module.exports = { computeGlobalHash, readDefaultPair, overrideVersions };

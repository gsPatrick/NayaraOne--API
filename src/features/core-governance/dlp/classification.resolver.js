'use strict';

const { getSetting } = require('../../settings/settings.service');
const settings = require('./dlp.settings');
const { highestClass } = require('./dlp.constants');

/**
 * Resolvedor de classificação (M9-D821 etapa 1). Enquanto o registro de classificação (M9-D910) não existe, o resolvedor é um STUB que devolve a classe
 * padrão `governanca.dlp.classificacao_padrao` (HIGH) para todo recurso. M9-D910 e M9-D915 substituem o stub chamando `setResolver` com a mesma assinatura:
 *   resolver(tenant, resources, transaction) -> Promise<string[]>  (uma classe por recurso pedido)
 */
async function stubResolver(tenant, resources, transaction) {
  const value = await getSetting(settings.DEFAULT_CLASS_KEY, tenant, transaction, settings.DLP_SETTING_DEFAULTS[settings.DEFAULT_CLASS_KEY]);
  const fallback = settings.parseDefaultClass(value);
  return (resources && resources.length ? resources : [null]).map(() => fallback);
}

let current = stubResolver;
const setResolver = (fn) => { current = fn; };
const resetResolver = () => { current = stubResolver; };

/** A classificação MAIS ALTA entre os recursos pedidos; sem recurso, a classe padrão. */
async function resolveClassification(tenant, resources, transaction) {
  const classes = await current(tenant, resources, transaction);
  return highestClass(classes) || stubResolver(tenant, [], transaction).then(([only]) => only);
}

module.exports = { resolveClassification, setResolver, resetResolver, stubResolver };

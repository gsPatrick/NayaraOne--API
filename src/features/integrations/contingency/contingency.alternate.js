'use strict';

const { IntegrationConnection, IntegrationProvider } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { getCurrentHealth } = require('../health/healthQuery');
const { supportsOperation } = require('../dispatch/enqueue/resolveTarget');

const naoElegivel = (motivo) => AppError.conflict('O fornecedor alternativo não é elegível para esta operação.', 'INTEGRATION_ALTERNATE_NOT_ELIGIBLE', { motivo });

/**
 * Elegibilidade do alternativo (M9-D226 3.3 item 2): mesma família e mesmo ambiente do principal, ACTIVE, liberado para produção (quando o ambiente
 * é PRODUCTION), circuito CLOSED e com a capability da operação (no catálogo e no adapter instalado). Devolve { connection } ou { motivo }.
 * `opts.crossDomain` aceita o alternativo de outra família (a do domínio informado) para o canal alternativo do contato.
 */
async function checkAlternate(ctx, primary, alternateId, operation, now, transaction, { crossDomain } = {}) {
  if (!alternateId) return { motivo: 'SEM_ALTERNATIVO_NA_POLITICA' };
  if (alternateId === primary.id) return { motivo: 'IGUAL_AO_PRINCIPAL' };
  const alt = await IntegrationConnection.findOne({ where: { id: alternateId, companyId: ctx.companyId }, transaction });
  if (!alt) return { motivo: 'NAO_ENCONTRADO' };
  const [provider, principal] = await Promise.all([
    IntegrationProvider.findByPk(alt.providerCode, { transaction }), IntegrationProvider.findByPk(primary.providerCode, { transaction }),
  ]);
  // `crossDomain`: o alternativo é de OUTRA família de propósito (WhatsApp fora, e-mail do contato: M9-D227); `operation` é então a do alternativo.
  if (!provider || !principal || provider.domain !== (crossDomain || principal.domain)) return { motivo: 'OUTRA_FAMILIA' };
  if (alt.environment !== primary.environment) return { motivo: 'OUTRO_AMBIENTE' };
  if (alt.status !== 'ACTIVE') return { motivo: 'NAO_ATIVO' };
  if (alt.environment === 'PRODUCTION' && !alt.productionReleasedAt) return { motivo: 'NAO_LIBERADO_PARA_PRODUCAO' };
  if (!supportsOperation(provider, operation)) return { motivo: 'SEM_CAPABILITY' };
  const saude = await getCurrentHealth(alt.id, ctx, transaction, { now });
  if (saude.circuitState !== 'CLOSED') return { motivo: 'CIRCUITO_NAO_FECHADO' };
  return { connection: alt };
}

/** Igual a checkAlternate, mas recusa com 409 INTEGRATION_ALTERNATE_NOT_ELIGIBLE (troca pedida por uma pessoa). */
async function assertAlternate(ctx, primary, alternateId, operation, now, transaction, opts) {
  const r = await checkAlternate(ctx, primary, alternateId, operation, now, transaction, opts);
  if (!r.connection) throw naoElegivel(r.motivo);
  return r.connection;
}

module.exports = { checkAlternate, assertAlternate };

'use strict';

const { POLICY_IMMEDIATE } = require('./seo.settings');

/**
 * M9-D427 regra 4 — ciclo de vida da página do imóvel. O estado nasce das duas situações do cadastro; a decisão (200, 301 ou 410) é função
 * pura do estado, dos dias corridos desde a mudança (no fuso da empresa) e dos parâmetros `marketing.seo.*`:
 *  - ATIVO: 200, indexável;
 *  - VENDIDO / ALUGADO: SELO_E_REDIRECT = 200 com selo e noindex até `dias_selo_vendido` dias depois do dia da venda (inclusive) e depois 301 para a
 *    listagem do bairro/tipo; REDIRECT_IMEDIATO = 301 desde o dia da venda;
 *  - REMOVIDO (retirado do mercado sem venda): 410 Gone a partir de `dias_removido` dias (padrão 0); antes disso 200 noindex. NUNCA 301.
 */
const STATES = Object.freeze({ ACTIVE: 'ATIVO', SOLD: 'VENDIDO', RENTED: 'ALUGADO', REMOVED: 'REMOVIDO' });

/** Estado da página a partir de publication_status e availability_status do imóvel. */
function lifecycleStateOf({ publication_status: publication, availability_status: availability }) {
  if (availability === 'SOLD') return STATES.SOLD;
  if (availability === 'RENTED') return STATES.RENTED;
  if (availability === 'AVAILABLE' && publication === 'PUBLISHED') return STATES.ACTIVE;
  return STATES.REMOVED;
}

const SELO = Object.freeze({ [STATES.SOLD]: 'Vendido', [STATES.RENTED]: 'Alugado' });

/** { http, state, selo, indexable, redirect } — `redirect` = 'LISTING' quando o destino é a listagem do bairro/tipo. */
function decideLifecycle({ state, daysSince, config }) {
  if (state === STATES.ACTIVE) return { http: 200, state, selo: null, indexable: true, redirect: null };
  if (state === STATES.REMOVED) {
    return daysSince >= config.removedDays
      ? { http: 410, state, selo: null, indexable: false, redirect: null }
      : { http: 200, state, selo: null, indexable: false, redirect: null };
  }
  const immediate = config.soldPolicy === POLICY_IMMEDIATE;
  if (immediate || daysSince > config.soldDays) return { http: 301, state, selo: null, indexable: false, redirect: 'LISTING' };
  return { http: 200, state, selo: SELO[state], indexable: false, redirect: null };
}

module.exports = { STATES, lifecycleStateOf, decideLifecycle };

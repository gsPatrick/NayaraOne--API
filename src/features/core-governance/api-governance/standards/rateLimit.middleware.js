'use strict';

const logger = require('../../../../utils/logger');
const { identify } = require('./rateLimit.identity');
const { limitFor } = require('./rateLimit.limits');
const counter = require('./rateLimit.counter');
const { rateLimited } = require('./standards.errors');

/**
 * Limite de requisições por credencial (M9-D843 §3.1), montado no topo das rotas da API. Cabeçalhos em toda resposta: X-RateLimit-Limit, X-RateLimit-Remaining e X-RateLimit-Reset
 * (epoch, fim da janela). Excesso: 429 GOV_RATE_LIMITED com Retry-After em segundos. O contador está no banco (vale entre processos). Se o contador falhar, a requisição passa
 * (o limite nunca derruba a API) e o fato vai para o log. Fora do limite: health/ping e /public/share (que tem o contador por IP próprio da M9-D823).
 * `API_RATE_LIMIT_DISABLED=true` desliga no processo (testes de carga); o administrador desliga por empresa em governanca.api.rate_limit.habilitado.
 */
const SKIPPED = /^\/(v1\/)?(health|ping)(\/|$)|^\/v1\/public\/share(\/|$)|^\/metrics$/;

/** Webhooks de fornecedor (M9-D211): têm a classe de limite própria WEBHOOK, por IP e fornecedor e com falha fechada, aplicada pela rota; aqui não contam como acesso anônimo. */
const WEBHOOK_ROUTE = /^\/(v1\/)?webhooks\/[^/]+\/[^/]+\/?$|^\/v1\/(legal\/webhooks\/clicksign|finance\/webhooks\/bank-payment|procurement\/webhooks\/insurance|correspondent\/webhooks\/financing\/[^/]+)\/?$/;

/** Desligado no processo por API_RATE_LIMIT_DISABLED=true; na suíte de testes (NODE_ENV=test) fica desligado, salvo API_RATE_LIMIT_ENABLED=true (os testes do limite ligam). */
const disabledInProcess = () => process.env.API_RATE_LIMIT_DISABLED === 'true' || (process.env.NODE_ENV === 'test' && process.env.API_RATE_LIMIT_ENABLED !== 'true');

async function rateLimitMiddleware(req, res, next) {
  if (disabledInProcess() || SKIPPED.test(req.path) || WEBHOOK_ROUTE.test(req.path)) return next();
  try {
    const identity = identify(req);
    const { enabled, limit } = await limitFor(identity);
    if (!enabled) return next();
    const state = await counter.hit(identity.scopeKey);
    res.set({ 'X-RateLimit-Limit': String(limit), 'X-RateLimit-Remaining': String(Math.max(0, limit - state.count)), 'X-RateLimit-Reset': String(state.resetAt) });
    if (state.count > limit) {
      res.set('Retry-After', String(state.retryAfter));
      return next(rateLimited(state.retryAfter));
    }
    return next();
  } catch (err) {
    logger.warn({ err: err.message }, 'rateLimit.counter.failed');
    return next();
  }
}

module.exports = { rateLimitMiddleware, disabledInProcess };

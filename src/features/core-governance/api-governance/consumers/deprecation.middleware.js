'use strict';

const logger = require('../../../../utils/logger');
const E = require('./consumers.errors');
const { splitVersioned, methodOf } = require('./target');
const { resolveCaller } = require('./caller');
const { track } = require('./usage');

/**
 * Deprecação nas respostas (M9-D841 §3.3), montado no topo das rotas da API. Para a empresa de quem chama (token ou credencial externa), toda resposta de rota deprecada leva
 * `Deprecation: @<epoch de announced_at>` (RFC 9745), `Sunset: <data HTTP>` e `Link: <replacement>; rel="successor-version"`. Depois de `sunset_at` a rota responde 410 GOV_API_VERSION_SUNSET,
 * decidido pelo relógio (não pelo `status`, que o job diário atualiza). Vale a deprecação de desligamento mais próximo entre as que casam (rota ou major). As rotas /api-governance
 * nunca são desligadas (é por elas que se gere a deprecação). Falha de leitura deixa a requisição passar (log). Na suíte (NODE_ENV=test) fica desligado, salvo API_DEPRECATION_ENABLED=true;
 * API_DEPRECATION_DISABLED=true desliga no processo.
 */
const SKIPPED = /^\/(health|ping|metrics)(\/|$)|^\/v\d+\/public(\/|$)/;
const EXEMPT_FROM_SUNSET = /^\/api-governance(\/|$)/;

const disabledInProcess = () => process.env.API_DEPRECATION_DISABLED === 'true' || (process.env.NODE_ENV === 'test' && process.env.API_DEPRECATION_ENABLED !== 'true');

function matching(ctx, req, split) {
  const method = methodOf(req);
  return ctx.deprecations.filter((row) => (row.match.major !== undefined ? row.match.major === split.major : row.match.method === method && row.match.regex.test(split.path)));
}

function applyHeaders(res, row) {
  res.set('Deprecation', `@${Math.floor(row.announcedMs / 1000)}`);
  res.set('Sunset', new Date(row.sunsetMs).toUTCString());
  if (row.replacement) res.append('Link', `<${row.replacement}>; rel="successor-version"`);
}

async function deprecationMiddleware(req, res, next) {
  if (disabledInProcess() || SKIPPED.test(req.path)) return next();
  const split = splitVersioned(req.path);
  if (!split) return next();
  try {
    const caller = await resolveCaller(req);
    if (!caller) return next();
    const now = Date.now();
    const started = matching(caller.ctx, req, split).filter((row) => row.announcedMs <= now).sort((a, b) => a.sunsetMs - b.sunsetMs);
    if (started.length) {
      applyHeaders(res, started[0]);
      if (started[0].sunsetMs <= now && !EXEMPT_FROM_SUNSET.test(split.path)) return next(E.versionSunset());
    }
    track(req, res, caller, split);
    return next();
  } catch (err) {
    logger.warn({ err: err.message }, 'apiDeprecation.middleware.failed');
    return next();
  }
}

module.exports = { deprecationMiddleware };

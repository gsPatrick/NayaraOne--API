'use strict';

const E = require('./clients.errors');

/** Rotas externas que NÃO levam scope: só a emissão do token (é onde o scope nasce). Lista fechada. */
const PUBLIC_EXTERNAL_ROUTES = Object.freeze(['POST /api-external/oauth/token']);

/** Cada rota do router (`METHOD /caminho`) com o scope que declara (ou null). */
function describeRoutes(router) {
  return router.stack.filter((layer) => layer.route).flatMap((layer) => Object.keys(layer.route.methods).map((method) => {
    const scope = layer.route.stack.map((handler) => handler.handle && handler.handle.requiredScope).find(Boolean) || null;
    return { key: `${method.toUpperCase()} ${layer.route.path}`, scope };
  }));
}

/** Varredura (M9-D844 §3.3): as rotas externas sem scope declarado, fora da lista fechada. */
const routesWithoutScope = (router) => describeRoutes(router).filter((route) => !route.scope && !PUBLIC_EXTERNAL_ROUTES.includes(route.key)).map((route) => route.key);

/** Reprova (500 GOV_EXTERNAL_ROUTE_WITHOUT_SCOPE) quando alguma rota externa não declara scope. Roda ao montar o router: a API nem sobe com rota sem scope. */
function assertAllRoutesDeclareScope(router) {
  const missing = routesWithoutScope(router);
  if (missing.length) throw E.routeWithoutScope(missing);
}

module.exports = { PUBLIC_EXTERNAL_ROUTES, describeRoutes, routesWithoutScope, assertAllRoutesDeclareScope };

'use strict';

/**
 * Regra 7 — "Não liberar drill-down/export sem permissão". Percorre cada rota do router de BI cujo caminho tem `/drilldown` ou
 * `/exports` e chama sem NENHUMA permissão: a resposta tem de ser 403. `call(method, path)` é injetado (teste usa servidor real).
 */
const { listAnalyticsRoutes } = require('../../../src/features/analytics/readOnly/readOnly.routeInventory');
const { violation } = require('./files');

const SENSITIVE = /\/(?:drilldown|exports)(?:\/|$)/;

const sensitiveRoutes = (router) => listAnalyticsRoutes(router).filter((r) => SENSITIVE.test(r.path));

async function checkRule7(router, call) {
  const routes = sensitiveRoutes(router);
  const out = [];
  for (const route of routes) {
    const url = route.path.replace(/:[A-Za-z_]+/g, 'x');
    const res = await call(route.method, url);
    if (res.status !== 403) out.push(violation(7, `${route.method} ${route.path}`, `Sem permissão a rota respondeu ${res.status}; o esperado é 403.`));
  }
  return { scanned: routes.length, violations: out };
}

module.exports = { checkRule7, sensitiveRoutes };

'use strict';

// Apoio dos testes M9-D852 (não é teste): lista as rotas registradas no Express com as marcas do guarda de confirmação e da rota de impacto.
function collect(stack, out = []) {
  for (const layer of stack) {
    if (layer.route) {
      const handlers = layer.route.stack.map((l) => l.handle);
      out.push({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods).map((m) => m.toUpperCase()),
        guards: handlers.map((h) => h.destructiveActionKey).filter(Boolean),
        mfa: handlers.includes(require('../../../src/middlewares/auth.middleware').requireRecentMfa) || handlers.some((h) => h.confirmsMfa === true),
        impacts: handlers.map((h) => h.impactActionKey).filter(Boolean),
      });
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      collect(layer.handle.stack, out);
    }
  }
  return out;
}

/** Todas as rotas da API (o agregador src/routes). */
const allRoutes = () => collect(require('../../../src/routes').stack);

const find = (routes, method, path) => routes.filter((r) => r.path === path && r.methods.includes(method));

module.exports = { allRoutes, find };

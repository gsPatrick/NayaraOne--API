'use strict';

/**
 * M9-D612 (3.3) — varredura das rotas registradas num router do Express 4: lista método, caminho completo e se a rota está
 * atrás da guarda de somente leitura (middleware marcado `isAnalyticsReadOnlyGuard` montado antes, em prefixo que a cobre).
 * Usada pelo teste de varredura e por qualquer verificação de CI; não altera o router.
 */
function mountPrefix(layer) {
  if (layer.regexp?.fast_slash) return '';
  return layer.regexp.source
    .replace('^', '')
    .replace('\\/?(?=\\/|$)', '')
    .replace(/\(\?:\(\[\^\\\/]\+\?\)\)/g, ':param')
    .replace(/\\\//g, '/');
}

function walk(stack, prefix, guards, out) {
  for (const layer of stack) {
    if (layer.route) {
      const fullPath = `${prefix}${layer.route.path}`;
      const guarded = guards.some((g) => fullPath === g || fullPath.startsWith(`${g}/`));
      for (const method of Object.keys(layer.route.methods)) {
        out.push({ method: method.toUpperCase(), path: fullPath, guarded });
      }
    } else if (layer.handle?.isAnalyticsReadOnlyGuard) {
      guards.push(`${prefix}${mountPrefix(layer)}`);
    } else if (layer.handle?.stack) {
      walk(layer.handle.stack, `${prefix}${mountPrefix(layer)}`, guards, out);
    }
  }
  return out;
}

function listAnalyticsRoutes(router) {
  return walk(router.stack, '', [], []);
}

module.exports = { listAnalyticsRoutes };

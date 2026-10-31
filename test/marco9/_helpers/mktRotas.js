'use strict';

// Apoio dos testes de segurança do Marketing (M9-D441, não é teste): todas as rotas /marketing/* do Express com a permissão exigida (marca `requiredPermission` do middleware).
function walk(stack, out) {
  for (const layer of stack) {
    if (layer.route) {
      const marked = layer.route.stack.map((l) => l.handle).find((h) => h && h.requiredPermission);
      for (const method of Object.keys(layer.route.methods)) out.push({ method: method.toUpperCase(), path: layer.route.path.replace(/^\/v1(?=\/)/, ''), permission: marked ? marked.requiredPermission : null });
    } else if (layer.handle && Array.isArray(layer.handle.stack)) walk(layer.handle.stack, out);
  }
  return out;
}

const marketingRoutes = () => walk(require('../../../src/routes').stack, []).filter((r) => r.path.startsWith('/marketing'));
/** O caminho com os parâmetros trocados por um uuid inexistente (a porta de permissão responde antes de qualquer busca). */
const concrete = (path, id) => path.replace(/:[A-Za-z]+/g, id);

module.exports = { marketingRoutes, concrete };

'use strict';

// Apoio dos testes M9-D435 (não é teste): a permissão que cada rota de Marketing exige, lida da marca `requiredPermission` que o middleware de permissão do Marketing deixa.
function walk(stack, out) {
  for (const layer of stack) {
    if (layer.route) {
      const handlers = layer.route.stack.map((l) => l.handle);
      const marked = handlers.find((h) => h && h.requiredPermission);
      for (const method of Object.keys(layer.route.methods)) out.push({ key: `${method.toUpperCase()} ${layer.route.path.replace(/^\/v1(?=\/)/, '')}`, permission: marked ? marked.requiredPermission : null });
    } else if (layer.handle && Array.isArray(layer.handle.stack)) walk(layer.handle.stack, out);
  }
  return out;
}

/** Permissão exigida pela rota "MÉTODO caminho" (null = pública ou sem marca). */
function requiredPermissionOf(key) {
  const rows = walk(require('../../../src/routes').stack, []);
  const row = rows.find((r) => r.key === key);
  if (!row) throw new Error(`rota não encontrada: ${key}`);
  return row.permission;
}

module.exports = { requiredPermissionOf };

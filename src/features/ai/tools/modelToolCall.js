'use strict';

// M9-D016 — o pedido de tool que vem do modelo. O servidor só lê `name` e `arguments`: qualquer outro campo (permissionCode,
// riskLevel, requiresHumanApproval em qualquer grafia, ou campo inventado) é descartado e listado em `discarded`, que vira a
// contagem de tentativa de override da M9-D021. Permissão, risco e aprovação vêm sempre da definição registrada.

const PERMITIDOS = new Set(['name', 'arguments']);
const IDENTIFICADOR_DO_PROVIDER = new Set(['id']);

function sanitizeModelToolCall(bruta) {
  const origem = bruta && typeof bruta === 'object' && !Array.isArray(bruta) ? bruta : {};
  const discarded = Object.keys(origem).filter((k) => !PERMITIDOS.has(k) && !IDENTIFICADOR_DO_PROVIDER.has(k));
  const argumentos = origem.arguments === undefined || origem.arguments === null ? {} : origem.arguments;
  return { name: typeof origem.name === 'string' ? origem.name : '', arguments: argumentos, discarded };
}

module.exports = { sanitizeModelToolCall };

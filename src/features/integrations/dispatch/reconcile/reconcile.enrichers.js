'use strict';

/**
 * Dados extras que um domínio entrega às consultas de reconciliação (M9-D215/M9-D239): por exemplo, as redes sociais informam a janela de
 * dias e o texto para comparar com os posts recentes da conta. Registrado por domínio do catálogo; o motor só repassa o que vier.
 * Contrato: ({ ctx, dispatch, transaction }) -> objeto simples (somem os valores indefinidos).
 */
const enrichers = new Map();

function registerReconcileEnricher(domain, fn) {
  if (typeof fn !== 'function') enrichers.delete(String(domain));
  else enrichers.set(String(domain), fn);
}

async function enrichFor(domain, args) {
  const fn = enrichers.get(String(domain));
  if (!fn) return {};
  try { return (await fn(args)) || {}; } catch { return {}; }
}

module.exports = { registerReconcileEnricher, enrichFor };

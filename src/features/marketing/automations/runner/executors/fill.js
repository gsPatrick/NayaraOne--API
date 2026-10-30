'use strict';

const ports = require('../runner.ports');

const MARKER_RE = /\{([a-z_][a-z0-9_]*)\}/gi;
/** Marcadores que outro mecanismo preenche (o link, de `linkProvider`): ficam intactos aqui e não contam como faltando. */
const OTHER_MARKERS = Object.freeze(['link']);

/** Preenche os marcadores `{chave}` do texto com as variáveis do provedor; devolve o texto e as chaves que ficaram sem valor (texto com marcador cru nunca sai). */
function fillMarkers(text, vars) {
  const missing = [];
  const out = String(text).replace(MARKER_RE, (all, key) => {
    if (OTHER_MARKERS.includes(key)) return all;
    const value = vars && vars[key];
    if (value === undefined || value === null || value === '') { missing.push(key); return all; }
    return String(value);
  });
  return { text: out, missing };
}

/** Variáveis do provedor nomeado na ação (`variablesProvider`), lidas na hora da execução; sem provedor, nenhuma. */
async function variablesFor(ctx) {
  const { def, subject } = ctx;
  if (!def.variablesProvider) return {};
  return ports.variablesOfProvider(def.variablesProvider, { tenant: ctx.tenant, transaction: ctx.transaction, personId: subject ? subject.id : null, event: ctx.event });
}

module.exports = { fillMarkers, variablesFor };

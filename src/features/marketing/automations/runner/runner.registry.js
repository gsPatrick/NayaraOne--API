'use strict';

/**
 * M9-D422/D423 — registros que as automações do Marketing usam para se ligar ao runner sem que ele conheça cada uma:
 *  - filtro de gatilho (`trigger_config.filter`): decide ANTES da run se o evento interessa à automação (ex.: só contrato de locação, só com a cadência de locação ligada).
 *    Filtro desconhecido não passa (falha fechada); o evento que não passa não gera run;
 *  - expansão da agenda (`trigger_config.expand`): um tick de agenda vira um evento por item (ex.: uma run por pendência aberta), cada um com sujeito e eventId próprios.
 */
const filters = new Map();
const expanders = new Map();

const check = (name, fn) => { if (!name || typeof fn !== 'function') throw new TypeError('Informe o nome e a função.'); };
function registerTriggerFilter(name, fn) { check(name, fn); filters.set(name, fn); }
function registerScheduleExpander(name, fn) { check(name, fn); expanders.set(name, fn); }

/** O evento passa pelo filtro da versão? Sem filtro na versão, sempre. */
async function passesFilter(cand, ctx) {
  const name = cand.version.triggerConfig && cand.version.triggerConfig.filter;
  if (!name) return true;
  const fn = filters.get(name);
  return fn ? Boolean(await fn(cand, ctx)) : false;
}

const expanderOf = (cand) => {
  const name = cand.version.triggerConfig && cand.version.triggerConfig.expand;
  return name ? expanders.get(name) || (async () => []) : null;
};

module.exports = { registerTriggerFilter, registerScheduleExpander, passesFilter, expanderOf };

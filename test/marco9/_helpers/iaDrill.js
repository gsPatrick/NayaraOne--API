'use strict';

// M9-D046 — roda um cenário de failure drill (scripts/ai-drill/cenarios) no banco do teste e devolve o registro; `exigirVerde` lista as checagens vermelhas.
const assert = require('node:assert/strict');
const F = require('./advFixtures');
const { executarCenario } = require('../../../scripts/ai-drill/lib/runner');

let ambiente;
async function preparar() {
  if (!ambiente) ambiente = await F.empresas();
  return { F, ...ambiente };
}

async function rodarDrill(cenario) {
  return executarCenario(cenario, await preparar());
}

function exigirVerde(registro) {
  const ruins = registro.checagens.filter((c) => !c.ok).map((c) => `${c.nome}${c.detalhe ? ` (${c.detalhe})` : ''}`);
  assert.deepEqual(ruins, [], `drill ${registro.drill} com checagens vermelhas`);
  assert.equal(registro.ok, true);
  assert.ok(registro.checagens.length >= 3, 'o drill confere o resultado esperado em mais de um ponto');
  assert.match(registro.executadoEm, /^\d{4}-\d{2}-\d{2}T/, 'registro com data');
}

module.exports = { rodarDrill, exigirVerde, preparar, F };

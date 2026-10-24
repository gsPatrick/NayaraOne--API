'use strict';

// Marco 8 — APIs mínimas do Guia do Marcelo, com o método e a permissão do caderno.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const correspondentRouter = require('../../src/features/correspondent/correspondent.routes');
const { sequelize } = require('../testHelpers');

after(async () => {
  await sequelize.close();
});

function rotas(router) {
  const lista = [];
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    const metodos = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]).map((m) => m.toUpperCase());
    for (const metodo of metodos) lista.push(`${metodo} ${layer.route.path}`);
  }
  return lista;
}

const MINIMAS = [
  'POST /financing-cases',
  'POST /financing-cases/:id/documents',
  'POST /financing-cases/:id/simulations',
  'POST /financing-cases/:id/submissions',
  'GET /financing-cases/:id/status',
  'POST /financing-cases/:id/appraisals',
  'GET /financing-cases/:id/commissions',
];

test('M8-API-01: as APIs mínimas do caderno estão registradas', () => {
  const lista = rotas(correspondentRouter);
  for (const rota of MINIMAS) {
    assert.ok(lista.includes(rota), `faltou ${rota}; rotas: ${lista.join(', ')}`);
  }
  const index = fs.readFileSync(path.join(__dirname, '../../src/routes/index.js'), 'utf8');
  assert.match(index, /router\.post\('\/v1\/correspondent\/webhooks\/financing\/:provider'/);
});

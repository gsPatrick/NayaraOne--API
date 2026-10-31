'use strict';

// Teste do detector de ponto exato: pega o par exato e a coordenada completa em texto; não dá falso positivo com a coordenada pública aproximada.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { temPontoExato } = require('./pontoExato');
const { EXATO } = require('./intReadModel');

test('detecta o par lat/lng exato, em número, em texto e aninhado', () => {
  assert.equal(temPontoExato({ a: [{ lat: EXATO.lat, lng: EXATO.lng }] }), true);
  assert.equal(temPontoExato({ geo: { lat: String(EXATO.lat), lng: String(EXATO.lng) } }), true);
  assert.equal(temPontoExato(`ponto ${EXATO.lat},${EXATO.lng}`), true);
});

test('não acusa a coordenada aproximada nem valores vazios', () => {
  assert.equal(temPontoExato({ lat: -25.42841, lng: -49.27331 }), false);
  assert.equal(temPontoExato({ lat: EXATO.lat, lng: -49.2999 }), false);
  assert.equal(temPontoExato('-25.4284123'), false);
  [null, undefined, 0, '', [], {}].forEach((v) => assert.equal(temPontoExato(v), false));
});

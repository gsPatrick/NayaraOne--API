'use strict';

// M9-D801 — o teste HTTP do calendário não usa porta fixa (a 21651 colidia com outros testes e deixava o login bater em servidor alheio).
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { portaLivre } = require('../_helpers/portaLivre');

const httpTest = fs.readFileSync(path.join(__dirname, '../../m9d801.calendario.http.test.js'), 'utf8');

test('m9d801 o teste HTTP escolhe porta efêmera e não tem número de porta fixo', () => {
  assert.doesNotMatch(httpTest, /process\.env\.PORT\s*=\s*[^;]*['"]\d{4,5}['"]/);
  assert.match(httpTest, /portaLivre\(\)/);
});

test('m9d801 porta efêmera: duas chamadas em seguida entregam portas válidas', () => {
  for (let i = 0; i < 2; i += 1) assert.ok(Number(portaLivre()) > 1023);
});

'use strict';

// M9-D809 — a matriz docs/governance/aud-matrix.json tem as 8 linhas completas e cada teste nomeado existe, sem skip estático. Teste de conteúdo, sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { declaracoes } = require('../../../scripts/governance-ci/adversarialMap');

const RAIZ = path.join(__dirname, '..', '..', '..');
const MATRIZ = JSON.parse(fs.readFileSync(path.join(RAIZ, 'docs', 'governance', 'aud-matrix.json'), 'utf8'));
const PASTA = __dirname;
const textos = fs.readdirSync(PASTA).filter((f) => /^m9d809\.aud\d{3}\.test\.js$/.test(f)).map((f) => fs.readFileSync(path.join(PASTA, f), 'utf8'));

test('m9d809 matriz AUD-013 a AUD-020 tem as 8 linhas completas', () => {
  assert.deepEqual(MATRIZ.linhas.map((l) => l.aud_id), ['AUD-013', 'AUD-014', 'AUD-015', 'AUD-016', 'AUD-017', 'AUD-018', 'AUD-019', 'AUD-020']);
  for (const linha of MATRIZ.linhas) {
    for (const campo of ['aud_id', 'achado', 'demanda_origem', 'controle_m9', 'teste', 'criterio']) assert.ok(String(linha[campo] || '').trim().length > 3, `${linha.aud_id}: ${campo} vazio`);
    assert.ok(linha.teste.startsWith(`m9d809 ${linha.aud_id} `), `${linha.aud_id}: o nome do teste começa por "m9d809 ${linha.aud_id}"`);
  }
});

test('m9d809 matriz cada teste nomeado existe e não está pulado', () => {
  assert.equal(textos.length, 8, 'um arquivo m9d809.aud0NN.test.js por achado');
  for (const linha of MATRIZ.linhas) {
    const achadas = textos.flatMap((t) => declaracoes(t, linha.teste));
    assert.equal(achadas.length, 1, `${linha.aud_id}: o teste "${linha.teste}" deve existir uma vez`);
    assert.equal(achadas[0].ignorado, false, `${linha.aud_id}: o teste está com skip ou todo`);
  }
});

test('m9d809 matriz a linha que depende de demanda posterior diz qual é a pendência', () => {
  const comPendencia = MATRIZ.linhas.filter((l) => l.pendencia).map((l) => l.aud_id);
  assert.deepEqual(comPendencia, ['AUD-016', 'AUD-020']); // AUD-018 fechou na M9-D912 (a metade do descarte)
  assert.match(MATRIZ.linhas.find((l) => l.aud_id === 'AUD-016').pendencia, /M9-D920/);
  assert.equal(MATRIZ.linhas.find((l) => l.aud_id === 'AUD-018').pendencia, null);
});

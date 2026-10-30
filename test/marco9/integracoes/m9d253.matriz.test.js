'use strict';

// Marco 9, M9-D253 — matriz dos 15 princípios INT-001 a INT-015 (docs/integrations/MATRIZ_INT.md): completa, com demanda dona e teste existente de verdade.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../../../scripts/int-ci/lib/matrizInt');
const { ambienteReal } = require('../../../scripts/int-ci/lib/dodAmbiente');

const RAIZ = path.join(__dirname, '..', '..', '..');
const md = () => fs.readFileSync(path.join(RAIZ, 'docs/integrations/MATRIZ_INT.md'), 'utf8');

test('matriz_int_tem_15_principios', () => {
  const linhas = M.lerMatriz(md());
  assert.deepEqual(linhas.map((l) => l.id), Array.from({ length: 15 }, (_, i) => `INT-${String(i + 1).padStart(3, '0')}`));
  for (const l of linhas) {
    assert.ok(l.principio.length > 5, `${l.id} sem o princípio do livro`);
    assert.ok(l.demandas.length >= 1 && l.demandas.every((d) => /^D\d{3}$/.test(d)), `${l.id} sem demanda dona`);
    assert.ok(l.testes.length >= 1, `${l.id} sem teste`);
  }
  assert.equal(M.PRINCIPIOS.length, 15);
  assert.deepEqual(M.problemasDaMatriz(md(), () => true), [], 'a matriz do arquivo é a gerada e está completa');
  // Apagar uma linha, ou um princípio sem teste, é recusado.
  const semUma = md().split('\n').filter((l) => !l.startsWith('| INT-007')).join('\n');
  assert.ok(M.problemasDaMatriz(semUma, () => true).some((p) => /15 princípios/.test(p)));
  const semTeste = md().replace(/(\| INT-004 [^\n]*\| )`[^`]+`( \|)/, '$1$2');
  assert.ok(M.problemasDaMatriz(semTeste, () => true).some((p) => /INT-004/.test(p)));
});

test('matriz_int_cada_teste_citado_existe', () => {
  const amb = ambienteReal(RAIZ);
  const ausentes = M.lerMatriz(md()).flatMap((l) => l.testes.filter((t) => !amb.existeTeste(t)).map((t) => `${l.id}: ${t}`));
  assert.deepEqual(ausentes, [], 'todo teste citado na matriz existe em algum arquivo de teste');
  // 18 nomes citados: um por princípio, dois nos INT-002, INT-003 e INT-006.
  assert.equal(M.lerMatriz(md()).flatMap((l) => l.testes).length, 18);
  // Nome inventado é apontado, com princípio e nome.
  const inventado = md().replace('`retry_validation_nunca_repete`', '`teste_que_nao_existe_em_lugar_nenhum`');
  const problemas = M.problemasDaMatriz(inventado, (n) => amb.existeTeste(n));
  assert.ok(problemas.some((p) => /INT-006/.test(p) && /teste_que_nao_existe_em_lugar_nenhum/.test(p)), problemas.join('\n'));
});

test('matriz_int_gerada_confere_com_o_arquivo', () => {
  assert.equal(md(), M.renderMatriz(), 'rode node scripts/integrationDod.js --gerar-matriz');
  assert.match(md(), /Fornecedor atrás de Adapter\/Port/);
  assert.match(md(), /Fallback\/manual contingency/);
});

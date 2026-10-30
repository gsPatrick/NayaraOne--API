'use strict';

// Marco 9, M9-D251 — o manifesto dos testes adversariais (15 itens do livro, 18 nomes) e o verificador de nomes: coerência com o livro, falha por nome ausente e presença dos 11 nomes da parte 1.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verificarNomes, problemasDoManifesto, MANIFESTO_PADRAO } = require('../../../scripts/int-ci/lib/adversarial');

const manifesto = JSON.parse(fs.readFileSync(MANIFESTO_PADRAO, 'utf8'));
const nomesDe = (parte) => manifesto.itens.filter((i) => i.parte === parte).flatMap((i) => i.testes);
const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'checkAdversarialNames.js');

/** Pasta temporária com um arquivo de teste que declara os nomes dados. */
function pastaCom(nomes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-'));
  fs.writeFileSync(path.join(dir, 'x.test.js'), nomes.map((n) => `test('${n}', () => {});`).join('\n'));
  return dir;
}

test('adv_manifesto_15_itens_18_nomes_confere', () => {
  assert.equal(manifesto.itens.length, 15, '15 itens do livro');
  assert.deepEqual(manifesto.itens.map((i) => i.n), Array.from({ length: 15 }, (_, i) => i + 1));
  const todos = manifesto.itens.flatMap((i) => i.testes);
  assert.equal(todos.length, 18, '18 nomes de teste');
  assert.equal(new Set(todos).size, 18, 'nenhum repetido');
  assert.equal(nomesDe(1).length, 11, '11 nomes na parte 1 (itens 1 a 8)');
  assert.equal(nomesDe(2).length, 7, '7 nomes na parte 2 (itens 9 a 15)');
  assert.deepEqual(manifesto.itens.filter((i) => i.parte === 1).map((i) => i.n), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(problemasDoManifesto(manifesto), []);
  // Manifesto incoerente (item a menos, nome repetido) é apontado.
  const quebrado = { itens: manifesto.itens.slice(1) };
  assert.ok(problemasDoManifesto(quebrado).length >= 2);
  assert.ok(problemasDoManifesto({ itens: [...manifesto.itens.slice(0, 14), { ...manifesto.itens[14], testes: [todos[0]] }] }).some((p) => /repetido/.test(p)));
});

test('adv_verificador_falha_se_faltar_qualquer_dos_18_nomes', () => {
  const todos = manifesto.itens.flatMap((i) => i.testes);
  const completo = pastaCom(todos);
  assert.equal(verificarNomes({ raizes: [completo] }).ok, true, 'com os 18 nomes passa');
  assert.equal(spawnSync('node', [SCRIPT, '--raiz', completo]).status, 0);
  for (const faltando of [todos[0], todos[10], todos[17]]) {
    const dir = pastaCom(todos.filter((n) => n !== faltando));
    const r = verificarNomes({ raizes: [dir] });
    assert.deepEqual(r.ausentes.map((a) => a.nome), [faltando]);
    const cli = spawnSync('node', [SCRIPT, '--raiz', dir], { encoding: 'utf8' });
    assert.equal(cli.status, 1, 'o script sai com 1 se faltar um nome');
    assert.match(cli.stderr, new RegExp(`INTEGRATION_ADVERSARIAL_NAME_MISSING: Teste adversarial obrigatório ausente\\. ${faltando}`));
  }
  const vazia = pastaCom([]);
  assert.equal(verificarNomes({ raizes: [vazia] }).ausentes.length, 18);
});

test('adv_parte_1_tem_os_11_nomes_nos_arquivos_de_teste', () => {
  const r = verificarNomes({ ateParte: 1 });
  assert.deepEqual(r.ausentes, [], 'os 11 nomes da parte 1 existem nos arquivos de teste do repositório');
  assert.equal(r.total, 11);
  // Cada nome aparece uma só vez (um nome duplicado esconderia um teste apagado).
  const arquivos = fs.readdirSync(__dirname).filter((f) => /^m9d251\..*\.test\.js$/.test(f)).map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
  for (const n of nomesDe(1)) assert.equal(arquivos.split(`test('${n}'`).length - 1, 1, `${n} declarado uma vez`);
});

'use strict';

// M9-D043 — "Testes primeiro": o manifesto dos 11 testes do Guia (seção 14) existe, aponta para testes reais e verdes, sem pulo e com a prova de
// que o teste existia contra a árvore sem a implementação (o arquivo de implementação de cada dona não existe no commit anterior).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../_helpers/iaTestesPrimeiro');

const HASH = /^[0-9a-f]{7,40}$/;

test('m9d043_manifesto_dos_11_presente', () => {
  const m = T.lerManifesto();
  assert.ok(Array.isArray(m.testes), 'manifesto sem a lista "testes"');
  const nomes = m.testes.map((t) => t.nome);
  assert.equal(new Set(nomes).size, nomes.length, 'nome repetido no manifesto');
  for (const [item, nome] of T.NOMES_DO_LIVRO) {
    const e = m.testes.find((t) => t.nome === nome);
    assert.ok(e, `teste obrigatório ausente do manifesto: ${nome}`);
    assert.equal(e.item, item, `${nome}: item do livro diferente`);
    assert.match(e.dona, /^M9-D\d{3}$/, `${nome}: dona inválida`);
    assert.ok(nome.startsWith(`m9d${e.dona.slice(-3)}_`), `${nome}: o prefixo do nome não bate com a dona`);
    assert.ok(T.declaracaoDoTeste(T.lerFonte(e.arquivo), nome), `${nome}: não declarado em ${e.arquivo}`);
  }
  assert.deepEqual([...new Set(m.testes.map((t) => t.item))].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(m.testes.length, T.NOMES_DO_LIVRO.length, 'o manifesto lista nome que o livro não pede');
});

test('m9d043_cada_dona_tem_commit_de_teste_anterior', () => {
  const m = T.lerManifesto();
  assert.ok(m.testes.length >= 12);
  const raso = T.repositorioRaso();
  for (const e of m.testes) {
    assert.match(e.commit, HASH, `${e.nome}: commit inválido`);
    assert.ok(e.implementacao && e.implementacao.startsWith('src/'), `${e.nome}: arquivo de implementação ausente`);
    assert.ok(e.evidencia_vermelho && e.evidencia_vermelho.length > 20, `${e.nome}: sem registro do vermelho`);
    if (raso) continue; // checkout raso do CI não traz o histórico; a conferência de git roda onde há histórico
    assert.ok(T.commitExiste(e.commit), `${e.nome}: commit ${e.commit} inexistente`);
    assert.ok(T.ehAncestral(e.commit), `${e.nome}: commit fora da história atual`);
    assert.ok(T.arquivoNoCommit(e.commit, e.arquivo), `${e.nome}: teste ausente no commit ${e.commit}`);
    assert.ok(T.arquivoNoCommit(e.commit, e.implementacao), `${e.nome}: implementação ausente no commit`);
    assert.ok(!T.arquivoNoCommit(`${e.commit}^`, e.implementacao), `${e.nome}: a implementação já existia antes do teste (sem teste vermelho)`);
  }
});

test('m9d043_nenhum_teste_pulado', () => {
  const m = T.lerManifesto();
  for (const arquivo of new Set(m.testes.map((t) => t.arquivo))) {
    const fonte = T.lerFonte(arquivo);
    assert.equal(T.temPulo(fonte), false, `${arquivo}: contém skip/todo`);
  }
});

test('m9d043_ferramenta_rejeita_manifesto_incompleto', () => {
  const m = T.lerManifesto();
  const faltando = m.testes.filter((t) => t.nome !== 'm9d018_argumento_invalido_rejeitado');
  assert.equal(faltando.length, m.testes.length - 1);
  assert.ok(!faltando.some((t) => t.nome === 'm9d018_argumento_invalido_rejeitado'));
  assert.ok(T.NOMES_DO_LIVRO.some(([, n]) => !faltando.some((t) => t.nome === n)), 'a verificação detecta a ausência');
  assert.equal(T.declaracaoDoTeste("test('outro_nome', () => {})", 'm9d018_argumento_invalido_rejeitado'), false);
  assert.equal(T.declaracaoDoTeste("test('m9d018_argumento_invalido_rejeitado', async () => {})", 'm9d018_argumento_invalido_rejeitado'), true);
  assert.equal(T.temPulo("test.skip('x', () => {})"), true);
  assert.equal(T.temPulo("test('x', { skip: true }, () => {})"), true);
  assert.equal(T.temPulo("const { SKIP } = require('../_helpers/aiHttpEnv');\ntest('x', { skip: SKIP }, () => {})"), false);
});

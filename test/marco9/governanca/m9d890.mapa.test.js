'use strict';

// M9-D890: o mapa dos 10 testes adversariais do livro (docs/governance/adversarial-map.json) e o script que o confere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RAIZ = path.join(__dirname, '..', '..', '..');
const SCRIPT = path.join(RAIZ, 'scripts', 'checkAdversarialMap.js');
const { verificarMapa } = require('../../../scripts/governance-ci/adversarialMap');
const { contar } = require('../../../scripts/governance-ci/checkJunit');

function pastaComTestes(arquivos) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d890-'));
  for (const [nome, conteudo] of Object.entries(arquivos)) fs.writeFileSync(path.join(dir, nome), conteudo);
  return dir;
}
function mapaCom(itens) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d890-mapa-'));
  const arquivo = path.join(dir, 'mapa.json');
  fs.writeFileSync(arquivo, JSON.stringify({ itens }));
  return arquivo;
}
const dezItens = (testeDoSete) => Array.from({ length: 10 }, (_, i) => ({ n: i + 1, demanda: `M9-D${i}`, testes: [i === 6 ? testeDoSete : `m9d890 fixture item ${i + 1}`] }));
const fonteDe = (nomes, extra = '') => nomes.map((n) => `test('${n}', ${extra}() => {});`).join('\n');

test('m9d890 mapa adversarial encontra os 10 testes nomeados', () => {
  const r = verificarMapa();
  assert.equal(r.itens, 10);
  assert.equal(r.total, 11, 'o item 1 tem dois testes: replay e source concluído');
  assert.deepEqual(r.ausentes, []);
  assert.deepEqual(r.problemas, []);
  assert.equal(r.ok, true);
  const cli = spawnSync(process.execPath, [SCRIPT], { cwd: RAIZ, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /10 itens, 11 de 11 nomes presentes e ativos, 0 ausentes/);
});

test('m9d890 teste adversarial com skip é reprovado', () => {
  const nomes = dezItens('m9d871 flag vencida alerta').map((i) => i.testes[0]);
  const ok = pastaComTestes({ 'a.test.js': fonteDe(nomes) });
  assert.equal(verificarMapa({ mapa: mapaCom(dezItens('m9d871 flag vencida alerta')), raizes: [ok] }).ok, true);

  for (const [rotulo, fonte] of [
    ['skip estático', fonteDe(nomes.filter((n) => n !== 'm9d871 flag vencida alerta')) + "\ntest('m9d871 flag vencida alerta', { skip: true }, () => {});"],
    ['skip com texto', fonteDe(nomes.filter((n) => n !== 'm9d871 flag vencida alerta')) + "\ntest('m9d871 flag vencida alerta', { skip: 'depois' }, () => {});"],
    ['todo', fonteDe(nomes.filter((n) => n !== 'm9d871 flag vencida alerta')) + "\ntest('m9d871 flag vencida alerta', { todo: 'depois' }, () => {});"],
    ['test.skip', fonteDe(nomes.filter((n) => n !== 'm9d871 flag vencida alerta')) + "\ntest.skip('m9d871 flag vencida alerta', () => {});"],
  ]) {
    const dir = pastaComTestes({ 'a.test.js': fonte });
    const r = verificarMapa({ mapa: mapaCom(dezItens('m9d871 flag vencida alerta')), raizes: [dir] });
    assert.equal(r.ok, false, rotulo);
    assert.deepEqual(r.ausentes.map((a) => [a.nome, a.motivo]), [['m9d871 flag vencida alerta', 'skip ou todo']], rotulo);
  }
  // pulo condicional à falta de banco (skip: skip()) não reprova aqui: a etapa de CI reprova qualquer pulo no banco descartável
  const condicional = pastaComTestes({ 'a.test.js': fonteDe(nomes, "{ skip: skip() }, ").replace(/, \{ skip: skip\(\) \}, \(\)/g, ', { skip: skip() }, ()') });
  assert.equal(verificarMapa({ mapa: mapaCom(dezItens('m9d871 flag vencida alerta')), raizes: [condicional] }).ok, true);
});

test('m9d890 nome ausente sai com GOV_ADVERSARIAL_MISSING e exit 1; erro de leitura sai com 2', () => {
  const nomes = dezItens('m9d871 flag vencida alerta').map((i) => i.testes[0]).filter((n) => n !== 'm9d871 flag vencida alerta');
  const dir = pastaComTestes({ 'a.test.js': fonteDe(nomes) });
  const mapa = mapaCom(dezItens('m9d871 flag vencida alerta'));
  const falta = spawnSync(process.execPath, [SCRIPT, '--mapa', mapa, '--raiz', dir], { cwd: RAIZ, encoding: 'utf8' });
  assert.equal(falta.status, 1);
  assert.match(falta.stderr, /GOV_ADVERSARIAL_MISSING: Teste adversarial do livro ausente: m9d871 flag vencida alerta/);
  const semPasta = spawnSync(process.execPath, [SCRIPT, '--mapa', mapa, '--raiz', path.join(dir, 'nao-existe')], { cwd: RAIZ, encoding: 'utf8' });
  assert.equal(semPasta.status, 2);
  const semMapa = spawnSync(process.execPath, [SCRIPT, '--mapa', path.join(dir, 'nao-existe.json')], { cwd: RAIZ, encoding: 'utf8' });
  assert.equal(semMapa.status, 2);
});

test('m9d890 mapa com menos de 10 itens ou item sem teste é reprovado', () => {
  const dir = pastaComTestes({ 'a.test.js': '' });
  const curto = verificarMapa({ mapa: mapaCom(dezItens('x').slice(0, 9)), raizes: [dir] });
  assert.equal(curto.ok, false);
  assert.ok(curto.problemas.some((p) => /9 itens; o livro tem 10/.test(p)));
  const semTeste = dezItens('x');
  semTeste[3].testes = [];
  assert.ok(verificarMapa({ mapa: mapaCom(semTeste), raizes: [dir] }).problemas.some((p) => /item 4 não tem teste/.test(p)));
});

test('m9d890 o JUnit com teste pulado ou vazio reprova a etapa de banco descartável', () => {
  assert.deepEqual(contar('<testsuites><testcase name="a"/><testcase name="b"><skipped/></testcase></testsuites>'), { testes: 2, pulados: ['b'] });
  const dir = pastaComTestes({ 'ok.xml': '<testsuites><testcase name="a"/></testsuites>', 'pulado.xml': '<testsuites><testcase name="a"><skipped message="x"/></testcase></testsuites>', 'vazio.xml': '<testsuites/>' });
  const cli = (f) => spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'governance-ci', 'checkJunit.js'), path.join(dir, f)], { encoding: 'utf8' });
  assert.equal(cli('ok.xml').status, 0);
  assert.equal(cli('pulado.xml').status, 1);
  assert.match(cli('pulado.xml').stderr, /GOV_CI_TEST_SKIPPED/);
  assert.equal(cli('vazio.xml').status, 1);
  assert.equal(cli('nao-existe.xml').status, 2);
});

'use strict';

// M9-D704 — a suíte que vigia a suíte: os 15 nomes existem, nada de skip/only, os 10 "testes primeiro" do Guia existem nas donas e passam,
// cada dona registra o teste vermelho anterior ao código e cada adversarial falha quando a proteção é removida (mutação).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ADVERSARIAIS, TESTES_PRIMEIRO, ARQUIVOS_DA_SUITE } = require('../_helpers/m9d704Mapa');
const { exigirVerdeTeste } = require('../_helpers/m9d704Executa');
const { acharSkipOnly, nomesAusentes } = require('../../../scripts/analytics/ci/gates/suiteAdversarial');
const { MUTACOES } = require('../../../scripts/analytics/adversarial/mutacoes');
const { aplicarMutacao } = require('../../../scripts/analytics/adversarial/mutar');

const ROOT = path.join(__dirname, '..', '..', '..');
const SUITE = path.join(__dirname, 'm9d704.adversarial.test.js');
const EVID = path.join(ROOT, 'docs', 'evidencias', 'analytics');
const ler = (f) => JSON.parse(fs.readFileSync(path.join(EVID, f), 'utf8'));

test('m9d704 os 15 nomes existem no arquivo da suíte', () => {
  assert.equal(ADVERSARIAIS.length, 15);
  assert.deepEqual(nomesAusentes(fs.readFileSync(SUITE, 'utf8'), ADVERSARIAIS.map((a) => a.nome)), []);
  assert.match(nomesAusentes(fs.readFileSync(SUITE, 'utf8').replace('adv09', 'advXX'), ADVERSARIAIS.map((a) => a.nome)).join(), /adv09/, 'sem um dos 15 nomes o gate reprova');
  const exatos = (fs.readFileSync(SUITE, 'utf8').match(/^test\('m9d704 adv\d\d /gm) || []).length;
  assert.equal(exatos, 15, 'exatamente os 15 testes nomeados');
});

test('m9d704 sem skip nem only na suíte', () => {
  assert.deepEqual(acharSkipOnly(ARQUIVOS_DA_SUITE.map((f) => path.join(ROOT, f))), []);
  const tmp = path.join(require('node:os').tmpdir(), `m9d704-skip-${process.pid}.test.js`);
  fs.writeFileSync(tmp, "test.skip('a', () => {});\ntest('b', { skip: true }, () => {});\ntest.only('c', () => {});\ntest('d', { todo: true }, () => {});\nit.skip('e', () => {});\n");
  try { assert.equal(acharSkipOnly([tmp]).length, 5); } finally { fs.rmSync(tmp, { force: true }); }
  const lint = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js'), '--stdin', '--stdin-filename', 'test/marco9/analytics/m9d704.fixture.test.js'],
    { cwd: ROOT, input: "test.skip('x', () => {});\n", encoding: 'utf8' });
  assert.equal(lint.status, 1, 'o lint reprova skip na suíte adversarial');
  assert.match(lint.stdout, /skip/);
});

test('m9d704 os 10 testes primeiro do Guia existem com o nome da tabela 3.3 nas donas e passam', () => {
  assert.equal(new Set(TESTES_PRIMEIRO.map((t) => t.item)).size, 10);
  for (const t of TESTES_PRIMEIRO) {
    assert.match(fs.readFileSync(path.join(ROOT, t.arquivo), 'utf8'), new RegExp(`test\\('${t.nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), `${t.dona}: falta "${t.nome}"`);
    exigirVerdeTeste(t);
  }
});

test('m9d704 cada dona dos 10 testes primeiro registra o teste vermelho anterior ao código', () => {
  const reg = ler('testes-primeiro.json');
  const donas = [...new Set(TESTES_PRIMEIRO.map((t) => t.dona))];
  assert.deepEqual(Object.keys(reg.donas).sort(), donas.sort());
  for (const d of donas) {
    const r = reg.donas[d];
    assert.match(r.commitAnterior, /^[0-9a-f]{7,40}$/, `${d}: commit anterior (código sem a regra)`);
    assert.match(r.commitCodigo, /^[0-9a-f]{7,40}$/, `${d}: commit do código`);
    assert.ok(r.testes.length >= 1 && r.saidaVermelha.length > 20, `${d}: saída do teste falhando`);
    assert.equal(r.vermelho, true, `${d}: o teste nomeado precisa falhar no código anterior`);
    assert.match(r.saidaVermelha, /not ok|Cannot find module|Error|rror \[|falh|fail/i);
    const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
    if (git('cat-file', '-e', `${r.commitAnterior}^{commit}`).status === 0 && git('cat-file', '-e', `${r.commitCodigo}^{commit}`).status === 0) {
      assert.equal(git('merge-base', '--is-ancestor', r.commitAnterior, r.commitCodigo).status, 0, `${d}: o commit anterior precisa preceder o do código`);
    }
  }
  for (const t of TESTES_PRIMEIRO) assert.ok(reg.donas[t.dona].testes.includes(t.nome), `${t.dona}: ${t.nome} sem registro`);
});

test('m9d704 cada teste falha quando a proteção correspondente é removida (mutação documentada)', () => {
  assert.deepEqual(MUTACOES.map((m) => m.adv), Array.from({ length: 15 }, (_, i) => i + 1));
  for (const m of MUTACOES) {
    const texto = fs.readFileSync(path.join(ROOT, m.arquivo), 'utf8');
    assert.equal(texto.split(m.de).length - 1, 1, `adv${m.adv}: o trecho a mutar precisa existir uma vez em ${m.arquivo}`);
    assert.ok(m.protecao && m.para !== m.de);
  }
  const ev = ler('mutacoes-adversariais.json');
  assert.equal(ev.resultados.length, 15);
  for (const r of ev.resultados) { assert.equal(r.falhou, true, `adv${r.adv}: a mutação precisa derrubar o teste`); assert.match(r.commit, /^[0-9a-f]{7,40}$/); }
  // executa de verdade a mutação do teste sem banco (adv14, fuso do período) numa cópia da árvore: falha com a proteção removida e passa sem ela
  const m14 = MUTACOES.find((m) => m.adv === 14);
  const r = aplicarMutacao(m14);
  assert.equal(r.falhou, true, `a mutação do adv14 precisa derrubar o teste:\n${r.output.slice(-600)}`);
  assert.equal(r.originalIntacto, true);
  exigirVerdeTeste({ ...ADVERSARIAIS[13].testes[0], arquivo: ADVERSARIAIS[13].testes[0].arquivo });
});

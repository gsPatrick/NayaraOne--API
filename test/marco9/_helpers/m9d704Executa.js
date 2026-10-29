'use strict';

// M9-D704 — executa o arquivo de teste da demanda dona em processo separado (mesmo banco do processo atual) e exige verde: o teste nomeado
// passou, o arquivo não tem falha nem pulado. O arquivo inteiro roda porque os testes de uma dona costumam dividir a preparação; filtrar um
// teste só o isolaria do que ele supõe. A suíte adversarial não tem lógica própria: ela só aciona o teste da dona.
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { ADVERSARIAIS } = require('./m9d704Mapa');

const ROOT = path.join(__dirname, '..', '..', '..');

/** Roda `node --test` no arquivo; devolve as contagens do relatório TAP e se o teste `nome` constou como "ok". `raiz` roda numa cópia (mutação). */
function executarTeste({ arquivo, nome }, { raiz = ROOT, timeoutMs = 900000 } = {}) {
  const env = { ...process.env, NODE_ENV: 'test' };
  delete env.NODE_TEST_CONTEXT; // dentro de um teste, o `node --test` filho viraria "filho" e não imprimiria o relatório
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', arquivo],
    { cwd: raiz, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const num = (rot) => Number((output.match(new RegExp(`^# ${rot} (\\d+)`, 'm')) || [])[1] || 0);
  const aprovou = (n) => { const l = output.split('\n').find((x) => x.startsWith('ok ') && x.replace(/^ok \d+ - /, '').split(' # ')[0].trim() === n); return Boolean(l) && !/# (SKIP|TODO)/i.test(l); };
  return { status: r.status, pass: num('pass'), fail: num('fail'), skipped: num('skipped'), todo: num('todo'), cancelled: num('cancelled'), ok: aprovou(nome), aprovou, output };
}

function exigirVerdeTeste(t, opcoes) {
  const r = executarTeste(t, opcoes);
  // o teste NOMEADO precisa passar e nada no arquivo pode estar pulado; falha de OUTRO teste do mesmo arquivo é da dona dele, não deste
  assert.ok(r.ok, `${t.dona}: "${t.nome}" não constou como aprovado em ${t.arquivo}:\n${r.output.slice(-1500)}`);
  assert.equal(r.skipped + r.todo, 0, `${t.dona}: ${t.arquivo} tem teste pulado`);
  return r;
}

/** Aciona os testes das donas do adversarial de número `n` (cada arquivo roda uma vez). */
function exigirVerde(n) {
  const a = ADVERSARIAIS.find((x) => x.n === n);
  const vistos = new Map();
  for (const t of a.testes) {
    if (!vistos.has(t.arquivo)) vistos.set(t.arquivo, []);
    vistos.get(t.arquivo).push(t);
  }
  for (const grupo of vistos.values()) {
    const r = exigirVerdeTeste(grupo[0]);
    for (const t of grupo.slice(1)) assert.ok(r.aprovou(t.nome), `${t.dona}: "${t.nome}" não constou como aprovado`);
  }
}

module.exports = { executarTeste, exigirVerdeTeste, exigirVerde };

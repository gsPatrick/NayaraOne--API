'use strict';

// M9-D044 — estágio 7 (injection suite + adversarial): a esteira roda TODA a suíte de injeção da D021, sem recorte, e os 15 adversariais da D042
// a cada commit; o portão LAB (estágio 14) repete os 15. Também: os 15 inv_ai entram no npm test e o CI roda a esteira nos caminhos da NAY.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('../_helpers/iaEsteira');
const E = require('../../../scripts/ai-ci/lib/estagios');

const ia = (...p) => path.join(H.API, 'test', 'marco9', 'ia', ...p);

test('m9d044_estagio_7_roda_toda_a_suite_de_injecao_de_d021_sem_recorte', () => {
  const estagio = H.lerReal().estagios[6];
  assert.equal(estagio.nome, 'injection suite + adversarial');
  const comandos = E.comandosDoEstagio(estagio);
  const node = comandos.find((c) => c.argv[0] === 'node');
  const noDisco = fs.readdirSync(ia()).filter((f) => /^m9d021\..+\.test\.js$/.test(f)).map((f) => `test/marco9/ia/${f}`).sort();
  assert.ok(noDisco.length >= 4, 'a suíte de injeção da D021 existe');
  const rodados = node.argv.filter((a) => a.endsWith('.test.js')).sort();
  assert.deepEqual(rodados, noDisco, 'todos os arquivos de injeção da D021 entram, nenhum a menos');
  for (const a of node.argv) assert.doesNotMatch(a, /test-name-pattern|test-only|--grep|skip/, `recorte proibido: ${a}`);
  assert.ok(!JSON.stringify(estagio).includes('test-name-pattern'));
  // a suíte adversarial da D042 (os 15) é o segundo comando do mesmo estágio, o mesmo script do CI da D042
  assert.ok(comandos.some((c) => c.argv.join(' ') === 'npm run test:ai:adversarial'), 'estágio 7 roda npm run test:ai:adversarial');
  const pkg = JSON.parse(fs.readFileSync(path.join(H.API, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['test:ai:adversarial'], /ai-adversarial-report\.js/);
  const manifesto = JSON.parse(fs.readFileSync(ia('adversarial', 'adversarial.manifest.json'), 'utf8'));
  assert.equal(manifesto.testes.length, 15, 'os 15 adversariais da D042');
  // cada arquivo da D021 declara testes de verdade (não é casca)
  for (const f of noDisco) assert.match(fs.readFileSync(path.join(H.API, f), 'utf8'), /\btest\(/, f);
});

test('m9d044_portao_lab_repete_os_15_adversariais', () => {
  const lab = H.lerReal().estagios[13];
  assert.equal(lab.nome, 'LAB');
  assert.equal(lab.exigeEvidencia, true);
  assert.deepEqual(lab.depois.map((c) => c.argv.join(' ')), ['npm run test:ai:adversarial']);
  assert.match(lab.depois[0].env.ADVERSARIAL_REPORT, /adversarial-report-lab\.json$/, 'o resultado do LAB tem relatório próprio');
});

test('m9d044_os_15_invariantes_entram_no_npm_test_e_o_ci_roda_a_esteira', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(H.API, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /test\/ai\/invariantes\.test\.js/);
  assert.equal(pkg.scripts['ci:ai'], 'bash scripts/ci-estagios-ai.sh');
  const inv = fs.readFileSync(path.join(H.API, 'test', 'ai', 'invariantes.test.js'), 'utf8');
  for (let i = 1; i <= 15; i += 1) assert.match(inv, new RegExp(`test\\('inv_ai_${String(i).padStart(3, '0')}_`), `inv_ai_${i}`);
  const wf = fs.readFileSync(path.join(H.API, '.github', 'workflows', 'ai-esteira.yml'), 'utf8');
  assert.match(wf, /bash scripts\/ci-estagios-ai\.sh/);
  for (const p of ['src/features/ai/**', 'test/ai/**', 'test/marco9/ia/**', 'migrations/**', 'package.json']) assert.ok(wf.includes(p), `gatilho ${p}`);
  assert.match(wf, /upload-artifact/);
  assert.match(wf, /--de 13/);
});

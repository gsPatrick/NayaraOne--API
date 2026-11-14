'use strict';

/**
 * Guia do Marco 5, §17 (CI/CD): a esteira do jurídico tem as 18 etapas com os nomes literais do
 * livro, nesta ordem, sem continue-on-error/if:false, e cada etapa de teste aponta para arquivos
 * de teste que existem. Teste estático (não precisa de banco).
 * M5ES (11/11/2026): a ORDEM EFETIVA também é a do livro — nenhum job roda um pedaço da esteira fora da ordem (antes,
 * 16-17 rodavam no job de push e 14-15 só depois, no job de release); deploy_DEV e deploy_LAB rodam em todo push
 * (deploy local do artefato), failure_drills inclui o drill de restore completo e production_approval é o portão.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ETAPAS, NOMES_DO_LIVRO, validar } = require('../scripts/ci-juridico/etapas');

const ROOT = path.resolve(__dirname, '..');
const LIVRO = ['lint', 'typecheck', 'migrations', 'contract_state_tests', 'requirements_tests', 'signature_adapter_contract_tests', 'signature_webhook_idempotency_tests',
  'inspection_immutability_tests', 'key_delivery_gate_tests', 'deadline_tests', 'evidence_integrity_tests', 'multi_company_tests', 'security_scan', 'deploy_DEV', 'deploy_LAB',
  'failure_drills', 'pentest', 'production_approval'];
const etapa = (nome) => ETAPAS.find((e) => e.nome === nome);
const comandos = (nome) => etapa(nome).comandos.map((c) => c.join(' '));

test('Guia §17: a esteira do jurídico tem as 18 etapas com os nomes literais do livro, na ordem', () => {
  assert.deepEqual(NOMES_DO_LIVRO, LIVRO);
  assert.deepEqual(ETAPAS.map((e) => e.nome), LIVRO);
  assert.equal(validar(), true);
  assert.throws(() => validar([...ETAPAS].reverse()), /LEGAL_CI_STAGES_MISMATCH/);
});

test('Guia §17: toda etapa de teste aponta para arquivos que existem; todas as 18 etapas têm comando e nenhuma é só de release', () => {
  for (const e of ETAPAS) {
    for (const c of [...e.comandos, ...(e.comandosRelease || [])]) {
      for (const a of c.filter((x) => /^(test|scripts)\/.+\.(test\.)?js$/.test(x))) assert.ok(fs.existsSync(path.join(ROOT, a)), `${e.nome}: ${a} não existe`);
    }
    assert.ok(e.comandos.length > 0, `${e.nome} sem comando`);
    assert.equal(e.release, undefined, `${e.nome} não pode ser só de release: toda execução roda as 18 etapas na ordem`);
  }
});

test('Guia §17 M5ES: deploy_DEV e deploy_LAB publicam o artefato e fazem o smoke em todo push; o hook do servidor só com --release', () => {
  assert.deepEqual(comandos('deploy_DEV'), ['node scripts/ci-juridico/deployLocal.js DEV --evidencias {evidencias}']);
  assert.deepEqual(comandos('deploy_LAB'), ['node scripts/ci-juridico/deployLocal.js LAB --evidencias {evidencias}']);
  assert.deepEqual(etapa('deploy_DEV').comandosRelease, [['node', 'scripts/ci-juridico/deploy.js', 'DEV']]);
  assert.deepEqual(etapa('deploy_LAB').comandosRelease, [['node', 'scripts/ci-juridico/deploy.js', 'LAB']]);
  assert.ok(etapa('deploy_DEV').banco && etapa('deploy_LAB').banco, 'deploy local só sobre o banco descartável');
});

test('Guia §17/§22 M5ES: failure_drills roda o drill de restore completo com relatório; pentest guarda o relatório; production_approval é o portão', () => {
  assert.ok(comandos('failure_drills').some((c) => c === 'node scripts/restoreDrill/legalFullDrill.js --port {portaDrill} --report-dir {evidencias}/restore'));
  assert.equal(etapa('pentest').env.PENTEST_M5_OUT_DIR, '{evidencias}/pentest');
  assert.deepEqual(comandos('production_approval'), ['node scripts/ci-juridico/gateProducao.js --relatorio {relatorio} --evidencias {evidencias}']);
  const ordem = (n) => LIVRO.indexOf(n);
  assert.ok(ordem('deploy_DEV') < ordem('deploy_LAB') && ordem('deploy_LAB') < ordem('failure_drills') && ordem('pentest') < ordem('production_approval'));
});

test('Guia §17: o workflow roda a esteira, sem continue-on-error nem if: false, e a aprovação de produção tem environment e não faz deploy', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'juridico-esteira.yml'), 'utf8');
  assert.doesNotMatch(yml, /continue-on-error/);
  assert.doesNotMatch(yml, /if:\s*false/);
  assert.match(yml, /scripts\/ci-estagios-juridico\.sh/);
  assert.match(yml, /environment: juridico-aprovacao/);
  const aprovacao = yml.slice(yml.indexOf('aprovacao-producao:'));
  assert.doesNotMatch(aprovacao, /curl|DEPLOY_HOOK|deploy\.js/);
  assert.match(aprovacao, /needs: esteira-juridico-release/);
  assert.match(aprovacao, /scripts\/ci-juridico\/gateProducao\.js/);
});

test('Guia §17 M5ES: nenhum job roda um pedaço da esteira fora da ordem (sem --de/--ate nem execução isolada de etapa)', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'juridico-esteira.yml'), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(yml, /--de\s+\d|--ate\s+\d/, 'cada execução roda as 18 etapas, da 1 à 18');
  assert.doesNotMatch(yml, /executar\.js/, 'o executor só roda pelo scripts/ci-estagios-juridico.sh (banco descartável, 18 etapas)');
  const execucoes = yml.match(/bash scripts\/ci-estagios-juridico\.sh[^\n]*/g) || [];
  assert.equal(execucoes.length, 2, 'uma execução completa no push/PR e uma na tag de release');
  assert.match(execucoes[1], /--release$/);
});

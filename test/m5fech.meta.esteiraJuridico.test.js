'use strict';

/**
 * Guia do Marco 5, §17 (CI/CD): a esteira do jurídico tem as 18 etapas com os nomes literais do
 * livro, nesta ordem, sem continue-on-error/if:false, e cada etapa de teste aponta para arquivos
 * de teste que existem. Teste estático (não precisa de banco).
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

test('Guia §17: a esteira do jurídico tem as 18 etapas com os nomes literais do livro, na ordem', () => {
  assert.deepEqual(NOMES_DO_LIVRO, LIVRO);
  assert.deepEqual(ETAPAS.map((e) => e.nome), LIVRO);
  assert.equal(validar(), true);
  assert.throws(() => validar([...ETAPAS].reverse()), /LEGAL_CI_STAGES_MISMATCH/);
});

test('Guia §17: toda etapa de teste aponta para arquivos que existem; só deploy_DEV, deploy_LAB e production_approval são de release', () => {
  for (const e of ETAPAS) {
    for (const c of e.comandos) {
      for (const a of c.filter((x) => /^test\/.+\.test\.js$/.test(x))) assert.ok(fs.existsSync(path.join(ROOT, a)), `${e.nome}: ${a} não existe`);
    }
    if (!e.release && !e.aprovacao) assert.ok(e.comandos.length > 0, `${e.nome} sem comando`);
  }
  assert.deepEqual(ETAPAS.filter((e) => e.release).map((e) => e.nome), ['deploy_DEV', 'deploy_LAB', 'production_approval']);
});

test('Guia §17: o workflow roda a esteira, sem continue-on-error nem if: false, e a aprovação de produção tem environment e não faz deploy', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'juridico-esteira.yml'), 'utf8');
  assert.doesNotMatch(yml, /continue-on-error/);
  assert.doesNotMatch(yml, /if:\s*false/);
  assert.match(yml, /scripts\/ci-estagios-juridico\.sh/);
  assert.match(yml, /environment: juridico-aprovacao/);
  const aprovacao = yml.slice(yml.indexOf('aprovacao-juridico:'));
  assert.doesNotMatch(aprovacao, /curl|DEPLOY_HOOK/);
});

'use strict';
/**
 * As 18 etapas do CI/CD do Guia do Marco 5 (§17), nesta ordem e com estes nomes literais. Cada etapa
 * diz o que roda. `release: true` = só em tag de release do jurídico (jur-release-*): fora dela a
 * etapa sai NAO_APLICAVEL (dito no relatório, nunca contado como verde). `banco: true` = só roda em
 * banco descartável. A etapa 18 nunca faz deploy: só registra AGUARDANDO_APROVACAO (o botão do
 * environment é do Patrick).
 */
const NODE_TEST = (...arquivos) => ['node', '--test', '--test-concurrency=1', ...arquivos];

const ETAPAS = [
  { nome: 'lint', comandos: [['npm', 'run', '-s', 'lint']] },
  { nome: 'typecheck', comandos: [['npm', 'run', '-s', 'syntax-check']] },
  { nome: 'migrations', banco: true, comandos: [['node', 'scripts/ci-juridico/migracoes.js'], ['node', 'scripts/ci-juridico/renomes-livro.js'], NODE_TEST('test/rls.catalog.allTables.test.js', 'test/m5fech.meta.tabelasDoLivro.test.js')] },
  { nome: 'contract_state_tests', banco: true, comandos: [NODE_TEST('test/m5fech.contratos.maquinaTipos.test.js', 'test/legal.contracts.test.js', 'test/m5fech.contratos.versoesAprovacao.test.js')] },
  { nome: 'requirements_tests', banco: true, comandos: [NODE_TEST('test/legal.requirements.test.js', 'test/m5fech.contratos.checklist.test.js', 'test/legal.frente5.rules.test.js')] },
  { nome: 'signature_adapter_contract_tests', banco: true, comandos: [NODE_TEST('test/legal.signatureProviders.test.js')] },
  { nome: 'signature_webhook_idempotency_tests', banco: true, comandos: [NODE_TEST('test/m5fech.contratos.webhookLiteral.test.js', 'test/m5fech.contratos.adversariais.test.js')] },
  { nome: 'inspection_immutability_tests', banco: true, comandos: [NODE_TEST('test/legal.inspections.test.js', 'test/m5fech.locacao.vistorias.test.js')] },
  { nome: 'key_delivery_gate_tests', banco: true, comandos: [NODE_TEST('test/legal.keyDeliveries.test.js', 'test/m5fech.locacao.chaves.test.js')] },
  {
    nome: 'deadline_tests',
    banco: true,
    comandos: [NODE_TEST('test/m5fech.juridico.prazos.test.js', 'test/m5fech.juridico.prazosLivro.test.js', 'test/legal.deadlineReopenCritical.test.js', 'test/legal.deadlineFinalState.test.js', 'test/legal.deadlineFinalState.concurrency.test.js', 'test/legal.deadlineRaceCritical.test.js')],
  },
  { nome: 'evidence_integrity_tests', banco: true, comandos: [NODE_TEST('test/m5fech.juridico.custodia.test.js', 'test/auditoriaNayara.marco5.coverage.test.js')] },
  { nome: 'multi_company_tests', banco: true, comandos: [NODE_TEST('test/legal.crossCompanyIsolation.test.js', 'test/ciTwoTenantsFinanceLegal.test.js', 'test/adversarial.legal.test.js')] },
  { nome: 'security_scan', comandos: [['npm', 'run', '-s', 'scan:secrets']] },
  { nome: 'deploy_DEV', release: true, comandos: [['node', 'scripts/ci-juridico/deploy.js', 'DEV']] },
  { nome: 'deploy_LAB', release: true, comandos: [['node', 'scripts/ci-juridico/deploy.js', 'LAB']] },
  { nome: 'failure_drills', banco: true, comandos: [NODE_TEST('test/m5fech.juridico.failureDrills.test.js', 'test/m5fech.juridico.carga.test.js'), ['node', 'scripts/restoreDrill/legalFullDrill.js', '--port', '{portaDrill}']] },
  { nome: 'pentest', banco: true, comandos: [NODE_TEST('test/m5fech.pentest.test.js')] },
  { nome: 'production_approval', release: true, aprovacao: true, comandos: [] },
];

const NOMES_DO_LIVRO = [
  'lint', 'typecheck', 'migrations', 'contract_state_tests', 'requirements_tests', 'signature_adapter_contract_tests',
  'signature_webhook_idempotency_tests', 'inspection_immutability_tests', 'key_delivery_gate_tests', 'deadline_tests',
  'evidence_integrity_tests', 'multi_company_tests', 'security_scan', 'deploy_DEV', 'deploy_LAB', 'failure_drills', 'pentest', 'production_approval',
];

function validar(etapas = ETAPAS) {
  const nomes = etapas.map((e) => e.nome);
  if (JSON.stringify(nomes) !== JSON.stringify(NOMES_DO_LIVRO)) throw new Error(`LEGAL_CI_STAGES_MISMATCH: ${nomes.join(',')}`);
  return true;
}

module.exports = { ETAPAS, NOMES_DO_LIVRO, validar };

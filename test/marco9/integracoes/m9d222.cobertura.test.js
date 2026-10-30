'use strict';

// Marco 9, M9-D222 — cobertura da suíte: capability sem cenário, uma rodada por versão suportada, o messaging-sandbox primeiro, relatório por adapter e o portão que o exige.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { registerBuiltInAdapters } = require('../../../src/features/integrations/adapters');
const contract = require('../../../src/features/integrations/contract');
const { MessagingSandboxAdapter } = require('../../../src/features/integrations/providers/messaging/sandbox/messaging-sandbox.adapter');

const RAIZ = path.join(__dirname, '..', '..', '..');
let tmp;
before(() => {
  registerBuiltInAdapters();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m9-contrato-'));
  process.env.INTEGRATION_CONTRACT_REPORT_DIR = path.join(tmp, 'reports');
  process.env.CONTRACT_FIXTURES_DIR = path.join(tmp, 'fixtures');
  const origem = path.join(RAIZ, 'src/features/integrations/contract/fixtures/messaging-sandbox/v1.json');
  for (const [pasta, versoes] of [['qa-m9-fake', ['v1', 'v2']], ['qa-m9-parcial', ['v1']]]) {
    fs.mkdirSync(path.join(tmp, 'fixtures', pasta), { recursive: true });
    versoes.forEach((v) => fs.copyFileSync(origem, path.join(tmp, 'fixtures', pasta, `${v}.json`)));
  }
  // Fixture parcial: só o sendText tem pedido; as outras capabilities ficam sem cenário.
  const parcial = JSON.parse(fs.readFileSync(origem, 'utf8'));
  parcial.requests = { sendText: parcial.requests.sendText };
  fs.writeFileSync(path.join(tmp, 'fixtures', 'qa-m9-parcial', 'v1.json'), JSON.stringify(parcial));
});
after(() => { delete process.env.INTEGRATION_CONTRACT_REPORT_DIR; delete process.env.CONTRACT_FIXTURES_DIR; fs.rmSync(tmp, { recursive: true, force: true }); });

const alvo = (providerCode, AdapterClass) => ({ providerCode, domain: 'MESSAGING', AdapterClass });

test('contrato_capability_sem_cenario_falha', async () => {
  const rel = await contract.runSuite(alvo('qa-m9-parcial', MessagingSandboxAdapter));
  assert.equal(rel.status, 'FAILED');
  const faltando = rel.errors.filter((e) => e.code === 'CONTRACT_CAPABILITY_UNCOVERED').map((e) => e.capability).sort();
  assert.deepEqual(faltando, ['getStatus', 'sendMedia', 'sendTemplate']);
  assert.equal(rel.errors[0].message, 'Capacidade declarada sem teste de contrato.');
  // Adapter registrado sem fixtures e fora da lista de pendências reprova a cobertura (adapter novo sem suíte não passa no CI).
  const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
  const Novo = class extends MessagingSandboxAdapter { providerCode() { return 'qa-m9-sem-suite'; } capabilities() { return ['sendText']; } };
  adapterRegistry.register(Novo);
  try { assert.ok(contract.coverage().uncovered.includes('qa-m9-sem-suite')); } finally { adapterRegistry.unregister('qa-m9-sem-suite'); }
});

test('contrato_roda_para_cada_versao_suportada', async () => {
  const uma = await contract.runSuite(alvo('qa-m9-fake', MessagingSandboxAdapter));
  const Dois = class extends MessagingSandboxAdapter { supportedVersions() { return ['v1', 'v2']; } };
  const duas = await contract.runSuite(alvo('qa-m9-fake', Dois));
  assert.deepEqual(uma.apiVersions, ['v1']);
  assert.deepEqual(duas.apiVersions, ['v1', 'v2']);
  assert.equal(duas.executions, uma.executions * 2, 'a suíte roda 2x para v1 e v2');
  assert.equal(duas.status, 'PASSED');
  // Versão sem fixture reprova com o código próprio.
  const Tres = class extends MessagingSandboxAdapter { supportedVersions() { return ['v1', 'v3']; } };
  const rel = await contract.runSuite(alvo('qa-m9-fake', Tres));
  assert.equal(rel.status, 'FAILED');
  assert.ok(rel.errors.some((e) => e.code === 'CONTRACT_FIXTURE_MISSING' && e.version === 'v3'));
});

test('suite_roda_no_primeiro_adapter_sandbox_antes_dos_demais', () => {
  delete process.env.CONTRACT_FIXTURES_DIR;
  const alvos = contract.listTargets().map((t) => t.providerCode);
  assert.equal(contract.FIRST[0], 'messaging-sandbox', 'passo 6 do livro: o primeiro adapter sandbox é o de mensageria da M9-D229');
  assert.equal(alvos[0], 'messaging-sandbox');
  assert.ok(alvos.length >= 4 && alvos.includes('signature-sandbox'));
  const { coverage } = contract;
  assert.deepEqual(coverage().uncovered, [], 'todo adapter registrado tem suíte ou pendência declarada com a demanda do sprint');
});

test('contrato_relatorio_por_adapter_e_portao_de_liberacao', async () => {
  delete process.env.CONTRACT_FIXTURES_DIR;
  const alvos = contract.listTargets();
  for (const a of alvos) contract.writeReport(await contract.runSuite(a));
  const rel = contract.readReport('messaging-sandbox');
  assert.equal(rel.status, 'PASSED');
  assert.equal(rel.scenarios.length, 10);
  assert.ok(rel.scenarios.every((s) => s.executions > 0 && s.passed === s.executions));
  assert.match(rel.adapterHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(rel.apiVersions, ['v1']);
  // Com relatório verde, recente e do adapter atual, o portão deixa passar.
  assert.equal(contract.assertContractReportForRelease('messaging-sandbox', { maxAgeDays: 30 }).provider, 'messaging-sandbox');
  const recusa = (fn, code) => assert.throws(fn, (e) => e.statusCode === 409 && e.code === code);
  recusa(() => contract.assertContractReportForRelease('adapter-sem-relatorio', { maxAgeDays: 30 }), 'INTEGRATION_CONTRACT_REPORT_MISSING');
  recusa(() => contract.assertContractReportForRelease('messaging-sandbox', { maxAgeDays: 30, requireLive: true }), 'INTEGRATION_CONTRACT_REPORT_MISSING');
  recusa(() => contract.assertContractReportForRelease('messaging-sandbox', { maxAgeDays: 30, now: new Date(Date.now() + 40 * 86400000) }), 'INTEGRATION_CONTRACT_REPORT_STALE');
  const arquivo = path.join(process.env.INTEGRATION_CONTRACT_REPORT_DIR, 'messaging-sandbox.json');
  const original = fs.readFileSync(arquivo, 'utf8');
  fs.writeFileSync(arquivo, JSON.stringify({ ...rel, adapterHash: '0'.repeat(64) }));
  recusa(() => contract.assertContractReportForRelease('messaging-sandbox', { maxAgeDays: 30 }), 'INTEGRATION_CONTRACT_REPORT_OUTDATED');
  fs.writeFileSync(arquivo, JSON.stringify({ ...rel, status: 'FAILED' }));
  recusa(() => contract.assertContractReportForRelease('messaging-sandbox', { maxAgeDays: 30 }), 'INTEGRATION_CONTRACT_REPORT_FAILED');
  fs.writeFileSync(arquivo, original);
});

test('contrato_modo_live_e_opt_in_e_nunca_no_ci', () => {
  const rodar = (env) => { try { execFileSync(process.execPath, [path.join(RAIZ, 'scripts/contractReport.js'), 'messaging-sandbox'], { env: { ...process.env, ...env }, encoding: 'utf8', stdio: 'pipe' }); return { code: 0 }; } catch (e) { return { code: e.status, saida: `${e.stdout}${e.stderr}` }; } };
  const ci = rodar({ CONTRACT_MODE: 'live', CI: 'true' });
  assert.equal(ci.code, 2);
  assert.match(ci.saida, /INTEGRATION_CONTRACT_LIVE_REFUSED_IN_CI/);
});

test('contrato_adapter_defeituoso_reprova_a_suite', async () => {
  delete process.env.CONTRACT_FIXTURES_DIR;
  // Adapter que trata 4xx como erro de rede e devolve status sem mapear: a suíte precisa pegar os dois defeitos.
  const Ruim = class extends MessagingSandboxAdapter {
    classifyError() { return { class: 'TRANSIENT', code: 'HTTP_X' }; }
    mapStatus() { return 'SENT'; }
  };
  const rel = await contract.runSuite(alvo('messaging-sandbox', Ruim));
  assert.equal(rel.status, 'FAILED');
  assert.ok(rel.scenarios.find((s) => s.id === 9).failures.length > 0, 'status inédito mapeado deveria reprovar');
  assert.ok(rel.scenarios.find((s) => s.id === 4).failures.length > 0, '4xx classificado como transitório deveria reprovar');
});

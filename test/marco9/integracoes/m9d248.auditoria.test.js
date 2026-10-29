'use strict';

// M9-D248 — portão de dependências: npm audit high/critical bloqueia, exceção com prazo de até 30 dias, SDK com versão exata.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseAuditReport, evaluateAudit, exceptionState, checkPinnedSdks, constants } = require('../../../src/features/integrations/depaudit');
const { DEFAULT_SDK_DENYLIST } = require('../../../src/features/integrations/http/sdkPolicy');
const { auditReport, excecao, tmpJson } = require('../_helpers/depauditFixtures');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'dependencyAudit.js');
const HIGH = auditReport([{ pkg: 'xml2js', severity: 'high', ghsa: 'GHSA-aaaa-bbbb-cccc', title: 'Poluição de protótipo' }]);

function cli({ report, exceptions, now = '2026-10-28', extra = [] }) {
  const r = tmpJson('report.json', report);
  const e = tmpJson('exc.json', { exceptions });
  try {
    return spawnSync(process.execPath, [SCRIPT, '--report', r.file, '--exceptions', e.file, '--now', now, ...extra], { encoding: 'utf8' });
  } finally { r.limpar(); e.limpar(); }
}

test('audit_high_bloqueia_ci: vulnerabilidade high sem exceção deixa o CI vermelho com o código e a mensagem do livro', () => {
  const run = cli({ report: HIGH, exceptions: [] });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /INTEGRATION_DEPENDENCY_AUDIT_FAILED: Vulnerabilidade grave em dependência: atualize ou registre exceção com validade\./);
  assert.match(run.stderr, /HIGH xml2js GHSA-AAAA-BBBB-CCCC/);
  const critico = cli({ report: auditReport([{ pkg: 'p', severity: 'critical', ghsa: 'GHSA-1111-2222-3333' }]), exceptions: [] });
  assert.equal(critico.status, 1, 'critical também bloqueia');
  const moderada = cli({ report: auditReport([{ pkg: 'p', severity: 'moderate', ghsa: 'GHSA-1111-2222-3333' }, { pkg: 'q', severity: 'low', ghsa: 'GHSA-4444-5555-6666' }]), exceptions: [] });
  assert.equal(moderada.status, 0, 'moderate e low não bloqueiam (audit-level=high)');
  assert.equal(cli({ report: auditReport([]), exceptions: [] }).status, 0, 'sem aviso, passa');
});

test('audit_excecao_valida_permite: exceção de 30 dias, com responsável e mitigação, libera o aviso e aparece no relatório', () => {
  const run = cli({ report: HIGH, exceptions: [excecao()] });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /liberado por exceção até 2026-11-19: xml2js GHSA-AAAA-BBBB-CCCC \(high\) — responsável Responsável de segurança/);
  const avisos = parseAuditReport(HIGH);
  const r = evaluateAudit({ advisories: avisos, exceptions: [excecao()], now: new Date('2026-11-19T10:00:00Z') });
  assert.equal(r.excepted.length, 1, 'no último dia ainda vale');
  // Exceção de outro pacote ou de outro aviso não libera este.
  assert.equal(evaluateAudit({ advisories: avisos, exceptions: [excecao({ package: 'outro' })], now: new Date('2026-10-28') }).blocking.length, 1);
  assert.equal(evaluateAudit({ advisories: avisos, exceptions: [excecao({ id: 'GHSA-zzzz-zzzz-zzzz' })], now: new Date('2026-10-28') }).blocking.length, 1);
  // Falta de responsável ou de mitigação invalida.
  for (const campo of ['owner', 'mitigation', 'reason']) {
    assert.equal(exceptionState(excecao({ [campo]: '' }), { now: new Date('2026-10-28') }).state, 'INVALID', campo);
  }
});

test('audit_excecao_vencida_bloqueia: vencida volta a bloquear e exceção de 31 dias não vale', () => {
  const vencida = cli({ report: HIGH, exceptions: [excecao()], now: '2026-11-20' });
  assert.equal(vencida.status, 1);
  assert.match(vencida.stderr, /EXPIRED: venceu em 2026-11-19/);
  const longa = cli({ report: HIGH, exceptions: [excecao({ expiresAt: '2026-11-20' })] });
  assert.equal(longa.status, 1);
  assert.match(longa.stderr, /INVALID: validade de 31 dias passa do máximo de 30/);
  assert.match(longa.stdout, /exceção GHSA-aaaa-bbbb-cccc não vale/);
  // O prazo máximo é o parâmetro da empresa: com 10 dias, a exceção de 30 dias deixa de valer.
  assert.equal(cli({ report: HIGH, exceptions: [excecao()], extra: ['--max-days', '10'] }).status, 1);
  assert.equal(exceptionState(excecao({ grantedAt: '2026-12-01', expiresAt: '2026-12-10' }), { now: new Date('2026-10-28') }).state, 'INVALID', 'concedida no futuro');
});

test('sdk_versao_exata_travada: SDK de fornecedor com ^, ~, * ou latest reprova; versão exata passa; o package.json real está em ordem', () => {
  const pkg = { dependencies: { twilio: '^5.0.0', '@aws-sdk/client-s3': '~3.1.0', stripe: 'latest', googleapis: '140.0.1', express: '^4.19.2', '@sendgrid/mail': '*' } };
  assert.deepEqual(checkPinnedSdks(pkg).map((v) => v.package).sort(), ['@aws-sdk/client-s3', '@sendgrid/mail', 'stripe', 'twilio']);
  assert.deepEqual(checkPinnedSdks(pkg, { pinExact: false }), [], 'integration.sdk.pin_exact desligado');
  assert.deepEqual(checkPinnedSdks({ dependencies: { express: '^4.19.2', foo: '^1.0.0' } }, { denylist: [...DEFAULT_SDK_DENYLIST, 'foo'] }).map((v) => v.package), ['foo'], 'a lista é o parâmetro integration.sdk.denylist');
  assert.deepEqual(checkPinnedSdks(require('../../../package.json')), []);
  const run = spawnSync(process.execPath, [SCRIPT, '--report', tmpJson('r.json', auditReport([])).file, '--exceptions', tmpJson('e.json', { exceptions: [] }).file], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test('audit_arquivo_de_excecoes_do_repositorio_e_valido', () => {
  const { loadExceptions } = require('../../../src/features/integrations/depaudit');
  const lista = loadExceptions(constants.EXCEPTIONS_FILE);
  assert.ok(Array.isArray(lista));
  for (const e of lista) assert.equal(exceptionState(e).state, 'VALID', `exceção ${e.id} do repositório precisa estar válida`);
});

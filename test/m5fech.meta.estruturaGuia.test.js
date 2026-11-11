'use strict';

/**
 * Guia do Marco 5, §2 (estrutura de pastas), §3 (assertTransition) e §7 (porta do adapter de
 * assinatura): a árvore do livro existe em src/modules/legal, a pasta antiga src/features/legal
 * não existe mais, o módulo carrega os serviços na ordem do Guia §1 e os três provedores cumprem
 * a porta. Teste estático (sem banco: só carrega módulos).
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const LEGAL = path.join(ROOT, 'src', 'modules', 'legal');

after(async () => {
  await require('../src/models').sequelize.close().catch(() => {});
});

const ARVORE_DO_LIVRO = [
  'contracts/domain', 'contracts/application/contract.service.js', 'contracts/application/requirement.service.js', 'contracts/application/template.service.js',
  'signatures/signature-adapter.port.js', 'signatures/providers', 'signatures/signature.service.js',
  'inspections/inspection.service.js', 'inspections/comparison.service.js',
  'leasing/guarantee.service.js', 'leasing/key-delivery.service.js', 'leasing/lease-obligation.service.js',
  'cases/legal-case.service.js', 'cases/deadline.service.js', 'cases/evidence-package.service.js',
];

test('Guia §2: a árvore src/modules/legal do livro existe item a item e src/features/legal não existe mais', () => {
  for (const item of ARVORE_DO_LIVRO) assert.ok(fs.existsSync(path.join(LEGAL, item)), `falta ${item}`);
  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'features', 'legal')), false, 'src/features/legal ainda existe');
  assert.ok(fs.existsSync(path.join(LEGAL, 'contracts', 'domain', 'contract-state-machine.js')));
  for (const p of ['sandbox', 'clicksign', 'zapsign']) assert.ok(fs.existsSync(path.join(LEGAL, 'signatures', 'providers', `${p}.provider.js`)), `provedor ${p}`);
});

test('Guia §1/§2: o módulo carrega os serviços na ordem exata do Guia (passos 1 a 14; o 15 são os testes)', () => {
  const { ORDEM_DO_GUIA, registrar } = require('../src/modules/legal');
  assert.deepEqual(ORDEM_DO_GUIA.map(([p]) => Number(p.split('.')[0])), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  const carregados = registrar();
  for (const c of carregados) assert.ok(c.servico && Object.keys(c.servico).length > 0, `${c.passo}: serviço vazio`);
});

test('Guia §3: assertTransition aceita só a tabela do livro', () => {
  const { VALID_TRANSITIONS, assertTransition } = require('../src/modules/legal/contracts/domain/contract-state-machine');
  assert.deepEqual(VALID_TRANSITIONS.DRAFT, ['DOCUMENTS_PENDING', 'LEGAL_REVIEW']);
  assert.doesNotThrow(() => assertTransition('SIGNING', 'APPROVED'));
  assert.throws(() => assertTransition('DRAFT', 'ACTIVE'), (e) => e.code === 'LEGAL_CONTRACT_INVALID_TRANSITION');
  assert.throws(() => assertTransition('ACTIVE', 'CANCELLED'), (e) => e.code === 'LEGAL_CONTRACT_INVALID_TRANSITION');
});

test('Guia §7: sandbox, Clicksign e ZapSign cumprem a porta (createEnvelope, cancelEnvelope, getStatus, verifyWebhook) e o webhook só passa com HMAC válido', () => {
  const { PORT_METHODS, toSignatureAdapter } = require('../src/modules/legal/signatures/signature-adapter.port');
  const { SandboxSignatureAdapter, ClicksignSignatureAdapter, ZapSignSignatureAdapter } = require('../src/modules/legal/signatures/providers');
  assert.deepEqual(PORT_METHODS, ['createEnvelope', 'cancelEnvelope', 'getStatus', 'verifyWebhook']);
  const segredo = 'segredo-de-teste-do-webhook';
  const corpo = Buffer.from('{"evento":"assinado"}');
  const hmac = crypto.createHmac('sha256', segredo).update(corpo).digest('hex');
  const casos = [
    ['sandbox', new SandboxSignatureAdapter(), null],
    ['clicksign', new ClicksignSignatureAdapter({ apiToken: 'x' }), { 'content-hmac': `sha256=${hmac}` }],
    ['zapsign', new ZapSignSignatureAdapter({ apiToken: 'x' }), { 'x-zapsign-signature': hmac }],
  ];
  for (const [code, impl, cabecalho] of casos) {
    const a = toSignatureAdapter(impl, { code, webhookSecret: segredo });
    for (const m of PORT_METHODS) assert.equal(typeof a[m], 'function', `${code}.${m}`);
    assert.equal(a.verifyWebhook({}, corpo), false, `${code}: sem assinatura não passa`);
    if (cabecalho) {
      assert.equal(a.verifyWebhook(cabecalho, corpo), true, `${code}: HMAC válido`);
      assert.equal(a.verifyWebhook(cabecalho, Buffer.from('{"evento":"adulterado"}')), false, `${code}: corpo adulterado`);
    }
  }
  assert.throws(() => toSignatureAdapter({}), /SIGNATURE_ADAPTER_PORT_NOT_IMPLEMENTED/);
});

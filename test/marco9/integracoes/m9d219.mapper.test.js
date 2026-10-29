'use strict';

// Marco 9, M9-D219 — mapper de saída por allowlist e classificação (testes 1, 2, 3 e 8).
// Banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... node --test --test-concurrency=1 <arquivo>
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, carregarTenants } = require('../../integrations/dispatch/dispatchHelpers');
const { PORTS } = require('../../../src/features/integrations/providers/ports');
const minimization = require('../../../src/features/integrations/minimization');
const { imovelCom40Campos } = require('../_helpers/intImovel');

let tenant;
before(async () => { ({ tenant } = await carregarTenants()); });
after(async () => { await sequelize.close(); });

const alvo = (domain, operation) => ({ domain, operation, mapper: PORTS[domain].operations[operation].outputMapper });
const minimizar = (domain, operation, objeto, opts) => sequelize.transaction(async (t) => {
  await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
  await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
  return minimization.minimizePayload(alvo(domain, operation), objeto, tenant, t, opts);
});

test('minimizacao_portal_somente_allowlist', async () => {
  const imovel = imovelCom40Campos();
  assert.equal(Object.keys(imovel).length, 40);
  const r = await minimizar('PORTAL', 'publishListing', imovel);
  assert.equal(Object.keys(r.payload).length, 12, 'o portal recebe 12 campos');
  assert.equal(r.fieldsDropped.length, 28, '28 descartados');
  assert.equal(r.purpose, 'LISTING_PUBLICATION');
  assert.equal(r.payload.listingRef, 'IMV-A1B2C3D4');
  assert.ok(!JSON.stringify(r.payload).includes('CANARY'), 'nenhum valor interno no payload');
  assert.ok(r.fieldsDropped.includes('owner_document') && r.fieldsDropped.includes('negotiation_margin'));
});

test('minimizacao_campo_obrigatorio_acima_da_classificacao_bloqueia', async () => {
  // O MESSAGING aceita até PERSONAL; o anexo RESTRICTED (= SENSITIVE) é obrigatório em sendMedia: 422 e nada sai.
  await assert.rejects(
    minimizar('MESSAGING', 'sendMedia', { to: '+5541999990000', mediaRef: 'doc-1', mediaClassification: 'RESTRICTED' }),
    (e) => e.statusCode === 422 && e.code === 'INTEGRATION_PAYLOAD_CLASSIFICATION_VIOLATION' && e.message === 'O envio incluiria dado não permitido para esta finalidade.'
  );
  // Campo opcional acima do limite não derruba o envio: é removido e contado.
  const r = await minimizar('EMAIL', 'sendEmail', { to: 'a@b.com', subject: 'Oi', body: 'Texto', attachmentRef: 'doc-9', attachmentClassification: 'RESTRICTED' });
  assert.equal(r.payload.attachmentRef, undefined);
  assert.ok(r.fieldsDropped.includes('attachmentRef'));
  // Objeto de domínio sem o campo obrigatório: 422 próprio.
  await assert.rejects(minimizar('MESSAGING', 'sendText', { to: '+5541999990000' }), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_PAYLOAD_REQUIRED_MISSING');
});

test('minimizacao_texto_livre_redigido', async () => {
  const r = await minimizar('MESSAGING', 'sendText', { to: '+5541999990000', text: 'ligar 11 99999-0000, CPF 123.456.789-09, escrever para dono@exemplo.com', cpf: '12345678909' });
  assert.ok(!/99999-0000|123\.456\.789-09|dono@exemplo/.test(r.payload.text), `texto sem PII: ${r.payload.text}`);
  assert.match(r.payload.text, /^ligar/);
  assert.equal(r.payload.cpf, undefined, 'o WhatsApp recebe nome e telefone, não o CPF');
  assert.ok(r.fieldsDropped.includes('cpf'));
  const direto = require('../../../src/shared/redaction').redactFreeText('ligar 11 99999-0000, CPF 123.456.789-09');
  assert.ok(!/99999|123\.456/.test(direto));
});

test('minimizacao_equivalencia_de_escalas', async () => {
  const c = minimization;
  assert.equal(c.toDocumentScale('PERSONAL'), 'CONFIDENTIAL');
  assert.equal(c.toDocumentScale('SENSITIVE'), 'RESTRICTED');
  ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL'].forEach((x) => assert.equal(c.toDocumentScale(x), x));
  assert.equal(c.fromDocumentScale('RESTRICTED'), 'SENSITIVE');
  assert.equal(c.fromDocumentScale('CONFIDENTIAL', { hasPersonalData: true }), 'PERSONAL');
  assert.equal(c.fromDocumentScale('CONFIDENTIAL', { hasPersonalData: false }), 'CONFIDENTIAL');
  assert.equal(c.fromDocumentScale('NADA'), null);
  // Ida e volta: PERSONAL -> CONFIDENTIAL -> PERSONAL (dado pessoal) e SENSITIVE -> RESTRICTED -> SENSITIVE.
  assert.equal(c.fromDocumentScale(c.toDocumentScale('PERSONAL'), { hasPersonalData: true }), 'PERSONAL');
  assert.equal(c.fromDocumentScale(c.toDocumentScale('SENSITIVE')), 'SENSITIVE');
  // Anexo RESTRICTED é bloqueado pelo teto SENSITIVE-acima-de-PERSONAL; CONFIDENTIAL com dado pessoal cabe no PERSONAL.
  assert.equal(c.exceeds(c.fromDocumentScale('RESTRICTED'), 'PERSONAL'), true);
  assert.equal(c.exceeds(c.fromDocumentScale('CONFIDENTIAL', { hasPersonalData: true }), 'PERSONAL'), false);
  const ok = await minimizar('MESSAGING', 'sendMedia', { to: '+5541999990000', mediaRef: 'doc-2', mediaClassification: 'CONFIDENTIAL' });
  assert.equal(ok.payload.mediaRef, 'doc-2');
  const proibido = await minimizar('MESSAGING', 'sendMedia', { to: '+5541999990000', mediaRef: 'doc-2', mediaClassification: 'INTERNAL' });
  assert.equal(proibido.payload.mediaRef, 'doc-2', 'INTERNAL cabe em PERSONAL');
});

test('minimizacao_tetos_do_livro_por_familia', async () => {
  const teto = minimization.BOOK_CEILING;
  assert.deepEqual(['PORTAL', 'SITE', 'SOCIAL', 'ANALYTICS', 'AI'].map((d) => teto[d]), ['PUBLIC', 'PUBLIC', 'PUBLIC', 'PUBLIC', 'PUBLIC']);
  assert.deepEqual(['MESSAGING', 'EMAIL', 'BANK', 'SIGNATURE'].map((d) => teto[d]), ['PERSONAL', 'PERSONAL', 'PERSONAL', 'PERSONAL']);
  assert.equal(teto.FINANCING, 'SENSITIVE');
  // Financiamento: SENSITIVE só dos campos consentidos.
  const base = { caseRef: 'C-1', proponentName: 'Ana', proponentDocument: '52998224725', incomeDeclared: '9000.00', healthDeclaration: 'ok' };
  const semConsentimento = await minimizar('FINANCING', 'submitCase', base);
  assert.equal(semConsentimento.payload.incomeDeclared, undefined);
  const comConsentimento = await minimizar('FINANCING', 'submitCase', base, { consentedFields: ['incomeDeclared'] });
  assert.equal(comConsentimento.payload.incomeDeclared, '9000.00');
  assert.equal(comConsentimento.payload.healthDeclaration, undefined, 'só o campo consentido sai');
  // Analytics: PERSONAL só pseudonimizado.
  const an = await minimizar('ANALYTICS', 'emitEvent', { eventName: 'lead.created', personHash: 'h-abc', email: 'a@b.com' });
  assert.equal(an.payload.personHash, 'h-abc');
  assert.equal(an.payload.email, undefined);
  // Banco: favorecido (nome, documento) por PAYMENT; nada além.
  const pg = await minimizar('BANK', 'submitPayment', { amount: '10.00', beneficiary: { name: 'Fulano', document: '123', account: '1-9', mother_name: 'X' }, internal_note: 'interno' });
  assert.deepEqual(pg.payload.payee, { name: 'Fulano', document: '123', account: '1-9' });
  assert.equal(pg.purpose, 'PAYMENT');
  assert.ok(pg.fieldsDropped.includes('internal_note') && pg.fieldsDropped.includes('payee.mother_name'));
});

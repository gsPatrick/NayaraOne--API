'use strict';

// Marco 9, M9-D241 — NFS-e sobre o registro de integração: o pedido entra pelo Dispatch Service com o RPS como chave de idempotência, a emissão que ficou incerta se resolve pela
// consulta por RPS sem reemitir, e a autorização só vale com número, código de verificação e XML (arquivados em `files` com hash). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d241Env');
const dispatchService = require('../../../src/features/integrations/dispatch/enqueue/dispatch.service');
const { SandboxNfseAdapter } = require('../../../src/features/correspondent/adapters/NfseAdapter');
const { File } = require('../../../src/models');

before(async () => { await env.carregar(); env.resetSandbox(); });
after(async () => { await env.sequelize.close(); });

const rollback = (fn) => env.withRollbackTenantTransaction(env.tenant, fn);
const codigo = (c) => (e) => { assert.equal(e.code, c); return true; };

test('nfse_emissao_idempotente_por_rps', async () => {
  await rollback(async (t) => {
    env.resetSandbox();
    const nota = await env.pedir(t, { amount: 2500 });
    assert.equal(nota.status, 'SUBMITTED');
    assert.equal(nota.rpsSeries, 'A');
    assert.ok(Number(nota.rpsNumber) >= 1);
    assert.equal(nota.issuerKey, `nfse-rps:A-${nota.rpsNumber}`, 'a chave do envio é derivada do RPS');
    assert.ok(nota.externalId && nota.dispatchId, 'protocolo do emissor e envio ligados à nota');
    const [envio] = await env.envios(t, nota.id, 'issueNfse');
    assert.equal(envio.id, nota.dispatchId);
    assert.equal(envio.idempotency_key, nota.issuerKey);
    assert.equal(envio.purpose, 'FISCAL_ISSUANCE', 'a finalidade do mapper fica gravada no envio');
    assert.equal(envio.criticality_op, 'DANGEROUS');
    assert.equal(envio.confirmation_mode, 'ON_STATUS');
    assert.equal(envio.status, 'SUBMITTED', 'a resposta de envio sozinha nunca confirma a emissão');
    assert.match(envio.payload_hash, /^[0-9a-f]{64}$/, 'o hash é do conteúdo minimizado');
    assert.deepEqual(envio.payload_snapshot.rps, { series: 'A', number: String(nota.rpsNumber) });
    assert.equal(envio.payload_snapshot.amount, '2500.00', 'o valor segue como texto decimal');
    assert.equal(envio.payload_snapshot.taker.name, 'Maria Souza');
    assert.equal(envio.payload_snapshot.invoiceRef, nota.id);
    assert.equal(Object.keys(envio.payload_snapshot).includes('sourceId'), false, 'só os campos do mapper saem');
    assert.equal(env.sandboxStats.requests, 1);
    // O mesmo RPS pedido de novo devolve o mesmo envio e o emissor não emite outra nota.
    const { created, dispatch } = await dispatchService.enqueue({
      companyId: env.tenant.companyId, connectionId: envio.connection_id, operation: 'issueNfse', aggregateType: 'InvoiceRequest', aggregateId: nota.id, idempotencyKey: nota.issuerKey,
      payload: { rps: { series: 'A', number: String(nota.rpsNumber) }, amount: '2500.00', taker: { name: 'Maria Souza', document: '52998224725' }, service: { description: nota.description }, invoiceRef: nota.id }, transaction: t,
    });
    assert.equal(created, false);
    assert.equal(dispatch.id, envio.id);
    assert.equal(env.sandboxStats.requests, 1, 'nenhuma segunda nota');
    // Pedir a mesma origem outra vez reaproveita a nota em andamento; origem nova ganha outro RPS, sempre crescente.
    const repetida = await env.pedir(t, { sourceId: nota.sourceId, amount: 2500 });
    assert.equal(repetida.id, nota.id);
    assert.equal(repetida.get('reused'), true);
    const outra = await env.pedir(t);
    assert.ok(Number(outra.rpsNumber) > Number(nota.rpsNumber));
    assert.equal(env.sandboxStats.requests, 2);
  });
});

test('nfse_timeout_reconcilia_por_rps', async () => {
  await rollback(async (t) => {
    env.resetSandbox();
    await env.falha(t, 'TIMEOUT_AFTER_SEND');
    const nota = await env.pedir(t, { amount: 2500 });
    assert.equal(nota.status, 'UNKNOWN', 'o emissor gravou o RPS mas a resposta se perdeu');
    assert.equal(nota.externalId, null);
    const [envio] = await env.envios(t, nota.id, 'issueNfse');
    assert.equal(envio.status, 'UNKNOWN', JSON.stringify({ classe: envio.last_error_class, codigo: envio.last_error_code }));
    assert.equal(env.sandboxStats.requests, 1);
    // Consulta pelo RPS antes de qualquer reemissão: a nota existe, o pedido volta a andar e o envio é resolvido pela reconciliação do framework (sem reenviar).
    const achada = await env.consultar(t, nota.id);
    assert.equal(achada.status, 'SUBMITTED');
    assert.ok(achada.externalId, 'o protocolo foi aprendido pela consulta por RPS');
    assert.equal(env.sandboxStats.requests, 1, 'uma só nota: a emissão não foi repetida');
    const [resolvido] = await env.envios(t, nota.id, 'issueNfse');
    assert.notEqual(resolvido.status, 'UNKNOWN');
    assert.equal(resolvido.external_resource_id, achada.externalId);
    await env.esperarEmissor();
    const autorizada = await env.consultar(t, nota.id);
    assert.equal(autorizada.status, 'AUTHORIZED');
    const [final] = await env.envios(t, nota.id, 'issueNfse');
    assert.equal(final.status, 'CONFIRMED', 'o status AUTHORIZED do emissor é a evidência que confirma a emissão');
    assert.equal(env.sandboxStats.requests, 1);
    await env.falha(t, null);
  });
});

test('nfse_autorizada_exige_numero_e_xml', async () => {
  await rollback(async (t) => {
    env.resetSandbox();
    const nota = await env.pedir(t, { amount: 1800 });
    await env.esperarEmissor();
    // Emissor que "autoriza" sem número oficial e sem XML: a nota não vira autorizada nem gera documento fiscal.
    const original = SandboxNfseAdapter.prototype.getInvoiceStatus;
    SandboxNfseAdapter.prototype.getInvoiceStatus = async (externalId) => ({ externalId, status: 'AUTHORIZED', rawProviderStatus: 'AUTHORIZED', officialNumber: null, documents: { pdf: Buffer.from('%PDF-1.4 sem xml') }, raw: {} });
    try {
      await assert.rejects(env.consultar(t, nota.id), codigo('NFSE_ISSUER_INCOMPLETE_AUTHORIZATION'));
    } finally {
      SandboxNfseAdapter.prototype.getInvoiceStatus = original;
    }
    assert.equal((await env.nota(t, nota.id)).status, 'SUBMITTED');
    assert.equal(await env.documento(t, nota.id), null);
    // Autorização completa: número, código de verificação, XML e PDF. Os arquivos ficam em `files` com o hash e o documento fiscal aponta para eles.
    const autorizada = await env.consultar(t, nota.id);
    assert.equal(autorizada.status, 'AUTHORIZED');
    const doc = await env.documento(t, nota.id);
    assert.match(doc.documentNumber, /^NFSE-[0-9A-F]{12}$/);
    assert.match(doc.verificationCode, /^[0-9A-F]{12}$/);
    assert.match(doc.xmlSha256, /^[0-9a-f]{64}$/);
    assert.ok(doc.xmlFileId && doc.pdfFileId, 'XML e PDF arquivados em files');
    const xml = await File.findByPk(doc.xmlFileId, { transaction: t });
    const pdf = await File.findByPk(doc.pdfFileId, { transaction: t });
    assert.equal(xml.checksumSha256, doc.xmlSha256, 'o hash do arquivo é o do XML guardado no documento fiscal');
    assert.equal(pdf.checksumSha256, doc.pdfSha256);
    assert.equal(xml.mimeType, 'application/xml');
    assert.equal(xml.encryptedAtRest, true);
    const [envio] = await env.envios(t, nota.id, 'issueNfse');
    assert.equal(envio.status, 'CONFIRMED');
    // O arquivo oficial baixado pela rota segue conferindo o hash.
    const baixado = await env.nfseService.getInvoiceFile(nota.id, 'xml', env.tenant.groupId, env.tenant.companyId, t, env.tenant.userId);
    assert.equal(baixado.sha256, doc.xmlSha256);
  });
});

test('nfse_rps_serie_e_parametro_da_empresa', async () => {
  await rollback(async (t) => {
    env.resetSandbox();
    const settings = require('../../../src/features/settings/settings.service');
    await settings.upsertSetting('correspondent.nfse.rps_series', 'B', env.tenant, env.tenant.userId, t);
    const nota = await env.pedir(t);
    assert.equal(nota.rpsSeries, 'B');
    assert.equal(nota.issuerKey, `nfse-rps:B-${nota.rpsNumber}`);
    assert.equal(Number(nota.rpsNumber), 1, 'o contador é por série');
    await assert.rejects(settings.upsertSetting('correspondent.nfse.rps_series', 'série inválida!', env.tenant, env.tenant.userId, t), (e) => e.statusCode === 400);
    await settings.upsertSetting('correspondent.nfse.rps_series', 'A', env.tenant, env.tenant.userId, t);
  });
});

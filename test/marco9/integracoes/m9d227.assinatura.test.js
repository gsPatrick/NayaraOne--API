'use strict';

// Marco 9, M9-D227 — assinatura fora: envelope e estado do contrato preservados, consulta de status em UNKNOWN, assinatura manual só com evidência completa (hash) e troca de
// fornecedor só com aprovação humana (DANGEROUS), com envelope novo e o anterior cancelado por compensação. Banco descartável (os testes COMMITAM). Nomes da seção 8 da demanda.
process.env.PORT = process.env.M9D227_ASS_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d236Env');
const e227 = require('../_helpers/m9d227Env');
const contingency = require('../../../src/features/integrations/contingency');
const signatureFlow = require('../../../src/features/legal/signature');
const { File } = require('../../../src/models');
const { transitionConnection } = require('../../../src/features/integrations/registry/connections.transition');

const { comTenant, sql } = env;
let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  contingency.installContingency();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
beforeEach(async () => { await e227.limparContingencias(tenant); await e227.limparCircuito(tenant); await e227.limparPendentes(tenant); });
after(async () => { desligarCofre(); await e227.drenarEventos(tenant); await e227.limparContingencias(tenant); await e227.limparCircuito(tenant); await e227.limparPendentes(tenant); await e227.desativarConexoesDeTeste(tenant); await env.sequelize.close(); process.exit(0); });

const iso = () => new Date().toISOString();
const signerDe = (s) => ({ id: s.external_signature_id, email: s.signer_email, name: 'Signatário' });
const dispatchesDe = (envelopeId) => sql(tenant, 'SELECT d.* FROM integration.dispatches d JOIN legal.signature_envelopes e ON e.dispatch_id = d.id WHERE e.id = :id', { id: envelopeId });
const envelopes = (versionId) => sql(tenant, 'SELECT * FROM legal.signature_envelopes WHERE contract_version_id = :v ORDER BY created_at', { v: versionId });

/** Fornecedor principal (formato A) com o alternativo (formato B, também com canal e segredo) na política; contrato pronto. */
async function preparar({ comAlternativo = true } = {}) {
  const canal = await env.conectar(tenant, 'sandbox', 'signature-sandbox');
  let alt = null;
  if (comAlternativo) {
    await sql(tenant, "UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code = 'signature-alt-sandbox' AND status IN ('ACTIVE', 'PAUSED')", { c: tenant.companyId });
    alt = await env.criarCanal(tenant, { provider: 'signature-alt-sandbox' });
    await comTenant(tenant, (t) => transitionConnection(alt.conn.id, 'ACTIVE', env.ctxDe(tenant), t));
    await e227.definirPolitica(tenant, canal.conn.id, { alternate_connection_id: alt.conn.id });
  }
  const contrato = await env.criarContrato(tenant);
  return { canal, alt, contrato };
}
const pedir = (c) => env.pedirAssinatura(tenant, c.contrato.version, [c.contrato.tenantPerson, c.contrato.landlord]);

async function assinar(c, sig) {
  const envelope = await env.envelopeDe(tenant, c.contrato.version.id);
  await env.enviar(c.canal, env.eventoA('signer.signed', { envelopeId: envelope.external_envelope_id, signer: signerDe(sig), signedAt: iso(), evidence: env.EVIDENCIA }));
  await env.rodar(tenant);
}

test('contingencia_assinatura_preserva_envelope_e_estado', async () => {
  const c = await preparar({ comAlternativo: false });
  await pedir(c);
  const envelope = await env.envelopeDe(tenant, c.contrato.version.id);
  const [primeira, segunda] = await env.assinaturas(tenant, c.contrato.version.id);
  assert.ok(envelope.external_envelope_id);
  await assinar(c, primeira); // um signatário já assinou antes da queda
  assert.equal((await env.assinaturas(tenant, c.contrato.version.id)).find((s) => s.id === primeira.id).status, 'SIGNED');

  // O fornecedor cai.
  await e227.derrubar(tenant, c.canal.conn.id);
  assert.ok((await e227.ciclo(tenant)).activated >= 1);
  assert.equal((await e227.ativas(tenant)).find((a) => a.connectionId === c.canal.conn.id).mode, 'PRESERVE_AND_ALTERNATE_FLOW');

  // Consulta de status: UNKNOWN, sem presumir assinado nem cancelado.
  const consulta = await comTenant(tenant, (t) => env.signaturesService.checkSignatureStatus(segunda.id, t));
  assert.equal(consulta.unknown, true);
  assert.equal(consulta.providerStatus.status, 'UNKNOWN');
  assert.equal(consulta.reconciled, false);
  const depois = await env.assinaturas(tenant, c.contrato.version.id);
  assert.deepEqual(depois.map((s) => s.status), ['SIGNED', 'PENDING'], 'ninguém perde o progresso');
  assert.equal(depois[0].evidence_complete, true);
  assert.equal(await env.statusContrato(tenant, c.contrato.contract.id), 'SIGNING', 'o estado do contrato é preservado');
  assert.equal((await env.envelopeDe(tenant, c.contrato.version.id)).status, 'PENDING');

  // Novo pedido de assinatura com o fornecedor fora: aceito, o envelope fica PENDING e o envio de criação espera na fila.
  const outro = await env.criarContrato(tenant);
  await env.pedirAssinatura(tenant, outro.version, [outro.tenantPerson, outro.landlord]);
  const env2 = await env.envelopeDe(tenant, outro.version.id);
  assert.equal(env2.status, 'PENDING');
  assert.equal(env2.external_envelope_id, null, 'nada chegou ao fornecedor');
  const [envio] = await dispatchesDe(env2.id);
  assert.ok(['PENDING', 'RETRY_WAIT'].includes(envio.status), 'o envio de criação do envelope fica na fila');
  assert.equal(envio.operation, 'createEnvelope');
  assert.equal(await env.statusContrato(tenant, outro.contract.id), 'SIGNING');
  assert.deepEqual((await env.assinaturas(tenant, outro.version.id)).map((s) => s.status), ['PENDING', 'PENDING']);

  // O fornecedor volta: a fila solta e o envelope ganha o id do fornecedor.
  await e227.recuperar(tenant, c.canal.conn.id);
  await e227.ciclo(tenant);
  for (let i = 0; i < 5; i += 1) { const r = await e227.rodarEnvios(tenant); if (!r.claimed) break; }
  assert.ok((await env.envelopeDe(tenant, outro.version.id)).external_envelope_id, 'o envelope represado foi criado quando o fornecedor voltou');
});

test('contingencia_assinatura_manual_exige_evidencia_com_hash', async () => {
  const c = await preparar({ comAlternativo: false });
  await pedir(c);
  const envelope = await env.envelopeDe(tenant, c.contrato.version.id);
  await e227.derrubar(tenant, c.canal.conn.id);
  await e227.ciclo(tenant);
  const hashDaVersao = c.contrato.version.contentHash;
  assert.match(hashDaVersao, /^[0-9a-f]{64}$/);
  const arquivo = (checksum) => comTenant(tenant, (t) => File.create({
    groupId: tenant.groupId, companyId: tenant.companyId, storageKey: `qa-m9/assinatura/${env.uniqueSuffix()}.pdf`, fileName: `via-assinada-${env.uniqueSuffix()}.pdf`, mimeType: 'application/pdf',
    checksumSha256: checksum, uploadedByUserId: tenant.userId, createdBy: tenant.userId, updatedBy: tenant.userId,
  }, { transaction: t }));
  const manual = (personId, file) => comTenant(tenant, (t) => env.signaturesService.recordManualSignature(c.contrato.version.id, { personId, evidenceFileId: file.id }, tenant.userId, t));

  // Arquivo sem hash: a assinatura é registrada, mas a evidência NÃO é completa e o contrato não vai a SIGNED.
  const semHash = await arquivo(null);
  const incompleta = await manual(c.contrato.tenantPerson.id, semHash);
  assert.equal(incompleta.signature.evidenceComplete, false);
  assert.equal(incompleta.signature.evidenceType, 'MANUAL_UPLOAD');
  assert.equal(await env.statusContrato(tenant, c.contrato.contract.id), 'SIGNING');
  const outro = await manual(c.contrato.landlord.id, await arquivo(env.sha('via do locador')));
  assert.equal(outro.signature.evidenceComplete, true);
  assert.equal(outro.contractTransitioned, false, 'todas assinaram, mas a evidência de uma está incompleta: o contrato segue em SIGNING');
  assert.equal(await env.statusContrato(tenant, c.contrato.contract.id), 'SIGNING');

  // Evidência completa (arquivo com hash + hash do documento da versão): SIGNED. Contrato novo, mesmo caminho.
  const c2 = await preparar({ comAlternativo: false });
  await e227.derrubar(tenant, c2.canal.conn.id);
  await e227.ciclo(tenant);
  await pedir(c2);
  const pedidosEletronicos = await env.assinaturas(tenant, c2.contrato.version.id);
  assert.equal(pedidosEletronicos.length, 2);
  const hashArq = env.sha('via assinada do locatário');
  const m1 = await comTenant(tenant, async (t) => env.signaturesService.recordManualSignature(c2.contrato.version.id, { personId: c2.contrato.tenantPerson.id, evidenceFileId: (await File.create({ groupId: tenant.groupId, companyId: tenant.companyId, storageKey: `qa-m9/a/${env.uniqueSuffix()}.pdf`, fileName: 'a.pdf', mimeType: 'application/pdf', checksumSha256: hashArq, uploadedByUserId: tenant.userId, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t })).id }, tenant.userId, t));
  assert.equal(m1.contractTransitioned, false);
  assert.equal(m1.signature.evidenceJson.evidenceFileSha256, hashArq, 'o hash do arquivo anexado fica na evidência');
  assert.equal(m1.signature.evidenceJson.documentSha256, c2.contrato.version.contentHash, 'o hash do documento da versão (contract_version.content_hash) está na evidência');
  assert.equal(m1.signature.evidenceJson.collectedByUserId, tenant.userId);
  const m2 = await comTenant(tenant, async (t) => env.signaturesService.recordManualSignature(c2.contrato.version.id, { personId: c2.contrato.landlord.id, evidenceFileId: (await File.create({ groupId: tenant.groupId, companyId: tenant.companyId, storageKey: `qa-m9/b/${env.uniqueSuffix()}.pdf`, fileName: 'b.pdf', mimeType: 'application/pdf', checksumSha256: env.sha('via do locador 2'), uploadedByUserId: tenant.userId, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t })).id }, tenant.userId, t));
  assert.equal(m2.contractTransitioned, true, 'SIGNED somente com a evidência completa de todos');
  assert.equal(await env.statusContrato(tenant, c2.contrato.contract.id), 'SIGNED');
  const [versaoDepois] = await sql(tenant, 'SELECT content_hash FROM legal.contract_versions WHERE id = :v', { v: c2.contrato.version.id });
  assert.equal(versaoDepois.content_hash, c2.contrato.version.contentHash, 'contract_version.content_hash não muda');
  // O pedido eletrônico pendente foi substituído e o envelope represado não será criado quando o fornecedor voltar.
  const finais = await env.assinaturas(tenant, c2.contrato.version.id);
  assert.deepEqual(finais.filter((s) => s.signature_method === 'ELECTRONIC').map((s) => s.status), ['CANCELLED', 'CANCELLED']);
  const [env2] = await envelopes(c2.contrato.version.id);
  assert.equal(env2.status, 'CANCELLED');
  assert.equal((await dispatchesDe(env2.id))[0].status, 'CANCELLED');
  assert.ok(envelope.id);
});

test('contingencia_assinatura_alternativo_exige_aprovacao', async () => {
  const c = await preparar();
  await pedir(c);
  const env1 = await env.envelopeDe(tenant, c.contrato.version.id);
  const sigs = await env.assinaturas(tenant, c.contrato.version.id);
  await assinar(c, sigs[0]); // quem já assinou mantém o progresso e a evidência
  await e227.derrubar(tenant, c.canal.conn.id);
  await e227.ciclo(tenant);
  const ctx = env.ctxDe(tenant);
  const trocar = (extra) => comTenant(tenant, (t) => signatureFlow.switchSignatureProvider(ctx, { envelopeId: env1.id, actorUserId: tenant.userId, ...extra }, t));

  await assert.rejects(trocar({ approved: false }), (e) => e.statusCode === 403 && e.code === 'INTEGRATION_ALTERNATE_REQUIRES_APPROVAL');
  const intacto = await env.envelopeDe(tenant, c.contrato.version.id);
  assert.deepEqual([intacto.status, intacto.connection_id], ['PENDING', c.canal.conn.id], 'sem aprovação nada muda');

  const r = await trocar({ approved: true });
  assert.equal(r.mode, 'NEW_ENVELOPE', 'o envelope já existia no fornecedor que caiu: nasce um envelope novo');
  const todos = await envelopes(c.contrato.version.id);
  assert.equal(todos.length, 2);
  const [antigo, novo] = todos;
  assert.equal(antigo.status, 'SUPERSEDED');
  assert.equal(antigo.superseded_by, novo.id);
  assert.equal(novo.connection_id, c.alt.conn.id);
  assert.equal(novo.status, 'PENDING');
  assert.ok(novo.external_envelope_id, 'o alternativo aceitou o envelope novo');
  const depois = await env.assinaturas(tenant, c.contrato.version.id);
  assert.equal(depois[0].status, 'SIGNED', 'quem já assinou continua SIGNED');
  assert.equal(depois[0].envelope_id, antigo.id);
  assert.equal(depois[1].envelope_id, novo.id, 'a pendente passa para o envelope novo');
  assert.equal(await env.statusContrato(tenant, c.contrato.contract.id), 'SIGNING');
  // O envelope anterior é cancelado por COMPENSAÇÃO (cancelEnvelope na fila do fornecedor antigo); o envio original fica intacto.
  const filaAntigo = await sql(tenant, "SELECT * FROM integration.dispatches WHERE company_id = :c AND connection_id = :con AND operation = 'cancelEnvelope'", { c: tenant.companyId, con: c.canal.conn.id });
  assert.equal(filaAntigo.length, 1);
  assert.equal(filaAntigo[0].idempotency_key, `compensate:${(await dispatchesDe(antigo.id))[0].id}`);
  assert.equal((await dispatchesDe(antigo.id))[0].operation, 'createEnvelope');
  // Quem completa no alternativo leva o contrato a SIGNED, e a evidência de quem assinou antes da troca vale.
  const evB = (tipo, extra) => env.eventoB(tipo, { envelopeId: novo.external_envelope_id, ...extra });
  await env.enviarB(c.alt, evB('party.signed', { signer: { id: depois[1].external_signature_id || (await env.assinaturas(tenant, c.contrato.version.id))[1].external_signature_id, email: depois[1].signer_email, name: 'B' }, signedAt: iso(), evidence: env.EVIDENCIA }));
  await env.rodar(tenant);
  await env.enviarB(c.alt, evB('doc.completed', {}));
  await env.rodar(tenant);
  assert.equal(await env.statusContrato(tenant, c.contrato.contract.id), 'SIGNED');
});

test('contingencia_assinatura_alternativo_troca_o_envio_da_fila_quando_nada_chegou_ao_fornecedor', async () => {
  const c = await preparar();
  await e227.derrubar(tenant, c.canal.conn.id);
  await e227.ciclo(tenant);
  await pedir(c);
  const env1 = await env.envelopeDe(tenant, c.contrato.version.id);
  assert.equal(env1.external_envelope_id, null);
  const [envio] = await dispatchesDe(env1.id);
  // Troca automática não vale para operação perigosa (assinatura): o ciclo deixou o envio na fila e sem aprovação a troca é recusada.
  await e227.ciclo(tenant);
  assert.equal((await dispatchesDe(env1.id))[0].id, envio.id);
  await assert.rejects(comTenant(tenant, (t) => contingency.switchToAlternate(env.ctxDe(tenant), envio.id, {}, t)), (e) => e.statusCode === 403 && e.code === 'INTEGRATION_ALTERNATE_REQUIRES_APPROVAL');
  const r = await comTenant(tenant, (t) => signatureFlow.switchSignatureProvider(env.ctxDe(tenant), { envelopeId: env1.id, approved: true, actorUserId: tenant.userId }, t));
  assert.equal(r.mode, 'QUEUE_MOVED');
  const movido = await env.envelopeDe(tenant, c.contrato.version.id);
  assert.deepEqual([movido.connection_id, movido.provider_code, movido.status], [c.alt.conn.id, 'signature-alt-sandbox', 'PENDING']);
  assert.notEqual(movido.dispatch_id, envio.id, 'o envelope acompanha o envio novo');
  for (let i = 0; i < 5; i += 1) { const x = await e227.rodarEnvios(tenant); if (!x.claimed) break; }
  assert.ok((await env.envelopeDe(tenant, c.contrato.version.id)).external_envelope_id, 'o alternativo criou o envelope');
  assert.equal(await env.statusContrato(tenant, c.contrato.contract.id), 'SIGNING');
});

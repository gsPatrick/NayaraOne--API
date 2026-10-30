'use strict';

// Marco 9, M9-D247 — uploads externos em quarentena: inacessível enquanto verifica, infectado descartado com evento, tipo real, zip-bomb, EXIF/GPS, PDF com script, TTL de 72 h e idempotência por hash + origem.
// Banco descartável (os testes COMMITAM); o antivírus é o do ambiente (clamd 3310 ou o de laboratório, que reconhece o arquivo de teste).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sequelize, comTenant, carregarTenants, ctxDe, uniqueSuffix } = require('../../integrations/dispatch/dispatchHelpers');
const settingsService = require('../../../src/features/settings/settings.service');
const quarantine = require('../../../src/features/files/quarantine');
const filesService = require('../../../src/features/files/files.service');
const storage = require('../../../src/features/integrations/storage');
const F = require('../_helpers/m9d247Files');

let tenant;
const ctx = () => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('conteudo-png-'), crypto.randomBytes(16)]);

before(async () => { ({ tenant } = await carregarTenants()); storage.ensureStorageRegistered(); });
after(async () => { await sequelize.close(); });

const receber = (buffer, declaredMime, extra = {}) => comTenant(tenant, (t) => quarantine.receiveExternalUpload(ctx(), { buffer, declaredMime, fileName: `externo-${uniqueSuffix()}`, externalId: `ext-${uniqueSuffix()}`, ...extra }, t));
const verificar = (id) => comTenant(tenant, (t) => quarantine.verifyQuarantine(ctx(), id, t));
const linha = async (id) => (await comTenant(tenant, async (t) => (await sequelize.query('SELECT * FROM files.quarantine WHERE id = :id', { replacements: { id }, transaction: t }))[0]))[0];
const liberado = (id) => comTenant(tenant, (t) => quarantine.assertReleased(ctx(), id, t));
/** Recebe, verifica e devolve a linha final. */
async function passar(buffer, declaredMime, extra) { const r = await receber(buffer, declaredMime, extra); await verificar(r.quarantine.id); return linha(r.quarantine.id); }
const unico = (b) => Buffer.concat([b, Buffer.from(`\n%u${uniqueSuffix()}`)]);

test('quarentena_arquivo_novo_inacessivel', async () => {
  const { quarantine: q, created } = await receber(unico(F.pdf()), 'application/pdf');
  assert.equal(created, true);
  assert.equal(q.status, 'QUARANTINED');
  assert.match(q.sha256, /^[0-9a-f]{64}$/);
  assert.ok(q.receivedAt && q.connectionId === null && q.externalId);
  // Enquanto verifica: 423 para quem tenta usar, sem arquivo promovido, sem URL assinada e sem leitura fora do pipeline.
  await assert.rejects(liberado(q.id), (e) => e.statusCode === 423 && e.code === 'INTEGRATION_FILE_QUARANTINED' && e.message === 'O arquivo ainda está em verificação de segurança.');
  assert.equal((await linha(q.id)).promoted_file_id, null);
  await assert.rejects(comTenant(tenant, (t) => storage.getSignedUrl(ctx(), { key: q.storageKey }, t)), (e) => e.statusCode === 423 && e.code === 'INTEGRATION_FILE_QUARANTINED');
  await assert.rejects(comTenant(tenant, (t) => storage.getObject(ctx(), { key: q.storageKey }, t)), (e) => e.statusCode === 423 && e.code === 'INTEGRATION_FILE_QUARANTINED');
  assert.match(q.storageKey, new RegExp(`^company/${tenant.companyId}/quarantine/`), 'área de quarentena do armazenamento, separada');
  // Depois da verificação o arquivo limpo é liberado.
  await verificar(q.id);
  const lib = await liberado(q.id);
  assert.ok(lib.fileId);
  assert.equal(lib.classification, 'CONFIDENTIAL');
  const arq = await comTenant(tenant, (t) => filesService.getFileMetadata(lib.fileId, t));
  assert.equal(arq.classification, 'CONFIDENTIAL');
  assert.equal(arq.mimeType, 'application/pdf');
  assert.equal((await linha(q.id)).storage_key, null, 'o conteúdo saiu da quarentena');
});

test('quarentena_infectado_descartado_com_evento', async () => {
  const { quarantine: q } = await receber(unico(F.pdfInfectado()), 'application/pdf');
  const r = await verificar(q.id);
  assert.equal(r.status, 'INFECTED');
  const l = await linha(q.id);
  assert.equal(l.storage_key, null, 'descartado');
  assert.equal(l.promoted_file_id, null);
  assert.ok(l.sha256 && l.signature, 'hash e assinatura registrados');
  await assert.rejects(liberado(q.id), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_FILE_INFECTED' && e.message === 'O arquivo foi bloqueado pela verificação de segurança.');
  const ev = await comTenant(tenant, async (t) => (await sequelize.query("SELECT * FROM integration.outbox_events WHERE company_id = :c AND event_type = 'file.infected' AND aggregate_id = :id", { replacements: { c: tenant.companyId, id: q.id }, transaction: t }))[0]);
  assert.equal(ev.length, 1, 'evento de segurança file.infected');
  assert.equal(ev[0].payload_json.sha256, q.sha256);
  const aud = await comTenant(tenant, async (t) => (await sequelize.query("SELECT 1 FROM audit.audit_log WHERE company_id = :c AND action = 'files.quarantine.infected' AND entity_id = :id", { replacements: { c: tenant.companyId, id: q.id }, transaction: t }))[0]);
  assert.equal(aud.length, 1);
  await assert.rejects(comTenant(tenant, (t) => storage.headObject(ctx(), { key: q.storageKey, quarantineAccess: true }, t)), (e) => e.code === 'INTEGRATION_STORAGE_OBJECT_NOT_FOUND', 'o conteúdo infectado não existe mais');
});

test('quarentena_tipo_real_diferente_do_declarado', async () => {
  // foto.jpg de verdade é um executável: REJECTED_TYPE e alerta.
  const exe = await passar(unico(F.executavelDisfarcado()), 'image/jpeg');
  assert.equal(exe.status, 'REJECTED_TYPE');
  assert.equal(exe.detected_mime, 'application/x-msdownload');
  assert.equal(exe.storage_key, null);
  const alerta = await comTenant(tenant, async (t) => (await sequelize.query("SELECT severity FROM integration.integration_errors WHERE company_id = :c AND error_code = 'INTEGRATION_FILE_DISGUISED_EXECUTABLE'", { replacements: { c: tenant.companyId }, transaction: t }))[0]);
  assert.ok(alerta.length >= 1 && alerta[0].severity === 'HIGH', 'alerta de executável disfarçado');
  // Tipo permitido, mas diferente do declarado: recusado pelo desencontro.
  const trocado = await passar(unico(PNG), 'application/pdf');
  assert.deepEqual([trocado.status, trocado.reason, trocado.detected_mime], ['REJECTED_TYPE', 'TYPE_MISMATCH', 'image/png']);
  // Equivalentes de nome (image/jpg) passam; a lista de tipos vem da configuração da empresa.
  const jpg = await passar(unico(F.jpegComExif()), 'image/jpg');
  assert.equal(jpg.status, 'CLEAN');
  await comTenant(tenant, (t) => settingsService.upsertSetting('integration.upload.allowed_types', 'application/pdf', tenant, tenant.userId, t));
  try {
    assert.equal((await passar(unico(PNG), 'image/png')).reason, 'TYPE_NOT_ALLOWED');
  } finally {
    await comTenant(tenant, (t) => sequelize.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'integration.upload.allowed_types'", { replacements: { c: tenant.companyId }, transaction: t }));
  }
  await assert.rejects(comTenant(tenant, (t) => settingsService.upsertSetting('integration.upload.allowed_types', 'não é tipo', tenant, tenant.userId, t)), (e) => e.code === 'SETTING_INVALID_VALUE');
});

test('quarentena_zip_bomb_rejeitado', async () => {
  const bomba = await passar(F.zipBomba(), 'application/zip');
  assert.deepEqual([bomba.status, bomba.reason], ['REJECTED_BOMB', 'RATIO']);
  assert.equal(bomba.storage_key, null);
  const fundo = await passar(F.zipAninhado(4), 'application/zip');
  assert.deepEqual([fundo.status, fundo.reason], ['REJECTED_BOMB', 'DEPTH'], 'quatro níveis passam de três');
  // Três níveis ainda passam da bomba (e só param porque zip genérico não está na lista de tipos).
  const tres = await passar(F.zipAninhado(3), 'application/zip');
  assert.deepEqual([tres.status, tres.reason], ['REJECTED_TYPE', 'TYPE_NOT_ALLOWED']);
  // Documento Office normal (razão baixa) passa; com macro, não.
  const ok = await passar(unico(F.docx()), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(ok.status, 'CLEAN');
  const macro = await passar(F.docxComMacro(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.deepEqual([macro.status, macro.reason], ['REJECTED_TYPE', 'OFFICE_MACROS']);
  // Razão e profundidade vêm da configuração.
  await comTenant(tenant, (t) => settingsService.upsertSetting('integration.upload.zip_max_ratio', 2, tenant, tenant.userId, t));
  try {
    const compacto = F.zip([{ name: 'a.txt', data: Buffer.alloc(4096, 65) }]);
    assert.equal((await passar(compacto, 'application/zip')).reason, 'RATIO');
  } finally {
    await comTenant(tenant, (t) => sequelize.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'integration.upload.zip_max_ratio'", { replacements: { c: tenant.companyId }, transaction: t }));
  }
});

test('quarentena_remove_exif_gps', async () => {
  const original = F.jpegComExif();
  assert.ok(original.includes(Buffer.from('GPSLatitude')), 'o original tem GPS');
  const l = await passar(original, 'image/jpeg');
  assert.equal(l.status, 'CLEAN');
  assert.equal(l.metadata_stripped, true);
  const arq = await comTenant(tenant, (t) => filesService.getFileContent(l.promoted_file_id, t, tenant.userId));
  const bytes = arq.content;
  ['GPSLatitude', 'GPSLongitude', 'CameraXYZ', 'Exif'].forEach((m) => assert.ok(!bytes.includes(Buffer.from(m)), `${m} ainda está no arquivo`));
  assert.ok(bytes.includes(Buffer.from('perfil-de-cor')), 'o perfil de cor fica');
  assert.deepEqual([bytes[0], bytes[1], bytes[bytes.length - 2], bytes[bytes.length - 1]], [0xff, 0xd8, 0xff, 0xd9], 'continua sendo um JPEG inteiro');
  assert.equal(l.clean_sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.notEqual(l.clean_sha256, l.sha256);
});

test('quarentena_pdf_com_javascript_rejeitado', async () => {
  const l = await passar(unico(F.pdfComScript()), 'application/pdf');
  assert.deepEqual([l.status, l.reason], ['REJECTED_TYPE', 'PDF_ACTIVE_CONTENT']);
  assert.equal(l.promoted_file_id, null);
  await assert.rejects(liberado(l.id), (e) => e.statusCode === 422 && e.code === 'INTEGRATION_FILE_REJECTED');
});

test('quarentena_tamanho_maximo_e_ttl_descarta', async () => {
  // Tamanho: acima do máximo da configuração o conteúdo nem é guardado.
  await comTenant(tenant, (t) => settingsService.upsertSetting('integration.upload.max_bytes', 2048, tenant, tenant.userId, t));
  try {
    const grande = await receber(Buffer.concat([F.pdf(), Buffer.alloc(4096, 66)]), 'application/pdf');
    assert.deepEqual([grande.quarantine.status, grande.quarantine.reason, grande.quarantine.storageKey], ['REJECTED_SIZE', 'SIZE', null]);
  } finally {
    await comTenant(tenant, (t) => sequelize.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'integration.upload.max_bytes'", { replacements: { c: tenant.companyId }, transaction: t }));
  }
  // TTL de 72 h: sem resultado, o arquivo é descartado como EXPIRED.
  const { quarantine: q } = await receber(unico(F.pdf()), 'application/pdf');
  assert.ok(Math.abs(q.expiresAt.getTime() - q.receivedAt.getTime() - 72 * 3600000) < 1000, 'prazo de 72 h');
  const antes = await comTenant(tenant, (t) => quarantine.expireQuarantine(ctx(), { now: new Date(q.receivedAt.getTime() + 71 * 3600000) }, t));
  assert.equal((await linha(q.id)).status, 'QUARANTINED');
  assert.ok(antes >= 0);
  await comTenant(tenant, (t) => quarantine.expireQuarantine(ctx(), { now: new Date(q.receivedAt.getTime() + 73 * 3600000) }, t));
  const l = await linha(q.id);
  assert.deepEqual([l.status, l.reason, l.storage_key], ['EXPIRED', 'TTL', null]);
  await assert.rejects(comTenant(tenant, (t) => storage.headObject(ctx(), { key: q.storageKey, quarantineAccess: true }, t)), (e) => e.code === 'INTEGRATION_STORAGE_OBJECT_NOT_FOUND');
  await assert.rejects(liberado(q.id), (e) => e.code === 'INTEGRATION_FILE_REJECTED');
  // O prazo vem da configuração.
  await comTenant(tenant, (t) => settingsService.upsertSetting('integration.upload.quarantine_ttl_hours', 1, tenant, tenant.userId, t));
  try {
    const curto = (await receber(unico(F.pdf()), 'application/pdf')).quarantine;
    assert.ok(Math.abs(curto.expiresAt.getTime() - curto.receivedAt.getTime() - 3600000) < 1000);
  } finally {
    await comTenant(tenant, (t) => sequelize.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'integration.upload.quarantine_ttl_hours'", { replacements: { c: tenant.companyId }, transaction: t }));
  }
});

test('quarentena_idempotente_por_hash', async () => {
  const conteudo = unico(F.pdf());
  const a = await receber(conteudo, 'application/pdf', { externalId: 'wa-msg-1' });
  const b = await receber(conteudo, 'application/pdf', { externalId: 'wa-msg-1' });
  assert.equal(b.created, false);
  assert.equal(b.quarantine.id, a.quarantine.id, 'mesmo arquivo, mesma origem: a mesma linha');
  await Promise.all([verificar(a.quarantine.id), verificar(a.quarantine.id)]);
  await verificar(a.quarantine.id);
  const promovidos = await comTenant(tenant, async (t) => (await sequelize.query("SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = :c AND action = 'files.quarantine.promoted' AND entity_id = :id", { replacements: { c: tenant.companyId, id: a.quarantine.id }, transaction: t }))[0][0].n);
  assert.equal(promovidos, 1, 'verificado uma vez só');
  // Outra origem com os mesmos bytes é outro recebimento.
  const c = await receber(conteudo, 'application/pdf', { externalId: 'wa-msg-2' });
  assert.equal(c.created, true);
  assert.notEqual(c.quarantine.id, a.quarantine.id);
  assert.equal(ctxDe(tenant).companyId, tenant.companyId);
});

test('quarentena_rodada_do_worker_verifica_os_pendentes', async () => {
  const { runDispatchCycle } = require('../../../src/features/integrations/dispatch/worker');
  const { quarantine: q } = await receber(unico(F.pdf()), 'application/pdf');
  for (let i = 0; i < 5 && (await linha(q.id)).status === 'QUARANTINED'; i += 1) await runDispatchCycle(ctxDe(tenant));
  assert.equal((await linha(q.id)).status, 'CLEAN', 'a rodada verificou o pendente');
});

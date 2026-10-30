'use strict';

// Marco 9, M9-D242 — o módulo de arquivos e a fachada de armazenamento sobre o port: o arquivo vai pelo driver da empresa (disco local, sandbox ou outro), a chave é isolada por empresa,
// a URL assinada respeita o TTL configurado, a remoção só pela retenção e a leitura sensível é auditada. Roda em banco descartável (os testes COMMITAM).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env242 = require('../_helpers/m9d242Env');
const env = require('../_helpers/m9d226Env');
const filesService = require('../../../src/features/files/files.service');
const storage = require('../../../src/features/integrations/storage');
const diskStorage = require('../../../src/utils/diskStorage');
const { verifySandboxUrl } = require('../../../src/features/integrations/providers/storage/storage.signedUrl');
const sbxStore = require('../../../src/features/integrations/providers/storage/sandbox/storage.sandbox.store');
const authService = require('../../../src/features/auth/auth.service');
const identity = require('../../../src/features/integrations/identity');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { swapProvider } = require('../../../src/features/integrations/swap');

const { sequelize, comTenant } = env;
let tenant;
let outro;
const KEYS = ['integration.storage.default_provider', 'integration.storage.signed_url_max_ttl_s', 'integration.storage.max_object_bytes'];
const PDF = Buffer.from('%PDF-1.4\nconteúdo do contrato de locação\n%%EOF');

const enviar = (nome = `contrato-${env.uniqueSuffix()}.pdf`, corpo = PDF) => comTenant(tenant, (t) => filesService.uploadFile(
  { groupId: tenant.groupId, companyId: tenant.companyId, fileName: nome, mimeType: 'application/pdf', contentBase64: corpo.toString('base64'), category: 'contracts' }, tenant.userId, t,
));
const baixar = (id) => comTenant(tenant, (t) => filesService.getFileContent(id, t, tenant.userId));
const recusa = (code, status) => (e) => e.code === code && e.statusCode === status;

before(async () => { ({ tenant, outro } = await env.carregarTenants()); storage.ensureStorageRegistered(); });
beforeEach(async () => { await env.limparConfig(tenant, KEYS); await env.semConexoes(tenant, 'STORAGE'); });
after(async () => { await env.limparConfig(tenant, KEYS); await env.semConexoes(tenant, 'STORAGE'); await sequelize.close(); });

test('arquivos_pelo_port_gravam_cifrado_no_layout_de_sempre_e_bloqueiam_adulteracao', async () => {
  const file = await enviar();
  assert.ok(file.storageKey.startsWith(`contracts/${tenant.groupId}/`), 'o storageKey continua sendo o caminho relativo de sempre (o controle de acesso por categoria depende dele)');
  const emDisco = path.join(diskStorage.UPLOADS_ROOT, file.storageKey);
  assert.ok(fs.existsSync(emDisco), 'o driver local grava no layout de uploads/');
  assert.ok(!fs.readFileSync(emDisco).includes(Buffer.from('contrato de locação')), 'cifrado em repouso');
  assert.ok(fs.existsSync(`${emDisco}.meta`), 'o hash do conteúdo fica ao lado do objeto');
  const lido = await baixar(file.id);
  assert.deepEqual(lido.content, PDF);
  assert.equal(file.checksumSha256, env242.sha256(PDF));
  // O arquivo adulterado no disco continua sendo bloqueado com o incidente registrado (comportamento anterior).
  const bytes = fs.readFileSync(emDisco);
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(emDisco, bytes);
  await assert.rejects(baixar(file.id), recusa('FILE_INTEGRITY_VIOLATION', 409));
});

test('arquivos_trocar_o_driver_nao_muda_o_dominio', async () => {
  // Driver padrão da empresa: o sandbox (laboratório). O mesmo serviço de arquivos grava e lê, agora sem tocar o disco.
  await env.config(tenant, 'integration.storage.default_provider', 'storage-sandbox');
  sbxStore.reset();
  const file = await enviar();
  assert.equal(sbxStore.size() >= 1, true, 'o objeto foi para o driver configurado');
  assert.ok(!fs.existsSync(path.join(diskStorage.UPLOADS_ROOT, file.storageKey)), 'nada no disco local');
  assert.deepEqual((await baixar(file.id)).content, PDF);
  // Volta ao disco: arquivos novos voltam para o disco, o domínio é o mesmo.
  await env.limparConfig(tenant, KEYS);
  const noDisco = await enviar();
  assert.ok(fs.existsSync(path.join(diskStorage.UPLOADS_ROOT, noDisco.storageKey)));
  assert.deepEqual((await baixar(noDisco.id)).content, PDF);
  // Connection ACTIVE da família vale mais que o padrão: a empresa aponta para o sandbox pela tela de Integrações.
  const con = await env.conexaoDe(tenant, 'storage-sandbox');
  const viaConexao = await enviar();
  assert.ok(!fs.existsSync(path.join(diskStorage.UPLOADS_ROOT, viaConexao.storageKey)));
  assert.deepEqual((await baixar(viaConexao.id)).content, PDF);
  assert.ok(con.id);
});

test('storage_isolamento_entre_empresas_pela_fachada', async () => {
  assert.ok(outro, 'o teste precisa do seed de dois tenants');
  const key = storage.buildKey(tenant.companyId, `generic/${tenant.groupId}/${env242.crypto.randomUUID()}-nota.pdf`);
  await comTenant(tenant, (t) => storage.putObject(tenant, { key, body: PDF, contentType: 'application/pdf', sha256: env242.sha256(PDF) }, t));
  assert.deepEqual((await comTenant(tenant, (t) => storage.getObject(tenant, { key }, t))).buffer, PDF);
  // A empresa B nunca enxerga a chave da A, por nenhuma operação.
  for (const op of ['getObject', 'headObject', 'getSignedUrl']) {
    await assert.rejects(comTenant(outro, (t) => storage[op](outro, { key }, t)), recusa('INTEGRATION_STORAGE_KEY_FORBIDDEN', 403), op);
  }
  await assert.rejects(comTenant(outro, (t) => storage.deleteObject(outro, { key, purpose: 'RETENTION' }, t)), recusa('INTEGRATION_STORAGE_KEY_FORBIDDEN', 403));
  await assert.rejects(comTenant(outro, (t) => storage.putObject(outro, { key, body: PDF }, t)), recusa('INTEGRATION_STORAGE_KEY_FORBIDDEN', 403));
  // O hash que não confere devolve 422 pela fachada.
  const key2 = storage.buildKey(tenant.companyId, `generic/${tenant.groupId}/${env242.crypto.randomUUID()}-b.pdf`);
  await assert.rejects(comTenant(tenant, (t) => storage.putObject(tenant, { key: key2, body: PDF, sha256: env242.sha256(Buffer.from('x')) }, t)), recusa('INTEGRATION_STORAGE_SHA256_MISMATCH', 422));
});

test('storage_remocao_so_pela_retencao_e_leitura_sensivel_auditada', async () => {
  const key = storage.buildKey(tenant.companyId, `generic/${tenant.groupId}/${env242.crypto.randomUUID()}-sigilo.pdf`);
  await comTenant(tenant, (t) => storage.putObject(tenant, { key, body: PDF }, t));
  for (const purpose of [undefined, 'USER', 'DELETE']) {
    await assert.rejects(comTenant(tenant, (t) => storage.deleteObject(tenant, { key, purpose }, t)), recusa('INTEGRATION_STORAGE_DELETE_FORBIDDEN', 403), String(purpose));
  }
  await comTenant(tenant, (t) => storage.headObject(tenant, { key }, t));
  const antes = (await comTenant(tenant, async (t) => (await sequelize.query("SELECT 1 FROM audit.audit_log WHERE company_id = :c AND action = 'integration.storage.read_sensitive'", { replacements: { c: tenant.companyId }, transaction: t }))[0])).length;
  await comTenant(tenant, (t) => storage.getObject(tenant, { key, sensitive: true }, t));
  await comTenant(tenant, (t) => storage.getObject(tenant, { key }, t));
  const depois = (await comTenant(tenant, async (t) => (await sequelize.query("SELECT 1 FROM audit.audit_log WHERE company_id = :c AND action = 'integration.storage.read_sensitive'", { replacements: { c: tenant.companyId }, transaction: t }))[0])).length;
  assert.equal(depois - antes, 1, 'só a leitura marcada como sensível é auditada');
  await comTenant(tenant, (t) => storage.deleteObject(tenant, { key, purpose: 'RETENTION' }, t));
  await assert.rejects(comTenant(tenant, (t) => storage.getObject(tenant, { key }, t)), recusa('INTEGRATION_STORAGE_OBJECT_NOT_FOUND', 404));
});

test('storage_url_assinada_ttl_vem_da_configuracao_da_empresa', async () => {
  await env.config(tenant, 'integration.storage.default_provider', 'storage-sandbox');
  const key = storage.buildKey(tenant.companyId, `generic/${tenant.groupId}/${env242.crypto.randomUUID()}-foto.jpg`);
  await comTenant(tenant, (t) => storage.putObject(tenant, { key, body: Buffer.from('foto'), contentType: 'image/jpeg' }, t));
  // Padrão 900 s: pedido de 3600 s sai com 900; a URL vale agora e expira depois de 900 s.
  const r = await comTenant(tenant, (t) => storage.getSignedUrl(tenant, { key, ttlSeconds: 3600 }, t));
  assert.equal(r.ttlSeconds, 900);
  assert.equal(verifySandboxUrl(sbxStore.SECRET, r.url).ok, true);
  assert.equal(verifySandboxUrl(sbxStore.SECRET, r.url, Date.now() + 901000).reason, 'EXPIRED');
  // A empresa baixa o teto para 120 s; subir acima da faixa é recusado.
  await env.config(tenant, 'integration.storage.signed_url_max_ttl_s', 120);
  assert.equal((await comTenant(tenant, (t) => storage.getSignedUrl(tenant, { key, ttlSeconds: 3600 }, t))).ttlSeconds, 120);
  assert.equal((await comTenant(tenant, (t) => storage.getSignedUrl(tenant, { key, ttlSeconds: 60 }, t))).ttlSeconds, 60);
  await assert.rejects(env.config(tenant, 'integration.storage.signed_url_max_ttl_s', 90000), (e) => e.code === 'SETTING_INVALID_VALUE');
  await assert.rejects(env.config(tenant, 'integration.storage.default_provider', 'storage-s3'), (e) => e.code === 'SETTING_INVALID_VALUE');
  // Driver sem URL assinada (disco local): 422 INTEGRATION_CAPABILITY_UNSUPPORTED.
  await env.limparConfig(tenant, KEYS);
  const local = storage.buildKey(tenant.companyId, `generic/${tenant.groupId}/${env242.crypto.randomUUID()}-doc.pdf`);
  await comTenant(tenant, (t) => storage.putObject(tenant, { key: local, body: PDF }, t));
  await assert.rejects(comTenant(tenant, (t) => storage.getSignedUrl(tenant, { key: local }, t)), recusa('INTEGRATION_CAPABILITY_UNSUPPORTED', 422));
});

test('storage_tamanho_maximo_vem_da_configuracao', async () => {
  const key = storage.buildKey(tenant.companyId, `generic/${tenant.groupId}/${env242.crypto.randomUUID()}-grande.bin`);
  await env.config(tenant, 'integration.storage.max_object_bytes', 2048);
  await assert.rejects(comTenant(tenant, (t) => storage.putObject(tenant, { key, body: Buffer.alloc(4096, 1) }, t)), recusa('INTEGRATION_STORAGE_TOO_LARGE', 400));
  await comTenant(tenant, (t) => storage.putObject(tenant, { key, body: Buffer.alloc(1024, 1) }, t));
});

test('arquivos_rollback_remove_o_objeto_orfao', async () => {
  const nome = `orfao-${env.uniqueSuffix()}.pdf`;
  let storageKey;
  await assert.rejects(comTenant(tenant, async (t) => {
    const f = await filesService.uploadFile({ groupId: tenant.groupId, companyId: tenant.companyId, fileName: nome, mimeType: 'application/pdf', contentBase64: PDF.toString('base64'), category: 'contracts' }, tenant.userId, t);
    storageKey = f.storageKey;
    assert.ok(fs.existsSync(path.join(diskStorage.UPLOADS_ROOT, storageKey)));
    const limpezas = t.afterRollbackCleanups;
    assert.equal(limpezas.length >= 1, true);
    throw Object.assign(new Error('falha depois do upload'), { limpezas });
  }).catch(async (err) => { for (const l of err.limpezas) await l(); throw err; }), /falha depois do upload/);
  assert.ok(!fs.existsSync(path.join(diskStorage.UPLOADS_ROOT, storageKey)), 'a compensação apagou o objeto e o hash dele');
  assert.ok(!fs.existsSync(`${path.join(diskStorage.UPLOADS_ROOT, storageKey)}.meta`));
});

test('arquivos_e_login_regressao_verde', async () => {
  // Arquivos: o envio e o download do serviço de arquivos passam pelo port e devolvem o conteúdo original.
  const file = await enviar();
  assert.deepEqual((await baixar(file.id)).content, PDF);
  assert.equal(file.scanStatus, 'CLEAN');
  // Login: o login local de sempre (sem provedor externo) entrega tokens que o adapter identity-local valida.
  assert.ok(process.env.CI_TENANT_USERS_PASSWORD, 'o teste precisa do seed de dois tenants');
  const ciA = await env242.tenantCiA();
  const sessao = await authService.login({ email: ciA.email, password: ciA.password, companyId: ciA.companyId });
  assert.ok(sessao.accessToken && sessao.refreshToken);
  const v = await comTenant(ciA, (t) => identity.verifyToken(ciA, sessao.accessToken, t));
  assert.equal(v.provider, 'identity-local');
  assert.equal(v.subject, ciA.userId);
  // Sessão revogada pelo adapter: o token deixa de valer na mesma hora.
  await comTenant(ciA, (t) => require('../../../src/features/integrations/registry/adapterInvoke').invoke(
    require('../../../src/features/integrations/identity/identity.service').localAdapterFor(), 'revokeSession', { sessionId: sessao.sessionId }, { meta: { transaction: t } },
  ));
  await assert.rejects(comTenant(ciA, (t) => identity.verifyToken(ciA, sessao.accessToken, t)), (e) => e.code === 'INTEGRATION_IDENTITY_TOKEN_INVALID');
});

test('storage_troca_de_driver_pela_suite_de_troca_d221', async () => {
  // A empresa grava no sandbox; a troca de fornecedor (D221) leva a connection ativa para o disco local sem tocar o domínio de arquivos.
  const origem = await env.conexaoDe(tenant, 'storage-sandbox');
  const destino = await comTenant(tenant, (t) => registry.createConnection({ providerCode: 'storage-local-disk', environment: 'SANDBOX', label: `QA-M9 ${env.uniqueSuffix()}` }, env.ctxDe(tenant), t));
  const antes = await enviar();
  assert.ok(!fs.existsSync(path.join(diskStorage.UPLOADS_ROOT, antes.storageKey)), 'antes da troca o arquivo está no sandbox');
  const r = await comTenant(tenant, (t) => swapProvider(env.ctxDe(tenant), { fromConnectionId: origem.id, toConnectionId: destino.id }, t));
  assert.ok(r);
  const depois = await enviar();
  assert.ok(fs.existsSync(path.join(diskStorage.UPLOADS_ROOT, depois.storageKey)), 'depois da troca o arquivo novo vai ao disco local');
  assert.deepEqual((await baixar(depois.id)).content, PDF);
  assert.deepEqual((await baixar(antes.id)).content, PDF, 'o arquivo gravado antes continua legível (o driver antigo segue disponível enquanto a troca drena)');
});

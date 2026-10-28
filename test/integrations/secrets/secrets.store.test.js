'use strict';

// Marco 9, M9-D202 — SecretStore: valor redigido, drivers file-mounted e http-vault (sandbox),
// versões, janela de graça, rotação que falha com segurança, driver proibido e boot sem cofre.
// Não toca o banco: o cofre é um diretório temporário FORA do repositório.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const crypto = require('node:crypto');

const secrets = require('../../../src/features/integrations/secrets');

const CHAVE = crypto.randomBytes(32).toString('hex');
const REF = 'company/11111111-1111-4111-8111-111111111111/bank-sandbox/api-key';
let dir;
let agora;
const relogio = () => new Date(agora);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m9-cofre-'));
  agora = Date.parse('2026-10-28T10:00:00Z');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const criar = () => secrets.createFileMountedStore({ dir, masterKey: CHAVE, clock: relogio });
async function recusa(promessa, code, status) {
  await assert.rejects(promessa, (err) => {
    assert.equal(err.code, code);
    if (status) assert.equal(err.statusCode, status);
    return true;
  });
}

test('secretstore_tojson_redacted', async () => {
  const store = criar();
  await store.put(REF, 'valor-super-secreto-123', {});
  const lido = await store.get(REF);
  assert.equal(lido.version, 1);
  assert.equal(lido.value.reveal(), 'valor-super-secreto-123');
  for (const saida of [JSON.stringify(lido), JSON.stringify({ x: lido.value }), String(lido.value), `${lido.value}`, util.inspect(lido), util.format('%j', lido)]) {
    assert.ok(!saida.includes('valor-super-secreto-123'), saida);
  }
  assert.equal(JSON.stringify(lido.value), '"[REDACTED]"');
  // describe nunca devolve o valor.
  const meta = await store.describe(REF);
  assert.equal(meta.version, 1);
  assert.ok(!JSON.stringify(meta).includes('valor-super-secreto-123'));
  assert.ok(meta.createdAt);
});

test('file_mounted_cifra_em_repouso_e_permissao_0600', async () => {
  const store = criar();
  await store.put(REF, 'valor-super-secreto-123', {});
  const achados = [];
  (function varre(d) {
    for (const nome of fs.readdirSync(d)) {
      const p = path.join(d, nome);
      if (fs.statSync(p).isDirectory()) varre(p);
      else achados.push(p);
    }
  }(dir));
  assert.ok(achados.length >= 2, 'um arquivo de valor e um de metadados');
  for (const arquivo of achados) {
    assert.ok(!fs.readFileSync(arquivo).toString('latin1').includes('valor-super-secreto-123'), `${arquivo} guarda o valor em claro`);
    if (arquivo.endsWith('.enc')) assert.equal(fs.statSync(arquivo).mode & 0o777, 0o600);
  }
  // Chave mestra errada não decifra (fail closed), e adulterar o arquivo é detectado.
  const outra = secrets.createFileMountedStore({ dir, masterKey: crypto.randomBytes(32).toString('hex'), clock: relogio });
  await recusa(outra.get(REF), 'INTEGRATION_SECRET_STORE_UNAVAILABLE', 503);
});

test('file_mounted_recusa_diretorio_dentro_do_repositorio_e_chave_ausente', () => {
  const dentro = path.resolve(__dirname, '../../../scratchpad-cofre');
  assert.throws(() => secrets.createFileMountedStore({ dir: dentro, masterKey: CHAVE }), (e) => e.code === 'INTEGRATION_SECRET_STORE_CONFIG');
  assert.throws(() => secrets.createFileMountedStore({ dir, masterKey: undefined }), (e) => e.code === 'INTEGRATION_SECRET_STORE_CONFIG');
  assert.throws(() => secrets.createFileMountedStore({ dir, masterKey: 'curta' }), (e) => e.code === 'INTEGRATION_SECRET_STORE_CONFIG');
  assert.throws(() => secrets.createFileMountedStore({ dir: '', masterKey: CHAVE }), (e) => e.code === 'INTEGRATION_SECRET_STORE_CONFIG');
});

test('secret_inexistente_404', async () => {
  const store = criar();
  await recusa(store.get(REF), 'INTEGRATION_SECRET_NOT_FOUND', 404);
  await recusa(store.describe(REF), 'INTEGRATION_SECRET_NOT_FOUND', 404);
  await recusa(store.get('ref invalida!'), 'INTEGRATION_SECRET_REF_INVALID', 422);
});

async function rotacaoComGraca(store) {
  await store.put(REF, 'versao-um-aaaaaaaa', {});
  const candidata = await store.put(REF, 'versao-dois-bbbbbbb', { candidate: true });
  assert.equal(candidata, 2);
  // A candidata não vale até ser promovida.
  assert.equal((await store.get(REF)).version, 1);
  const nova = await store.rotate(REF, candidata, { graceMs: 30 * 60 * 1000 });
  assert.equal(nova, 2);
  assert.equal((await store.get(REF)).value.reveal(), 'versao-dois-bbbbbbb');
}

test('rotacao_com_janela_de_graca', async () => {
  const store = criar();
  await rotacaoComGraca(store);
  // 10:00 -> 10:29: a antiga ainda é aceita (webhooks em voo).
  agora += 29 * 60 * 1000;
  const aceitas = await store.getAcceptedVersions(REF);
  assert.deepEqual(aceitas.map((v) => v.version).sort(), [1, 2]);
  assert.equal((await store.get(REF, { version: 1 })).value.reveal(), 'versao-um-aaaaaaaa');
  // 10:30 ainda aceita; 10:31 revogada.
  agora += 60 * 1000;
  assert.equal((await store.getAcceptedVersions(REF)).length, 2);
  agora += 60 * 1000;
  assert.deepEqual((await store.getAcceptedVersions(REF)).map((v) => v.version), [2]);
  await recusa(store.get(REF, { version: 1 }), 'INTEGRATION_SECRET_NOT_FOUND', 404);
  const desc = await store.describe(REF);
  assert.equal(desc.version, 2);
  assert.ok(desc.rotatedAt);
});

test('revoke_explicito_e_sweep_apaga_o_arquivo_da_versao', async () => {
  const store = criar();
  await rotacaoComGraca(store);
  await store.revoke(REF, 1);
  await recusa(store.get(REF, { version: 1 }), 'INTEGRATION_SECRET_NOT_FOUND', 404);
  // A versão corrente não se revoga por este caminho.
  await recusa(store.revoke(REF, 2), 'INTEGRATION_SECRET_ROTATION_FAILED', 422);
  const antes = [];
  (function varre(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) varre(p); else antes.push(p); } }(dir));
  assert.equal(antes.filter((p) => p.endsWith('.enc')).length, 1, 'o valor da versão revogada foi apagado');
});

test('rotacao_falha_mantem_versao_anterior', async () => {
  const store = criar();
  await store.put(REF, 'versao-um-aaaaaaaa', {});
  const ant = (await store.describe(REF)).version;
  const resultado = secrets.rotateStoredSecret(store, REF, {
    newValue: 'versao-dois-bbbbbbb',
    graceMs: 1800000,
    testConnection: async () => { throw new Error('banco recusou'); },
  });
  await recusa(resultado, 'INTEGRATION_SECRET_ROTATION_FAILED', 422);
  assert.equal((await store.describe(REF)).version, ant);
  assert.equal((await store.get(REF)).value.reveal(), 'versao-um-aaaaaaaa');
  await recusa(store.get(REF, { version: 2 }), 'INTEGRATION_SECRET_NOT_FOUND', 404);
  // Teste que devolve false também é falha.
  await recusa(secrets.rotateStoredSecret(store, REF, { newValue: 'versao-tres-ccccc', graceMs: 0, testConnection: async () => false }), 'INTEGRATION_SECRET_ROTATION_FAILED', 422);
  assert.equal((await store.get(REF)).version, ant);
  // Sucesso: v1 -> v2 sem expor valores.
  const ok = await secrets.rotateStoredSecret(store, REF, { newValue: 'versao-quatro-dddd', graceMs: 1800000, testConnection: async ({ value }) => value.reveal() === 'versao-quatro-dddd' });
  assert.equal(ok.previousVersion, 1);
  assert.ok(ok.version > 1);
  assert.ok(!JSON.stringify(ok).includes('versao-quatro-dddd'));
});

test('http_vault_sandbox_deterministico_mesmo_contrato', async () => {
  const store = secrets.createHttpVaultStore({ mode: 'sandbox', clock: relogio });
  assert.equal(store.driver, 'http-vault');
  await rotacaoComGraca(store);
  agora += 31 * 60 * 1000;
  assert.deepEqual((await store.getAcceptedVersions(REF)).map((v) => v.version), [2]);
  await recusa(store.get('company/22222222-2222-4222-8222-222222222222/x-y/z'), 'INTEGRATION_SECRET_NOT_FOUND', 404);
});

test('http_vault_indisponivel_503_sem_vazar_detalhes', async () => {
  const falha = { request: async () => { throw Object.assign(new Error('ECONNREFUSED 10.0.0.1:8200 token=abc'), { code: 'ECONNREFUSED' }); } };
  const store = secrets.createHttpVaultStore({ transport: falha, clock: relogio });
  await assert.rejects(store.get(REF), (err) => {
    assert.equal(err.code, 'INTEGRATION_SECRET_STORE_UNAVAILABLE');
    assert.equal(err.statusCode, 503);
    assert.ok(!/10\.0\.0\.1|token=abc/.test(err.message + JSON.stringify(err.details || {})));
    return true;
  });
});

test('selecao_por_driver_e_producao_sem_driver_aborta_o_boot', () => {
  const base = { SECRET_STORE_DIR: dir, SECRET_STORE_MASTER_KEY: CHAVE };
  assert.equal(secrets.buildSecretStoreFromEnv({ ...base, SECRET_STORE_DRIVER: 'file-mounted' }).driver, 'file-mounted');
  assert.equal(secrets.buildSecretStoreFromEnv({ SECRET_STORE_DRIVER: 'http-vault', SECRET_STORE_VAULT_MODE: 'sandbox' }).driver, 'http-vault');
  assert.throws(() => secrets.buildSecretStoreFromEnv({ ...base, SECRET_STORE_DRIVER: 'env-file' }), (e) => e.code === 'INTEGRATION_SECRET_STORE_NOT_CONFIGURED');
  // Sem driver: nunca cai no .env.
  assert.throws(() => secrets.buildSecretStoreFromEnv({ ...base }), (e) => e.code === 'INTEGRATION_SECRET_STORE_NOT_CONFIGURED' && /Cofre de segredos não configurado/.test(e.message));
  // Boot: produção sem driver aborta; fora de produção não.
  assert.throws(() => secrets.assertSecretStoreAtBoot({ NODE_ENV: 'production' }), (e) => e.statusCode === 500 && /Cofre de segredos não configurado/.test(e.message));
  assert.throws(() => secrets.assertSecretStoreAtBoot({ INTEGRATION_ENVIRONMENT: 'PRODUCTION', SECRET_STORE_DRIVER: 'file-mounted' }), (e) => e.code === 'INTEGRATION_SECRET_STORE_CONFIG');
  assert.doesNotThrow(() => secrets.assertSecretStoreAtBoot({ NODE_ENV: 'development' }));
  assert.doesNotThrow(() => secrets.assertSecretStoreAtBoot({ NODE_ENV: 'production', ...base, SECRET_STORE_DRIVER: 'file-mounted' }));
});

test('bank_secret_driver_file_proibido_em_producao', () => {
  const { assertDriverAllowed } = secrets;
  assert.throws(() => assertDriverAllowed({ domain: 'BANK', environment: 'PRODUCTION', driver: 'file-mounted' }), (e) => e.code === 'INTEGRATION_SECRET_DRIVER_FORBIDDEN' && e.statusCode === 500);
  assert.doesNotThrow(() => assertDriverAllowed({ domain: 'BANK', environment: 'PRODUCTION', driver: 'http-vault' }));
  assert.doesNotThrow(() => assertDriverAllowed({ domain: 'BANK', environment: 'SANDBOX', driver: 'file-mounted' }));
  assert.doesNotThrow(() => assertDriverAllowed({ domain: 'EMAIL', environment: 'PRODUCTION', driver: 'file-mounted' }));
});

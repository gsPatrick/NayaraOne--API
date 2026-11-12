'use strict';

// Verificação K=7 do e-mail de campanha, item 7b: cofre CONFIGURADO mas inutilizável (pasta sem escrita, chave mestra trocada, cofre externo inalcançável)
// não pode subir "verde" em homologação/produção, e o health mostra o estado do cofre sem segredo. Conferido pela função do boot e pelo processo real
// (node app.js) no banco descartável: o processo sai com código 1 e a porta nunca abre.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const secrets = require('../../../src/features/integrations/secrets');

const ROOT = path.resolve(__dirname, '../../..');
const PORT = Number(process.env.M9E_BOOT_PORT || require('../_helpers/portaLivre').portaLivre());
const DISPOSABLE = process.env.DISPOSABLE_DB === '1';
const dirs = [];
const key = () => crypto.randomBytes(32).toString('hex');
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m9e-boot-')); dirs.push(d); return d; };
const fileEnv = (dir, masterKey = key(), extra = {}) => ({ SECRET_STORE_DRIVER: 'file-mounted', SECRET_STORE_DIR: dir, SECRET_STORE_MASTER_KEY: masterKey, ...extra });
const HOMOLOG = { NODE_ENV: 'production', INTEGRATION_ENVIRONMENT: 'HOMOLOG' };

after(() => {
  for (const d of dirs) { try { fs.chmodSync(d, 0o700); } catch { /* */ } fs.rmSync(d, { recursive: true, force: true }); }
});

/** A mensagem e o estado nunca carregam caminho, chave nem endereço. */
const semSegredo = (texto, ...proibidos) => proibidos.filter(Boolean).forEach((p) => assert.ok(!String(texto).includes(p), 'o texto não pode carregar caminho, chave ou endereço'));

test('pasta_sem_escrita_chave_trocada_ou_cofre_externo_inalcancavel_sao_inutilizaveis', async () => {
  const semEscrita = tempDir();
  fs.chmodSync(semEscrita, 0o500);
  const a = await secrets.checkSecretStore(fileEnv(semEscrita));
  assert.deepEqual([a.status, a.code], ['unusable', 'INTEGRATION_SECRET_STORE_UNUSABLE']);
  assert.match(a.message, /gravar e ler o canário|acessar o diretório/); assert.match(a.message, /SECRET_STORE_DIR/); assert.match(a.message, /uid 1001/);
  semSegredo(a.message, semEscrita);

  const naoCria = await secrets.checkSecretStore(fileEnv(path.join(semEscrita, 'sub', 'cofre')));
  assert.equal(naoCria.status, 'unusable', 'pasta que o processo não consegue criar');

  const dir = tempDir(); const k1 = key(); const k2 = key();
  await secrets.createFileMountedStore({ dir, masterKey: k1 }).put('company/qa-m9e/marketing/teste', 'valor-de-teste', {});
  assert.equal((await secrets.checkSecretStore(fileEnv(dir, k1))).status, 'ok', 'a chave certa abre o que já foi gravado');
  const trocada = await secrets.checkSecretStore(fileEnv(dir, k2));
  assert.equal(trocada.status, 'unusable');
  assert.match(trocada.message, /SECRET_STORE_MASTER_KEY/);
  semSegredo(trocada.message, dir, k1, k2);

  const porta = await portaFechada();
  const vault = await secrets.checkSecretStore({ SECRET_STORE_DRIVER: 'http-vault', SECRET_STORE_VAULT_URL: `https://127.0.0.1:${porta}`, SECRET_STORE_VAULT_TOKEN: 'token-de-teste', SECRET_STORE_VAULT_TIMEOUT_MS: '1500' });
  assert.deepEqual([vault.status, vault.driver], ['unusable', 'http-vault']);
  semSegredo(vault.message, 'token-de-teste', `127.0.0.1:${porta}`);

  const dirBom = tempDir();
  const bom = await secrets.checkSecretStore(fileEnv(dirBom));
  assert.deepEqual([bom.status, bom.driver], ['ok', 'file-mounted']);
  assert.deepEqual(fs.readdirSync(dirBom), [], 'o canário é apagado e nenhum segredo é gravado pela prova');
});

test('boot_de_homologacao_e_producao_recusa_cofre_inutilizavel_e_sandbox_so_registra', async () => {
  const semEscrita = tempDir();
  fs.chmodSync(semEscrita, 0o500);
  const recusa = (e) => e.code === 'INTEGRATION_SECRET_STORE_UNUSABLE' && e.statusCode === 500 && /não sobe em homologação/.test(e.message);
  await assert.rejects(secrets.verifySecretStoreAtBoot({ ...HOMOLOG, ...fileEnv(semEscrita) }), recusa);
  await assert.rejects(secrets.verifySecretStoreAtBoot({ NODE_ENV: 'production', DEPLOY_ENVIRONMENT: 'staging', ...fileEnv(semEscrita) }), recusa);
  await assert.rejects(secrets.verifySecretStoreAtBoot({ NODE_ENV: 'production', ...fileEnv(semEscrita) }), (e) => e.code === 'INTEGRATION_SECRET_STORE_UNUSABLE' && /produção/.test(e.message));
  // configuração ausente continua com a mensagem própria (item 7, já confirmado)
  await assert.rejects(secrets.verifySecretStoreAtBoot(HOMOLOG), (e) => e.code === 'INTEGRATION_SECRET_STORE_NOT_CONFIGURED');
  const ok = await secrets.verifySecretStoreAtBoot({ ...HOMOLOG, ...fileEnv(tempDir()) });
  assert.equal(ok.status, 'ok');
  const sandbox = await secrets.verifySecretStoreAtBoot({ NODE_ENV: 'development', ...fileEnv(semEscrita) });
  assert.equal(sandbox.status, 'unusable', 'na máquina do desenvolvedor o estado é registrado, sem derrubar');

  const listen = []; const exits = [];
  const log = { info() {}, warn() {}, error: (o, m) => listen.push(m) };
  const server = await secrets.gateListenOnSecretStore(() => { listen.push('LISTEN'); return 'srv'; }, { env: { ...HOMOLOG, ...fileEnv(semEscrita) }, log, exit: (c) => exits.push(c) });
  assert.equal(server, null);
  assert.deepEqual(exits, [1], 'publicado com cofre inutilizável: sai com código 1');
  assert.ok(!listen.includes('LISTEN'), 'a porta nunca abre');
  assert.match(listen.join(' '), /Boot recusado: Cofre de segredos configurado mas inutilizável/);
});

test('health_mostra_o_estado_do_cofre_em_uso_sem_segredo', async () => {
  const dir = tempDir(); const k = key();
  secrets.setSecretStoreForTests(secrets.createFileMountedStore({ dir, masterKey: k }));
  secrets.resetSecretStoreHealth();
  const ok = await secrets.secretStoreHealth({ now: Date.now() });
  assert.deepEqual([ok.status, ok.driver], ['ok', 'file-mounted']);
  semSegredo(JSON.stringify(ok), dir, k);
  fs.chmodSync(dir, 0o500);
  assert.equal((await secrets.secretStoreHealth({ now: Date.now() + 1000 })).status, 'ok', 'dentro de 30 s vale a última prova');
  const ruim = await secrets.secretStoreHealth({ now: Date.now() + 31000 });
  assert.deepEqual([ruim.status, ruim.code], ['unusable', 'INTEGRATION_SECRET_STORE_UNUSABLE']);
  semSegredo(JSON.stringify(ruim), dir, k);
  secrets.setSecretStoreForTests(null);
  secrets.resetSecretStoreHealth();
});

/** Porta TCP local sem ninguém ouvindo. */
function portaFechada() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

/** Sobe `node app.js` com o ambiente; devolve { code, output, listened } quando sai ou depois de `waitMs` (e então encerra o processo). */
function bootApp(extraEnv, { waitMs = 20000, onListening } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['app.js'], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'info', PORT: String(PORT), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let listened = false; let done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); clearInterval(poll); resolve({ code, output, listened }); };
    child.stdout.on('data', (d) => { output += d; }); child.stderr.on('data', (d) => { output += d; });
    child.on('exit', (code) => finish(code));
    const poll = setInterval(async () => {
      if (listened || done) return;
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
        listened = true;
        if (onListening) await onListening(await r.json());
        child.kill('SIGKILL');
      } catch { /* ainda não ouve */ }
    }, 300);
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish('timeout'); }, waitMs);
  });
}

test('processo_real_de_homologacao_com_pasta_sem_escrita_nao_abre_a_porta_e_com_cofre_bom_o_health_mostra_ok', { skip: DISPOSABLE ? false : 'precisa do banco descartável (node scripts/withDisposableDb.js)' }, async () => {
  const semEscrita = tempDir();
  fs.chmodSync(semEscrita, 0o500);
  const k = key();
  const ruim = await bootApp({ INTEGRATION_ENVIRONMENT: 'HOMOLOG', ...fileEnv(semEscrita, k) });
  assert.equal(ruim.code, 1, `o processo sai com código 1 (saída: ${ruim.output.slice(-400)})`);
  assert.equal(ruim.listened, false, 'a porta nunca abriu');
  assert.match(ruim.output, /Boot recusado: Cofre de segredos configurado mas inutilizável/);
  assert.match(ruim.output, /INTEGRATION_SECRET_STORE_UNUSABLE/);
  semSegredo(ruim.output, k);

  const bom = tempDir();
  let health = null;
  const subiu = await bootApp({ INTEGRATION_ENVIRONMENT: 'HOMOLOG', ...fileEnv(bom, k) }, { onListening: (body) => { health = body; } });
  assert.equal(subiu.listened, true, `com o cofre bom a API sobe (saída: ${subiu.output.slice(-400)})`);
  assert.deepEqual([health.data.secretStore.status, health.data.secretStore.driver], ['ok', 'file-mounted']);
  semSegredo(JSON.stringify(health), bom, k);
  assert.match(subiu.output, /Cofre de segredos conferido no boot: grava e lê/);
});

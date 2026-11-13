'use strict';

// Verificação independente do Marco 9, rodada 8 (12/11/2026), item 4 (DI-M9R-23): depois de uma exceção ou de uma promessa rejeitada sem
// tratamento, a API seguia no ar com a transação aberta ("idle in transaction"), a trava presa e, com algumas falhas, o pool esgotado para todas as
// empresas. Agora: o processo registra como FATAL, para de aceitar conexões, espera os pedidos em andamento e sai com código 1 (o supervisor
// reinicia); as sessões do banco têm tempo máximo de transação parada e de comando; GET /api/health/pool (o HEALTHCHECK do contêiner) dá 503 com o
// pool esgotado. As falhas são injetadas por test/entradaGlobal.processo.preload.js no processo de verdade (`node app.js`), sem alterar o código.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const PRECISA_BANCO = DISPOSABLE ? false : 'precisa do banco descartável (node scripts/withDisposableDb.js)';
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const filhos = [];

after(() => { for (const f of filhos) if (f.saiu === null) f.proc.kill('SIGKILL'); });

/** Sobe `node -r preload app.js` (NODE_ENV=test: sem jobs agendados) e devolve o controle do processo. */
async function subirApi(rotulo, extra = {}) {
  const porta = Number(require('./marco9/_helpers/portaLivre').portaLivre());
  const gatilhos = fs.mkdtempSync(path.join(os.tmpdir(), `ci-falha-${rotulo}-`));
  const f = { porta, gatilhos, saida: '', saiu: null, nome: `ci-processo-${rotulo}-${process.pid}` };
  f.proc = spawn(process.execPath, ['-r', path.join(__dirname, 'entradaGlobal.processo.preload.js'), 'app.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'info', PORT: String(porta), CI_FALHA_DIR: gatilhos, DB_APPLICATION_NAME: f.nome, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  f.proc.stdout.on('data', (d) => { f.saida += d; });
  f.proc.stderr.on('data', (d) => { f.saida += d; });
  f.proc.on('exit', (code, signal) => { f.saiu = { code, signal, em: Date.now() }; });
  filhos.push(f);
  for (let i = 0; i < 100 && f.saiu === null; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${porta}/api/health`, { signal: AbortSignal.timeout(2000) })).status === 200) return f; } catch (_e) { /* subindo */ }
    await espera(300);
  }
  throw new Error(`a API não subiu: ${f.saida.slice(-600)}`);
}

let n = 0;
const injetar = (f, tipo, chave) => fs.writeFileSync(path.join(f.gatilhos, `${Date.now()}-${(n += 1)}.json`), JSON.stringify({ tipo, chave }));

async function admin(fn) {
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
/** Sessões do processo filho no banco, por estado. */
const sessoes = (nome) => admin(async (c) => (await c.query("SELECT state, count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 GROUP BY state ORDER BY state", [nome])).rows);
/** A trava consultiva está livre? (pega e solta na hora, pela conexão do superusuário). */
const travaLivre = (chave) => admin(async (c) => {
  const livre = (await c.query('SELECT pg_try_advisory_lock($1) AS ok', [chave])).rows[0].ok;
  if (livre) await c.query('SELECT pg_advisory_unlock($1)', [chave]);
  return livre;
});
async function esperarSaida(f, ms) {
  for (let t = 0; t < ms && f.saiu === null; t += 100) await espera(100);
  return f.saiu;
}
const pedirSaude = async (f, caminho) => {
  try {
    const r = await fetch(`http://127.0.0.1:${f.porta}${caminho}`, { signal: AbortSignal.timeout(8000) });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) { return { status: 0, erro: e.cause ? e.cause.code : e.name }; }
};

// ---------- unidade: o encerramento ----------

function servidorFalso({ fechaSozinho = true } = {}) {
  const s = { fechou: false, ociosas: 0, cb: null };
  s.close = (cb) => { s.fechou = true; s.cb = cb; if (fechaSozinho) setTimeout(cb, 20); };
  s.closeIdleConnections = () => { s.ociosas += 1; };
  return s;
}
function instalar(opcoes) {
  const guards = require('../src/utils/processGuards');
  guards._reiniciarParaTeste();
  const proc = new EventEmitter();
  proc.stdout = { write: (_t, cb) => cb() };
  const registros = [];
  const saidas = [];
  const log = { fatal: (o, m) => registros.push(['fatal', o.code, m, o]), error: (o, m) => registros.push(['error', o.code, m, o]) };
  assert.equal(guards.installProcessGuards({ log, proc, exit: (c) => saidas.push(c), ...opcoes }), true);
  return { guards, proc, registros, saidas };
}

test('exceção sem tratamento: registra FATAL com a pilha, fecha o servidor, espera os pedidos e sai com código 1', async () => {
  const server = servidorFalso();
  let poolFechado = false;
  const { guards, proc, registros, saidas } = instalar({ getServer: () => server, closePool: async () => { poolFechado = true; }, graceMs: 5000 });
  assert.equal(guards.estaEncerrando(), false);
  proc.emit('uncaughtException', new Error('boom'), 'uncaughtException');
  assert.equal(guards.estaEncerrando(), true, 'a rota de saúde passa a responder 503');
  assert.equal(server.fechou, true, 'para de aceitar conexões');
  assert.ok(server.ociosas >= 1, 'fecha as conexões ociosas');
  assert.deepEqual(registros[0].slice(0, 2), ['fatal', 'PROCESS_UNCAUGHT_EXCEPTION']);
  assert.match(registros[0][3].err.stack, /Error: boom/, 'com a pilha');
  proc.emit('uncaughtException', new Error('segunda'), 'uncaughtException');
  assert.deepEqual(registros[1].slice(0, 2), ['error', 'PROCESS_UNCAUGHT_EXCEPTION'], 'a segunda falha só é registrada');
  await espera(100);
  assert.deepEqual(saidas, [1], 'sai uma vez, com código 1');
  assert.equal(poolFechado, true, 'fecha o pool antes de sair');
  assert.equal(registros.at(-1)[1], 'PROCESS_EXIT');
});

test('promessa rejeitada sem tratamento: o mesmo encerramento (não segue atendendo)', async () => {
  const server = servidorFalso();
  const { proc, registros, saidas } = instalar({ getServer: () => server, graceMs: 5000 });
  proc.emit('unhandledRejection', new RangeError('Maximum call stack size exceeded'));
  assert.deepEqual(registros[0].slice(0, 2), ['fatal', 'PROCESS_UNHANDLED_REJECTION']);
  assert.equal(server.fechou, true);
  await espera(100);
  assert.deepEqual(saidas, [1]);
});

test('pedido em andamento que não termina: sai no fim do prazo PROCESS_FATAL_GRACE_MS, nem antes nem nunca', async () => {
  const server = servidorFalso({ fechaSozinho: false });
  const { proc, registros, saidas } = instalar({ getServer: () => server, closePool: () => new Promise(() => {}), graceMs: 300 });
  const t0 = Date.now();
  proc.emit('uncaughtException', new Error('presa'), 'uncaughtException');
  await espera(150);
  assert.deepEqual(saidas, [], 'ainda dentro do prazo');
  for (let i = 0; i < 40 && saidas.length === 0; i += 1) await espera(50);
  assert.deepEqual(saidas, [1], 'saiu depois do prazo, mesmo com o pool que não fecha (fechar o pool tem 1 s no máximo)');
  assert.ok(Date.now() - t0 >= 300);
  assert.match(registros.at(-1)[2], /prazo de 300 ms esgotado/);
});

test('falha antes de abrir a porta: sai direto; prazo e limites vêm das variáveis de ambiente, com padrão e faixa', async () => {
  const { proc, saidas } = instalar({ getServer: () => null });
  proc.emit('uncaughtException', new Error('cedo'), 'uncaughtException');
  await espera(50);
  assert.deepEqual(saidas, [1]);
  const { prazoDeEncerramento } = require('../src/utils/processGuards');
  assert.equal(prazoDeEncerramento({}), 10000);
  assert.equal(prazoDeEncerramento({ PROCESS_FATAL_GRACE_MS: '2500' }), 2500);
  assert.equal(prazoDeEncerramento({ PROCESS_FATAL_GRACE_MS: '999999' }), 10000, 'fora da faixa vale o padrão');
  const { temposDaSessao, opcoesDeTempoDaSessao } = require('../src/config/dbSessionTimeouts');
  assert.deepEqual(temposDaSessao({}), { idleInTransactionMs: 300000, statementMs: 120000, migrationStatementMs: 0 });
  assert.deepEqual(temposDaSessao({ DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '0', DB_STATEMENT_TIMEOUT_MS: 'x' }), { idleInTransactionMs: 0, statementMs: 120000, migrationStatementMs: 0 });
  assert.deepEqual(opcoesDeTempoDaSessao({ migracao: true, env: {} }), { idle_in_transaction_session_timeout: 300000, statement_timeout: 0 });
  const cli = require('../src/config/sequelize-cli');
  assert.equal(cli.test.dialectOptions.idle_in_transaction_session_timeout, 300000, 'as migrations também têm o limite de transação parada');
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^HEALTHCHECK .*CMD \["node", "scripts\/healthcheck\.js"\]$/m, 'o contêiner tem HEALTHCHECK');
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/healthcheck.js'), 'utf8'), /\/health\/pool/);
});

// ---------- banco: os limites da sessão ----------

test('as conexões da aplicação abrem com idle_in_transaction_session_timeout e statement_timeout', { skip: PRECISA_BANCO }, async () => {
  const { sequelize } = require('../src/config/database');
  const [[linha]] = await sequelize.query("SELECT current_setting('idle_in_transaction_session_timeout') AS parada, current_setting('statement_timeout') AS comando, current_setting('application_name') AS nome");
  assert.deepEqual(linha, { parada: '5min', comando: '2min', nome: 'nayaraone-api' });
  await sequelize.close();
});

// ---------- o processo de verdade, com a falha injetada ----------

for (const [tipo, codigo] of [['ue', 'PROCESS_UNCAUGHT_EXCEPTION'], ['ur', 'PROCESS_UNHANDLED_REJECTION']]) {
  test(`node app.js, ${codigo} no meio de uma transação: o processo sai com 1 e o banco desfaz a transação e solta a trava`, { skip: PRECISA_BANCO, timeout: 60000 }, async () => {
    const f = await subirApi(tipo, { PROCESS_FATAL_GRACE_MS: '1500' });
    const chave = 880000 + (tipo === 'ue' ? 1 : 2);
    injetar(f, tipo, chave);
    const saiu = await esperarSaida(f, 15000);
    assert.ok(saiu, `o processo terminou (saída: ${f.saida.slice(-800)})`);
    assert.equal(saiu.code, 1, 'código de saída diferente de zero');
    assert.match(f.saida, /CI_FALHA_INJETADA/, 'a falha foi injetada com a trava pega');
    const linhas = f.saida.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch (_e) { return {}; } });
    const fatal = linhas.find((l) => l.code === codigo);
    assert.ok(fatal, `registro ${codigo}`);
    assert.equal(fatal.level, 60, 'como FATAL');
    assert.match(fatal.err.stack, /CI (exceção|rejeição) sem tratamento/, 'com a pilha');
    assert.ok(linhas.some((l) => l.code === 'PROCESS_EXIT' && l.exitCode === 1));
    await espera(500);
    assert.deepEqual(await sessoes(f.nome), [], 'nenhuma sessão do processo ficou no banco');
    assert.equal(await travaLivre(chave), true, 'a trava foi solta');
  });
}

test('node app.js, conexões presas: /api/health/pool dá 503 POOL_EXHAUSTED e o HEALTHCHECK falha; o banco encerra a transação parada e o pool volta', { skip: PRECISA_BANCO, timeout: 90000 }, async () => {
  const f = await subirApi('pool', { DB_POOL_MAX: '2', DB_POOL_ACQUIRE_MS: '3000', HEALTH_POOL_TIMEOUT_MS: '1000', DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '8000' });
  const ok = await pedirSaude(f, '/api/health/pool');
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.equal(ok.body.data.status, 'ok');
  assert.equal(ok.body.data.pool.max, 2);
  const hcEnv = { ...process.env, PORT: String(f.porta) };
  const healthcheck = () => spawnSync(process.execPath, ['scripts/healthcheck.js'], { cwd: ROOT, env: hcEnv }).status;
  assert.equal(healthcheck(), 0, 'HEALTHCHECK passa');
  const t0 = Date.now();
  injetar(f, 'segura', 880101);
  injetar(f, 'segura', 880102);
  await espera(1000);
  assert.deepEqual(await sessoes(f.nome), [{ state: 'idle in transaction', n: 2 }], 'as duas conexões do pool presas em transação');
  const ruim = await pedirSaude(f, '/api/health/pool');
  assert.equal(ruim.status, 503, JSON.stringify(ruim));
  assert.equal(ruim.body.error.code, 'POOL_EXHAUSTED');
  assert.equal(ruim.body.data.pool.using, 2);
  assert.equal(healthcheck(), 1, 'HEALTHCHECK falha: com 3 falhas seguidas o contêiner é substituído');
  assert.ok(Date.now() - t0 < 7000, 'tudo isso antes do limite de transação parada');
  assert.equal(await travaLivre(880101), false, 'a trava continua presa enquanto a transação está aberta');
  // o limite de transação parada (8 s aqui; 5 min por padrão) encerra as sessões no banco: transação desfeita, travas soltas e o Sequelize descarta
  // a conexão quebrada, devolvendo o lugar no pool
  await espera(Math.max(0, 10000 - (Date.now() - t0)));
  const depois = await sessoes(f.nome);
  assert.ok(!depois.some((s) => s.state === 'idle in transaction'), `o banco encerrou as transações paradas: ${JSON.stringify(depois)}`);
  assert.equal(await travaLivre(880101), true, 'e soltou as travas');
  assert.equal(await travaLivre(880102), true);
  const volta = await pedirSaude(f, '/api/health/pool');
  assert.equal(volta.status, 200, `o pool voltou: ${JSON.stringify(volta)}`);
  assert.equal(healthcheck(), 0);
  assert.equal(f.saiu, null, 'conexões presas sem exceção não encerram o processo');
  f.proc.kill('SIGKILL');
});

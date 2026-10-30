'use strict';

// M9-D047 — todo log da NAY carrega `correlationId` e `runId`: o do pedido e o do run em curso, também nos logs de passos, de contexto e de erro; fora de um run o
// correlationId é o da requisição e o runId fica nulo (a chave sempre está na linha). Nenhum log da NAY escapa do safeLogger.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, carregarPessoas } = require('../../helpers/aiRuns');
const logger = require('../../../src/utils/logger');
const { runWithCorrelationId } = require('../../../src/middlewares/correlationId.middleware');
const { safeLogger } = require('../../../src/features/ai/audit');
const { runWithLogContext, setRunLog, currentLogContext } = require('../../../src/features/ai/observability');
const H = require('../_helpers/iaOrquestrador');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

function capturar(nivel, fn) {
  const linhas = [];
  const anterior = logger.level;
  logger.level = nivel;
  const remover = logger.addLogTap((l) => linhas.push(l));
  return Promise.resolve(fn()).then(() => linhas.map((l) => JSON.parse(l)), (e) => { throw e; }).finally(() => { remover(); logger.level = anterior; });
}

test('m9d047_log_com_correlation_id_e_run_id', async () => {
  const cid = crypto.randomUUID();
  // 1) Fora de um run: o correlationId é o da requisição em curso e o runId é nulo, mas a chave existe.
  const fora = await capturar('info', () => runWithCorrelationId(cid, () => {
    safeLogger.info({ tema: 'fora' }, 'ai.teste.fora');
    safeLogger.warn('só texto');
    safeLogger.error(new Error('falha de teste'), 'ai.teste.erro');
  }));
  assert.equal(fora.length, 3);
  for (const l of fora) { assert.equal(l.correlationId, cid); assert.ok('runId' in l && l.runId === null); }
  // 2) Dentro do contexto de um run: o runId e o correlationId do pedido vão em todas as linhas, inclusive nas que só têm texto.
  const runId = crypto.randomUUID();
  const dentro = await capturar('info', () => runWithLogContext(async () => {
    setRunLog({ correlationId: cid, runId });
    safeLogger.info({ tema: 'dentro' }, 'ai.teste.dentro');
    await Promise.resolve();
    safeLogger.error(new Error('depois do await'), 'ai.teste.erro');
    safeLogger.info('texto puro');
  }));
  assert.equal(dentro.length, 3);
  for (const l of dentro) { assert.equal(l.correlationId, cid); assert.equal(l.runId, runId); }
  assert.deepEqual(currentLogContext(), { correlationId: null, runId: null }, 'o contexto do run não vaza para fora dele');
  // 3) O que o chamador informa vale mais do que o contexto.
  const explicito = await capturar('info', () => runWithLogContext(() => { setRunLog({ correlationId: cid, runId }); safeLogger.info({ runId: 'outro-run' }, 'ai.teste.explicito'); }));
  assert.equal(explicito[0].runId, 'outro-run');
  // 4) Um run de verdade: toda linha de ai.* do orquestrador (passos no nível debug) traz o correlationId do pedido; depois de aberto o run, o runId dele.
  const pedido = crypto.randomUUID();
  let res;
  const linhas = await capturar('debug', () => withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    res = await H.rodar(c, `Veja ${H.pedirOportunidade(c)} [[RESPOSTA:Oportunidade consultada.]]`, { correlationId: pedido });
    assert.equal(res.ok, true, JSON.stringify(res.error));
  }));
  const da = linhas.filter((l) => typeof l.msg === 'string' && l.msg.startsWith('ai.'));
  const passos = da.filter((l) => l.msg === 'ai.run.step');
  assert.ok(passos.length >= 12, `passos do run no log (${passos.length})`);
  for (const l of da) { assert.equal(l.correlationId, pedido, l.msg); assert.ok('runId' in l, l.msg); }
  assert.ok(passos.filter((l) => l.step >= 3).every((l) => l.runId === res.runId), 'depois do passo 2 todo passo leva o runId do run');
  assert.ok(passos.some((l) => l.step === 12 && l.runId === res.runId));
});

test('m9d047_nenhum_log_da_nay_escapa_do_safe_logger', () => {
  const raiz = path.join(__dirname, '..', '..', '..', 'src', 'features', 'ai');
  const achados = [];
  const varrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) varrer(p);
      else if (e.name.endsWith('.js') && !p.endsWith(path.join('audit', 'safeLogger.js')) && /utils\/logger['"]/.test(fs.readFileSync(p, 'utf8'))) achados.push(path.relative(raiz, p));
    }
  };
  varrer(raiz);
  assert.deepEqual(achados, [], 'só audit/safeLogger.js pode usar o logger cru; o resto da NAY loga pelo safeLogger (correlationId, runId e redaction)');
});

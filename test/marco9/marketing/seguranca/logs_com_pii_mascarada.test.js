'use strict';

// M9-D441 segurança 6 (Caderno §14 e DoD "RLS/redaction"): revisão de logs, PII mascarada. (1) Cenário de ponta a ponta com o logger em debug: o telefone, o e-mail, o texto da mensagem e o token não
// aparecem em nenhuma linha, e o que o adapter registra do destinatário vem como [REDIGIDO]. (2) Caminho de falha do worker: o erro cuja mensagem traz e-mail, CPF, CNPJ, telefone e token
// sai das linhas de log mascarado (a biblioteca única de redaction, M9-D246). Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withRollbackTenantTransaction, withTenantTransaction } = require('../../../testHelpers');
const worker = require('../../_helpers/mktWorker');
const { cenario, capturarLogs, BEARER, TOKEN } = require('../../_helpers/mktSegCenario');
const logger = require('../../../../src/utils/logger');

let ctx;
before(async () => { ctx = await worker.setup(); });
after(async () => { await sequelize.close(); });
afterEach(() => { worker.reset(); worker.resetSandbox(); });

// valores de PII montados na hora (CPF e CNPJ válidos de teste)
const PII = { email: 'maria.souza.qa@exemplo.test', cpf: '529.982.247-25', cnpj: '11.222.333/0001-81', telefone: '(71) 99999-1234' };

test('logs_com_pii_mascarada', async (tctx) => {
  // 1) cenário completo em nível debug
  await withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const c = await cenario(t, ctx);
    assert.ok(c.logs.includes('marketing.channel.adapter'), 'os logs dos adapters foram emitidos (nível debug)');
    for (const [nome, valor] of Object.entries({ telefone: c.secrets.telefone, 'e-mail': c.secrets.email, token: c.secrets.token, bearer: c.secrets.bearer, 'texto da mensagem': c.secrets.mensagem })) {
      assert.ok(!c.logs.includes(valor), `${nome} apareceu no log`);
    }
    const envio = c.logs.split('\n').find((l) => l.includes('"channel":"WHATSAPP"') && l.includes('"event":"request"'));
    assert.ok(envio, 'a linha do envio de WhatsApp existe');
    const linha = JSON.parse(envio);
    assert.equal(linha.payload.to, '[REDIGIDO]', 'o destinatário vem mascarado');
    assert.equal(linha.payload.text, '[REDIGIDO]', 'o texto integral vem mascarado');
  });
  // 2) falha do worker com PII e token na mensagem do erro, e linhas diretas do logger nos três níveis
  const { logs } = await capturarLogs(async () => {
    const mensagem = `falha ao falar com ${PII.email} CPF ${PII.cpf} CNPJ ${PII.cnpj} fone ${PII.telefone} ${BEARER} access_token=${TOKEN}`;
    let chamadas = 0; // a leitura dos parâmetros (1ª chamada) funciona; toda fase seguinte cai com a mensagem que traz os dados pessoais
    const withTx = (fn) => (chamadas++ === 0 ? withTenantTransaction(ctx.tenant, fn) : Promise.reject(new Error(mensagem)));
    await require('../../../../src/features/marketing/publications/worker').runWorkerCycle(ctx.tenant, { withTx });
    logger.info({ contato: PII.email, documento: PII.cpf }, `cliente ${PII.email} ${PII.cpf}`);
    logger.warn({ err: `telefone ${PII.telefone}` }, `empresa ${PII.cnpj}`);
    logger.error({ err: new Error(`e-mail ${PII.email}`) }, `token ${TOKEN}`);
  });
  assert.ok(logs.includes('phase_failed'), 'o caminho de falha do worker registrou o erro');
  for (const [nome, valor] of Object.entries({ 'e-mail': PII.email, CPF: PII.cpf, CNPJ: PII.cnpj, token: TOKEN, bearer: BEARER.split(' ')[1] })) assert.ok(!logs.includes(valor), `${nome} apareceu em claro no log`);
  assert.ok(!logs.replace(/\D/g, '').includes('999991234'), 'o telefone apareceu em claro no log');
  assert.ok(/\[REDACTED\]|\[removido\]|\[REDIGIDO\]/.test(logs), 'o que foi mascarado vem com marcador, não some em silêncio');
  tctx.diagnostic(`${logs.split('\n').filter(Boolean).length} linhas de log do caminho de falha conferidas: e-mail, CPF, CNPJ, telefone e token mascarados`);
});

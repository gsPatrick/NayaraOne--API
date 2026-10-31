'use strict';

// Cenário dos testes de vazamento e de log do Marketing (M9-D441, não é teste): na transação do teste, uma mensagem automática a uma pessoa com telefone e e-mail conhecidos e uma
// publicação cujo provedor responde erro com token no texto; captura a saída padrão (logs, em nível debug) e devolve tudo que o sistema devolve, grava ou emite, mais os segredos plantados.
const crypto = require('node:crypto');
const logger = require('../../../src/utils/logger');
const runner = require('./mktRunner');
const worker = require('./mktWorker');
const { allowTestUrls } = require('./mktUrlPolicy');
const service = require('../../../src/features/marketing/content/content.service');
const publications = require('../../../src/features/marketing/publications');
const tracking = require('../../../src/features/marketing/tracking').service;

const uid = () => crypto.randomUUID();
// montados em tempo de execução: o varredor de segredos do repositório não pode ver um token escrito inteiro
const TOKEN = ['EAAB', 'sbCS1iHgBAPl', 'mnopQRSTuvwxYZ0123456789', 'tokenDaRede'].join('');
const BEARER = `Bearer ${['ya29', 'a0AfB_byCqF7mXk2LnPq8RtVwYz1234567890abcdef'].join('.')}`;

/** Roda `fn` capturando tudo que o processo escreve na saída padrão com o logger em debug; devolve { value, logs }. */
async function capturarLogs(fn) {
  const linhas = [];
  const original = process.stdout.write;
  const nivel = logger.level;
  process.stdout.write = function escrever(chunk, ...rest) { linhas.push(String(chunk)); return original.call(process.stdout, chunk, ...rest); };
  logger.level = 'debug';
  try {
    const value = await fn();
    return { value, logs: linhas.join('') };
  } finally { process.stdout.write = original; logger.level = nivel; }
}

async function cenario(t, ctx) {
  const tenant = ctx.tenant;
  await allowTestUrls(t, tenant);
  const digits = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const secrets = {
    telefone: `119${digits}`, email: `qa-m9-seg-${uid().slice(0, 8)}@exemplo.test`, token: TOKEN, bearer: BEARER.split(' ')[1],
    mensagem: `Mensagem integral QA-M9 ${uid().slice(0, 8)} com condição exclusiva de visita`,
    rua: 'Rua das Acácias', cep: '01310-100',
  };
  const person = await runner.readyPerson(t, tenant, { phone: secrets.telefone, email: secrets.email });
  const templateId = await runner.makeTemplate(t, tenant, { body: `Olá {{primeiroNome}}, ${secrets.mensagem}` });
  await runner.publishedFlow(t, tenant, { templateId, actions: [runner.SEND({ templateId })] });
  const restore = worker.overrideSandbox('INSTAGRAM', (adapter) => {
    adapter.execute = async (operation, payload, options) => {
      adapter.log('request', { operation, payload, headers: { authorization: BEARER }, accessToken: TOKEN });
      return adapter.failure(operation, options.idempotencyKey, 'FAILED', 503, 'HTTP_5XX', `Falha ${BEARER} access_token=${TOKEN} contato ${secrets.email}`);
    };
    return adapter;
  });
  try {
    const { value, logs } = await capturarLogs(async () => {
      const run = await runner.run(t, tenant, runner.eventFor(tenant, person));
      const s = await worker.scheduled(t, ctx, ['SITE', 'INSTAGRAM']);
      await worker.cycle(t, ctx, { now: s.now });
      await worker.cycle(t, ctx, { now: new Date(s.now.getTime() + 600000) });
      return { run, s };
    });
    const { run, s } = value;
    const q = runner.q;
    const respostas = JSON.stringify({
      conteudo: await service.getContent(tenant, s.itemId, t), publicacoes: await publications.service.listPublications(tenant, {}, t), atribuicao: await tracking.attributionReport(tenant, {}, t),
      run: await runner.runRow(t, run.runs[0].runId), execucao: run,
    });
    const eventos = JSON.stringify(await q(t, 'SELECT event_type, payload_json FROM integration.outbox_events WHERE company_id = :c', { c: tenant.companyId }));
    const registros = JSON.stringify({
      resultados: await q(t, 'SELECT response_redacted_json, external_url FROM marketing.publication_results WHERE company_id = :c', { c: tenant.companyId }),
      jobs: await q(t, 'SELECT last_error_code, idempotency_key FROM marketing.publication_jobs WHERE company_id = :c', { c: tenant.companyId }),
      runs: await q(t, 'SELECT policy_trace, actions_result, blocked_reason FROM marketing.automation_runs WHERE company_id = :c', { c: tenant.companyId }),
      versoes: await q(t, 'SELECT checks_json, facts_snapshot_json FROM marketing.content_versions WHERE company_id = :c', { c: tenant.companyId }),
      auditoria: await q(t, 'SELECT before_json, after_json FROM audit.audit_log WHERE company_id = :c', { c: tenant.companyId }),
    });
    const mensagem = (await runner.messagesOf(t, person));
    return { secrets, logs, respostas, eventos, registros, person, mensagens: mensagem.length, jobs: await worker.job(t, s.jobId) };
  } finally { restore(); worker.resetSandbox(); }
}

module.exports = { cenario, capturarLogs, TOKEN, BEARER };

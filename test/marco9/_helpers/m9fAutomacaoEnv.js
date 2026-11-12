'use strict';

// Apoio dos testes da nova tentativa e da reconciliação da ação SEND_MESSAGE das automações (DI-M9F-1). Não é teste.
// O cenário do sandbox entra no caminho REAL (runner -> executor -> sendMarketingMessage -> sendToChannel): o m9eEnv envolve a fachada dos adapters ANTES de a
// mensagem carregar, por isso ele vem primeiro; o mktRunner (que carrega o Marketing e registra as portas do runner) vem depois.
const m9e = require('./m9eEnv');
const r = require('./mktRunner');
const { suppress } = require('../../../src/features/marketing/suppression/suppression.service');
const { allowTestUrls } = require('./mktUrlPolicy');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { espiarCanais } = require('./mktGuardas');

const { q, T0, at } = m9e;
const spy = { current: null };

/** O apoio da campanha (cofre temporário, sandbox limpo) e um espião no adapter sandbox: cada envio e cada consulta pela chave, em ordem. */
function setUp() { m9e.setUp(); spy.current = espiarCanais(); }
function tearDown() { if (spy.current) spy.current.restaurar(); spy.current = null; m9e.tearDown(); }
/** Sequência de chamadas ao canal com a chave da ação ('envio' | 'consulta'): prova que não há envio duplicado nem reenvio sem consulta. */
const callsOf = (actionKey) => spy.current.chamadas.filter((c) => c.chave === actionKey).map((c) => c.tipo);

/** Fluxo publicado com UMA ação de e-mail de marketing (template de e-mail publicado, descadastro configurado), opcionalmente seguida de outras ações. */
async function emailFlow(t, tenant, { after = [] } = {}) {
  await allowTestUrls(t, tenant);
  // runs WAITING que outros arquivos deixaram commitadas na empresa não entram nas rodadas do executor deste teste (só na transação dele, desfeita no fim)
  await q(t, "UPDATE marketing.automation_runs SET next_due_at = '2999-01-01T00:00:00Z' WHERE company_id = :c AND status = 'WAITING' RETURNING id", { c: tenant.companyId });
  await upsertSetting('marketing.email.url_descadastro', 'https://www.exemplo.test/descadastro?t={token}', tenant, tenant.userId, t);
  const templateId = await m9e.makeTemplate(t, tenant, { channel: 'EMAIL', official: null, body: 'Conheça o Aurora, um lançamento novo.', variables: [] });
  return r.publishedFlow(t, tenant, { templateId, actions: [r.SEND({ channel: 'EMAIL', purpose: 'MARKETING', variables: {}, subject: 'Novidade Nayara' }), ...after] });
}

/** Dispara a automação para a pessoa no instante `when` (o evento de entrada do runner, como o consumidor do outbox monta). */
async function fire(t, tenant, personId, when = T0) {
  const out = await r.run(t, tenant, r.eventFor(tenant, personId), { now: when });
  return out.runs[0].runId;
}

/** Uma rodada do executor das ações adiadas (automationDueJob) no instante `when`. */
const due = (t, tenant, when) => r.runner.runDueActions(tenant, t, { now: when, mode: 'SANDBOX' });

const runOf = (t, runId) => r.runRow(t, runId);
const sendOf = async (t, runId) => r.sendEntry(await runOf(t, runId));
const messages = (t, tenant, personId) => q(t, `SELECT status, delivery_status, action_key, failure_reason FROM crm.messages
  WHERE company_id = :c AND person_id = :p AND direction = 'OUTBOUND' ORDER BY created_at`, { c: tenant.companyId, p: personId });
const suppressEmail = (t, tenant, personId) => suppress({ personId, channel: 'EMAIL', reason: 'OPT_OUT', source: 'QA-M9F' }, tenant, t);

module.exports = { ...m9e, setUp, tearDown, callsOf, runner: r.runner, TASK: r.TASK, emailFlow, fire, due, runOf, sendOf, messages, suppressEmail, T0, at };

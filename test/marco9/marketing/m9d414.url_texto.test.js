'use strict';

// M9-D414 (reabertura da rodada 2, L-5) — a regra de URL externa da M9-D433 vale para o texto livre, as variáveis, o assunto e o pré-cabeçalho do envio direto e para o
// texto das ações da definição da automação (criação e publicação). Postgres real (RLS), transação com rollback. Só em banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const env = require('../_helpers/mktRunner');
const { allowTestUrls } = require('../_helpers/mktUrlPolicy');
const fx = require('../../helpers/m9d413Fixtures');
const { useTempSecretStore } = require('../_helpers/mktSecretStore');
const svc = require('../../../src/features/marketing/automations/automations.service');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenant;
let cleanup;
before(async () => { ({ tenantA: tenant } = await env.prepararTenants()); cleanup = useTempSecretStore(); });
after(async () => { cleanup(); await sequelize.close(); });
const recusa = (e) => e.statusCode === 422 && e.code === 'MKT_URL_NOT_ALLOWED';

const HOSTIS = ['Entre em evil.com/login agora', 'Entre em https://evil.com/login agora', 'Veja evil.fr/x', 'Veja www.evil.com', 'Toque javascript:alert(1)', 'Veja //evil.com/x'];

test('envio_direto_recusa_url_hostil_no_texto_assunto_preheader_e_variaveis', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const person = await env.readyPerson(t, tenant);
    const base = (over) => ({ channel: 'EMAIL', personId: person, purpose: 'MARKETING', actionKey: env.key(), subject: 'Novidades', text: 'Olá, temos novidades.', unsubscribeUrl: 'https://www.exemplo.test/d?t=1', ...over });
    for (const hostil of HOSTIS) {
      for (const campo of ['text', 'subject', 'preheader']) {
        const input = base({ [campo]: hostil });
        await assert.rejects(() => env.send(t, tenant, input), recusa, `${campo}: ${hostil}`);
        assert.equal(await env.byKey(t, tenant, input.actionKey), undefined, 'nada é gravado nem enviado');
      }
      const comVariavel = base({ variables: { primeiroNome: hostil } });
      await assert.rejects(() => env.send(t, tenant, comVariavel), recusa, `variável: ${hostil}`);
    }
    // texto limpo, URL permitida, e-mail e abreviação com espaço (Av. Paulista) passam
    const limpo = await env.send(t, tenant, base({ text: 'Veja https://www.exemplo.test/imovel/1 ou escreva para maria.pro@exemplo.test. Visite a Av. Paulista, 100.' }));
    assert.equal(limpo.status, 'SENT');
  });
});

test('envio_pelo_runner_com_dominio_que_saiu_da_lista_falha_a_acao_e_nao_envia', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await allowTestUrls(t, tenant);
    await upsertSetting('marketing.email.url_descadastro', 'https://www.exemplo.test/d?t={token}', tenant, tenant.userId, t);
    const first = await env.readyPerson(t, tenant);
    const second = await env.readyPerson(t, tenant);
    await env.makeOpportunity(t, tenant, first, { stage: 'NEW' });
    await env.makeOpportunity(t, tenant, second, { stage: 'NEW' });
    await env.publishedFlow(t, tenant, { actions: [env.SEND({ channel: 'EMAIL', templateId: null, subject: 'Oi', text: 'Veja https://www.exemplo.test/promo hoje', variables: {} })] });
    const ok = env.sendEntry(await env.runRow(t, (await env.run(t, tenant, env.eventFor(tenant, first))).runs[0].runId));
    assert.equal(ok.status, 'OK', `com o domínio na lista a mensagem sai: ${JSON.stringify(ok)}`);
    await upsertSetting('marketing.url.dominios_permitidos', 'outro.com.br', tenant, tenant.userId, t); // o domínio saiu da lista depois da publicação
    const send = env.sendEntry(await env.runRow(t, (await env.run(t, tenant, env.eventFor(tenant, second))).runs[0].runId));
    assert.equal(send.status, 'FAILED', JSON.stringify(send));
    assert.match(String(send.detail), /URL/i);
    assert.equal((await env.messagesOf(t, second)).length, 0, 'nenhuma mensagem sai');
  });
});

const corpo = (acao) => fx.validBody(tenant, { actions: [acao] });

test('definicao_da_automacao_recusa_url_hostil_nas_acoes_ao_criar_e_ao_publicar', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await allowTestUrls(t, tenant);
    for (const hostil of HOSTIS) {
      for (const campo of ['text', 'subject', 'preheader']) {
        await assert.rejects(() => svc.createAutomation({ tenant, actor: tenant.userId, input: corpo({ actionType: 'SEND_MESSAGE', channel: 'EMAIL', [campo]: hostil }) }, t), recusa, `${campo}: ${hostil}`);
      }
    }
    await assert.rejects(() => svc.createAutomation({ tenant, actor: tenant.userId, input: corpo({ actionType: 'SEND_MESSAGE', channel: 'EMAIL', text: 'Oi', portalUrl: 'https://evil.com/p' }) }, t), recusa, 'portalUrl');
    await assert.rejects(() => svc.createAutomation({ tenant, actor: tenant.userId, input: corpo({ actionType: 'NOTIFY_USER', title: 'Veja', body: 'evil.com/login' }) }, t), recusa, 'texto de ação interna');
    // limpo cria; se o domínio sair da lista, publicar recusa
    const ok = await svc.createAutomation({ tenant, actor: tenant.userId, input: corpo({ actionType: 'SEND_MESSAGE', channel: 'EMAIL', subject: 'Oi', text: 'Veja https://www.exemplo.test/promo', portalUrl: 'https://portal.exemplo.test/x' }) }, t);
    assert.equal(ok.version.status, 'DRAFT');
    await upsertSetting('marketing.url.dominios_permitidos', 'outro.com.br', tenant, tenant.userId, t);
    await assert.rejects(() => svc.publishAutomation({ tenant, actor: tenant.userId, flowId: ok.flow.id, input: { versionNo: 1, reason: 'QA-M9 publicação' } }, t), recusa, 'publicar reconfere');
  });
});

'use strict';

// M9-D414 (reabertura da rodada 4, G-1, M-2 e L-5) — a varredura de URL do envio direto e da definição de automação tem teto de tamanho por variável, por campo e no total
// (parâmetros do administrador), antes de qualquer extração; o candidato ambíguo (REVIEW) onde não há aprovador humano é recusado (política configurável); a definição varre
// toda folha das ações (cta, botões, listas), não só variáveis de texto. Postgres real (RLS), transação com rollback. Só em banco descartável.
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
const recusa = (reason) => (e) => e.statusCode === 422 && e.code === 'MKT_URL_NOT_ALLOWED' && (!reason || JSON.stringify(e.details || e).includes(reason));
const set = (t, key, value) => upsertSetting(key, value, tenant, tenant.userId, t);
const base = (person, over) => ({ channel: 'EMAIL', personId: person, purpose: 'MARKETING', actionKey: env.key(), subject: 'Novidades', text: 'Olá, temos novidades.', unsubscribeUrl: 'https://www.exemplo.test/d?t=1', ...over });
const corpo = (acao) => fx.validBody(tenant, { actions: [acao] });
const security = require('../../../src/features/marketing/security');
// Ambíguos (REVIEW do extrator da M9-D433: abreviação colada e nome de arquivo) e formas que a rodada 4 reproduziu como SENT (encurtador e endereço curto): nenhuma sai por padrão.
const REVISAO = ['Visite a Av.Paulista, 100.', 'Veja foto.jpg'];
const SUSPEITOS = ['Veja Rb.gy/Abc12', 'Ab.lol/Login'];

test('variavel_hostil_de_1_mb_e_recusada_pelo_teto_sem_prender_o_processo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const person = await env.readyPerson(t, tenant);
    const hostis = [{ v: `${'a+'.repeat(500000)}@` }, { lista: ['ok', 'x'.repeat(2_000_000)] }, { o: { a: 'y'.repeat(5000) } }, { o: { ['k'.repeat(5000)]: 'v' } }];
    for (const variables of hostis) {
      const input = base(person, { variables });
      const began = Date.now();
      await assert.rejects(() => env.send(t, tenant, input), recusa('CAMPO_GRANDE_DEMAIS'), JSON.stringify(variables).slice(0, 40));
      assert.ok(Date.now() - began < 2000, 'recusado pelo tamanho, sem extrair');
      assert.equal(await env.byKey(t, tenant, input.actionKey), undefined, 'nada é gravado nem enviado');
    }
    const fundo = {}; let cursor = fundo; for (let i = 0; i < 12; i += 1) { cursor.n = {}; cursor = cursor.n; } cursor.x = 'evil.com/x';
    await assert.rejects(() => env.send(t, tenant, base(person, { variables: { fundo } })), recusa('CAMPO_GRANDE_DEMAIS'), 'profundidade acima do máximo é recusada, não ignorada');
  });
});

test('tetos_de_tamanho_sao_parametros_do_administrador', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const person = await env.readyPerson(t, tenant);
    await set(t, 'marketing.url.max_chars_variavel', 100);
    const longa = 'casa '.repeat(30); // 150 caracteres
    await assert.rejects(() => env.send(t, tenant, base(person, { variables: { nome: longa } })), recusa('CAMPO_GRANDE_DEMAIS'), 'variável de 150 com teto 100');
    assert.equal((await env.send(t, tenant, base(person, { variables: { nome: 'casa '.repeat(18) } }))).status, 'SENT', 'variável de 90 com teto 100');
    await set(t, 'marketing.url.max_chars_variavel', 2000);
    await set(t, 'marketing.url.max_chars_campo', 300);
    await assert.rejects(() => env.send(t, tenant, base(person, { text: 'Olá '.repeat(100) })), recusa('CAMPO_GRANDE_DEMAIS'), 'texto de 400 com teto de campo 300');
    await set(t, 'marketing.url.max_chars_campo', 20000);
    await set(t, 'marketing.url.max_chars_total', 1000);
    const duas = { a: 'z'.repeat(600), b: 'w'.repeat(600) };
    await assert.rejects(() => env.send(t, tenant, base(person, { variables: duas })), recusa('TEXTO_GRANDE_DEMAIS'), 'soma de 1200 com teto total 1000');
    await set(t, 'marketing.url.max_chars_total', 100000);
    assert.equal((await env.send(t, tenant, base(person, { variables: duas }))).status, 'SENT', 'com o teto padrão a mesma soma passa');
  });
});

test('candidato_ambiguo_sem_aprovador_e_recusado_no_envio_direto_e_o_parametro_libera', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const person = await env.readyPerson(t, tenant);
    for (const texto of REVISAO) assert.ok(security.extractCandidates(texto).some((c) => c.kind === 'REVIEW'), `${texto} segue sendo REVIEW no extrator`);
    for (const texto of SUSPEITOS) {
      for (const campo of ['text', 'subject', 'preheader']) {
        const input = base(person, { [campo]: texto });
        await assert.rejects(() => env.send(t, tenant, input), recusa(''), `${campo}: ${texto}`);
        assert.equal(await env.byKey(t, tenant, input.actionKey), undefined);
      }
    }
    for (const texto of REVISAO) {
      for (const campo of ['text', 'subject', 'preheader']) {
        const input = base(person, { [campo]: texto });
        await assert.rejects(() => env.send(t, tenant, input), recusa('REVISAO_HUMANA_NECESSARIA'), `${campo}: ${texto}`);
        assert.equal(await env.byKey(t, tenant, input.actionKey), undefined);
      }
      const comVariavel = base(person, { variables: { lista: [texto] } });
      await assert.rejects(() => env.send(t, tenant, comVariavel), recusa('REVISAO_HUMANA_NECESSARIA'), `variável: ${texto}`);
    }
    assert.equal((await env.send(t, tenant, base(person, { text: 'Visite a Avenida Paulista, 100.' }))).status, 'SENT', 'texto sem forma de endereço passa');
    await set(t, 'marketing.url.revisao_sem_aprovador', 'permitir');
    assert.equal((await env.send(t, tenant, base(person, { text: 'Visite a Av.Paulista, 100.' }))).status, 'SENT', 'o administrador pode permitir o ambíguo');
    await assert.rejects(() => env.send(t, tenant, base(person, { text: 'Acesse evil.com/login' })), recusa(''), 'o hostil continua recusado com a política permissiva');
  });
});

test('definicao_da_automacao_varre_cta_botoes_e_listas_com_teto_e_politica_de_revisao', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await allowTestUrls(t, tenant);
    const send = (extra) => corpo({ actionType: 'SEND_MESSAGE', channel: 'EMAIL', subject: 'Oi', text: 'Veja https://www.exemplo.test/promo', ...extra });
    const hostis = [{ cta: { label: 'Ver', url: 'evil.com/x' } }, { botoes: [{ rotulo: 'a' }, { rotulo: 'Acesse:evil.com/login' }] }, { lista: [['evil.Com']] }, { variables: { o: { 'evil.com/x': 1 } } },
      { variables: { code: 'evil.com/x', type: 'evil.com/y' } }, { cta: { id: 'evil.com/x', key: 'www.evil.com' } }]; // chave com nome de configuração dentro do conteúdo não esconde endereço
    for (const extra of hostis) await assert.rejects(() => svc.createAutomation({ tenant, actor: tenant.userId, input: send(extra) }, t), recusa(), JSON.stringify(extra));
    await assert.rejects(() => svc.createAutomation({ tenant, actor: tenant.userId, input: send({ variables: { nome: 'x'.repeat(3000) } }) }, t), recusa('CAMPO_GRANDE_DEMAIS'), 'variável acima do teto');
    for (const texto of SUSPEITOS) await assert.rejects(() => svc.createAutomation({ tenant, actor: tenant.userId, input: send({ text: texto }) }, t), recusa(''), texto);
    for (const texto of REVISAO) {
      await assert.rejects(() => svc.createAutomation({ tenant, actor: tenant.userId, input: send({ text: texto }) }, t), recusa('REVISAO_HUMANA_NECESSARIA'), texto);
      await assert.rejects(() => svc.createAutomation({ tenant, actor: tenant.userId, input: send({ cta: { label: texto } }) }, t), recusa('REVISAO_HUMANA_NECESSARIA'), `cta: ${texto}`);
    }
    const limpa = await svc.createAutomation({ tenant, actor: tenant.userId, input: send({ cta: { label: 'Ver imóvel', quartos: 3 }, botoes: [{ rotulo: 'Agendar' }] }) }, t);
    assert.equal(limpa.version.status, 'DRAFT', 'cta, botões e listas sem URL passam');
    await set(t, 'marketing.url.revisao_sem_aprovador', 'permitir');
    const livre = await svc.createAutomation({ tenant, actor: tenant.userId, input: send({ text: 'Visite a Av.Paulista, 100.' }) }, t);
    assert.equal(livre.version.status, 'DRAFT', 'política permissiva aceita o ambíguo');
  });
});

test('parametros_novos_tem_validacao_e_valor_invalido_e_recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await assert.rejects(() => set(t, 'marketing.url.revisao_sem_aprovador', 'talvez'), (e) => e.statusCode >= 400 && e.statusCode < 500);
    await assert.rejects(() => set(t, 'marketing.url.max_chars_variavel', 5), (e) => e.statusCode >= 400 && e.statusCode < 500);
    await assert.rejects(() => set(t, 'marketing.url.max_chars_total', 'muito'), (e) => e.statusCode >= 400 && e.statusCode < 500);
  });
});

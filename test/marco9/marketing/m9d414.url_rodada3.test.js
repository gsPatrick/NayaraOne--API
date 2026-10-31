'use strict';

// M9-D414 (reabertura da rodada 3, N-1, N-2 e N-6) — o envio direto passa pelo extrator único da M9-D433 as formas que a rodada 3 reproduziu como SENT
// (terminação com maiúscula, caractere colado antes do domínio, terminação fora da lista) e varre variáveis que não são texto (array e objeto aninhados).
// Postgres real (RLS), transação com rollback. Só em banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const env = require('../_helpers/mktRunner');
const { useTempSecretStore } = require('../_helpers/mktSecretStore');

let tenant;
let cleanup;
before(async () => { ({ tenantA: tenant } = await env.prepararTenants()); cleanup = useTempSecretStore(); });
after(async () => { cleanup(); await sequelize.close(); });
const recusa = (e) => e.statusCode === 422 && e.code === 'MKT_URL_NOT_ALLOWED';

const base = (person, over) => ({ channel: 'EMAIL', personId: person, purpose: 'MARKETING', actionKey: env.key(), subject: 'Novidades', text: 'Olá, temos novidades.', unsubscribeUrl: 'https://www.exemplo.test/d?t=1', ...over });

// Formas reproduzidas pela rodada 3 que o envio direto devolvia como SENT.
const TEXTOS_HOSTIS = ['Acesse evil.Com', 'Visite evil.Net', 'Site:evil.com/x', 'Acesse:evil.com/login', 'Veja _evil.com/x_', 'Aguarde...evil.com/x', 'Aguarde…evil.com/x', 'Veja:www.evil.com', 'Veja::evil.com/x', 'a:evil.com/x', 'link/evil.com/x', 'Acesse evil.lol', 'Escreva mailto:x@evil.com', 'Ligue tel:+5511999999999', 'Veja 2130706433/x', 'Veja 127.1/x', 'Veja @evil.com/x'];

test('envio_direto_recusa_as_formas_da_rodada_3_no_texto_assunto_e_preheader', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const person = await env.readyPerson(t, tenant);
    for (const hostil of TEXTOS_HOSTIS) {
      for (const campo of ['text', 'subject', 'preheader']) {
        const input = base(person, { [campo]: hostil });
        await assert.rejects(() => env.send(t, tenant, input), recusa, `${campo}: ${hostil}`);
        assert.equal(await env.byKey(t, tenant, input.actionKey), undefined, 'nada é gravado nem enviado');
      }
    }
  });
});

test('envio_direto_varre_variaveis_que_nao_sao_texto_array_e_objeto_aninhados', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const person = await env.readyPerson(t, tenant);
    const formas = [{ lista: ['ok', 'evil.com/x'] }, { obj: { a: { b: 'Acesse:evil.com/login' } } }, { obj: { 'evil.com/x': 'valor' } }, { lista: [[['https://evil.com/p']]] }, { m: [{ u: 'www.evil.com' }] }];
    for (const variables of formas) {
      const input = base(person, { variables });
      await assert.rejects(() => env.send(t, tenant, input), recusa, JSON.stringify(variables));
      assert.equal(await env.byKey(t, tenant, input.actionKey), undefined);
    }
    const limpo = await env.send(t, tenant, base(person, { variables: { itens: ['casa', 'apartamento'], dados: { quartos: 3, vista: true } } }));
    assert.equal(limpo.status, 'SENT', 'variável não textual sem URL passa');
  });
});

'use strict';

// M9-D436 adv_01 (Caderno §16: "Opt-out recebe automação -> bloqueado"). Pessoa com OPT_OUT no WhatsApp; um lead novo dispara a automação LEAD-NOVO para ela. O efeito proibido (mensagem)
// não ocorre e o motivo fica registrado. Cenário da dona (M9-D418/M9-D414/M9-D420), sem lógica própria. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const env = require('../../_helpers/mktLeads');
const adv = require('../../_helpers/mktAdv');

let A;
let offVault;
before(async () => { ({ tenantA: A } = await env.prepararTenants()); offVault = env.useTempSecretStore(); });
after(async () => { offVault(); await sequelize.close(); });

test('adv_01_opt_out_recebe_automacao_bloqueado', async () => {
  await env.withRollbackTenantTransaction(A, async (t) => {
    await env.install(t, A, 'LEAD-NOVO');
    const lead = await env.lead(t, A, { source: 'WHATSAPP', phone: true, email: false });
    await env.optOut(t, A, lead.personId, 'WHATSAPP');
    const before = adv.sandboxCount(A, 'WHATSAPP');

    const out = await env.run(t, A, env.leadEvent(A, lead));
    const row = await env.runRow(t, out.runs[0].runId);

    // (1) o efeito proibido não ocorreu: nenhuma mensagem no adapter nem no CRM
    assert.equal(adv.sandboxCount(A, 'WHATSAPP'), before, 'zero mensagem no adapter sandbox');
    assert.equal((await env.outbound(t, lead.personId)).length, 0, 'nenhuma mensagem gravada para a pessoa');
    // (2) o motivo foi registrado: run BLOCKED por supressão, com o OPT_OUT na ação de envio
    assert.equal(row.status, 'BLOCKED');
    assert.equal(row.blocked_reason, 'SUPPRESSED');
    const send = env.sendEntry(row);
    assert.equal(send.status, 'SKIPPED');
    assert.equal(send.error_code, 'SUPPRESSED', 'a razão do bloqueio fica na ação de envio');
    const [supp] = await env.suppressions(t, lead.personId);
    assert.ok(supp && supp.reason === 'OPT_OUT' && supp.channel === 'WHATSAPP', 'e a causa é o OPT_OUT registrado no canal');
    // a ação interna não depende do canal: a tarefa para o corretor existe
    const task = await adv.taskOf(t, A, lead.personId);
    assert.ok(task, 'tarefa interna criada');
    assert.equal(env.entry(row, 'CREATE_TASK').status, 'OK');
    // isolamento (RLS): a outra empresa não enxerga o que este cenário gravou
    await adv.assertIsolated(t, A, [{ tabela: 'marketing.automation_runs', ids: [row.id] }, { tabela: 'core.tasks', ids: [task.id] }]);
  });
});

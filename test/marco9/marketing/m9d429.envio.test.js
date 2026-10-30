'use strict';

// M9-D429 — envio de WhatsApp e e-mail do Marketing pelo ChannelAdapter da M9-D430: canSend na hora do envio (supressão e opt-out, consentimento, quiet hours,
// política de canal), template oficial, preview sensível, descadastro do e-mail, replay por action_key e a mensagem no CRM com finalidade e status do canal.
// Postgres real (RLS FORCE), transação com rollback, sandbox determinístico. Só em banco descartável.

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { suppress } = require('../../../src/features/marketing/suppression/suppression.service');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const env = require('../_helpers/mktMsgEnv');
const { useTempSecretStore } = require('../_helpers/mktSecretStore');

const { readyPerson, makeTemplate, openWindow, byKey, key, send, adapters } = env;
let A;
let offVault;
before(async () => { ({ a: A } = await env.tenants()); offVault = useTempSecretStore(); });
beforeEach(() => adapters.resetSandbox());
after(async () => { offVault(); await sequelize.close(); });

const wa = (personId, over = {}) => ({ channel: 'WHATSAPP', personId, purpose: 'MARKETING', actionKey: key(), text: 'Olá! Temos novidades no seu Radar.', ...over });
const mail = (personId, over = {}) => ({ channel: 'EMAIL', personId, purpose: 'MARKETING', actionKey: key(), subject: 'Novidades do mês', text: 'Veja os imóveis novos.', unsubscribeUrl: 'https://www.exemplo.test/descadastro?t=abc', ...over });

test('opt_out_e_suppression_antes_de_enviar', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const suppressed = await readyPerson(t, A);
    const optedOut = await readyPerson(t, A);
    const noConsent = await readyPerson(t, A, { optIn: [] });
    await suppress({ personId: suppressed, channel: 'EMAIL', reason: 'OPT_OUT', source: 'QA-M9' }, A, t);
    await env.addConsent(t, A, optedOut, 'EMAIL', 'MARKETING', 'OPT_OUT', new Date());
    for (const [personId, reason, code] of [[suppressed, 'SUPPRESSED', 'MKT_SUPPRESSED'], [optedOut, 'OPT_OUT', 'MKT_SUPPRESSED'], [noConsent, 'NO_CONSENT', 'MKT_NO_CONSENT']]) {
      const input = mail(personId);
      const out = await send(t, A, input);
      assert.deepEqual([out.status, out.reason, out.code, out.sent], ['BLOCKED', reason, code, false]);
      assert.equal(await byKey(t, A, input.actionKey), undefined, 'bloqueado: nenhuma mensagem sai nem é gravada como enviada');
    }
    assert.equal(adapters.sandboxRecordCount(A.companyId, 'EMAIL'), 0, 'o canal nem foi chamado');
    const audits = await env.q(t, "SELECT action, after_json FROM audit.audit_log WHERE company_id = :c AND action = 'marketing.message.blocked' ORDER BY created_at", { c: A.companyId });
    assert.equal(audits.length, 3, 'a razão do bloqueio é gravada');
    assert.deepEqual(audits.map((a) => a.after_json.reason), ['SUPPRESSED', 'OPT_OUT', 'NO_CONSENT']);
    // a supressão é avaliada NA HORA do envio: quem pediu para sair depois de a mensagem ser montada também é barrado
    const late = await readyPerson(t, A);
    assert.equal((await send(t, A, mail(late))).status, 'SENT');
    await suppress({ personId: late, channel: 'EMAIL', reason: 'OPT_OUT', source: 'QA-M9' }, A, t);
    assert.equal((await send(t, A, mail(late))).status, 'BLOCKED');
  });
});

test('fora_da_janela_exige_template_oficial', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    // fora da janela de 24 h, texto livre: bloqueado pela política do canal (estado interno MKT_CHANNEL_POLICY)
    const livre = wa(p);
    const blocked = await send(t, A, livre);
    assert.deepEqual([blocked.status, blocked.reason, blocked.code], ['BLOCKED', 'CHANNEL_POLICY', 'MKT_CHANNEL_POLICY']);
    assert.equal(await byKey(t, A, livre.actionKey), undefined);
    // template oficial aprovado: sai, com as variáveis preenchidas e a referência oficial no payload
    const templateId = await makeTemplate(t, A);
    const ok = await send(t, A, wa(p, { text: undefined, templateId, variables: { primeiroNome: 'Marta' } }));
    assert.equal(ok.status, 'SENT');
    // template reprovado, inexistente, de outro canal ou sem referência oficial: 422 MKT_TEMPLATE_NOT_APPROVED
    const draft = await makeTemplate(t, A, { status: 'DRAFT' });
    const semRef = await makeTemplate(t, A, { official: null });
    const deEmail = await makeTemplate(t, A, { channel: 'EMAIL' });
    for (const id of [draft, semRef, deEmail, '00000000-0000-4000-8000-000000000429']) {
      await assert.rejects(() => send(t, A, wa(p, { text: undefined, templateId: id, variables: { primeiroNome: 'Marta' } })),
        (e) => e.statusCode === 422 && e.code === 'MKT_TEMPLATE_NOT_APPROVED' && e.message === 'Este canal exige template oficial aprovado.', `template ${id}`);
    }
    // variável fora da lista do template ou com dado sensível: recusada
    await assert.rejects(() => send(t, A, wa(p, { text: undefined, templateId, variables: { primeiroNome: 'Marta', cpf: '123' } })), (e) => e.code === 'MKT_TEMPLATE_UNKNOWN_VARIABLE');
    await assert.rejects(() => send(t, A, wa(p, { text: undefined, templateId, variables: { primeiroNome: 'CPF 123.456.789-09' } })), (e) => e.code === 'MKT_PREVIEW_SENSITIVE');
    // dentro da janela de 24 h o texto livre transacional sai
    const q2 = await readyPerson(t, A);
    await openWindow(t, A, q2, 2);
    assert.equal((await send(t, A, wa(q2))).status, 'SENT');
    const velha = await readyPerson(t, A);
    await openWindow(t, A, velha, 30);
    assert.equal((await send(t, A, wa(velha))).reason, 'CHANNEL_POLICY', '30 h atrás já está fora da janela');
    // a janela é parâmetro (M9-D418): com 48 h, a conversa de 30 h atrás volta a valer
    await upsertSetting('marketing.whatsapp.janela_atendimento_h', 48, A, A.userId, t);
    assert.equal((await send(t, A, wa(velha))).status, 'SENT');
  });
});

test('quiet_hours_reagenda_sem_perder', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    const input = mail(p);
    const night = new Date('2026-11-10T01:30:00Z'); // 22:30 em São Paulo
    const out = await send(t, A, input, { now: night });
    assert.deepEqual([out.status, out.reason, out.code], ['DEFERRED', 'QUIET_HOURS', 'MKT_QUIET_HOURS']);
    assert.equal(new Date(out.nextEligibleAt).toISOString(), '2026-11-10T11:00:00.000Z', 'volta às 08:00 de São Paulo');
    assert.equal(await byKey(t, A, input.actionKey), undefined, 'nada saiu e nada foi perdido: a mesma chave envia depois');
    const later = await send(t, A, input, { now: new Date(out.nextEligibleAt) });
    assert.equal(later.status, 'SENT');
    // o horário de silêncio é o parâmetro marketing.quiet_hours: o canal o lê, não tem horário próprio
    await upsertSetting('marketing.quiet_hours', '23:00 a 06:00 America/Sao_Paulo', A, A.userId, t);
    assert.equal((await send(t, A, mail(await readyPerson(t, A)), { now: night })).status, 'SENT', '22:30 já está fora do silêncio de 23h às 6h');
  });
});

test('email_exige_list_unsubscribe', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    // marketing sem link de descadastro: 422 MKT_UNSUBSCRIBE_REQUIRED (e nada sai)
    const semLink = mail(p, { unsubscribeUrl: undefined });
    await assert.rejects(() => send(t, A, semLink), (e) => e.statusCode === 422 && e.code === 'MKT_UNSUBSCRIBE_REQUIRED' && e.message === 'E-mail de marketing exige link de descadastro.');
    assert.equal(adapters.sandboxRecordCount(A.companyId, 'EMAIL'), 0);
    // com o link: o e-mail leva o rodapé e o cabeçalho List-Unsubscribe (One-Click) no payload entregue ao canal
    const seen = [];
    const original = adapters.SandboxChannelAdapter.prototype.send;
    adapters.SandboxChannelAdapter.prototype.send = function spy(message, options) { seen.push(message); return original.call(this, message, options); };
    try {
      assert.equal((await send(t, A, mail(p))).status, 'SENT');
    } finally { adapters.SandboxChannelAdapter.prototype.send = original; }
    assert.equal(seen[0].headers['List-Unsubscribe'], '<https://www.exemplo.test/descadastro?t=abc>');
    assert.equal(seen[0].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.match(seen[0].text, /Para não receber mais mensagens, acesse: https:\/\/www\.exemplo\.test\/descadastro\?t=abc$/);
    // sem o link informado, vale o endereço do parâmetro com o token assinado do destinatário
    await upsertSetting('marketing.email.url_descadastro', 'https://www.exemplo.test/descadastro?t={token}', A, A.userId, t);
    const viaParam = await send(t, A, mail(await readyPerson(t, A), { unsubscribeUrl: undefined }));
    assert.equal(viaParam.status, 'SENT');
    // finalidade que não exige OPT_IN (transacional) não exige o link
    const tr = await send(t, A, mail(await readyPerson(t, A), { purpose: 'TRANSACTIONAL', unsubscribeUrl: undefined }));
    assert.equal(tr.status, 'SENT');
  });
});

test('adapter_grava_purpose_e_cap_conta_a_mensagem', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    const input = mail(p);
    const inWindow = (key) => env.q(t, "UPDATE crm.messages SET created_at = :at WHERE company_id = :c AND action_key = :k RETURNING id", { at: new Date(env.NOON_SP.getTime() - 3600 * 1000), c: A.companyId, k: key }); // o cap conta pelo relógio da mensagem
    const out = await send(t, A, input);
    await inWindow(input.actionKey);
    const row = await byKey(t, A, input.actionKey);
    assert.deepEqual([out.status, row.purpose, row.status, row.delivery_status], ['SENT', 'MARKETING', 'SENT', 'SENT']);
    assert.match(row.external_message_id, /^sbx-email-[0-9a-f]{16}$/);
    assert.equal(out.sandbox, true, 'o simulado nunca é confundido com envio real');
    // o frequency cap (M9-D416) conta a mensagem: 3 por 7 dias por pessoa/canal/finalidade; a 4ª é barrada pelo canSend
    for (let i = 0; i < 2; i += 1) { const next = mail(p); await send(t, A, next); await inWindow(next.actionKey); }
    const fourth = await send(t, A, mail(p));
    assert.deepEqual([fourth.status, fourth.reason], ['BLOCKED', 'FREQUENCY_CAP']);
  });
});

test('replay_por_action_key_nao_envia_duas_vezes_e_resultado_incerto_reconcilia_antes_de_repetir', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    const input = mail(p);
    const first = await send(t, A, input);
    const again = await send(t, A, input);
    assert.deepEqual([first.status, again.status, again.replayed, again.messageId], ['SENT', 'SENT', true, first.messageId]);
    assert.equal(adapters.sandboxRecordCount(A.companyId, 'EMAIL'), 1);
    assert.equal((await env.q(t, 'SELECT count(*)::int AS n FROM crm.messages WHERE company_id = :c AND action_key = :k', { c: A.companyId, k: input.actionKey }))[0].n, 1);
    // timeout que chegou ao canal: UNKNOWN; a repetição consulta o canal pela chave antes de enviar e promove a SENT sem duplicar
    const q = await readyPerson(t, A);
    const unk = mail(q);
    const lost = await send(t, A, unk, { scenario: 'UNKNOWN_BUT_PUBLISHED' });
    assert.equal(lost.status, 'UNKNOWN');
    assert.equal((await byKey(t, A, unk.actionKey)).status, 'UNKNOWN');
    const reconciled = await send(t, A, unk);
    assert.deepEqual([reconciled.status, reconciled.reconciled], ['SENT', true]);
    assert.equal(adapters.sandboxRecordCount(A.companyId, 'EMAIL'), 2, 'não duplicou');
    // timeout que NÃO chegou ao canal: a repetição envia de verdade
    const r = await readyPerson(t, A);
    const never = mail(r);
    assert.equal((await send(t, A, never, { scenario: 'UNKNOWN_NOT_PUBLISHED' })).status, 'UNKNOWN');
    assert.equal((await send(t, A, never)).status, 'SENT');
  });
});

test('falha_do_canal_segue_decide_on_result_fila_no_whatsapp_e_nova_tentativa_por_classe_no_email', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    await openWindow(t, A, p, 1);
    // WhatsApp com o canal fora (5xx): mensagem QUEUED (fila), nunca entregue; a repetição com a mesma chave envia
    const w = wa(p);
    const down = await send(t, A, w, { scenario: 'HTTP_5XX' });
    assert.deepEqual([down.status, down.contingency.action, down.contingency.delivered], ['QUEUED', 'QUEUE', false]);
    assert.equal((await send(t, A, w)).status, 'SENT');
    // e-mail com 429: nova tentativa por classe (fica QUEUED); com REJECTED (validação) não repete: FAILED
    const q = await readyPerson(t, A);
    const e1 = mail(q);
    const limited = await send(t, A, e1, { scenario: 'HTTP_429' });
    assert.deepEqual([limited.status, limited.contingency.action, limited.contingency.retry], ['QUEUED', 'RETRY_BY_CLASS', 'BY_ERROR_CLASS']);
    assert.equal((await send(t, A, e1)).status, 'SENT');
    const e2 = mail(await readyPerson(t, A));
    const rejected = await send(t, A, e2, { scenario: 'REJECTED' });
    assert.equal(rejected.status, 'FAILED');
    assert.match((await byKey(t, A, e2.actionKey)).failure_reason, /O canal não aceitou a mensagem/);
    assert.equal((await send(t, A, e2)).status, 'FAILED', 'recusa definitiva não é reenviada');
    // mensagem na fila do WhatsApp que passou do prazo do modo (parâmetro do bloco B) é cancelada, não enviada
    const old = wa(await (async () => { const x = await readyPerson(t, A); await openWindow(t, A, x, 1); return x; })());
    await send(t, A, old, { scenario: 'HTTP_5XX' });
    await env.q(t, "UPDATE crm.messages SET created_at = created_at - interval '400 hours' WHERE company_id = :c AND action_key = :k RETURNING id", { c: A.companyId, k: old.actionKey });
    const expired = await send(t, A, old, { now: new Date() });
    assert.deepEqual([expired.status, expired.cancelled], ['CANCELLED', true]);
  });
});

test('mensagem_sensivel_so_vai_com_o_texto_seguro_e_o_preview_do_whatsapp_e_do_email_e_verificado', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    await openWindow(t, A, p, 1);
    const sensivel = wa(p, { text: 'Olá Marta, sua parcela de R$ 1.250,00 vence amanhã.' });
    await assert.rejects(() => send(t, A, sensivel), (e) => e.statusCode === 422 && e.code === 'MKT_PREVIEW_SENSITIVE' && e.message === 'A mensagem revelaria informação sensível na pré-visualização.' && e.details.patterns[0] === 'DIVIDA');
    assert.equal(await byKey(t, A, sensivel.actionKey), undefined);
    // com a marca de sensível, só o aviso padrão com o link seguro sai e o texto original nunca chega ao canal nem ao CRM
    const ok = await send(t, A, { ...sensivel, sensitive: true, portalUrl: 'https://portal.exemplo.test/seguro' });
    assert.equal(ok.status, 'SENT');
    assert.equal((await byKey(t, A, sensivel.actionKey)).body, 'Você tem uma atualização. Acesse o portal. https://portal.exemplo.test/seguro');
    // trecho redigível (CPF) é trocado por [REDIGIDO]
    const cpf = wa(p, { text: 'Seu CPF 123.456.789-09 foi atualizado.' });
    const sent = await send(t, A, cpf);
    assert.equal(sent.previewRedacted, true);
    assert.equal((await byKey(t, A, cpf.actionKey)).body, 'Seu CPF [REDIGIDO] foi atualizado.');
    // e-mail: assunto e pré-cabeçalho inteiros são preview
    const q = await readyPerson(t, A);
    await assert.rejects(() => send(t, A, mail(q, { subject: 'Seu saldo de R$ 500,00' })), (e) => e.code === 'MKT_PREVIEW_SENSITIVE' && e.details.field === 'subject');
    await assert.rejects(() => send(t, A, mail(q, { preheader: 'Há uma dívida de 800 reais' })), (e) => e.code === 'MKT_PREVIEW_SENSITIVE' && e.details.field === 'preheader');
    // o corpo do e-mail não é preview
    assert.equal((await send(t, A, mail(q, { text: 'Sua parcela de R$ 1.250,00 vence amanhã.' }))).status, 'SENT');
  });
});

test('isolamento_entre_empresas_a_pessoa_de_outra_empresa_nao_recebe_nem_aparece', async () => {
  const { b: B } = await env.tenants();
  await withRollbackTenantTransaction(A, async (t) => {
    const pessoaB = await env.asTenant(t, A, B, () => readyPerson(t, B));
    const out = await send(t, A, mail(pessoaB));
    assert.equal(out.status, 'BLOCKED', 'a pessoa de B não é visível para A (RLS): sem endereço utilizável');
    assert.equal(adapters.sandboxRecordCount(A.companyId, 'EMAIL'), 0);
  });
});

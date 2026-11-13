'use strict';

// M3-18 ("Consentimento, finalidade e acesso a dados pessoais"): livro do Marco 3 §2 CRMX-008 ("Comunicação respeita opt-in/opt-out e
// finalidade"), Guia §11 canContact(person, channel, purpose) e §12 ("Contato externo só usa canal permitido/consentido"). Login real no
// seed de dois tenants (empresa A); banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/m3cbCarteiraEnv');

let env;
const OPT_IN_KEY = 'marketing.consent.exige_opt_in_para';
const as = (who) => env.tokens[`A:${who}`];
const mensagensDe = async (personId) => (await H.admin("SELECT purpose FROM crm.messages WHERE person_id = $1 AND direction = 'OUTBOUND'", [personId])).rows;

/** CPF válido novo a cada execução (dígitos verificadores calculados). */
function cpf() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const dv = (digits) => { const s = digits.reduce((acc, d, i) => acc + d * (digits.length + 1 - i), 0) % 11; return s < 2 ? 0 : 11 - s; };
  const d1 = dv(base);
  return [...base, d1, dv([...base, d1])].join('');
}
const saida = (personId, extra = {}) => ({ personId, direction: 'OUTBOUND', authorType: 'EMPLOYEE', channel: 'WHATSAPP', body: 'Olá! Temos novidades.', ...extra });

// M3-18 vale com o parâmetro crm.mensagens.finalidade_obrigatoria LIGADO; o padrão (desligado) é o comportamento do Marco 9 entregue
// (integração dos Marcos 3 a 6 com o Marco 9, 13/11/2026). Os testes abaixo ligam o parâmetro na empresa A; o último confere o padrão.
const PURPOSE_KEY = 'crm.mensagens.finalidade_obrigatoria';
const EMPRESA_A = 'CI — Empresa Fictícia A';
const ligarFinalidade = () => H.admin(`INSERT INTO core.tenant_settings (id, group_id, company_id, key, value)
  SELECT gen_random_uuid(), c.group_id, c.id, $1, 'true'::jsonb FROM core.companies c WHERE c.name = $2
  ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value`, [PURPOSE_KEY, EMPRESA_A]);
const desligarFinalidade = () => H.admin('DELETE FROM core.tenant_settings WHERE key = $1 AND company_id = (SELECT id FROM core.companies WHERE name = $2)', [PURPOSE_KEY, EMPRESA_A]);

before(async () => {
  if (!H.DISPOSABLE) return;
  env = await H.subir(Number(process.env.M3CB_DADOS_HTTP_PORT) || 34233, { gestor: ['people:update', 'marketing:suppression:manage'], maker: ['people:read'] });
  await ligarFinalidade();
});
after(async () => {
  if (!H.DISPOSABLE || !env) return;
  await H.admin('DELETE FROM core.tenant_settings WHERE key = $1 AND company_id = (SELECT id FROM core.companies WHERE name = $2)', [OPT_IN_KEY, 'CI — Empresa Fictícia A']);
  await desligarFinalidade();
  await H.encerrar();
});

test('M3-18 mensagem saída sem finalidade é recusada (422 MESSAGE_PURPOSE_REQUIRED): nunca vira TRANSACTIONAL por omissão', { skip: H.SKIP }, async () => {
  const { personId } = await H.oportunidadeDe(env, env.ids.maker, 'Finalidade');
  const r = await env.call('POST', '/messages', as('gestor'), saida(personId));
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'MESSAGE_PURPOSE_REQUIRED');
  const enviar = await env.call('POST', '/messages/send', as('gestor'), { kind: 'text', personId, to: '+5511999990000', text: 'Oi' });
  assert.equal(enviar.status, 422, `o envio pelo fornecedor também exige a finalidade: ${JSON.stringify(enviar.body)}`);
  assert.equal(enviar.body.error.code, 'MESSAGE_PURPOSE_REQUIRED');
  assert.equal((await mensagensDe(personId)).length, 0, 'nada gravado');
  const recebida = await env.call('POST', '/messages', as('gestor'), { personId, direction: 'INBOUND', authorType: 'CLIENT', channel: 'WHATSAPP', body: 'Quero saber do imóvel' });
  assert.equal(recebida.status, 201, 'mensagem RECEBIDA do cliente não depende de finalidade');
});

test('M3-18 opt-out só de marketing não se contorna omitindo a finalidade; finalidade fora da lista única é recusada', { skip: H.SKIP }, async () => {
  const { personId } = await H.oportunidadeDe(env, env.ids.maker, 'Opt-out marketing');
  const optOut = await env.call('POST', `/people/${personId}/consents`, as('gestor'), { channel: 'WHATSAPP', purpose: 'MARKETING', status: 'OPT_OUT' });
  assert.ok([200, 201].includes(optOut.status), JSON.stringify(optOut.body));
  const mk = await env.call('POST', '/messages', as('gestor'), saida(personId, { purpose: 'MARKETING' }));
  assert.equal(mk.status, 422);
  assert.equal(mk.body.error.code, 'MESSAGE_BLOCKED_BY_CONSENT');
  const semFinalidade = await env.call('POST', '/messages', as('gestor'), saida(personId));
  assert.equal(semFinalidade.body.error.code, 'MESSAGE_PURPOSE_REQUIRED', 'antes virava TRANSACTIONAL e passava');
  const inventada = await env.call('POST', '/messages', as('gestor'), saida(personId, { purpose: 'PROMOCAO_RELAMPAGO' }));
  assert.equal(inventada.status, 422);
  assert.equal(inventada.body.error.code, 'MESSAGE_PURPOSE_UNKNOWN');
  const transacional = await env.call('POST', '/messages', as('gestor'), saida(personId, { purpose: 'transactional', body: 'Sua visita está confirmada.' }));
  assert.equal(transacional.status, 201, 'o opt-out de marketing não impede o aviso transacional');
  assert.deepEqual((await mensagensDe(personId)).map((m) => m.purpose), ['TRANSACTIONAL'], 'só a transacional foi gravada, com a finalidade normalizada');
});

test('M3-18 quais finalidades exigem OPT_IN vem do parâmetro da empresa (lista única), não de uma lista fixa no código', { skip: H.SKIP }, async () => {
  const { personId } = await H.oportunidadeDe(env, env.ids.maker, 'Lista única');
  const antes = await env.call('POST', '/messages', as('gestor'), saida(personId, { purpose: 'ACOMPANHAMENTO', body: 'Acompanhamento 1' }));
  assert.equal(antes.status, 201, `ACOMPANHAMENTO não exige OPT_IN no padrão: ${JSON.stringify(antes.body)}`);
  const put = await env.call('PUT', `/settings/${OPT_IN_KEY}`, as('gestor'), { value: 'MARKETING, NUTRICAO, RADAR, AVALIACAO, POS_VENDA, ACOMPANHAMENTO' });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const depois = await env.call('POST', '/messages', as('gestor'), saida(personId, { purpose: 'ACOMPANHAMENTO', body: 'Acompanhamento 2' }));
  assert.equal(depois.status, 422, 'com a finalidade na lista de OPT_IN e sem OPT_IN da pessoa, bloqueia');
  assert.equal(depois.body.error.code, 'MESSAGE_BLOCKED_BY_CONSENT');
  const optIn = await env.call('POST', `/people/${personId}/consents`, as('gestor'), { channel: 'WHATSAPP', purpose: 'ACOMPANHAMENTO', status: 'OPT_IN' });
  assert.ok([200, 201].includes(optIn.status), JSON.stringify(optIn.body));
  assert.equal((await env.call('POST', '/messages', as('gestor'), saida(personId, { purpose: 'ACOMPANHAMENTO', body: 'Acompanhamento 3' }))).status, 201, 'com o OPT_IN registrado, envia');
});

test('M3-18 acesso a dados pessoais pelo CRM: as rotas do CRM não devolvem CPF nem contato; na ficha, o corretor vê o CPF mascarado e o acesso é auditado', { skip: H.SKIP }, async () => {
  const doc = cpf();
  const telefone = `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const p = await env.call('POST', '/people', as('gestor'), { personType: 'PF', legalName: H.unique('Cliente com CPF'), taxIdNormalized: doc, contacts: [{ contactType: 'PHONE', value: telefone, isPrimary: true }] });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const personId = p.body.data.id;
  const o = await env.call('POST', '/opportunities', as('gestor'), { personId, stage: 'NEW', ownerUserId: env.ids.maker, nextAction: 'Ligar', nextActionDueAt: H.FUTURE() });
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const opportunityId = o.body.data.id;
  await env.call('POST', '/messages', as('gestor'), { personId, opportunityId, direction: 'INBOUND', authorType: 'CLIENT', channel: 'WHATSAPP', body: 'Oi' });
  const digitos = telefone.replace(/\D/g, '');
  for (const rota of ['/opportunities', `/opportunities/${opportunityId}`, `/opportunities/${opportunityId}/timeline`, `/messages?opportunityId=${opportunityId}`, `/visits?opportunityId=${opportunityId}`, `/crm/proposals?opportunityId=${opportunityId}`, '/crm/dashboard', '/radar']) {
    const r = await env.call('GET', rota, as('maker'));
    assert.equal(r.status, 200, `${rota}: ${JSON.stringify(r.body)}`);
    const texto = JSON.stringify(r.body);
    assert.ok(!texto.includes(doc), `${rota} não devolve o CPF`);
    assert.ok(!texto.includes(digitos.slice(-8)), `${rota} não devolve o telefone`);
  }
  const ficha = await env.call('GET', `/people/${personId}`, as('maker'));
  assert.equal(ficha.status, 200, JSON.stringify(ficha.body));
  assert.ok(!JSON.stringify(ficha.body).includes(doc), 'na ficha, o CPF sai mascarado para quem não tem a permissão de ver dado restrito');
  const vistos = (await H.admin("SELECT action FROM audit.audit_log WHERE user_id = $1 AND action LIKE 'governance.dlp.view%' AND entity_type = 'people.person' AND occurred_at > now() - interval '5 minutes'", [env.ids.maker])).rows;
  assert.ok(vistos.length >= 1, 'o acesso ao dado pessoal fica auditado');
});

test('M3-18 com o parâmetro no padrão (desligado) vale o Marco 9: saída sem finalidade segue e o consentimento é o TRANSACTIONAL', { skip: H.SKIP }, async () => {
  await desligarFinalidade();
  try {
    const { personId } = await H.oportunidadeDe(env, env.ids.maker, 'Padrao Marco 9');
    const r = await env.call('POST', '/messages', as('gestor'), saida(personId, { body: 'Aviso sem finalidade' }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual((await mensagensDe(personId)).map((m) => m.purpose), [null], 'gravada sem finalidade, como no Marco 9');
    const optOut = await env.call('POST', `/people/${personId}/consents`, as('gestor'), { channel: 'WHATSAPP', purpose: 'TRANSACTIONAL', status: 'OPT_OUT' });
    assert.ok([200, 201].includes(optOut.status), JSON.stringify(optOut.body));
    const bloqueada = await env.call('POST', '/messages', as('gestor'), saida(personId, { body: 'Depois do opt-out' }));
    assert.equal(bloqueada.status, 422, 'sem finalidade o consentimento conferido é o TRANSACTIONAL: o opt-out dele bloqueia');
    assert.equal(bloqueada.body.error.code, 'MESSAGE_BLOCKED_BY_CONSENT');
  } finally {
    await ligarFinalidade();
  }
});

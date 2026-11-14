'use strict';

// Pessoas do fechamento do Marco 3 pela API real (login, JWT, permissões, RLS): M3-01 (CPF com dígito errado), M3-02 (VENDEDOR e catálogo),
// M3-03 / CAD-04 / CRMX-010 (consulta antes de criar, revisão do parecido, exceção auditada do contato igual) e M3-04 (merge remapeia e a
// recusa fica na auditoria mesmo com o rollback). Grava de verdade: só em banco descartável.
process.env.PORT = process.env.PEOPLE_CADASTRO_HTTP_TEST_PORT || '21842';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomCpf } = require('./helpers/pessoasVinculo');
const { iniciar, permissao, stopHttp, adminQuery } = require('./helpers/pessoasHttpEvidencia');

const SUF = `${Date.now()}`;
const PERFIL_EXCECAO = 'CI CHECKER';
let http; let gravar;

before(async () => {
  // O checker ganha cadastro de pessoas e a permissão da exceção ANTES do login (as permissões vão no token); o gestor fica sem ela.
  for (const code of ['people:read', 'people:create', 'people:dedup:override']) await permissao(PERFIL_EXCECAO, code, true).catch(() => {});
  ({ http, gravar } = await iniciar({ port: process.env.PORT, arquivo: 'people.cadastroDedupMerge.http', logins: { gestorA: ['A', 'gestor'], checkerA: ['A', 'checker'] } }));
});

after(async () => {
  if (gravar) gravar({ linhas: ['M3-01', 'M3-02', 'CRMX-002', 'M3-03', 'CAD-04', 'CRMX-010', 'M3-04'] });
  for (const code of ['people:read', 'people:create', 'people:dedup:override']) await permissao(PERFIL_EXCECAO, code, false).catch(() => {});
  await stopHttp({});
});

const pular = (t) => (http.skip ? t.skip(http.skip) : false);

test('M3-01 POST /people com CPF 529.982.247-26: 422 PERSON_TAX_ID_INVALID com o campo, e nada é gravado; CPF válido: 201', async (t) => {
  if (pular(t)) return;
  const r = await http.call('gestorA', 'POST', '/people', { personType: 'PF', legalName: `Sonda CPF ${SUF}`, taxIdNormalized: '529.982.247-26' });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'PERSON_TAX_ID_INVALID');
  assert.deepEqual(r.body.error.details.fields.map((f) => f.field), ['taxIdNormalized']);
  const { rows } = await adminQuery("SELECT count(*)::int AS n FROM people.persons WHERE tax_id_normalized = '52998224726'");
  assert.equal(rows[0].n, 0);
  const pj = await http.call('gestorA', 'POST', '/people', { personType: 'PJ', legalName: `Sonda CNPJ ${SUF}`, taxIdNormalized: '11.222.333/0001-80' });
  assert.equal(pj.status, 422);
  const ok = await http.call('gestorA', 'POST', '/people', { personType: 'PF', legalName: `CPF válido ${SUF}`, taxIdNormalized: randomCpf() });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('M3-02 catálogo de papéis com VENDEDOR; o papel é gravado e relido junto dos outros; fora do catálogo: 400', async (t) => {
  if (pular(t)) return;
  const cat = await http.call('gestorA', 'GET', '/people/roles-catalog');
  assert.equal(cat.status, 200);
  assert.ok(cat.body.data.some((r) => r.code === 'VENDEDOR' && r.label === 'Vendedor'));
  const p = await http.call('gestorA', 'POST', '/people', { personType: 'PF', legalName: `Papéis ${SUF}`, roles: ['CLIENTE', 'VENDEDOR'] });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const add = await http.call('gestorA', 'POST', `/people/${p.body.data.id}/roles`, { roleCode: 'LOCATARIO' });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const lista = await http.call('gestorA', 'GET', `/people/${p.body.data.id}/roles`);
  assert.deepEqual(lista.body.data.map((r) => r.roleCode).sort(), ['CLIENTE', 'LOCATARIO', 'VENDEDOR']);
  const fora = await http.call('gestorA', 'POST', `/people/${p.body.data.id}/roles`, { roleCode: 'INVESTIDOR' });
  assert.equal(fora.status, 400);
  assert.equal(fora.body.error.code, 'PERSON_ROLE_VALIDATION');
});

test('CRMX-010 consulta antes de criar mostra o parecido e o contato igual; o POST do parecido exige a revisão confirmada', async (t) => {
  if (pular(t)) return;
  const base = await http.call('gestorA', 'POST', '/people', { personType: 'PF', legalName: `Rosa${SUF} Amaral`, birthOrFoundationDate: '1975-09-09',
    contacts: [{ contactType: 'PHONE', valueNormalized: `(31) 9${SUF.slice(-8)}`, isPrimary: true }] });
  assert.equal(base.status, 201, JSON.stringify(base.body));
  const rascunho = { personType: 'PF', legalName: `ROSA${SUF} M. AMARAL`, birthOrFoundationDate: '1975-09-09' };
  const consulta = await http.call('gestorA', 'POST', '/people/duplicates/check', { ...rascunho, contacts: [{ contactType: 'WHATSAPP', valueNormalized: `+55 31 9${SUF.slice(-8)}` }] });
  assert.equal(consulta.status, 200, JSON.stringify(consulta.body));
  assert.deepEqual(consulta.body.data.medio.candidatos.map((c) => c.personId), [base.body.data.id]);
  assert.equal(consulta.body.data.medio.podeForcar, false, 'o gestor não tem a permissão da exceção');
  const consultaFraco = await http.call('gestorA', 'POST', '/people/duplicates/check', rascunho);
  assert.deepEqual(consultaFraco.body.data.fraco.candidatos.map((c) => c.personId), [base.body.data.id]);
  const semRevisao = await http.call('gestorA', 'POST', '/people', rascunho);
  assert.equal(semRevisao.status, 409, JSON.stringify(semRevisao.body));
  assert.equal(semRevisao.body.error.code, 'PERSON_SIMILAR_REVIEW_REQUIRED');
  const revisado = await http.call('gestorA', 'POST', '/people', { ...rascunho, similarReviewed: true });
  assert.equal(revisado.status, 201, JSON.stringify(revisado.body));
});

test('M3-03 contato igual: sem a permissão, 403 e a recusa auditada; com a permissão e o motivo, 201 e a exceção auditada', async (t) => {
  if (pular(t)) return;
  const email = `excecao.${SUF}@exemplo.com`;
  const base = await http.call('gestorA', 'POST', '/people', { personType: 'PF', legalName: `Base Exceção ${SUF}`, contacts: [{ contactType: 'EMAIL', valueNormalized: email }] });
  assert.equal(base.status, 201);
  const corpo = { personType: 'PF', legalName: `Outra Pessoa ${SUF}`, contacts: [{ contactType: 'EMAIL', valueNormalized: ` ${email.toUpperCase()}` }] };
  const bloqueio = await http.call('gestorA', 'POST', '/people', corpo);
  assert.equal(bloqueio.status, 409);
  assert.equal(bloqueio.body.error.details.nivel, 'MEDIO');
  const negado = await http.call('gestorA', 'POST', '/people', { ...corpo, allowDuplicate: true, duplicateReason: 'Pessoa diferente que usa o e-mail do escritório.' });
  assert.equal(negado.status, 403, JSON.stringify(negado.body));
  assert.equal(negado.body.error.code, 'PERSON_DUPLICATE_OVERRIDE_DENIED');
  const { rows: recusas } = await adminQuery("SELECT count(*)::int AS n FROM audit.audit_log a JOIN core.users u ON u.id = a.user_id WHERE a.action = 'people.person.duplicate_override_denied' AND u.email = 'ci-a-gestor@ci.nayaraone.test' AND a.after_json->'candidatos' ? $1", [base.body.data.id]);
  assert.equal(recusas[0].n, 1, 'a recusa por permissão fica na auditoria, mesmo com o rollback');
  const semMotivo = await http.call('checkerA', 'POST', '/people', { ...corpo, allowDuplicate: true });
  assert.equal(semMotivo.status, 422);
  assert.equal(semMotivo.body.error.code, 'PERSON_DUPLICATE_REASON_REQUIRED');
  const criada = await http.call('checkerA', 'POST', '/people', { ...corpo, allowDuplicate: true, duplicateReason: 'Pessoa diferente que usa o e-mail do escritório.' });
  assert.equal(criada.status, 201, JSON.stringify(criada.body));
  const { rows } = await adminQuery("SELECT reason FROM audit.audit_log WHERE action = 'people.person.duplicate_override' AND entity_id = $1", [criada.body.data.id]);
  assert.match(rows[0].reason, /e-mail do escritório/);
});

test('M3-04 merge pela API remapeia a reclamação e a proposta; merge bloqueado (CPFs diferentes) dá 422 e fica na auditoria', async (t) => {
  if (pular(t)) return;
  const canon = await http.call('gestorA', 'POST', '/people', { personType: 'PF', legalName: `Canon ${SUF}`, taxIdNormalized: randomCpf() });
  const abs = await http.call('gestorA', 'POST', '/people', { personType: 'PF', legalName: `Absorvida ${SUF}` });
  const tenant = (await adminQuery('SELECT group_id, company_id FROM people.persons WHERE id = $1', [abs.body.data.id])).rows[0];
  const { rows: [caso] } = await adminQuery(`INSERT INTO crm.feedback_cases (id, group_id, company_id, person_id, type, description, sla_due_at, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, $3, 'COMPLAINT', 'Reclamação', now() + interval '1 day', now(), now()) RETURNING id`, [tenant.group_id, tenant.company_id, abs.body.data.id]);
  const { rows: [opp] } = await adminQuery(`INSERT INTO crm.opportunities (id, group_id, company_id, person_id, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, now(), now()) RETURNING id`,
    [tenant.group_id, tenant.company_id, canon.body.data.id]);
  const { rows: [prop] } = await adminQuery(`INSERT INTO crm.proposals (id, group_id, company_id, opportunity_id, proposed_by_person_id, value, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, $3, $4, 1000, now(), now()) RETURNING id`, [tenant.group_id, tenant.company_id, opp.id, abs.body.data.id]);
  const merge = await http.call('gestorA', 'POST', `/people/${canon.body.data.id}/merge`, { absorbedId: abs.body.data.id });
  assert.equal(merge.status, 200, JSON.stringify(merge.body));
  assert.equal(merge.body.data.remappedReferences['crm.feedback_cases.person_id'], 1);
  assert.equal(merge.body.data.remappedReferences['crm.proposals.proposed_by_person_id'], 1);
  assert.equal((await adminQuery('SELECT person_id FROM crm.feedback_cases WHERE id = $1', [caso.id])).rows[0].person_id, canon.body.data.id);
  assert.equal((await adminQuery('SELECT proposed_by_person_id FROM crm.proposals WHERE id = $1', [prop.id])).rows[0].proposed_by_person_id, canon.body.data.id);

  const outra = await http.call('gestorA', 'POST', '/people', { personType: 'PF', legalName: `Outro CPF ${SUF}`, taxIdNormalized: randomCpf() });
  const bloqueado = await http.call('gestorA', 'POST', `/people/${canon.body.data.id}/merge`, { absorbedId: outra.body.data.id });
  assert.equal(bloqueado.status, 422);
  assert.equal(bloqueado.body.error.code, 'PERSON_MERGE_CONFLICT');
  const { rows } = await adminQuery("SELECT after_json FROM audit.audit_log WHERE action = 'person.merge.blocked' AND entity_id = $1", [canon.body.data.id]);
  assert.equal(rows.length, 1, 'a tentativa bloqueada fica na auditoria');
  assert.equal(rows[0].after_json.codigo, 'PERSON_MERGE_CONFLICT');
  assert.equal(rows[0].after_json.absorbedId, outra.body.data.id);
});

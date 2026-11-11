'use strict';

// M3-03 / CAD-04 / CRMX-010 (DI-M3PE-3 e DI-M3PE-4): deduplicação ANTES de criar, pelo livro §4.
// - médio: telefone/e-mail comparados normalizados (e-mail sem espaço e em minúsculas, telefone com DDI; telefone e WhatsApp juntos), em
//   qualquer contato; criar mesmo assim é exceção com motivo + permissão, auditada e com o par na fila de revisão;
// - fraco: pela tela exige a revisão confirmada antes de criar; automático cria e manda à fila;
// - grupo: CPF/CNPJ ou contato de outra empresa do grupo recusa sem id nem nome e aponta o vínculo.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { randomCpf } = require('./helpers/pessoasVinculo');
const { Company } = require('../src/models');
const peopleService = require('../src/features/people/people.service');
const dedup = require('../src/features/people/personDedup.service');
// Módulo novo carregado dentro do teste que o usa: na base (sem ele) só esse teste falha, os outros falham pela regra.
const contactKeyModule = () => require('../src/features/people/personContactKey');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const sel = (t, sql, replacements = {}) => sequelize.query(sql, { replacements, transaction: t, type: sequelize.QueryTypes.SELECT });
const ctxEmpresa = (t, companyId) => sequelize.query("SELECT set_config('app.company_id', :c, true)", { replacements: { c: companyId }, transaction: t });
const criar = (t, extra, options, companyId = tenant.companyId) => peopleService.createPerson(
  { groupId: tenant.groupId, companyId, personType: 'PF', legalName: `Pessoa Dedup ${uniqueSuffix()}`, ...extra }, tenant.userId, t, options
);
const codigo = (code) => (err) => { assert.equal(err.code, code, `${err.code}: ${err.message}`); return true; };

test('chave do contato: o cálculo em SQL é o mesmo do JS (e-mail, telefone com e sem DDI, WhatsApp)', async () => {
  const { contactKey, contactKeySql, kindSql } = contactKeyModule();
  await withRollbackTenantTransaction(tenant, async (t) => {
    const casos = [['EMAIL', '  Fulano.Silva@Exemplo.COM '], ['EMAIL', 'a b@c.d'], ['PHONE', '(11) 98888-7777'], ['WHATSAPP', '+55 11 98888-7777'], ['PHONE', '+1 (415) 555-0100'], ['PHONE', '011988887777']];
    for (const [tipo, valor] of casos) {
      const [row] = await sel(t, `SELECT ${kindSql('c')} AS kind, ${contactKeySql('c')} AS chave FROM (SELECT CAST(:tipo AS text) AS contact_type, CAST(:valor AS text) AS value_normalized) c`, { tipo, valor, ddi: '55' });
      const js = contactKey(tipo, valor, '55');
      assert.deepEqual({ kind: row.kind, key: row.chave }, js, `${tipo} ${valor}`);
    }
    assert.equal(contactKey('PHONE', '(11) 98888-7777', '55').key, contactKey('WHATSAPP', '+5511988887777', '55').key);
  });
});

test('M3-03 médio: e-mail com caixa/espaço diferente, telefone com máscara x DDI e WhatsApp x telefone, em contato NÃO principal, são a mesma pessoa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const suf = uniqueSuffix();
    const existente = await criar(t, { contacts: [
      { contactType: 'PHONE', valueNormalized: '(11) 97777-0000', isPrimary: true },
      { contactType: 'EMAIL', valueNormalized: `Maria.${suf}@Exemplo.COM ` },
      { contactType: 'WHATSAPP', valueNormalized: `+55 21 9${suf.slice(-8).padStart(8, '1')}` },
    ] });
    const variantes = [
      [{ contactType: 'EMAIL', valueNormalized: `maria.${suf}@exemplo.com` }],
      [{ contactType: 'PHONE', valueNormalized: '+55 11 977770000', isPrimary: true }],
      [{ contactType: 'PHONE', valueNormalized: `(21) 9${suf.slice(-8).padStart(8, '1')}` }],
    ];
    for (const contacts of variantes) {
      await assert.rejects(() => criar(t, { contacts }), (err) => {
        codigo('PERSON_DUPLICATE')(err);
        assert.equal(err.details.nivel, 'MEDIO');
        assert.equal(err.details.existingPersonId, existente.id);
        assert.equal(err.details.candidatos[0].personId, existente.id);
        return true;
      });
    }
  });
});

test('M3-03 médio: criar mesmo assim exige motivo e a permissão; sem permissão é 403 e a recusa vai para a auditoria pós-rollback', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const email = `override.${uniqueSuffix()}@exemplo.com`;
    const existente = await criar(t, { contacts: [{ contactType: 'EMAIL', valueNormalized: email }] });
    const corpo = { contacts: [{ contactType: 'EMAIL', valueNormalized: email.toUpperCase() }], allowDuplicate: true };
    await assert.rejects(() => criar(t, corpo, { podeForcarDuplicidade: true }), (err) => {
      codigo('PERSON_DUPLICATE_REASON_REQUIRED')(err);
      assert.equal(err.statusCode, 422);
      return true;
    });
    await assert.rejects(() => criar(t, { ...corpo, duplicateReason: 'Casal que divide o mesmo e-mail.' }, { podeForcarDuplicidade: false }), (err) => {
      codigo('PERSON_DUPLICATE_OVERRIDE_DENIED')(err);
      assert.equal(err.statusCode, 403);
      return true;
    });
    assert.ok((t.afterRollbackAudits || []).some((e) => e.action === 'people.person.duplicate_override_denied'));
    const nova = await criar(t, { ...corpo, duplicateReason: 'Casal que divide o mesmo e-mail.' }, { podeForcarDuplicidade: true });
    const [audit] = await sel(t, "SELECT reason, after_json FROM audit.audit_log WHERE action = 'people.person.duplicate_override' AND entity_id = :id", { id: nova.id });
    assert.match(audit.reason, /Casal que divide o mesmo e-mail/);
    assert.deepEqual(audit.after_json.candidatos, [existente.id]);
    const fila = await sel(t, "SELECT reason_code, status FROM governance.review_queue_items WHERE entity_type = 'PERSON' AND primary_id IN (:a, :b) AND secondary_id IN (:a, :b)", { a: nova.id, b: existente.id });
    assert.deepEqual(fila.map((f) => [f.reason_code, f.status]), [['PERSON_CONTACT_AT_CREATE', 'OPEN']]);
    // A lista de "possíveis duplicadas" da tela usa a mesma chave normalizada (e-mail em caixa diferente é o mesmo).
    const pares = await dedup.listPotentialDuplicatePairs(t);
    const par = pares.find((p) => p.value === email);
    assert.ok(par, `par do e-mail ${email} ausente da lista`);
    assert.deepEqual(par.personIds, [existente.id, nova.id].sort());
  });
});

test('CRMX-010 fraco: pela tela, nome semelhante + mesma data de nascimento é recusado ANTES de criar; com a revisão confirmada cria, audita e põe na fila', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const suf = uniqueSuffix();
    const existente = await criar(t, { legalName: `Joana ${suf} Prado`, birthOrFoundationDate: '1980-02-03' });
    const rascunho = { legalName: `JOANA M. ${suf} PRADO`, birthOrFoundationDate: '1980-02-03' };
    const [{ n: antes }] = await sel(t, 'SELECT count(*)::int AS n FROM people.persons');
    await assert.rejects(() => criar(t, rascunho, { modoSemelhante: 'EXIGIR' }), (err) => {
      codigo('PERSON_SIMILAR_REVIEW_REQUIRED')(err);
      assert.deepEqual(err.details.candidatos.map((c) => c.personId), [existente.id]);
      return true;
    });
    const [{ n: depois }] = await sel(t, 'SELECT count(*)::int AS n FROM people.persons');
    assert.equal(depois, antes, 'o cadastro parecido não pode ser criado antes da revisão');
    const nova = await criar(t, { ...rascunho, similarReviewed: true }, { modoSemelhante: 'EXIGIR' });
    const [audit] = await sel(t, "SELECT after_json FROM audit.audit_log WHERE action = 'people.person.similar_reviewed' AND entity_id = :id", { id: nova.id });
    assert.equal(audit.after_json.confirmadoNaTela, true);
    assert.equal(audit.after_json.candidatos[0].personId, existente.id);
    const fila = await sel(t, "SELECT reason_code FROM governance.review_queue_items WHERE primary_id IN (:a, :b) AND secondary_id IN (:a, :b)", { a: nova.id, b: existente.id });
    assert.deepEqual(fila.map((f) => f.reason_code), ['PERSON_SIMILAR_AT_CREATE']);
    // Criação automática (importação, lead, mensagem): não há tela para revisar; cria e o par vai para a fila.
    const auto = await criar(t, { legalName: `Joana ${suf} Prado`, address: { street: 'Rua X', number: '1', city: 'Rio' }, birthOrFoundationDate: '1980-02-03' });
    const filaAuto = await sel(t, 'SELECT count(*)::int AS n FROM governance.review_queue_items WHERE primary_id = :a OR secondary_id = :a', { a: auto.id });
    assert.ok(filaAuto[0].n >= 1);
  });
});

test('M3-03 grupo: CPF ou e-mail de pessoa de OUTRA empresa do grupo recusa antes de gravar, sem id nem nome, e aponta o vínculo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const empresaB = await Company.create({ groupId: tenant.groupId, name: `Dedup B ${uniqueSuffix()}`, status: 'ACTIVE' }, { transaction: t });
    const cpf = randomCpf();
    const email = `grupo.${uniqueSuffix()}@exemplo.com`;
    await criar(t, { taxIdNormalized: cpf, contacts: [{ contactType: 'EMAIL', valueNormalized: email }] });
    await ctxEmpresa(t, empresaB.id);
    await assert.rejects(() => criar(t, { taxIdNormalized: cpf }, {}, empresaB.id), (err) => {
      codigo('PERSON_TAX_ID_IN_GROUP')(err);
      assert.equal(err.details, undefined);
      return true;
    });
    await assert.rejects(() => criar(t, { contacts: [{ contactType: 'EMAIL', valueNormalized: ` ${email.toUpperCase()}` }] }, {}, empresaB.id), (err) => {
      codigo('PERSON_CONTACT_IN_GROUP')(err);
      assert.equal(JSON.stringify(err.details).includes(email), false);
      assert.equal(err.details.nivel, 'MEDIO_GRUPO');
      return true;
    });
    const tentativas = (t.afterRollbackAudits || []).filter((e) => e.action === 'people.person.link_attempt').map((e) => e.afterJson.resultado);
    assert.deepEqual(tentativas, ['CPF_CNPJ_JA_NO_GRUPO', 'CONTATO_JA_NO_GRUPO']);
    // Exceção auditada também vale aqui (pessoa diferente que usa o mesmo e-mail).
    const nova = await criar(t, { contacts: [{ contactType: 'EMAIL', valueNormalized: email }], allowDuplicate: true, duplicateReason: 'E-mail do escritório, pessoa diferente.' }, { podeForcarDuplicidade: true }, empresaB.id);
    assert.ok(nova.id);
    await ctxEmpresa(t, tenant.companyId);
  });
});

test('M3-03 forte nesta empresa: bloqueia sempre (allowDuplicate não contorna) e oferece o cadastro existente', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const cpf = randomCpf();
    const existente = await criar(t, { taxIdNormalized: cpf });
    for (const extra of [{}, { allowDuplicate: true, duplicateReason: 'Tentativa de forçar o mesmo CPF.' }]) {
      await assert.rejects(() => criar(t, { taxIdNormalized: `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`, ...extra }, { podeForcarDuplicidade: true }), (err) => {
        codigo('PERSON_DUPLICATE')(err);
        assert.equal(err.details.nivel, 'FORTE');
        assert.deepEqual(err.details.existente, { id: existente.id, legalName: existente.legalName });
        return true;
      });
    }
  });
});

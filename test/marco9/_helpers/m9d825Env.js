'use strict';

// Apoio dos testes M9-D825 e M9-D824 pela API real (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const env = require('./m9d824Env');
const { startHttp, stopHttp } = require('./m9d806Http');

const VIEW_RESTRICTED = 'governance:dlp:view-restricted';
const CPF = '52998224725';
const ACCOUNT = '12345678-9';

/** Sobe a API com os perfis do teste: gestorA (dlp:admin, sem view-restricted), makerA (sem nada de DLP), checkerA (view-restricted), gestorB. */
async function startDlpHttp(port) {
  if (env.DISPOSABLE) {
    await env.setRolePermission('CI GESTOR', env.ADMIN, true);
    await env.setRolePermission('CI GESTOR', VIEW_RESTRICTED, false);
    await env.setRolePermission('CI CHECKER', VIEW_RESTRICTED, true);
    await env.setRolePermission('CI MAKER', VIEW_RESTRICTED, false);
    await env.setRolePermission('CI MAKER', env.ADMIN, false);
    await env.clean();
  }
  return startHttp({ port, grants: {}, logins: { gestorA: ['A', 'gestor'], makerA: ['A', 'maker'], checkerA: ['A', 'checker'], gestorB: ['B', 'gestor'] } });
}

async function stopDlpHttp() {
  if (env.DISPOSABLE) {
    await env.setRolePermission('CI GESTOR', env.ADMIN, false);
    await env.setRolePermission('CI CHECKER', VIEW_RESTRICTED, false);
    await env.clean().catch(() => {});
  }
  await stopHttp({});
}

/** Uma conta bancária (RESTRICTED: conta e PIX; HIGH: agência) e uma pessoa (RESTRICTED: CPF; HIGH: nascimento) criadas pela API como gestor da empresa. */
async function createFixtures(http, who = 'gestorA', suffix = String(Date.now())) {
  const account = await http.call(who, 'POST', '/finance/bank-accounts', { bankCode: '001', agency: '0001', accountNumber: ACCOUNT, pixKey: `qa-m9-${suffix}@pix.test` });
  if (account.status !== 201) throw new Error(`conta: ${JSON.stringify(account.body)}`);
  const cpf = who === 'gestorB' ? '11144477735' : CPF;
  const person = await http.call(who, 'POST', '/people', { personType: 'PF', legalName: `QA-M9 Pessoa ${suffix}`, taxIdNormalized: cpf, birthOrFoundationDate: '1990-05-17', allowDuplicate: true });
  if (person.status !== 201) throw new Error(`pessoa: ${JSON.stringify(person.body)}`);
  return { accountId: account.body.data.id, personId: person.body.data.id, suffix };
}

async function removeFixtures(ids) {
  await env.adminQuery('DELETE FROM finance.bank_accounts WHERE id = $1', [ids.accountId]).catch(() => {});
  await env.adminQuery('DELETE FROM people.persons WHERE id = $1', [ids.personId]).catch(() => {});
}

module.exports = { ...env, startDlpHttp, stopDlpHttp, createFixtures, removeFixtures, VIEW_RESTRICTED, CPF, ACCOUNT };

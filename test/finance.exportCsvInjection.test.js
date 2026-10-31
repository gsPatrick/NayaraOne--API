'use strict';

// R11 (reconferência ao vivo 20/10/2026) — prova a neutralização de fórmulas no CSV de
// exportação financeira (CSV injection): descrições iniciadas por = + - @ TAB CR saem com
// apóstrofo; separador ';' e aspas continuam corretos; valor negativo legítimo segue número.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.FINANCE_EXPORT_HTTP_TEST_PORT || '21650';

require('../app');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const { exportFinancialEntries, csvCell } = require('../src/features/finance/financeExport.service');
const mfaService = require('../src/features/users/mfa.service');

let tenant;
before(async () => { tenant = await getSeedTenant(); await new Promise((r) => setTimeout(r, 300)); });
after(async () => { await sequelize.close(); process.exit(0); });

// Parser CSV mínimo (separador ';', aspas duplas, "" como aspas escapada, quebras dentro de aspas).
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ';') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  return rows;
}

test('csvCell: neutraliza = + - @ TAB CR, preserva número negativo e escapa separador/aspas', () => {
  for (const bad of ['=1+1', '+x', '-x', '@x', '\t=x', '\r=x']) {
    const out = csvCell(bad);
    assert.ok(out.replace(/^"/, '').startsWith("'"), `${JSON.stringify(bad)} -> ${JSON.stringify(out)}`);
  }
  assert.equal(csvCell('-10.00', { numeric: true }), '-10.00');
  assert.equal(csvCell('-x', { numeric: true }), "'-x");
  assert.equal(csvCell('texto normal'), 'texto normal');
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('diz "oi"'), '"diz ""oi"""');
  assert.equal(csvCell('=SOMA(A1;A2)'), '"\'=SOMA(A1;A2)"');
  assert.equal(csvCell(null), '');
});

test('exportFinancialEntries: descrições maliciosas saem prefixadas; colunas e valores intactos', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const cc = await createTestCostCenter(tenant, t);
    const tag = uniqueSuffix();
    const descriptions = [`=1+1 ${tag}`, `+x ${tag}`, `-x ${tag}`, `@x ${tag}`, `\t=x ${tag}`, `\r=x ${tag}`, `ok; "aspas" ${tag}`];
    for (const [i, description] of descriptions.entries()) {
      await financialEntriesService.createFinancialEntry(
        { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 10 + i, description, costCenterId: cc.id, idempotencyKey: `r11-${tag}-${i}` },
        tenant.userId, t
      );
    }
    const result = await exportFinancialEntries(
      { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId }, {}, t, { maxRows: 100000 }
    );
    const rows = parseCsv(result.csv).filter((r) => r.length > 1);
    const header = rows[0];
    assert.equal(header.length, 10);
    const mine = rows.slice(1).filter((r) => r[8].includes(tag));
    assert.equal(mine.length, descriptions.length);
    for (const r of mine) {
      assert.equal(r.length, 10, 'continua com 10 colunas');
      assert.ok(/^'[=+\-@\t\r]/.test(r[8]) || r[8].startsWith('ok;'), `descrição não neutralizada: ${JSON.stringify(r[8])}`);
      assert.match(r[5], /^\d+(\.\d+)?$/, 'valor continua numérico');
    }
    assert.ok(mine.some((r) => r[8] === `'=1+1 ${tag}`));
    assert.ok(mine.some((r) => r[8] === `'\t=x ${tag}`));
    assert.ok(mine.some((r) => r[8] === `'\r=x ${tag}`));
    assert.ok(mine.some((r) => r[8] === `ok; "aspas" ${tag}`), 'separador e aspas voltam idênticos após o parser');
  });
});

test('rota GET /finance/exports/entries: sem MFA recente recusa; com MFA recente (stub) devolve CSV com cabeçalho correto', async () => {
  const token = signAccessToken({ sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'], permissions: ['finance:read'] });
  const url = `http://127.0.0.1:${process.env.PORT}/api/v1/finance/exports/entries?competenceMonth=1999-01`;
  const original = mfaService.assertRecentMfa;
  try {
    mfaService.assertRecentMfa = async () => { const AppError = require('../src/utils/AppError'); throw AppError.forbidden('MFA recente necessário.', 'MFA_STEP_UP_REQUIRED'); };
    const denied = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(denied.status, 403);

    mfaService.assertRecentMfa = async () => {};
    const ok = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /text\/csv/);
    const body = await ok.text();
    assert.equal(body.split('\n')[0], 'id;competenceMonth;nature;entryType;status;amount;dueAt;settledAt;description;isThirdPartyFunds');
    assert.ok(ok.headers.get('x-export-sha256'));
  } finally {
    mfaService.assertRecentMfa = original;
  }
});

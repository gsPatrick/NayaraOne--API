'use strict';

// R8 (reconferência ao vivo 20/10/2026) — a URL de download do comprovante de baixa
// (finance.financial_entries.settlement_evidence_file_id) responde 403 para quem não tem acesso
// ao Financeiro, 200 para quem tem finance:read, e 404 em outra empresa.
// Fixtures COMMITADAS: rode com
//   node scripts/withDisposableDb.js -- node --test test/finance.receiptFileAccess.test.js
// Fora de banco descartável (DISPOSABLE_DB=1 ou CI, cujo Postgres é efêmero) o teste é pulado.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.FINANCE_RECEIPT_HTTP_TEST_PORT || '21652';
const skip = (process.env.DISPOSABLE_DB || process.env.CI) ? false : 'requer banco descartável (scripts/withDisposableDb.js ou o CI)';

let ctx = {};

before(async () => {
  if (skip) return;
  require('../app');
  const { sequelize, getSeedTenant, withTenantTransaction, uniqueSuffix, createTestCostCenter } = require('./testHelpers');
  const { Company } = require('../src/models');
  const filesService = require('../src/features/files/files.service');
  const financialEntriesService = require('../src/features/finance/financialEntries.service');
  const tenant = await getSeedTenant();
  const file = await withTenantTransaction(tenant, (t) =>
    filesService.uploadFile(
      { groupId: tenant.groupId, companyId: tenant.companyId, fileName: `comprovante-${uniqueSuffix()}.pdf`, mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.4 comprovante R8').toString('base64') },
      tenant.userId, t
    )
  );
  await withTenantTransaction(tenant, async (t) => {
    const cc = await createTestCostCenter(tenant, t);
    const entry = await financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 12, description: 'R8 comprovante', costCenterId: cc.id },
      tenant.userId, t
    );
    await sequelize.query('UPDATE finance.financial_entries SET settlement_evidence_file_id = :f WHERE id = :e', {
      replacements: { f: file.id, e: entry.id }, transaction: t,
    });
  });
  const other = await withTenantTransaction({ ...tenant, companyId: null }, (t) =>
    Company.create({ groupId: tenant.groupId, name: `R8 Outra ${uniqueSuffix()}`, status: 'ACTIVE' }, { transaction: t })
  );
  ctx = { tenant, file, other, sequelize };
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  if (ctx.sequelize) await ctx.sequelize.close().catch(() => {});
  if (!skip) process.exit(0);
});

test('comprovante: sem acesso ao módulo Financeiro -> 403; com finance:read -> 200; outra empresa -> 404', { skip }, async () => {
  const { User } = require('../src/models');
  const { signAccessToken } = require('../src/utils/jwt');
  const { tenant, file, other } = ctx;
  const stranger = await User.create({ name: 'HOMO QA R8 sem papel', email: `homo-qa-r8-${Date.now()}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' });
  const call = (userId, permissions, companyId) =>
    fetch(`http://127.0.0.1:${process.env.PORT}/api/v1/files/${file.id}/content`, {
      headers: { Authorization: `Bearer ${signAccessToken({ sub: userId, group_id: tenant.groupId, company_id: companyId || tenant.companyId, roles: ['r8'], permissions })}` },
    });
  assert.equal((await call(stranger.id, [])).status, 403, 'sem nenhuma permissão');
  assert.equal((await call(stranger.id, ['construction:read', 'inventory:read', 'people:read'])).status, 403, 'com outros módulos');
  assert.equal((await call(stranger.id, ['finance:read'])).status, 200, 'controle positivo: finance:read');
  assert.equal((await call(stranger.id, ['finance:read'], other.id)).status, 404, 'outra empresa não enxerga o arquivo');
  assert.equal((await fetch(`http://127.0.0.1:${process.env.PORT}/api/v1/files/${file.id}/content`)).status, 401, 'sem token');
});

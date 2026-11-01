'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { getCrmDashboard } = require('../src/features/crm/dashboard.service');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

test('dashboard do CRM: filtro por período de criação (createdFrom/createdTo) executa sem erro de coluna', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const out = await getCrmDashboard({ createdFrom: new Date('2000-01-01'), createdTo: new Date('2000-01-02') }, t);
    assert.ok(out && typeof out === 'object');
  });
});

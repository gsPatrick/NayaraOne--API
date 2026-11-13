'use strict';

// Observação L64 da verificação do Marco 5 (Caderno §3, 12 códigos): contrato NOVO só com os códigos do livro. SERVICE
// não existe no livro e é recusado; SALE e LEASE legados só entram pela conversão explícita e auditada (DI-M5CT-2).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const contractsService = require('../src/modules/legal/contracts/application/contract.service');
const { Contract, AuditLog } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId, totalValue: 100 });
// Caderno M5 §3 "Tipos de contrato", na ordem do livro.
const LIVRO = ['SALE_CASH', 'SALE_FINANCED', 'SALE_TRADE', 'SALE_INSTALLMENTS', 'LEASE_RESIDENTIAL', 'LEASE_COMMERCIAL', 'LEASE_SEASONAL', 'PROPERTY_ADMIN', 'CONSTRUCTION', 'ADDENDUM', 'KEY_DELIVERY', 'USED_PROPERTY_DELIVERY'];

test('L64 §3: SERVICE (não está no livro) é recusado para contrato novo e nada é gravado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const antes = await Contract.count({ transaction: t });
    await assert.rejects(
      contractsService.createContract({ ...base(), contractType: 'SERVICE' }, tenant.userId, t),
      (err) => err.statusCode === 400 && err.code === 'LEGAL_CONTRACT_TYPE_NOT_IN_BOOK' && Array.isArray(err.details.allowed) && !err.details.allowed.includes('SERVICE')
    );
    assert.equal(await Contract.count({ transaction: t }), antes);
  });
});

test('L64 §3: SALE e LEASE legados são convertidos explicitamente para o código do livro e a conversão fica na auditoria', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    for (const [informado, gravado] of [['LEASE', 'LEASE_RESIDENTIAL'], ['SALE', 'SALE_CASH']]) {
      const c = await contractsService.createContract({ ...base(), contractType: informado }, tenant.userId, t);
      assert.equal(c.contractType, gravado);
      assert.equal((await Contract.findByPk(c.id, { transaction: t })).contractType, gravado, 'gravado no código do livro');
      const audit = await AuditLog.findOne({ where: { entityType: 'Contract', entityId: c.id, action: 'legal.contract.create' }, transaction: t });
      assert.deepEqual(audit.afterJson.conversaoDeTipo, { contractTypeInformado: informado, contractTypeGravado: gravado });
      assert.match(audit.reason, new RegExp(`legado "${informado}" convertido`));
    }
  });
});

test('L64 §3: os 12 códigos do livro são os aceitos para contrato novo; código desconhecido é 400', async () => {
  const { BOOK_CONTRACT_TYPES } = require('../src/modules/legal/contracts/domain/contractTypes');
  assert.deepEqual([...BOOK_CONTRACT_TYPES], LIVRO);
  await withRollbackTenantTransaction(tenant, async (t) => {
    for (const tipo of ['SALE_CASH', 'LEASE_COMMERCIAL', 'PROPERTY_ADMIN']) {
      const c = await contractsService.createContract({ ...base(), contractType: tipo }, tenant.userId, t);
      assert.equal(c.contractType, tipo);
      const audit = await AuditLog.findOne({ where: { entityType: 'Contract', entityId: c.id, action: 'legal.contract.create' }, transaction: t });
      assert.equal(audit.afterJson.conversaoDeTipo, undefined, 'código do livro não tem conversão');
    }
    await assert.rejects(contractsService.createContract({ ...base(), contractType: 'RENT' }, tenant.userId, t), (err) => err.code === 'LEGAL_CONTRACT_VALIDATION');
  });
});

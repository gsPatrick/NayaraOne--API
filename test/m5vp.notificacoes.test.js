'use strict';

/**
 * Fechamento M5 (vistorias e prazos) — M5-A0100, livro §13 "Notificação possui canal, destinatário, conteúdo/arquivo, data e
 * evidência": sem destinatário a notificação não nasce, não ganha versão sem destinatário e uma antiga sem destinatário não sai.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const noticesService = require('../src/modules/legal/contracts/application/notices.service');
const noticeVersions = require('../src/modules/legal/contracts/application/noticeVersions.service');
const { Contract, Notice } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const code = (c) => (err) => { assert.equal(err.code, c, `${err.code}: ${err.message}`); return true; };
const lease = (t) => Contract.create({ ...base(), contractType: 'LEASE_RESIDENTIAL', contractNumber: `M5VP-N-${uniqueSuffix()}`, status: 'ACTIVE', createdBy: tenant.userId }, { transaction: t });

test('M5-A0100/§13: notificação sem destinatário é recusada na criação, na nova versão e no envio', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ct = await lease(t);
    await assert.rejects(() => noticesService.createNotice({ contractId: ct.id, channel: 'EMAIL', content: 'Sem destinatário' }, tenant.userId, t), code('LEGAL_NOTICE_RECIPIENT_REQUIRED'));
    await assert.rejects(() => noticesService.createNotice({ contractId: ct.id, channel: 'EMAIL', content: 'Só espaços', recipientDescription: '   ' }, tenant.userId, t), code('LEGAL_NOTICE_RECIPIENT_REQUIRED'));
    assert.equal(await Notice.count({ where: { contractId: ct.id }, transaction: t }), 0, 'nada gravado');

    const ok = await noticesService.createNotice({ contractId: ct.id, channel: 'EMAIL', content: 'Aviso', recipientDescription: 'Locatário do imóvel' }, tenant.userId, t);
    assert.equal(ok.recipientDescription, 'Locatário do imóvel');
    await assert.rejects(() => noticeVersions.createNoticeVersion(ok.id, { recipientDescription: null, reason: 'tirar o destinatário' }, tenant.userId, t), code('LEGAL_NOTICE_RECIPIENT_REQUIRED'));

    // Notificação antiga, gravada antes da regra sem destinatário e já aprovada: não é enviada.
    const legacy = await Notice.create({ ...base(), contractId: ct.id, channel: 'EMAIL', content: 'Legado', status: 'APPROVED', currentVersion: 1, approvedVersion: 1, createdBy: tenant.userId }, { transaction: t });
    await assert.rejects(() => noticesService.sendNotice(legacy.id, tenant.userId, t), code('LEGAL_NOTICE_RECIPIENT_REQUIRED'));
    assert.equal((await Notice.findByPk(legacy.id, { transaction: t })).status, 'APPROVED');

    // Com destinatário, o fluxo segue: aprova e envia.
    await noticesService.approveNotice(ok.id, tenant.userId, t);
    const sent = await noticesService.sendNotice(ok.id, tenant.userId, t);
    assert.equal(sent.status, 'SENT');
  });
});

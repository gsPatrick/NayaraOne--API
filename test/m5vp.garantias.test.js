'use strict';

/**
 * Fechamento M5 (vistorias e prazos) — garantias: vigência e dados protegidos pelo estado (M5-A0304, JUR-006) e garantia
 * substituída como histórico imutável (M5-A0320, livro §9 "contrato não perde histórico quando a garantia é substituída").
 * Camada de serviço em transação desfeita, sob a RLS do tenant de seed; a trava do banco é provada com UPDATE/DELETE direto.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const guaranteesService = require('../src/modules/legal/leasing/guarantee.service');
const { Contract, Guarantee } = require('../src/models');
const { completeInsurance } = require('./m5fech.locacao.helpers');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const code = (c) => (err) => { assert.equal(err.code, c, `${err.code}: ${err.message}`); return true; };

async function activeLease(t) {
  return Contract.create({ ...base(), contractType: 'LEASE_RESIDENTIAL', contractNumber: `M5VP-G-${uniqueSuffix()}`, status: 'ACTIVE', createdBy: tenant.userId }, { transaction: t });
}

async function inSavepoint(t, fn) {
  try {
    await sequelize.transaction({ transaction: t }, fn);
    return null;
  } catch (err) {
    return err;
  }
}

test('M5-A0304/JUR-006: PATCH não apaga a vigência nem os dados exigidos de uma garantia ACTIVE; edição legítima continua valendo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ct = await activeLease(t);
    const g = await guaranteesService.createGuarantee(ct.id, await completeInsurance(tenant, t), tenant.userId, t);
    assert.equal(g.status, 'ACTIVE');
    const endsAtBefore = String(g.endsAt);

    await assert.rejects(() => guaranteesService.updateGuarantee(g.id, { endsAt: null }, tenant.userId, t), code('LEGAL_GUARANTEE_VALIDITY_REQUIRED'));
    await assert.rejects(() => guaranteesService.updateGuarantee(g.id, { endsAt: '' }, tenant.userId, t), code('LEGAL_GUARANTEE_VALIDITY_REQUIRED'));
    // Os demais dados do tipo (livro §9 INSURANCE: provider/apólice, vigência, parcelas, renovação) também não somem.
    await assert.rejects(() => guaranteesService.updateGuarantee(g.id, { value: null }, tenant.userId, t), code('LEGAL_GUARANTEE_ACTIVE_DATA_REQUIRED'));
    await assert.rejects(() => guaranteesService.updateGuarantee(g.id, { policyNumber: null }, tenant.userId, t), code('LEGAL_GUARANTEE_VALIDATION'));
    await assert.rejects(() => guaranteesService.updateGuarantee(g.id, { renewalDueAt: null, status: 'ACTIVE' }, tenant.userId, t), (err) => ['LEGAL_GUARANTEE_VALIDATION'].includes(err.code));

    const fresh = await guaranteesService.getGuarantee(g.id, t);
    assert.equal(String(fresh.endsAt), endsAtBefore, 'fim da vigência intacto');
    assert.equal(fresh.status, 'ACTIVE');
    assert.ok(Number(fresh.value) > 0, 'valor intacto');

    // Trocar a vigência por outra data válida continua permitido (e é registrado).
    const moved = await guaranteesService.updateGuarantee(g.id, { endsAt: '2031-06-30' }, tenant.userId, t);
    assert.equal(String(moved.endsAt).slice(0, 10), '2031-06-30');
    // Mesmo encerrada (RELEASED), fiador/seguro/título não ficam sem fim de vigência.
    const released = await guaranteesService.updateGuarantee(g.id, { status: 'RELEASED' }, tenant.userId, t);
    assert.equal(released.status, 'RELEASED');
    await assert.rejects(() => guaranteesService.updateGuarantee(g.id, { endsAt: null }, tenant.userId, t), code('LEGAL_GUARANTEE_VALIDITY_REQUIRED'));
  });
});

test('M5-A0320/§9: garantia substituída não é editada nem apagada — serviço recusa e o banco também', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ct = await activeLease(t);
    const old = await guaranteesService.createGuarantee(ct.id, await completeInsurance(tenant, t), tenant.userId, t);
    const { oldGuarantee, newGuarantee } = await guaranteesService.replaceGuarantee(old.id, await completeInsurance(tenant, t, { endsAt: '2032-12-31' }), tenant.userId, t);
    assert.equal(oldGuarantee.replacedByGuaranteeId, newGuarantee.id);
    const snapshot = (await guaranteesService.getGuarantee(old.id, t)).toJSON();

    await assert.rejects(() => guaranteesService.updateGuarantee(old.id, { value: 1 }, tenant.userId, t), code('LEGAL_GUARANTEE_REPLACED_IMMUTABLE'));
    await assert.rejects(() => guaranteesService.updateGuarantee(old.id, { status: 'ACTIVE' }, tenant.userId, t), code('LEGAL_GUARANTEE_REPLACED_IMMUTABLE'));
    await assert.rejects(() => guaranteesService.deleteGuarantee(old.id, tenant.userId, t), code('LEGAL_GUARANTEE_REPLACED_IMMUTABLE'));
    const again = await completeInsurance(tenant, t);
    await assert.rejects(() => guaranteesService.replaceGuarantee(old.id, again, tenant.userId, t), code('LEGAL_GUARANTEE_ALREADY_REPLACED'));

    // Por baixo do serviço: UPDATE e exclusão lógica direto na tabela são recusados pelo gatilho.
    const upd = await inSavepoint(t, (sp) => sequelize.query('UPDATE legal.guarantees SET value = 1 WHERE id = :id', { replacements: { id: old.id }, transaction: sp }));
    assert.match(String(upd && upd.message), /LEGAL_GUARANTEE_REPLACED_IMMUTABLE/);
    const del = await inSavepoint(t, (sp) => sequelize.query('UPDATE legal.guarantees SET deleted_at = now() WHERE id = :id', { replacements: { id: old.id }, transaction: sp }));
    assert.match(String(del && del.message), /LEGAL_GUARANTEE_REPLACED_IMMUTABLE/);
    const hard = await inSavepoint(t, (sp) => sequelize.query('DELETE FROM legal.guarantees WHERE id = :id', { replacements: { id: old.id }, transaction: sp }));
    assert.match(String(hard && hard.message), /LEGAL_GUARANTEE_REPLACED_IMMUTABLE/);

    const after = (await Guarantee.findByPk(old.id, { transaction: t })).toJSON();
    assert.equal(Number(after.value), Number(snapshot.value));
    assert.equal(after.status, 'RELEASED');
    assert.equal(after.replacedByGuaranteeId, newGuarantee.id);
    // A nova garantia continua editável normalmente.
    const edited = await guaranteesService.updateGuarantee(newGuarantee.id, { notes: 'renovada em 2026' }, tenant.userId, t);
    assert.equal(edited.notes, 'renovada em 2026');
  });
});

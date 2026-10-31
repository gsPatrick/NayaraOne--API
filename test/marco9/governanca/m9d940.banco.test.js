'use strict';

// M9-D940 — as provas que leem o banco (classificação e piso do DLP) reprovam o fechamento. Só em banco descartável (DISPOSABLE_DB=1).
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP_DISPOSABLE, adminQuery, loadTenants } = require('../../m9d801.helpers');
const kit = require('../_helpers/m9d940Fixtures');

const skip = () => (DISPOSABLE ? false : SKIP_DISPOSABLE);
let tenants;
before(async () => { if (DISPOSABLE) tenants = await loadTenants(); });

test('m9d940 coluna sem classificação reprova o fechamento', { skip: skip() }, async () => {
  const amb = kit.ambiente();
  const limpo = kit.fechar(amb, ['--itens', 'registry']);
  assert.equal(limpo.status, 0, limpo.out);
  assert.match(kit.linha(limpo, 'governance registry'), /classificação: cobertura de classificação 100%.*retenção: política de retenção obrigatória/);
  await adminQuery('ALTER TABLE people.persons ADD COLUMN qa_m9d940_mother_name text');
  try {
    const r = kit.fechar(amb, ['--itens', 'registry']);
    assert.equal(r.status, 1, r.out);
    assert.match(kit.linha(r, 'governance registry'), /^FALHA governance registry: classificação: 1 coluna\(s\) sem classificação \(GOV_CLASSIFICATION_MISSING people\.persons\.qa_m9d940_mother_name\)/);
    assert.match(r.stderr, /GOV_DOD_F_ITEM_FAILED: O item governance registry do fechamento do bloco F não está verde\./);
  } finally { await adminQuery('ALTER TABLE people.persons DROP COLUMN IF EXISTS qa_m9d940_mother_name'); }
  assert.equal(kit.fechar(amb, ['--itens', 'registry']).status, 0);
});

test('m9d940 suíte do registro vermelha reprova o fechamento', { skip: skip() }, () => {
  const amb = kit.ambiente();
  amb.cfg.registry.suites = [kit.suiteMinima(amb.dir, 'vermelha.suite.test.js', "test('legal hold bloqueando disposição', () => { throw new Error('falhou'); });")];
  amb.salvar();
  const r = kit.fechar(amb, ['--itens', 'registry']);
  assert.equal(r.status, 1, r.out);
  assert.match(kit.linha(r, 'governance registry'), /suíte: a suíte falhou/);
});

test('m9d940 política DLP enfraquecida abaixo do piso reprova o fechamento', { skip: skip() }, async () => {
  const amb = kit.ambiente();
  const empresa = tenants.A;
  const limpar = () => adminQuery("DELETE FROM governance.dlp_policies WHERE company_id = $1 AND classification = 'HIGH' AND action = 'EXPORT'", [empresa.companyId]);
  const gravar = (mfa, expiry) => adminQuery(
    `INSERT INTO governance.dlp_policies (group_id, company_id, classification, action, allowed, require_justification, require_mfa, require_audit, max_expiry_hours)
     VALUES ($1, $2, 'HIGH', 'EXPORT', true, true, $3, true, $4)`, [empresa.groupId, empresa.companyId, mfa, expiry]
  );
  await limpar();
  try {
    await gravar(true, 24);
    const ok = kit.fechar(amb, ['--itens', 'dlp']);
    assert.equal(ok.status, 0, ok.out);
    assert.match(kit.linha(ok, 'DLP'), /piso: piso de EXPORT respeitado/);
    await limpar();
    await gravar(false, 24); // sem MFA
    const semMfa = kit.fechar(amb, ['--itens', 'dlp']);
    assert.equal(semMfa.status, 1, semMfa.out);
    assert.match(kit.linha(semMfa, 'DLP'), /^FALHA DLP: piso: 1 política\(s\) de EXPORT abaixo do piso \(GOV_DLP_FLOOR_VIOLATION em HIGH\)/);
    assert.match(semMfa.stderr, /GOV_DOD_F_ITEM_FAILED: O item DLP do fechamento do bloco F não está verde\./);
    await limpar();
    await gravar(true, null); // sem expiração
    assert.equal(kit.fechar(amb, ['--itens', 'dlp']).status, 1);
    await limpar();
    await adminQuery(`INSERT INTO governance.dlp_policies (group_id, company_id, classification, action, allowed, require_mfa) VALUES ($1, $2, 'HIGH', 'EXPORT', false, false)`, [empresa.groupId, empresa.companyId]);
    assert.equal(kit.fechar(amb, ['--itens', 'dlp']).status, 0, 'endurecer (negar a ação) é permitido');
  } finally { await limpar(); }
});

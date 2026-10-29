'use strict';

// M9-D821 — dlpGuard.evaluate puro (sem banco): ordem fixa das 6 etapas, primeira falha encerra, VIEW/COPY em modo leve e obrigações da decisão.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../../../src/features/core-governance/dlp/dlp.guard');
const { request, ctx, policyOf, NOW } = require('../_helpers/dlpGuardKit');

const steps = (out) => out.trace.map((t) => `${t.step}:${t.result}`);

test('m9d821 ordem das 6 etapas respeitada', () => {
  const ok = evaluate(request(), ctx('HIGH', 'EXPORT'));
  assert.equal(ok.decision, 'ALLOW');
  assert.deepEqual(ok.trace.map((t) => t.step), ['CLASSIFICATION', 'PERMISSION', 'PURPOSE', 'MFA', 'VOLUME', 'DECISION']);
  assert.deepEqual(steps(ok), ['CLASSIFICATION:PASS', 'PERMISSION:PASS', 'PURPOSE:PASS', 'MFA:PASS', 'VOLUME:PASS', 'DECISION:ALLOW']);
  // tudo falha ao mesmo tempo: só a primeira (permissão) conta e as demais não são avaliadas
  const all = evaluate(request({ purpose: 'XYZ', justification: 'x', mfaOk: false, estimatedRows: 999999 }), ctx('HIGH', 'EXPORT', { policy: policyOf('HIGH', 'EXPORT', { requirePermission: 'finance:entries:export' }) }));
  assert.deepEqual([all.decision, all.blockReason], ['DENY', 'PERMISSION']);
  assert.deepEqual(steps(all), ['CLASSIFICATION:PASS', 'PERMISSION:FAIL', 'PURPOSE:SKIPPED', 'MFA:SKIPPED', 'VOLUME:SKIPPED', 'DECISION:DENY']);
  // sem a falha da permissão, a finalidade vem antes do MFA e este antes do volume
  const purpose = evaluate(request({ justification: 'curta', mfaOk: false, estimatedRows: 999999 }), ctx('HIGH', 'EXPORT'));
  assert.equal(purpose.blockReason, 'PURPOSE');
  assert.deepEqual(steps(purpose).slice(2), ['PURPOSE:FAIL', 'MFA:SKIPPED', 'VOLUME:SKIPPED', 'DECISION:DENY']);
  const mfa = evaluate(request({ mfaOk: false, estimatedRows: 999999 }), ctx('HIGH', 'EXPORT'));
  assert.equal(mfa.blockReason, 'MFA');
  assert.equal(steps(mfa)[4], 'VOLUME:SKIPPED');
  assert.equal(evaluate(request({ estimatedRows: 999999 }), ctx('HIGH', 'EXPORT')).blockReason, 'VOLUME');
});

test('m9d821 RESTRICTED sem MFA com 800 linhas: etapas 1 a 3 passam e a 4 falha', () => {
  const out = evaluate(request({ mfaOk: false, estimatedRows: 800, justification: 'x'.repeat(40) }), ctx('RESTRICTED', 'EXPORT'));
  assert.deepEqual([out.decision, out.blockReason, out.errorCode, out.httpStatus], ['DENY', 'MFA', 'MFA_STEP_UP_REQUIRED', 403]);
  assert.deepEqual(steps(out), ['CLASSIFICATION:PASS', 'PERMISSION:PASS', 'PURPOSE:PASS', 'MFA:FAIL', 'VOLUME:SKIPPED', 'DECISION:DENY']);
});

test('m9d821 volume acima do teto bloqueia e abaixo aprova', () => {
  const high = (rows) => evaluate(request({ estimatedRows: rows }), ctx('HIGH', 'EXPORT'));
  const over = high(12000);
  assert.deepEqual([over.decision, over.blockReason, over.errorCode, over.httpStatus], ['DENY', 'VOLUME', 'GOV_DLP_VOLUME_EXCEEDED', 422]);
  assert.equal(high(10000).decision, 'ALLOW', 'o teto é inclusivo');
  assert.equal(high(10001).blockReason, 'VOLUME');
  assert.equal(high(6000).decision, 'ALLOW');
  assert.equal(evaluate(request({ estimatedRows: 1001 }), ctx('RESTRICTED', 'EXPORT')).blockReason, 'VOLUME');
  assert.equal(evaluate(request({ estimatedRows: 100000 }), ctx('LOW', 'EXPORT')).decision, 'ALLOW');
});

test('m9d821 justificativa curta bloqueia com PURPOSE e o MFA nem é avaliado', () => {
  const out = evaluate(request({ justification: '12345678', mfaOk: false }), ctx('HIGH', 'EXPORT'));
  assert.deepEqual([out.decision, out.blockReason, out.errorCode, out.httpStatus], ['DENY', 'PURPOSE', 'GOV_DLP_PURPOSE_REQUIRED', 422]);
  assert.equal(steps(out)[3], 'MFA:SKIPPED');
  assert.equal(evaluate(request({ justification: ' '.repeat(30) }), ctx('HIGH', 'EXPORT')).blockReason, 'PURPOSE', 'espaços não contam');
  assert.equal(evaluate(request({ purpose: 'NAO_EXISTE' }), ctx('HIGH', 'EXPORT')).blockReason, 'PURPOSE', 'finalidade fora do catálogo');
  assert.equal(evaluate(request({ purpose: undefined }), ctx('HIGH', 'EXPORT')).blockReason, 'PURPOSE');
  assert.equal(evaluate(request({ justification: 'x'.repeat(20) }), ctx('HIGH', 'EXPORT')).decision, 'ALLOW', 'exatamente o mínimo passa');
  assert.equal(evaluate(request({ justification: 'x'.repeat(10) }), ctx('HIGH', 'EXPORT', { justificationMin: 10 })).decision, 'ALLOW', 'o mínimo é parâmetro');
  assert.equal(evaluate(request({ purpose: 'qualquer', justification: '' }), ctx('LOW', 'EXPORT')).decision, 'ALLOW', 'LOW não exige finalidade');
});

test('m9d821 política com allowed falso bloqueia com POLICY', () => {
  const copy = evaluate(request({ action: 'COPY', kind: undefined }), ctx('RESTRICTED', 'COPY'));
  assert.deepEqual([copy.decision, copy.blockReason, copy.errorCode, copy.httpStatus], ['DENY', 'POLICY', 'GOV_DLP_DENIED', 403]);
  const off = evaluate(request(), ctx('LOW', 'EXPORT', { policy: policyOf('LOW', 'EXPORT', { allowed: false }) }));
  assert.equal(off.blockReason, 'POLICY');
  assert.equal(steps(off)[1], 'PERMISSION:FAIL');
  assert.equal(off.trace[1].check, 'POLICY');
});

test('m9d821 a IA só passa se a classe permitir e ai_allowed for verdadeiro', () => {
  const ai = (cls, flag) => evaluate({ action: 'AI', resourceType: 'crm.contacts', mfaOk: true, aiAllowed: flag, permissions: [] }, ctx(cls, 'AI'));
  assert.equal(ai('LOW', true).decision, 'ALLOW');
  assert.equal(ai('LOW', false).blockReason, 'POLICY');
  assert.equal(ai('HIGH', undefined).blockReason, 'POLICY');
  assert.equal(ai('RESTRICTED', true).blockReason, 'POLICY');
  assert.equal(ai('HIGH', true).obligations.mask, true, 'HIGH exige máscara');
});

test('m9d821 usuário suspenso por anomalia é bloqueado em EXPORT, SHARE e PRINT e liberado em VIEW com SUSPENDED', () => {
  const until = new Date(NOW.getTime() + 3600 * 1000);
  for (const action of ['EXPORT', 'SHARE', 'PRINT']) {
    const out = evaluate(request({ action, kind: action }), ctx('LOW', action, { suspendedUntil: until }));
    assert.deepEqual([out.decision, out.blockReason, out.errorCode, out.httpStatus], ['DENY', 'SUSPENDED', 'GOV_DLP_USER_SUSPENDED', 403], action);
    assert.equal(out.trace[1].check, 'SUSPENDED');
  }
  const view = evaluate({ action: 'VIEW', resourceType: 'people.persons', mfaOk: true, permissions: [] }, ctx('LOW', 'VIEW', { suspendedUntil: until }));
  assert.equal(view.decision, 'ALLOW', 'a suspensão não vale para VIEW');
  const expired = evaluate(request(), ctx('LOW', 'EXPORT', { suspendedUntil: new Date(NOW.getTime() - 1000) }));
  assert.equal(expired.decision, 'ALLOW', 'suspensão vencida não bloqueia');
  const order = evaluate(request(), ctx('LOW', 'EXPORT', { policy: policyOf('LOW', 'EXPORT', { allowed: false }), suspendedUntil: until }));
  assert.equal(order.blockReason, 'POLICY', '2a antes de 2b');
  const perm = evaluate(request(), ctx('HIGH', 'EXPORT', { policy: policyOf('HIGH', 'EXPORT', { requirePermission: 'x:y' }), suspendedUntil: until }));
  assert.equal(perm.blockReason, 'SUSPENDED', '2b antes de 2c');
});

test('m9d821 a permissão da política e a do módulo de origem são exigidas (etapa 2c)', () => {
  const policy = policyOf('RESTRICTED', 'VIEW');
  const view = (permissions) => evaluate({ action: 'VIEW', resourceType: 'people.persons', mfaOk: true, permissions }, ctx('RESTRICTED', 'VIEW', { policy, permissions }));
  const denied = view(['people:read']);
  assert.deepEqual([denied.decision, denied.blockReason, denied.errorCode, denied.httpStatus], ['DENY', 'PERMISSION', 'GOV_DLP_PERMISSION', 403]);
  assert.equal(view(['governance:dlp:view-restricted']).decision, 'ALLOW');
  const origin = evaluate(request({ originPermission: 'finance:entries:export' }), ctx('LOW', 'EXPORT', { permissions: ['governance:dlp:export'] }));
  assert.equal(origin.blockReason, 'PERMISSION', 'falta a permissão do módulo de origem');
  assert.equal(evaluate(request({ originPermission: 'finance:entries:export' }), ctx('LOW', 'EXPORT', { permissions: ['finance:entries:export'] })).decision, 'ALLOW');
});

test('m9d821 VIEW e COPY percorrem só as etapas 1, 2, 4 e 6', () => {
  for (const action of ['VIEW', 'COPY']) {
    const out = evaluate({ action, resourceType: 'people.persons', mfaOk: false, permissions: [], justification: '', estimatedRows: 999999999 }, ctx('HIGH', action));
    assert.equal(out.mode, 'LIGHT');
    assert.deepEqual(steps(out), ['CLASSIFICATION:PASS', 'PERMISSION:PASS', 'PURPOSE:NOT_APPLICABLE', 'MFA:PASS', 'VOLUME:NOT_APPLICABLE', 'DECISION:ALLOW'], action);
  }
  const mfa = evaluate({ action: 'VIEW', resourceType: 'x', mfaOk: false, permissions: [] }, ctx('HIGH', 'VIEW', { policy: policyOf('HIGH', 'VIEW', { requireMfa: true }) }));
  assert.equal(mfa.blockReason, 'MFA', 'MFA da política vale também em modo leve');
  assert.equal(evaluate(request(), ctx('HIGH', 'EXPORT')).mode, 'FULL');
});

test('m9d821 a decisão traz as obrigações: auditoria, expiração, marca d\'água e máscara', () => {
  const out = evaluate(request({ watermarkRequested: false }), ctx('HIGH', 'EXPORT'));
  assert.deepEqual(out.obligations, { audit: true, watermark: false, mask: false, expiresAt: new Date(NOW.getTime() + 48 * 3600 * 1000).toISOString(), maxExpiryHours: 48 });
  const wm = evaluate(request({ watermarkRequested: true }), ctx('LOW', 'EXPORT'));
  assert.equal(wm.obligations.watermark, true, 'o usuário pode pedir a marca em qualquer exportação');
  assert.equal(evaluate(request(), ctx('LOW', 'EXPORT', { policy: policyOf('LOW', 'EXPORT', { requireWatermark: true }) })).obligations.watermark, true, 'ou a política exige');
  assert.equal(evaluate(request({ action: 'PRINT', kind: 'PRINT' }), ctx('LOW', 'PRINT')).obligations.expiresAt, null, 'sem prazo na política, sem expiração');
  assert.equal(evaluate(request({ estimatedRows: 800 }), ctx('RESTRICTED', 'EXPORT', { policy: policyOf('RESTRICTED', 'EXPORT'), now: NOW })).obligations.maxExpiryHours, 24);
});

test('m9d821 cada motivo de bloqueio vira o erro HTTP do livro, com a mensagem em português', () => {
  const { blockedError } = require('../../../src/features/core-governance/dlp/guard.reasons');
  const make = (blockReason) => blockedError({ blockReason, job: { id: 'j1' } }, 20);
  const expected = {
    POLICY: [403, 'GOV_DLP_DENIED', 'Esta ação não é permitida para dados desta classificação.'],
    SUSPENDED: [403, 'GOV_DLP_USER_SUSPENDED', 'Suas exportações estão suspensas para revisão de segurança.'],
    PERMISSION: [403, 'GOV_DLP_PERMISSION', 'Você não tem permissão para esta exportação.'],
    PURPOSE: [422, 'GOV_DLP_PURPOSE_REQUIRED', 'Informe a finalidade e uma justificativa com pelo menos 20 caracteres.'],
    MFA: [403, 'MFA_STEP_UP_REQUIRED', 'Confirme o código de verificação para continuar.'],
    VOLUME: [422, 'GOV_DLP_VOLUME_EXCEEDED', 'O volume pedido excede o limite desta classificação.'],
  };
  for (const [reason, [status, code, message]] of Object.entries(expected)) {
    const err = make(reason);
    assert.deepEqual([err.statusCode, err.code, err.message], [status, code, message], reason);
    assert.deepEqual(err.details, { blockReason: reason, exportJobId: 'j1' });
  }
  assert.match(blockedError({ blockReason: 'PURPOSE', job: null }, 8).message, /pelo menos 8 caracteres/, 'o mínimo vem do parâmetro');
});

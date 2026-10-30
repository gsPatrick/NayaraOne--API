'use strict';

// M9-D852 §3.3 (R34) — o inventário fechado bate com as rotas reais: toda ação com rota passa pelo guarda de confirmação e tem rota /impact com provedor;
// toda ação sem rota nomeia a demanda dona e a rota realmente não existe. Carrega as rotas (sem abrir conexão); roda em banco descartável por segurança.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP_DISPOSABLE } = require('../../m9d801.helpers');

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'segredo-de-teste-m9d852';
const skip = DISPOSABLE ? false : SKIP_DISPOSABLE;

test('m9d852 toda rota do inventário de ações destrutivas tem /impact e usa o guarda da ConfirmAction', { skip }, () => {
  const { allRoutes, find } = require('../_helpers/m9d852Rotas');
  const D = require('../../../src/shared/destructive-actions');
  const routes = allRoutes();
  for (const a of D.inventory.wired()) {
    const action = find(routes, a.method, a.route);
    assert.ok(action.some((r) => r.guards.includes(a.key)), `${a.key}: ${a.method} ${a.route} sem o guarda de confirmação`);
    const impact = find(routes, a.impact.method, a.impact.path);
    assert.ok(impact.some((r) => r.impacts.includes(a.key)), `${a.key}: ${a.impact.method} ${a.impact.path} sem rota de impacto`);
    assert.ok(D.registry.registeredKeys().includes(a.key), `${a.key} sem provedor de impacto`);
    // Ação com MFA "sim": a rota (ou o próprio guarda, quando só parte dos casos exige) confere o MFA recente.
    if (a.mfa === 'sim') assert.ok(action.some((r) => r.mfa), `${a.key}: MFA "sim" no inventário, mas a rota não confere o MFA recente`);
    for (const extra of a.alsoGuarded || []) {
      const [, method, route] = /^([A-Z]+) (\S+)/.exec(extra);
      assert.ok(find(routes, method, route).some((r) => r.guards.includes(a.key)), `${a.key}: ${extra} sem o guarda`);
    }
  }
});

test('m9d852 as ações sem rota no código nomeiam a demanda dona e a rota realmente não existe (nada fica sem guarda por esquecimento)', { skip }, () => {
  const { allRoutes, find } = require('../_helpers/m9d852Rotas');
  const D = require('../../../src/shared/destructive-actions');
  const routes = allRoutes();
  for (const a of D.inventory.unwired()) {
    assert.match(a.ownerDemand, /^M9-D\d{3}$/);
    assert.ok(a.pendingReason, `${a.key}: motivo`);
    const real = find(routes, a.method, a.route);
    if (a.key.startsWith('kill_switch.')) continue; // PATCH /feature-flags ainda não existe; o kill switch de marketing (D425) é rota própria
    assert.equal(real.length, 0, `${a.key}: a rota ${a.method} ${a.route} existe no código mas está marcada sem rota`);
  }
});

test('m9d852 nenhuma rota guardada fica fora do inventário', { skip }, () => {
  const { allRoutes } = require('../_helpers/m9d852Rotas');
  const D = require('../../../src/shared/destructive-actions');
  const known = new Set(D.inventory.all().map((a) => a.key));
  for (const r of allRoutes()) for (const key of r.guards) assert.ok(known.has(key), `guarda de ação fora do inventário: ${key}`);
});

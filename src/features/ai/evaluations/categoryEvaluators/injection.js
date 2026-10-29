'use strict';

const { detectInjection } = require('../../orchestrator/injectionDetector');
const { makeItem } = require('./common');

/** INJECTION: o detector da M9-D021 precisa sinalizar (alerta ou quarentena) o ataque e deixar passar o pedido legítimo. */
function evaluateInjection(caseDef, env) {
  if (caseDef.probe) return require('../adversarial').runProbeCase(caseDef, env); // suíte adversarial (M9-D042)
  const r = detectInjection(caseDef.input, env.injectionLimits);
  const detected = r.action !== 'ALLOW';
  return makeItem(caseDef, {
    expected: caseDef.expectDetected ? 'injeção detectada' : 'pedido legítimo liberado', actual: r.action, passed: detected === caseDef.expectDetected,
    details: { action: r.action, scoreCents: r.scoreCents, patternIds: r.patternIds },
  });
}

module.exports = { evaluateInjection };

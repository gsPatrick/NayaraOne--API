'use strict';

/**
 * Caso do golden dataset (linha de ai.golden_cases) -> definição de caso que os avaliadores de categoria entendem (M9-D032).
 * O id leva a versão do caso: corrigir um caso muda o `casesHash` da avaliação. INJECTION pertence à suíte adversarial.
 */
function toCaseDef(c) {
  const fixtures = c.fixtures || {};
  const expected = c.expected || {};
  const base = {
    id: `golden:${c.caseKey}@${c.version}`, category: c.category, suite: c.category === 'INJECTION' ? 'ADVERSARIAL' : 'GOLDEN', input: c.input,
    golden: { expected, mustNot: c.mustNot || [] },
  };
  switch (c.category) {
    case 'GROUNDING':
    case 'HALLUCINATION':
      return { ...base, sources: fixtures.sources || [] };
    case 'TOOL_SELECTION': {
      const list = Array.isArray(expected.tools) ? expected.tools : null;
      return { ...base, expectedTool: expected.tool !== undefined ? expected.tool : (list && list.length ? list[0] : null) };
    }
    case 'PERMISSIONS':
      return { ...base, toolName: fixtures.toolName, actorPermissions: fixtures.actorPermissions || [], expectBlocked: expected.blocked !== false };
    case 'INJECTION':
      return { ...base, expectDetected: expected.detected !== false };
    default:
      return base;
  }
}

module.exports = { toCaseDef };

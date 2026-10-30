'use strict';

const { ler, exigir, linhaDe } = require('./source');

const NOME = 'guard_ai_output_requires_factual_validation';
const CORE = 'content/pipeline.core.js';
// A corrente do livro: nada avança sem o passo anterior ter gravado ok, e o primeiro passo depois dos fatos é a validação factual.
const CORRENTE = [['factual', 'facts'], ['branding', 'factual'], ['compliance', 'branding'], ['approval', 'compliance'], ['schedule', 'approval']];

/** O conteúdo gerado pela NAY só avança com checks_json.factual.ok = true. */
function verificar(raiz) {
  const texto = ler(raiz, CORE);
  if (texto === null) return [{ arquivo: CORE, linha: 1, regra: 'o pipeline de conteúdo não existe' }];
  const problemas = [];
  for (const [passo, requisito] of CORRENTE) {
    const m = new RegExp(`\\b${passo}:\\s*\\{[^}]*prereq:\\s*'([^']*)'`).exec(texto);
    if (!m || m[1] !== requisito) {
      problemas.push({ arquivo: CORE, linha: m ? linhaDe(texto, m.index) : 1, regra: `o passo "${passo}" deve exigir o passo "${requisito}" gravado com ok (hoje: ${m ? m[1] : 'passo ausente'}); sem isso o texto da IA avança sem validação factual` });
    }
  }
  if (!/if\s*\(!checkOk\(version,\s*def\.prereq\)\)\s*throw\s+stepRequired/.test(texto)) {
    problemas.push({ arquivo: CORE, linha: 1, regra: 'executeStep deve recusar (MKT_PIPELINE_STEP_REQUIRED) quando o passo anterior não gravou ok' });
  }
  problemas.push(...exigir(raiz, 'content/autopublish.policy.js', /checks\.factual\.ok\s*!==\s*true/, 'a autopublicação deve exigir checks.factual.ok = true'));
  return problemas;
}

module.exports = { NOME, verificar };

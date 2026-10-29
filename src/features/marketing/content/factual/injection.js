'use strict';

const { fold } = require('./text');
const { finding } = require('./finding');

/** Frases imperativas dirigidas ao modelo (sobre o texto dobrado). O cadastro é DADO: ordem escrita nele nunca é obedecida. */
const PATTERNS = Object.freeze([
  /\b(?:ignore|ignorem|ignorar|desconsidere|desconsiderem|desconsiderar|esqueca|esquecam|esquecer|desobedeca|descarte)\b[^.!?]*\b(?:regras?|instrucoes|instrucao|anteriores|politicas?|acima|tudo|orientacoes|restricoes)\b/,
  /\b(?:ignore|disregard|forget)\b[^.!?]*\b(?:previous|above|instructions?|rules?)\b/,
  /\b(?:diga|digam|escreva|escrevam|afirme|responda|declare|publique|anuncie|invente|finja|simule)\s+que\b/,
  /\b(?:voce deve|voce precisa|a partir de agora|novas instrucoes|system prompt|prompt do sistema|nova regra|modo desenvolvedor|jailbreak)\b/,
]);

const sentencesOf = (text) => text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

function walk(node, path, out) {
  if (typeof node === 'string') out.push({ path, text: node });
  else if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') Object.keys(node).forEach((k) => walk(node[k], path ? `${path}.${k}` : k, out));
  return out;
}

/** Varre os textos do cadastro (qualquer campo de texto, em qualquer nível): uma suspeita por campo, com a frase suspeita. */
function checkInjection(facts) {
  const findings = [];
  for (const { path, text } of walk(facts, '', [])) {
    const sentence = sentencesOf(text).find((s) => PATTERNS.some((re) => re.test(fold(s))));
    if (!sentence) continue;
    findings.push(finding({
      kind: 'INJECTION_SUSPECT', claim: sentence.slice(0, 160), expected: null, found: path, reason: 'INJECTION', field: path,
      message: 'Há instrução suspeita no texto de origem do cadastro; revisão humana necessária.',
    }));
  }
  return findings;
}

module.exports = { checkInjection };

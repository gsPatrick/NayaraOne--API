'use strict';
/**
 * Parser do test-results.log (reporter "spec" do node:test). Lê apenas as linhas de resultado
 * ANTES do resumo "ℹ tests": ✔ passou, ✖ falhou, ﹣ pulado/todo (com "# SKIP"/"# TODO").
 * Nomes repetidos no log viram várias ocorrências (o pior resultado prevalece na classificação).
 */
const LINHA = /^(\s*)(✔|✖|﹣)\s+(.*?)\s+\(([\d.]+)ms\)(?:\s+#\s+(SKIP|TODO)\b.*)?\s*$/;

function parseLog(texto) {
  const linhas = texto.split('\n');
  const cabecalho = [];
  const testes = new Map();
  const resumo = {};
  let noResumo = false;
  for (const l of linhas) {
    if (l.startsWith('# ') || l === '#') { if (!noResumo) cabecalho.push(l); continue; }
    const r = /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)/.exec(l);
    if (r) { noResumo = true; resumo[r[1]] = Number(r[2]); continue; }
    if (noResumo) continue;
    const m = LINHA.exec(l);
    if (!m) continue;
    const status = m[2] === '✔' ? (m[5] === 'TODO' ? 'todo' : 'pass') : m[2] === '✖' ? 'fail' : (m[5] === 'TODO' ? 'todo' : 'skip');
    const nome = m[3];
    if (!testes.has(nome)) testes.set(nome, []);
    testes.get(nome).push({ status, duracaoMs: Number(m[4]) });
  }
  const commit = (cabecalho.map((h) => /commit avaliado[^:]*:\s*([0-9a-f]{7,40})/.exec(h)).find(Boolean) || [])[1] || null;
  return { cabecalho, testes, resumo, commit };
}

/** Resultado de um nome de teste: pior ocorrência (fail > todo > skip > pass); null se ausente. */
function resultadoDe(parsed, nome) {
  const occ = parsed && parsed.testes.get(nome);
  if (!occ) return null;
  const ordem = ['fail', 'todo', 'skip', 'pass'];
  const pior = occ.slice().sort((a, b) => ordem.indexOf(a.status) - ordem.indexOf(b.status))[0];
  return { status: pior.status, duracaoMs: occ.reduce((s, o) => s + o.duracaoMs, 0), ocorrencias: occ.length };
}

module.exports = { parseLog, resultadoDe };

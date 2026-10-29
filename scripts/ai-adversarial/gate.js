'use strict';

/**
 * Portão da suíte adversarial da NAY (M9-D042). Funções puras: conferem o manifesto contra os arquivos de teste e o relatório contra o
 * manifesto. Devolvem a lista de problemas (vazia = ok). Os 15 nomes do livro precisam existir, um por arquivo, sem skip, todo nem only,
 * e o relatório precisa listar os 15 como aprovados.
 */
const CATEGORIAS = Object.freeze(['INJECTION', 'PERMISSIONS']);
const TOTAL = 15;
const PULO = /(?:\b(?:test|it|describe)\.(?:skip|todo|only)\b|\{\s*(?:skip|todo|only)\s*:)/;
const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `lerArquivo(nomeDoArquivo)` devolve o texto do arquivo de teste ou null se não existir. */
function validateManifest(manifest, lerArquivo) {
  const problemas = [];
  const testes = (manifest && manifest.testes) || [];
  if (testes.length !== TOTAL) problemas.push(`o manifesto lista ${testes.length} testes e o livro exige ${TOTAL}`);
  const nomes = testes.map((t) => t.nome);
  if (new Set(nomes).size !== nomes.length) problemas.push('há nome repetido no manifesto');
  const arquivos = testes.map((t) => t.arquivo);
  if (new Set(arquivos).size !== arquivos.length) problemas.push('um arquivo de teste serve a mais de um nome (a suíte tem um arquivo por teste)');
  for (const t of testes) {
    if (!/^adv_[a-z0-9_]+$/.test(t.nome || '')) problemas.push(`nome inválido: ${t.nome}`);
    if (!/^M9-D\d{3}$/.test(t.demandaDona || '')) problemas.push(`${t.nome}: demandaDona inválida`);
    if (!CATEGORIAS.includes(t.categoria)) problemas.push(`${t.nome}: categoria deve ser INJECTION ou PERMISSIONS`);
    const texto = lerArquivo(t.arquivo);
    if (texto === null || texto === undefined) { problemas.push(`${t.nome}: arquivo ${t.arquivo} ausente`); continue; }
    if (!new RegExp(`^test\\('${escapar(t.nome)}'`, 'm').test(texto)) problemas.push(`${t.nome}: teste ausente em ${t.arquivo}`);
    if (PULO.test(texto)) problemas.push(`${t.nome}: ${t.arquivo} tem skip, todo ou only`);
  }
  return problemas;
}

/** `report.testes`: [{ nome, passou, pulado }]. Todos os nomes do manifesto, uma vez cada, aprovados e não pulados. */
function validateReport(report, manifest) {
  const problemas = [];
  const linhas = (report && report.testes) || [];
  for (const t of (manifest && manifest.testes) || []) {
    const achadas = linhas.filter((l) => l.nome === t.nome);
    if (achadas.length === 0) problemas.push(`${t.nome}: o relatório não lista o teste`);
    else if (achadas.length > 1) problemas.push(`${t.nome}: o relatório lista o teste ${achadas.length} vezes`);
    else if (achadas[0].pulado) problemas.push(`${t.nome}: teste pulado`);
    else if (achadas[0].passou !== true) problemas.push(`${t.nome}: reprovado`);
  }
  if (linhas.filter((l) => ((manifest && manifest.testes) || []).some((t) => t.nome === l.nome)).length < TOTAL && !problemas.length) problemas.push(`o relatório lista menos de ${TOTAL} testes`);
  return problemas;
}

module.exports = { validateManifest, validateReport, CATEGORIAS, TOTAL };

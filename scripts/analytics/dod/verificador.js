'use strict';

/**
 * M9-D707 — "verificada" só vale com verificador independente: o DoD reaproveita o `demandas-check.js` do repositório de documentos (a mesma
 * validação do portão do marco: critérios marcados, commit, testes, evidência, veredito COMPLETA e implementador diferente do verificador).
 */
const fs = require('node:fs');
const path = require('node:path');

function criarVerificador(pastaDemandas) {
  const ferramentas = path.join(pastaDemandas, '_ferramentas');
  const check = path.join(ferramentas, 'demandas-check.js');
  if (!fs.existsSync(check)) throw new Error(`ferramenta de verificação não encontrada: ${check}`);
  const { analisar } = require(check);
  const A = analisar({ raiz: pastaDemandas, faixas: path.join(ferramentas, 'faixas.json'), permitidas: path.join(ferramentas, 'palavras-permitidas.txt'), marco: '9' });
  const erros = new Map([...A.resultados].map(([d, r]) => [d.id, r.erros]));
  return async (demanda) => {
    const e = erros.get(demanda.id);
    if (!e) return { ok: false, motivo: 'o demandas-check não leu a demanda' };
    return e.length ? { ok: false, motivo: e[0].slice(0, 160) } : { ok: true };
  };
}

module.exports = { criarVerificador };

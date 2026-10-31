'use strict';

const { daRaiz } = require('./config');
const { LeituraError } = require('./erros');
const { rodar } = require('./processo');

const NOME = 'manifest documental';

/** Item 5: chama verificar-manifest.js (M9-D932) sobre o manifest dos documentos CURRENT. Exit 0 = ok; 1 = violação GOV_MANIFEST_*; 2 = índice inválido (erro de leitura). */
async function verificar({ cfg }) {
  const m = cfg.manifest;
  const r = rodar(process.execPath, [daRaiz(m.script), daRaiz(m.manifest), ...(m.args || []).map((a) => (a.startsWith('--') ? a : daRaiz(a)))]);
  if (r.status === 2) throw new LeituraError('o índice documental é inválido (verificar-manifest.js saiu com 2)');
  if (r.status !== 0) {
    const erros = r.out.split('\n').filter((l) => l.startsWith('ERRO ')).map((l) => l.replace(/^ERRO /, ''));
    return { nome: NOME, ok: false, motivo: `verificar-manifest.js reprovou: ${(erros.slice(0, 2).join(' | ') || `exit ${r.status}`)}${erros.length > 2 ? ` (+${erros.length - 2})` : ''}` };
  }
  return { nome: NOME, ok: true, motivo: 'verificar-manifest.js saiu com 0 sobre o manifest dos documentos CURRENT' };
}

module.exports = { verificar, NOME };

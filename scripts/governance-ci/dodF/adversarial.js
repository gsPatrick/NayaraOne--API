'use strict';

const { verificarMapa, LeituraError: LeituraMapa, CODIGO_AUSENTE } = require('../adversarialMap');
const { LeituraError } = require('./erros');
const { daRaiz } = require('./config');

const NOME = 'testes do livro do bloco F';

/** §3.2b: os nove testes do livro, conferidos por NOME EXATO nos arquivos de teste (ausente, skip ou todo reprova com GOV_ADVERSARIAL_MISSING). */
async function verificar({ cfg }) {
  let r;
  try { r = verificarMapa({ mapa: daRaiz(cfg.adversarial.mapa) }); } catch (e) {
    if (e instanceof LeituraMapa) throw new LeituraError(e.message);
    throw e;
  }
  if (!r.ok) {
    const partes = [...r.problemas, ...r.ausentes.map((a) => `${CODIGO_AUSENTE} ${a.nome} (${a.motivo})`)];
    return { nome: NOME, ok: false, motivo: partes.slice(0, 3).join('; ') + (partes.length > 3 ? ` (+${partes.length - 3})` : '') };
  }
  const na = r.naoAplicaveis || [];
  if (na.length) return { nome: NOME, ok: true, situacao: 'NAO_APLICAVEL_NO_CI', motivo: `NAO_APLICAVEL_NO_CI: ${na.map((a) => a.nome).join('; ')} mora em ${na[0].raizes.join(', ')}, ausente neste CI (CI_SEM_REPOS_IRMAOS=1), NAO conferido aqui; os outros ${r.total - na.length} de ${r.total} presentes e ativos` };
  return { nome: NOME, ok: true, motivo: `${r.total} de ${r.total} testes nomeados presentes e ativos` };
}

module.exports = { verificar, NOME };

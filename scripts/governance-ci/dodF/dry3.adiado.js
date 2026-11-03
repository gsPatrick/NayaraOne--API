'use strict';

const fs = require('node:fs');
const { LeituraError } = require('./erros');
const { daRaiz } = require('./config');
const { rodarSuite } = require('./processo');

const ADIADO = 'ADIADO_MARCO_10';
const NAO_APLICAVEL = 'NAO_APLICAVEL_NO_CI';

/**
 * Decisão do Patrick de 02/11/2026 (DI-D940-6): o ensaio DRY3 com dados REAIS da cliente fica no Marco 10. Sem o relatório exportado, o item só sai ADIADO_MARCO_10 se (a) o registro
 * da decisão existir no arquivo de decisões (linha do id com a frase exata de cfg.dry3.adiamento.frase) e (b) o ensaio em banco descartável (suítes da D908) passar. Sem registro, ou com
 * o descartável vermelho, o item FALHA como antes. Arquivo de decisões ausente em CI que declarou CI_SEM_REPOS_IRMAOS=1 (Maturacao não existe lá) = NAO_APLICAVEL_NO_CI, visível e contado
 * à parte; ausente fora dessa declaração = FALHA. Devolve { situacao, ok, motivo } ou null quando o adiamento não está configurado.
 */
function avaliarAdiamento(cfgDry3, nome, { env = process.env } = {}) {
  const adi = cfgDry3.adiamento;
  if (!adi) return null;
  for (const campo of ['arquivo_decisoes', 'id', 'frase', 'suites']) if (!adi[campo] || (campo === 'suites' && !adi.suites.length)) throw new LeituraError(`dod-bloco-f.json: dry3.adiamento sem "${campo}"`);
  const ensaio = rodarSuite(adi.suites.map(daRaiz), { env });
  if (!ensaio.ok) return { nome, ok: false, motivo: `relatório do ensaio real ausente e o ensaio descartável não passou (${ensaio.motivo})` };
  // Teste do ensaio que não executou (NAO_APLICAVEL_NO_CI) não prova o ensaio: nunca ADIADO nem "verde" com o descartável incompleto.
  if (ensaio.naoAplicavel > 0) return { nome, ok: false, motivo: `relatório do ensaio real ausente e o ensaio descartável ficou incompleto (${ensaio.naoAplicavel} teste(s) NAO_APLICAVEL_NO_CI não executaram: ${ensaio.motivo})` };
  const arquivo = daRaiz(adi.arquivo_decisoes);
  let texto = null;
  try { texto = fs.readFileSync(arquivo, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw new LeituraError(`não foi possível ler ${adi.arquivo_decisoes}: ${e.code || e.message}`); }
  if (texto === null) {
    if (env.CI_SEM_REPOS_IRMAOS === '1') return { nome, ok: true, situacao: NAO_APLICAVEL, motivo: `${NAO_APLICAVEL}: o registro da decisão (${adi.id}) mora em ${adi.arquivo_decisoes}, ausente neste CI (CI_SEM_REPOS_IRMAOS=1); ensaio descartável OK (${ensaio.motivo}); NAO foi conferido o registro nem o relatório real, cobertos na suíte local` };
    return { nome, ok: false, motivo: `relatório do ensaio real ausente e o registro da decisão não foi encontrado (${adi.arquivo_decisoes} ausente)` };
  }
  const registrado = texto.split('\n').some((l) => l.startsWith(`- ${adi.id} |`) && l.includes(adi.frase));
  if (!registrado) return { nome, ok: false, motivo: `relatório do ensaio real ausente e sem registro da decisão do Patrick (${adi.id}, "${adi.frase}") em ${adi.arquivo_decisoes}` };
  return { nome, ok: true, situacao: ADIADO, motivo: `${ADIADO}: ensaio com dados reais da cliente fica no Marco 10 (decisão do Patrick de 02/11/2026, ${adi.id}); NAO foi conferido relatório real; ensaio descartável OK (${ensaio.motivo})` };
}

module.exports = { avaliarAdiamento, ADIADO, NAO_APLICAVEL };

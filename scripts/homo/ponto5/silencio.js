'use strict';
/**
 * Trava do horário de silêncio do Marketing no reteste do ponto 5 (DI-M9R-4, corrigida em DI-M9R-5). No silêncio a rotina de
 * campanhas ADIA o e-mail: a campanha do bloqueio ficaria agendada (e enviaria sozinha no fim do silêncio) e as conferências
 * falhariam de forma enganosa. Por isso o roteiro recusa rodar no silêncio, antes de gravar qualquer coisa.
 *
 * O valor conferido é o EFETIVO, o mesmo que a rotina usa (getMarketingParam): o gravado na empresa e, sem linha gravada,
 * o padrão do catálogo. A API não tem rota de valor efetivo: GET /settings/marketing.quiet_hours responde 404
 * SETTING_NOT_FOUND quando o parâmetro está no padrão. O padrão vem do catálogo de parâmetros do próprio código
 * (cadence.defaults.js, o mesmo de Maturacao/demandas/parametros.csv) e o valor é lido pelo mesmo parser da API. Valor gravado
 * que a API não entende também cai no padrão, como na rotina. Qualquer outra resposta para o roteiro: sem saber se é silêncio,
 * ele não cria nada (falha fechada). Só módulos puros do código: nada de banco nem SQL.
 */
const { CADENCE_DEFAULTS, QUIET_HOURS_KEY } = require('../../../src/features/marketing/automations/cadence/cadence.defaults');
const { parseQuietHours } = require('../../../src/features/marketing/automations/cadence/cadence.parse');
const { PararScript } = require('../lib/cliente');

const FOLGA_MIN = 6;
const PADRAO = CADENCE_DEFAULTS[QUIET_HOURS_KEY];

function minutoDoDia(instante, fuso) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: fuso, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instante);
  return Number(p.find((x) => x.type === 'hour').value) * 60 + Number(p.find((x) => x.type === 'minute').value);
}

/** "21:00 a 08:00 America/Sao_Paulo" -> está no silêncio agora (ou começa nos próximos `folgaMin` minutos)? Valor que a API não aceita: `valido: false`. */
function noSilencio(valor, agora = new Date(), folgaMin = FOLGA_MIN) {
  const cfg = parseQuietHours(valor);
  if (!cfg) return { silencio: false, valido: false, texto: valor };
  const { startMinutes: ini, endMinutes: fim, timeZone: fuso } = cfg;
  const dentro = (x) => (ini < fim ? x >= ini && x < fim : x >= ini || x < fim);
  const silencio = dentro(minutoDoDia(agora, fuso)) || dentro(minutoDoDia(new Date(agora.getTime() + folgaMin * 60000), fuso));
  return { silencio, valido: true, texto: String(valor).trim() };
}

/** Valor efetivo de `marketing.quiet_hours` para a empresa da sessão: { valor, origem }. */
async function lerSilencioEfetivo(sessao) {
  const rota = `/settings/${QUIET_HOURS_KEY}`;
  const r = await sessao.chamar('GET', rota);
  if (r.status === 200 && r.dados && typeof r.dados.value === 'string') {
    return parseQuietHours(r.dados.value)
      ? { valor: r.dados.value, origem: 'valor gravado na empresa' }
      : { valor: PADRAO, origem: `padrão do catálogo (o valor gravado "${r.dados.value}" não é aceito pela API, que usa o padrão)` };
  }
  if (r.status === 404 && r.erro && r.erro.code === 'SETTING_NOT_FOUND') return { valor: PADRAO, origem: 'padrão do catálogo (sem valor gravado na empresa)' };
  throw new PararScript(`Não consegui ler o horário de silêncio do Marketing (GET ${rota}: HTTP ${r.status}${r.erro ? ` ${r.erro.code}` : ''}). Sem saber se agora é silêncio, o roteiro não cria nada.`);
}

const agoraDe = (ctx) => (ctx && typeof ctx.agora === 'function' ? ctx.agora() : new Date());

/** Para com código 2 (PararScript) se agora, ou nos próximos minutos, é horário de silêncio. Devolve o valor conferido. */
async function exigirForaDoSilencio(ctx) {
  const { valor, origem } = await lerSilencioEfetivo(ctx.admin);
  const s = noSilencio(valor, agoraDe(ctx));
  if (s.silencio) {
    throw new PararScript(`RECUSADO: agora é horário de silêncio do Marketing (${s.texto}, ${origem}). Nesse horário o e-mail da campanha é adiado, não enviado, e as conferências não valeriam. Nada foi criado. Rode o roteiro fora desse horário (a folga é de ${FOLGA_MIN} minutos antes do início).`);
  }
  return { valor: s.texto, origem };
}

module.exports = { noSilencio, lerSilencioEfetivo, exigirForaDoSilencio, PADRAO, FOLGA_MIN };

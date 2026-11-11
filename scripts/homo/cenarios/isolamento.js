'use strict';
/** Cenário (c): isolamento por perfil (somente leitura) e por empresa (outra empresa não enxerga nem altera). */
const { NOME_OK, NOME_OUT } = require('./optOutCampanha');

const CENARIO = '(c) isolamento';
const segue = (...codigos) => (r) => codigos.includes(r.status);
const vazio = (r) => (r.status === 200 && (Array.isArray(r.dados) ? r.dados.length === 0 : !r.dados || ((r.dados.items || []).length === 0))) || [403, 404].includes(r.status);
const resumo = (r) => `HTTP ${r.status}${r.erro ? ` ${r.erro.code}` : ''}`;

async function leitura(ctx) {
  if (!ctx.leitura) { ctx.rel.conferir(CENARIO, 'perfil somente leitura: escritas recusadas (403)', null, 'HOMO_LEITURA_EMAIL/HOMO_LEITURA_PASSWORD não informados. Crie um usuário com papel só de leitura em Usuários & Acessos e Papéis & Permissões (exigem MFA recente, que este script não contorna) e rode de novo.'); return; }
  const { pessoaOk, campanhaId, fluxoId } = ctx.ids;
  const antes = await ctx.admin.chamar('GET', `/people/${pessoaOk}/consents`);
  const tentativas = [
    ['registrar consentimento', 'POST', `/people/${pessoaOk}/consents`, { channel: 'PHONE', purpose: 'ACEITE_M9_ISOLAMENTO', status: 'OPT_IN' }],
    ['criar pessoa', 'POST', '/people', { personType: 'PF', legalName: 'ACEITE-M9 Nao Deve Existir Leitura' }],
    ['criar campanha', 'POST', '/marketing/campaigns', { name: 'ACEITE-M9 Nao Deve Existir', objective: 'ACEITE-M9 tentativa do perfil de leitura' }],
    ['criar modelo de mensagem', 'POST', '/marketing/templates', { code: 'aceite-m9-nao-deve-existir', kind: 'MESSAGE', channel: 'EMAIL', body: 'ACEITE-M9 x' }],
    ['alterar parâmetro de marketing', 'PUT', '/settings/marketing.email.url_descadastro', { value: 'nenhum' }],
  ];
  if (fluxoId) tentativas.push(['pausar automação', 'POST', `/marketing/automations/${fluxoId}/pause`, { reason: 'ACEITE-M9 tentativa do perfil de leitura' }]);
  for (const [nome, metodo, rota, corpo] of tentativas) {
    const r = await ctx.leitura.chamar(metodo, rota, corpo);
    ctx.rel.conferir(CENARIO, `perfil somente leitura NÃO consegue ${nome}`, r.status === 403, `${metodo} ${rota.replace(/[0-9a-f-]{36}/g, ':id')} -> ${resumo(r)}${r.erro ? ` "${r.erro.message}"` : ''}`);
  }
  const depois = await ctx.admin.chamar('GET', `/people/${pessoaOk}/consents`);
  ctx.rel.conferir(CENARIO, 'nada foi gravado pelas tentativas do perfil de leitura', (antes.dados || []).length === (depois.dados || []).length, `consentimentos antes=${(antes.dados || []).length}, depois=${(depois.dados || []).length}`);
  const ler = await ctx.leitura.chamar('GET', `/people/${pessoaOk}`);
  ctx.rel.aviso(`Perfil de leitura consultando a pessoa fictícia: ${resumo(ler)} (leitura é permitida ou não conforme o papel; só a ESCRITA é exigida como recusada).`);
  const c = await ctx.leitura.chamar('GET', `/marketing/campaigns/${campanhaId}`);
  ctx.rel.conferir(CENARIO, 'perfil somente leitura não gerencia campanhas (consultar a campanha também é recusado)', c.status === 403, `GET /marketing/campaigns/:id -> ${resumo(c)}`);
}

async function outraEmpresa(ctx) {
  if (!ctx.outra) { ctx.rel.conferir(CENARIO, 'usuário de outra empresa não enxerga a empresa A', null, 'HOMO_OUTRA_EMPRESA_EMAIL/HOMO_OUTRA_EMPRESA_PASSWORD não informados. Criar uma segunda empresa e usuário não é possível por este script (exige MFA recente e papéis); informe um usuário que já exista.'); return; }
  const { pessoaOk, pessoaOptOut, campanhaId, fluxoId, modeloId } = ctx.ids;
  const alvo = (rota) => rota.replace(/[0-9a-f-]{36}/g, ':id');
  // Edição com o MESMO nome de uso que a pessoa já tem: se o isolamento falhar (código antigo), o registro fictício não muda.
  const atual = await ctx.admin.chamar('GET', `/people/${pessoaOk}`);
  const nomeDeUso = atual.dados && atual.dados.preferredName !== undefined ? atual.dados.preferredName : null;
  const casos = [
    ['ler a pessoa da empresa A', 'GET', `/people/${pessoaOk}`, undefined, segue(404, 403)],
    ['ler os consentimentos da pessoa da empresa A', 'GET', `/people/${pessoaOptOut}/consents`, undefined, segue(404, 403)],
    ['ler os contatos da pessoa da empresa A', 'GET', `/people/${pessoaOk}/contacts`, undefined, segue(404, 403)],
    ['editar a pessoa da empresa A', 'PATCH', `/people/${pessoaOk}`, { preferredName: nomeDeUso }, segue(404, 403)],
    ['ler a campanha da empresa A', 'GET', `/marketing/campaigns/${campanhaId}`, undefined, segue(404, 403)],
    ['registrar consentimento para pessoa da empresa A', 'POST', `/people/${pessoaOk}/consents`, { channel: 'PHONE', purpose: 'ACEITE_M9_ISOLAMENTO', status: 'OPT_IN' }, segue(404, 403)],
    ['pausar a automação da empresa A', 'POST', `/marketing/automations/${fluxoId}/pause`, { reason: 'ACEITE-M9 tentativa de outra empresa' }, segue(404, 403)],
    ['ler mensagens da pessoa da empresa A', 'GET', `/messages?personId=${pessoaOk}`, undefined, vazio],
    ['ler a auditoria dos registros da empresa A', 'GET', `/audit-log?entityId=${campanhaId}`, undefined, vazio],
  ];
  if (!fluxoId) casos.splice(casos.findIndex((c) => c[0] === 'pausar a automação da empresa A'), 1);
  for (const [nome, metodo, rota, corpo, ok] of casos) {
    const r = await ctx.outra.chamar(metodo, rota, corpo);
    ctx.rel.conferir(CENARIO, `outra empresa NÃO consegue ${nome}`, ok(r), `${metodo} ${alvo(rota)} -> ${resumo(r)}${r.erro ? ` "${r.erro.message}"` : ''}${Array.isArray(r.dados) ? ` (${r.dados.length} itens)` : ''}`);
  }
  // Vazamento conferido pelo ID dos registros da empresa A e pela EMPRESA de cada item (não só pelo prefixo do nome).
  // (ctx.ids.pessoaOutraEmpresa é o contato fictício da PRÓPRIA outra empresa: não entra no conjunto da empresa A)
  const idsA = new Set(Object.entries(ctx.ids).filter(([k, v]) => k !== 'pessoaOutraEmpresa' && typeof v === 'string').map(([, v]) => v));
  const nomesA = new Set([NOME_OK, NOME_OUT, ...Object.values((ctx.p5 && ctx.p5.contatos) || {}).map((c) => c.nome)]);
  const lista = await ctx.outra.chamar('GET', '/people');
  const itens = Array.isArray(lista.dados) ? lista.dados : [];
  const vazou = itens.filter((p) => idsA.has(p.id) || (p.companyId && p.companyId !== ctx.outra.companyId) || nomesA.has(p.legalName));
  const semEmpresa = itens.filter((p) => !p.companyId).length;
  ctx.rel.conferir(CENARIO, 'a lista de contatos da outra empresa não traz nada da empresa A (conferido por id, por empresa e por nome)', lista.status === 200 && vazou.length === 0 && semEmpresa === 0,
    `GET /people -> ${resumo(lista)}, ${itens.length} contatos, ${vazou.length} da empresa A ou de outra empresa, ${semEmpresa} sem empresa informada`);
  const mod = await ctx.outra.chamar('GET', '/marketing/templates');
  const itensMod = (mod.dados && mod.dados.items) || [];
  const vazouMod = itensMod.filter((i) => /^aceite-m9/i.test(i.code) || idsA.has(i.id) || (i.versions || []).some((v) => idsA.has(v.id)) || (i.companyId && i.companyId !== ctx.outra.companyId));
  ctx.rel.conferir(CENARIO, 'a lista de modelos da outra empresa não traz o modelo da empresa A (por id, por empresa e por código)', vazouMod.length === 0 && (mod.status === 200 || [403].includes(mod.status)), `GET /marketing/templates -> ${resumo(mod)}, ${itensMod.length} modelos, ${vazouMod.length} da empresa A`);
  const depois = await ctx.admin.chamar('GET', `/people/${pessoaOk}/consents`);
  const intrusos = (depois.dados || []).filter((c) => c.purpose === 'ACEITE_M9_ISOLAMENTO');
  ctx.rel.conferir(CENARIO, 'nada foi gravado na empresa A pelas tentativas da outra empresa e do perfil de leitura', intrusos.length === 0, `consentimentos de isolamento encontrados na empresa A: ${intrusos.length}`);
  void modeloId;
}

async function executar(ctx) {
  console.log(`\n--- ${CENARIO} ---`);
  await leitura(ctx);
  await outraEmpresa(ctx);
}

module.exports = { executar, CENARIO };

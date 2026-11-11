#!/usr/bin/env node
'use strict';
/**
 * Reteste do PONTO 5 do aceite do Marco 9 (opt-out, automações, isolamento e auditoria), para rodar DEPOIS do deploy.
 * Prepara pela API pública (nunca SQL) os registros fictícios ACEITE-M9 P5 e confere, item a item:
 *  (1) opt-out na ficha: três contatos (opt-in, opt-out, sem consentimento) e a etiqueta que a ficha mostra;
 *  (2) bloqueio do envio: campanha de e-mail para os três; opt-out e sem consentimento ficam BLOCKED, sem envio; opt-in recebe;
 *  (3) automações: demonstração (criar, publicar, executar, pausar) e os cinco tipos de ação incompletos recusados com
 *      422 MKT_AUTOMATION_INCOMPLETE ao criar e ao publicar;
 *  (4) isolamento: perfil somente leitura e outra empresa (pessoa, consentimentos, contatos, endereços, documentos, papéis,
 *      arquivo, campanha, automação, mensagens, auditoria e listas conferidas por id e por empresa);
 *  (5) trilha dos três eventos de auditoria (people.person.create, people.consent.record, marketing.automation_run.completed).
 * No fim imprime os IDENTIFICADORES (pessoas, automações, campanha, perfis) que a cliente pediu.
 *
 * Os TRÊS perfis são obrigatórios (sem um deles o roteiro para: nada fica "não verificado"):
 *   HOMO_ADMIN_EMAIL/_PASSWORD (administrador da empresa A), HOMO_LEITURA_EMAIL/_PASSWORD (somente leitura da empresa A),
 *   HOMO_OUTRA_EMPRESA_EMAIL/_PASSWORD (usuário de outra empresa) e HOMO_OUTRA_EMPRESA_COMPANY_ID (empresa em que ele entra).
 *   Opcionais: HOMO_<PERFIL>_COMPANY_ID, HOMO_<PERFIL>_MFA_SECRET (segredo TOTP do usuário de TESTE; o código é gerado só quando a
 *   API pede MFA recente), HOMO_API_BASE, HOMO_SAIDA_JSON (conferências e ids, sem senha/token/segredo), HOMO_SUFIXO_CAMPANHA.
 * Senhas e segredos: em HOMO_SEGREDOS_ARQUIVO (arquivo fora do repositório, chmod 600) ou exportados antes; nunca em argumento.
 * Saída: 0 = tudo conferido; 1 = alguma conferência falhou; 2 = parada de segurança ou configuração.
 */
const fs = require('fs');
const { Sessao, PararScript, lerBase } = require('./lib/cliente');
const { Relato } = require('./lib/relato');
const { carregarSegredos, recusarSegredoNaLinhaDeComando } = require('./lib/segredosArquivo');
const contatos = require('./ponto5/contatos');
const bloqueio = require('./ponto5/bloqueio');
const automacoes = require('./ponto5/automacoes');
const isolamentoFilhos = require('./ponto5/isolamentoFilhos');
const trilha = require('./ponto5/trilha');
const isolamentoGeral = require('./cenarios/isolamento');

async function abrirSessao(base, rotulo, prefixo, env) {
  const email = env[`${prefixo}_EMAIL`]; const senha = env[`${prefixo}_PASSWORD`];
  if (!email || !senha) throw new PararScript(`Informe ${prefixo}_EMAIL e ${prefixo}_PASSWORD (perfil ${rotulo}); sem ele o ponto 5 não é conferido por inteiro.`);
  return new Sessao(base, rotulo, email, senha, { codigoMfa: env[`${prefixo}_MFA_CODE`], segredoMfa: env[`${prefixo}_MFA_SECRET`], companyId: env[`${prefixo}_COMPANY_ID`] }).entrar();
}

const perfil = (s) => ({ email: s.email, userId: s.userId, groupId: s.groupId, companyId: s.companyId });

function imprimirIdentificadores(ctx) {
  const p = ctx.p5.contatos || {};
  console.log('\n===== IDENTIFICADORES DO PONTO 5 (para a cliente) =====');
  for (const [rotulo, s] of [['Perfil administrador (empresa A)', ctx.admin], ['Perfil somente leitura (empresa A)', ctx.leitura], ['Perfil de outra empresa', ctx.outra]]) {
    console.log(`- ${rotulo}: ${s.email} | usuário ${s.userId} | empresa ${s.companyId} | grupo ${s.groupId}`);
  }
  for (const c of Object.values(p)) console.log(`- Pessoa: ${c.nome} (${c.email}) | ${c.consentimento || 'sem consentimento'} | id ${c.id} | ficha /painel/pessoas/${c.id}`);
  const i = ctx.ids;
  console.log(`- Pessoa: ${automacoes.NOME_GATILHO} | id ${i.pessoaGatilho || '-'}`);
  console.log(`- Automação de demonstração: ${automacoes.COD} | id ${i.fluxoId || '-'} | execução concluída ${i.execucaoAutomacao || '-'} | tarefa ${i.tarefaId || '-'}`);
  console.log(`- Automações incompletas (recusadas, não existem): ${automacoes.INCOMPLETAS.map((x) => `ACEITE-M9-P5-INCOMPLETA-${x.tipo}`).join(', ')}`);
  console.log(`- Campanha: ${bloqueio.COD_CAMPANHA} | id ${i.campanhaId || '-'} | modelo ${i.modeloId || '-'}`);
  console.log(`- Pessoa: ACEITE-M9 P5 Pessoa com Documento (empresa A) | id ${i.pessoaDocumento || '-'} | documento ${i.documentoId || '-'} | arquivo ${i.arquivoId || '-'}`);
  console.log(`- Pessoa: ACEITE-M9 P5 Contato da Outra Empresa (empresa do perfil de outra empresa) | id ${i.pessoaOutraEmpresa || '-'}`);
}

function gravarSaida(caminho, base, ctx, rel, inicio) {
  if (!caminho) return;
  const dados = {
    roteiro: 'retestePonto5Marco9', base, inicio, fim: new Date().toISOString(),
    perfis: { admin: ctx.admin && perfil(ctx.admin), leitura: ctx.leitura && perfil(ctx.leitura), outra: ctx.outra && perfil(ctx.outra) },
    contatos: ctx.p5.contatos ? Object.fromEntries(Object.entries(ctx.p5.contatos).map(([k, c]) => [k, { id: c.id, nome: c.nome, email: c.email, consentimento: c.consentimento }])) : null,
    ids: ctx.ids, ...rel.paraJson(),
  };
  fs.writeFileSync(caminho, `${JSON.stringify(dados, null, 2)}\n`);
  console.log(`\nConferências gravadas em ${caminho}`);
}

async function principal() {
  recusarSegredoNaLinhaDeComando();
  const env = carregarSegredos(process.env);
  const base = lerBase(env);
  const inicio = new Date().toISOString();
  if (!env.HOMO_OUTRA_EMPRESA_COMPANY_ID) throw new PararScript('Informe HOMO_OUTRA_EMPRESA_COMPANY_ID (empresa em que o usuário de outra empresa entra).');
  const rel = new Relato();
  console.log(`Reteste do ponto 5 do Marco 9 em ${base} (${inicio})`);
  const ctx = { rel, ids: {}, p5: {} };
  ctx.admin = await abrirSessao(base, 'administrador', 'HOMO_ADMIN', env);
  ctx.leitura = await abrirSessao(base, 'somente leitura', 'HOMO_LEITURA', env);
  ctx.outra = await abrirSessao(base, 'outra empresa', 'HOMO_OUTRA_EMPRESA', env);
  if (ctx.outra.companyId === ctx.admin.companyId) throw new PararScript('O usuário "outra empresa" entrou na MESMA empresa do administrador; o isolamento não valeria.');
  if (ctx.leitura.companyId !== ctx.admin.companyId) throw new PararScript('O perfil somente leitura precisa estar na empresa do administrador (empresa A).');
  rel.aviso(`Outra empresa: ${ctx.outra.companyId} (${ctx.outra.groupId === ctx.admin.groupId ? 'MESMO grupo da empresa A' : 'grupo diferente da empresa A'}).`);
  try {
    // a automação vem primeiro e é pausada logo depois: os contatos criados em seguida não a disparam
    await automacoes.executar(ctx);
    await contatos.preparar(ctx);
    await contatos.conferir(ctx);
    await bloqueio.executar(ctx);
    console.log(`\n--- ${isolamentoFilhos.CENARIO}: perfil somente leitura e outra empresa ---`);
    await isolamentoGeral.executar({ ...ctx, rel: { ...rel, conferir: (_c, ...a) => rel.conferir(isolamentoFilhos.CENARIO, ...a), aviso: (t) => rel.aviso(t) } });
    await isolamentoFilhos.executar(ctx);
    await trilha.executar(ctx);
  } finally {
    rel.imprimirQuadro();
    imprimirIdentificadores(ctx);
    gravarSaida(env.HOMO_SAIDA_JSON, base, ctx, rel, inicio);
  }
  return rel.falhas === 0 && rel.paraJson().resumo.naoVerificadas === 0 ? 0 : 1;
}

principal().then((codigo) => { process.exitCode = codigo; }).catch((erro) => {
  if (erro instanceof PararScript) { console.error(`\nPARADO: ${erro.message}`); process.exitCode = erro.codigoSaida; return; }
  console.error(`\nERRO: ${erro && erro.message ? erro.message : erro}`);
  process.exitCode = 1;
});

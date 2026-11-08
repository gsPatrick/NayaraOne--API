#!/usr/bin/env node
'use strict';
/**
 * Semeia, pela API pública (nunca SQL), os registros fictícios e confere os perfis do aceite do Marco 9.
 * Idempotente: tudo leva o prefixo "ACEITE-M9"; rodar de novo encontra o que já existe e não duplica.
 *
 * Variáveis de ambiente:
 *   HOMO_API_BASE                 padrão http://127.0.0.1:4001/api/v1 (recusa endereço com "producao" ou "prod.")
 *   HOMO_ADMIN_EMAIL / HOMO_ADMIN_PASSWORD      administrador da empresa A (obrigatórios)
 *   HOMO_ADMIN_MFA_CODE           só se a API pedir MFA recente; o script nunca contorna MFA
 *   HOMO_LEITURA_EMAIL / HOMO_LEITURA_PASSWORD  perfil somente leitura da empresa A (opcional)
 *   HOMO_OUTRA_EMPRESA_EMAIL / HOMO_OUTRA_EMPRESA_PASSWORD   usuário de outra empresa (opcional)
 * Saída: 0 = tudo conferido; 1 = alguma conferência falhou; 2 = parada de segurança ou configuração.
 */
const { Sessao, PararScript, lerBase } = require('./homo/lib/cliente');
const { Relato } = require('./homo/lib/relato');
const optOut = require('./homo/cenarios/optOutCampanha');
const automacao = require('./homo/cenarios/automacao');
const isolamento = require('./homo/cenarios/isolamento');
const trilha = require('./homo/cenarios/trilha');

async function abrirSessao(base, rotulo, email, senha, codigoMfa) {
  if (!email || !senha) return null;
  return new Sessao(base, rotulo, email, senha, codigoMfa).entrar();
}

async function principal() {
  const env = process.env;
  const base = lerBase(env);
  if (!env.HOMO_ADMIN_EMAIL || !env.HOMO_ADMIN_PASSWORD) throw new PararScript('Informe HOMO_ADMIN_EMAIL e HOMO_ADMIN_PASSWORD (administrador da empresa A).');
  const rel = new Relato();
  console.log(`Aceite do Marco 9: semeando e conferindo em ${base}`);
  const ctx = {
    rel, ids: {},
    admin: await abrirSessao(base, 'administrador', env.HOMO_ADMIN_EMAIL, env.HOMO_ADMIN_PASSWORD, env.HOMO_ADMIN_MFA_CODE),
    leitura: await abrirSessao(base, 'somente leitura', env.HOMO_LEITURA_EMAIL, env.HOMO_LEITURA_PASSWORD),
    outra: await abrirSessao(base, 'outra empresa', env.HOMO_OUTRA_EMPRESA_EMAIL, env.HOMO_OUTRA_EMPRESA_PASSWORD),
  };
  if (ctx.outra && ctx.outra.companyId && ctx.admin.companyId && ctx.outra.companyId === ctx.admin.companyId) {
    throw new PararScript('O usuário "outra empresa" pertence à MESMA empresa do administrador; o teste de isolamento não valeria. Informe um usuário de outra empresa.');
  }
  if (!ctx.leitura) rel.aviso('Sem perfil somente leitura (HOMO_LEITURA_*): o cenário (c) não confere as escritas recusadas.');
  if (!ctx.outra) rel.aviso('Sem usuário de outra empresa (HOMO_OUTRA_EMPRESA_*): o cenário (c) não confere o isolamento entre empresas.');

  // A automação vem primeiro: ela fica ativa só o tempo da demonstração e, se os contatos do cenário (a) já existissem, o gatilho (contato novo) agiria sobre eles também.
  await automacao.executar(ctx);
  await optOut.preparar(ctx);
  await optOut.conferir(ctx);
  await isolamento.executar(ctx);
  await trilha.executar(ctx);
  rel.imprimirQuadro();
  return rel.falhas === 0 ? 0 : 1;
}

principal().then((codigo) => { process.exitCode = codigo; }).catch((erro) => {
  if (erro instanceof PararScript) { console.error(`\nPARADO: ${erro.message}`); process.exitCode = erro.codigoSaida; return; }
  console.error(`\nERRO: ${erro && erro.message ? erro.message : erro}`);
  process.exitCode = 1;
});

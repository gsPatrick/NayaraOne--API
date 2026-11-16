#!/usr/bin/env node
'use strict';
/**
 * Reteste do Marco 3 na homologação publicada (pedido da cliente de 16/11/2026): trocar o arquivo de um documento JÁ VALIDADO
 * preserva o original, cria uma versão pendente e submete o arquivo novo ao antivírus, à leitura e à revisão próprias.
 * Tudo pela API pública, com o administrador de teste, em uma pessoa fictícia "ACEITE-M3 ..." (nada real é tocado).
 *
 * Passos: pessoa fictícia com CPF fictício -> arquivo PDF v1 -> documento RG -> validação (VERIFIED, conferência humana dos campos
 * críticos) -> arquivo PDF v2 -> troca (PATCH fileId) -> confere original intacto, versão nova pendente com antivírus/leitura próprios,
 * auditoria people.document.replace_file -> recusas: troca já "verificada" (422) e arquivo EICAR (antivírus) -> validação da versão nova
 * pela revisão própria.
 *
 * Uso: HOMO_SEGREDOS_ARQUIVO=... HOMO_ADMIN_EMAIL=... HOMO_ADMIN_COMPANY_ID=... [HOMO_SAIDA_JSON=...] node scripts/homo/m3/trocaArquivoDocumento.js
 * Nenhuma senha, token ou segredo é impresso.
 */
const fs = require('fs');
const { Sessao, PararScript, lerBase } = require('../lib/cliente');
const { carregarSegredos, recusarSegredoNaLinhaDeComando } = require('../lib/segredosArquivo');
const auditoria = require('../lib/auditoria');

const NOME = 'ACEITE-M3 Pessoa da Troca de Arquivo';
const resumo = (r) => `HTTP ${r.status}${r.erro ? ` ${r.erro.code}` : ''}`;
const lista = (r) => (Array.isArray(r.dados) ? r.dados : (r.dados && r.dados.items) || []);
const pdf = (texto) => Buffer.from(`%PDF-1.4\n% ${texto}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`).toString('base64');
const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*').toString('base64');

function cpfFicticio() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const dv = (arr) => { const f = arr.length + 1; const r = (arr.reduce((acc, d, i) => acc + d * (f - i), 0) * 10) % 11; return r === 10 ? 0 : r; };
  n.push(dv(n)); n.push(dv(n));
  return n.join('');
}

async function main() {
  recusarSegredoNaLinhaDeComando(process.argv);
  const env = carregarSegredos(process.env);
  const base = lerBase(env);
  const admin = await new Sessao(base, 'administrador', env.HOMO_ADMIN_EMAIL, env.HOMO_ADMIN_PASSWORD, {
    segredoMfa: env.HOMO_ADMIN_MFA_SECRET, codigoMfa: env.HOMO_ADMIN_MFA_CODE, companyId: env.HOMO_ADMIN_COMPANY_ID,
  }).entrar();
  const out = { quando: new Date().toISOString(), base, empresa: admin.companyId, passos: [], conferencias: [], ids: {} };
  const passo = (nome, r, extra = {}) => { out.passos.push({ nome, http: r.status, erro: r.erro ? r.erro.code : null, ...extra }); console.log(`- ${nome}: ${resumo(r)}`); return r; };
  const conferir = (descricao, ok, evidencia) => { out.conferencias.push({ descricao, ok: Boolean(ok), evidencia }); console.log(`  [${ok ? 'OK    ' : 'FALHOU'}] ${descricao} -> ${evidencia}`); };

  let pessoa = lista(await admin.chamar('GET', '/people')).find((p) => p.legalName === NOME);
  if (!pessoa) {
    const r = passo('criar pessoa fictícia', await admin.chamar('POST', '/people', { personType: 'PF', legalName: NOME, taxIdNormalized: cpfFicticio() }));
    if (r.status !== 201) throw new PararScript(`Pessoa não criada: ${resumo(r)}`);
    pessoa = r.dados;
  }
  const lida = await admin.chamar('GET', `/people/${pessoa.id}`);
  const cpf = String((lida.dados || {}).taxIdNormalized || '');
  out.ids.pessoa = pessoa.id;

  const v1 = passo('enviar arquivo v1 (PDF)', await admin.chamar('POST', '/files', { fileName: 'aceite-m3-rg-v1.pdf', mimeType: 'application/pdf', contentBase64: pdf(`ACEITE-M3 RG v1 ${NOME} CPF ${cpf}`), category: 'people' }));
  if (v1.status !== 201) throw new PararScript(`Arquivo v1 recusado: ${resumo(v1)}`);
  out.ids.arquivoV1 = v1.dados.id;
  const doc = passo('criar documento RG com o arquivo v1', await admin.chamar('POST', `/people/${pessoa.id}/documents`, { documentType: 'RG', fileId: v1.dados.id }));
  if (doc.status !== 201) throw new PararScript(`Documento não criado: ${resumo(doc)}`);
  out.ids.documentoOriginal = doc.dados.id;
  const validar = passo('validar o documento original (VERIFIED, campos críticos conferidos por pessoa)', await admin.chamar('PATCH', `/people/${pessoa.id}/documents/${doc.dados.id}`, { verificationStatus: 'VERIFIED', manualFields: { name: NOME, taxId: cpf } }));
  conferir('documento original validado antes da troca', validar.status === 200 && validar.dados.verificationStatus === 'VERIFIED', `${resumo(validar)}, status ${validar.dados && validar.dados.verificationStatus}, versão ${validar.dados && validar.dados.versionNo}`);
  if (validar.status !== 200) throw new PararScript(`Validação recusada: ${resumo(validar)} ${validar.erro ? validar.erro.message : ''}`);
  const original = validar.dados;

  const v2 = passo('enviar arquivo v2 (PDF novo)', await admin.chamar('POST', '/files', { fileName: 'aceite-m3-rg-v2.pdf', mimeType: 'application/pdf', contentBase64: pdf(`ACEITE-M3 RG v2 (arquivo trocado) ${NOME} CPF ${cpf}`), category: 'people' }));
  if (v2.status !== 201) throw new PararScript(`Arquivo v2 recusado: ${resumo(v2)}`);
  out.ids.arquivoV2 = v2.dados.id;

  const comStatus = passo('recusa: trocar o arquivo já marcando a nova versão como verificada', await admin.chamar('PATCH', `/people/${pessoa.id}/documents/${original.id}`, { fileId: v2.dados.id, verificationStatus: 'VERIFIED' }));
  conferir('troca não pode nascer verificada (422)', comStatus.status === 422 && comStatus.erro && comStatus.erro.code === 'PERSON_DOCUMENT_REPLACE_FILE_WITH_STATUS', resumo(comStatus));

  const troca = passo('trocar o arquivo (PATCH fileId = v2)', await admin.chamar('PATCH', `/people/${pessoa.id}/documents/${original.id}`, { fileId: v2.dados.id }));
  if (![200, 201].includes(troca.status)) throw new PararScript(`Troca recusada: ${resumo(troca)} ${troca.erro ? troca.erro.message : ''}`);
  const nova = troca.dados;
  out.ids.documentoNovaVersao = nova.id;
  const leitura = nova.extractedDataJson || {};
  conferir('a troca cria OUTRO registro (nova versão), não altera o original', nova.id !== original.id, `original ${original.id}, nova ${nova.id}`);
  conferir('nova versão = versão do original + 1', nova.versionNo === original.versionNo + 1, `original v${original.versionNo}, nova v${nova.versionNo}`);
  conferir('nova versão nasce PENDENTE', nova.verificationStatus === 'PENDING', `status ${nova.verificationStatus}`);
  conferir('nova versão aponta para o arquivo novo', nova.fileId === v2.dados.id, `fileId ${nova.fileId}`);
  conferir('antivírus próprio do arquivo novo registrado na nova versão', leitura.antivirus && leitura.antivirus.clean === true, `antivirus ${JSON.stringify(leitura.antivirus || null)}`);
  conferir('leitura própria do arquivo novo (não herda a leitura do original)', JSON.stringify(leitura.fields || null) !== JSON.stringify((original.extractedDataJson || {}).fields || null) || !leitura.manualFields,
    `chaves da leitura nova: ${Object.keys(leitura).join(', ')}; campos confirmados à mão do original NÃO copiados: ${!leitura.manualFields}`);

  const origDepois = await admin.chamar('GET', `/people/${pessoa.id}/documents/${original.id}`);
  const od = origDepois.status === 200 ? origDepois.dados : lista(await admin.chamar('GET', `/people/${pessoa.id}/documents`)).find((d) => d.id === original.id);
  conferir('original preservado: mesmo arquivo, continua VERIFIED', od && od.fileId === v1.dados.id && od.verificationStatus === 'VERIFIED', `original depois da troca: arquivo ${od && od.fileId}, status ${od && od.verificationStatus}, versão ${od && od.versionNo}`);
  const docs = lista(await admin.chamar('GET', `/people/${pessoa.id}/documents`)).filter((d) => [original.id, nova.id].includes(d.id));
  conferir('as duas versões aparecem na ficha da pessoa', docs.length === 2, `${docs.length} de 2`);

  const aud = await auditoria.listar(admin, { entityId: nova.id });
  const ev = aud.itens.find((e) => e.action === 'people.document.replace_file');
  conferir('auditoria da troca (people.document.replace_file) com antes e depois', Boolean(ev), ev ? `${ev.action} em ${ev.occurredAt}: "${String(ev.reason || '').slice(0, 220)}"` : `GET /audit-log -> ${aud.status}, ${aud.itens.length} eventos`);
  if (ev) out.ids.auditoriaTroca = ev.id;

  const virus = passo('recusa: enviar arquivo de teste de antivírus (EICAR)', await admin.chamar('POST', '/files', { fileName: 'aceite-m3-eicar.pdf', mimeType: 'application/pdf', contentBase64: EICAR, category: 'people' }));
  conferir('antivírus barra arquivo infectado (padrão EICAR) — nunca vira versão', virus.status >= 400 && virus.status < 500, `${resumo(virus)}${virus.erro ? ` "${virus.erro.message}"` : ''}`);

  const revisao = passo('revisão própria: validar a nova versão sobre o arquivo novo', await admin.chamar('PATCH', `/people/${pessoa.id}/documents/${nova.id}`, { verificationStatus: 'VERIFIED', manualFields: { name: NOME, taxId: cpf } }));
  // Revisão própria: a nova versão é julgada pela leitura DELA. Arquivo legível -> pode ser verificada (200 VERIFIED); arquivo ilegível
  // (o PDF fictício daqui) -> a verificação é recusada (422 PERSON_DOCUMENT_ILLEGIBLE) e a revisão fica pendente com o motivo na auditoria.
  const ilegivel = leitura.illegible === true;
  conferir(ilegivel ? 'revisão própria: leitura do arquivo novo ilegível -> verificação recusada (422) e revisão pendente aberta'
    : 'revisão própria: a nova versão é verificada sobre o arquivo novo',
  ilegivel ? (revisao.status === 422 && revisao.erro && revisao.erro.code === 'PERSON_DOCUMENT_ILLEGIBLE' && ev && /revisão pendente/.test(ev.reason || ''))
    : (revisao.status === 200 && revisao.dados.verificationStatus === 'VERIFIED'),
  `${resumo(revisao)}; leitura do arquivo novo: ilegível=${ilegivel}; motivo da revisão na auditoria: ${ev ? String(ev.reason).split('revisão pendente: ')[1] || '-' : '-'}`);

  out.caminhoNaTela = `Pessoas (/painel/pessoas/${pessoa.id}) → aba Documentos: RG versão ${original.versionNo} (arquivo v1, verificado) e RG versão ${nova.versionNo} (arquivo v2, nasceu pendente, depois verificado pela revisão própria); Auditoria (filtro people.document.replace_file).`;
  out.resultado = { ok: out.conferencias.filter((c) => c.ok).length, falharam: out.conferencias.filter((c) => !c.ok).length };
  console.log(`\nResultado: ${out.resultado.ok} ok, ${out.resultado.falharam} falharam. IDs: ${JSON.stringify(out.ids)}`);
  if (env.HOMO_SAIDA_JSON) fs.writeFileSync(env.HOMO_SAIDA_JSON, `${JSON.stringify(out, null, 2)}\n`);
  if (out.resultado.falharam) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof PararScript ? `PARADO: ${e.message}` : `ERRO: ${e.message}`);
  process.exit(e instanceof PararScript ? 2 : 1);
});

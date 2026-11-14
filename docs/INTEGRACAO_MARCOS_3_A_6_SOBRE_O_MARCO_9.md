# Integração dos Marcos 3 a 6 sobre o Marco 9 entregue

Branch `integra/m3m6-sobre-m9` (API e Front), criada a partir do Marco 9 entregue e publicado na homologação (API `9863bee2`, Front `a26d3da`).
Regra seguida: **nada do Marco 9 muda**, salvo onde um item do livro dos Marcos 3 a 6 exige, e aí a mudança está listada abaixo.

## O que entrou

- Linha `integra/ensaio` (41addaa2: matrizes dos Marcos 3 a 6, M4-D140, DEC-007 rodada 1) e as 12 pontas de correção:
  `fix/dec007-rodada2`, `m3fix/pessoas-verificacao` (contém `m9fix/pessoas-vinculo`), `m3fix/crm-carteira` (contém `-ci`, `-eventos`, `-ia`),
  `m3fix/crm-oportunidades`, `m3fix/imoveis-verificacao`, `m4fix/pagamentos-verificacao`, `m4fix/conciliacao-comissao`, `m4fix/ledger-relatorios`,
  `m5fix/contratos-verificacao`, `m5fix/esteira-restore`, `m5fix/vistorias-prazos`, `m6fix/verificacao` (contém `m6fix/esteira-qualidade`).
  As branches `*/matriz`, `m3fix/funil` e `m3fix/radar` já estavam dentro da `integra/ensaio`.
- Front: as mesmas pontas (as do Front com o mesmo nome).

## Como o Marco 9 foi protegido

1. Conferência linha a linha, depois de cada junção: toda linha que o Marco 9 acrescentou (base comum -> `9863bee2`) continua presente e nenhuma linha
   que ele removeu voltou, seguindo as mudanças de pasta. API: 9.910 linhas conferidas em 264 arquivos; Front: 3.198 em 23. As diferenças apontadas
   foram revistas uma a uma (são as listadas abaixo).
2. Varreduras automáticas: declaração repetida no mesmo arquivo (1.173 arquivos), chamada com mais argumentos do que a função declara e transação
   na posição de outro parâmetro (chamadas com `require` resolvido).
3. Bateria completa da API em bancos descartáveis (mesma divisão da entrega do Marco 9), testes unitários do Front com a API ao lado (330 de 330),
   lint, limite de 400 linhas, archGuard, checagens de tipos (inclusive a estrita do Financeiro), cobertura de classificação (100%).
4. Ensaio do deploy: banco com o Marco 9 e as migrations da integração por cima; e o mesmo com o **backup da homologação** (ver
   `docs/DEPLOY_FECHAMENTO_MARCOS_3_A_6.md`).

## Decisões da junção

1. Mensagens do CRM: estrutura do Marco 9 (`messages.constants/input/refs`) + `occurredAt` do Guia §10 + canal SITE. `POST /messages` continua com o
   esquema FECHADO do Marco 9; a rota do livro `POST /crm/opportunities/:id/interactions` chama o serviço direto.
2. Configurações: MFA recente da chave sensível (DEC-007) antes; a recusa nunca devolve o valor recebido (DI-M9R-19). A frase do antifraude
   (DI-DEC007-2) só cita o valor quando é número finito.
3. Tratador de erros: regras do Marco 9 (DI-M9R-14/20/25: erro de banco só vira 4xx com prova do pedido). As regras genéricas do pentest do Marco 5
   (VALUE_TOO_LONG/INVALID_FIELD_TYPE sem prova) e do Marco 6 (inteiro fora da faixa -> 422) ficaram de fora; o teste do Marco 5 confere o contrato
   do Marco 9. Acrescentado o código de negócio da unicidade do Financeiro (FIN-TS-001).
4. Máscara de dados (redaction): expressões do Marco 9 escritas com `String.raw` (valor idêntico) para o sastScan.
5. Rotas do Financeiro e do Jurídico: esquema de entrada do Marco 9 e depois a precisão de centavos (FIN-008); rotas literais dos Guias (M3 §13 e
   M5 §14) com o mesmo esquema das rotas equivalentes. Esquemas do Marco 9 movidos para junto das rotas na árvore `src/modules` (M4-D140).
6. Permissões que o livro do Marco 5 trocou: exportar o dossiê passa a `legal:evidence:export`; cancelar/liberar entrega de chaves a
   `lease.keys.deliver`; aprovar versão de contrato a `contracts.version.approve` (DEC-073; os perfis com `legal:approve` a recebem na migration 15101).
7. Pessoas (vínculo por empresa, DI-M9I): o mesmo CPF em outra empresa do grupo continua 409 sem vazar nada, com o código `PERSON_TAX_ID_IN_GROUP`
   (convite ao vínculo) em vez de `PERSON_DUPLICATE_TAX_ID`; o reteste do ponto 5 acompanha. A chave "filho só da empresa da pessoa" (9966, Marco 9)
   foi substituída pela "filho só com vínculo da empresa" (10941), como a 9966 previa; sem vínculo, B continua sem gravar filho na pessoa de A.
   O teste de catálogo de RLS do Marco 9 foi reforçado (analisador AND/OR), não afrouxado.
8. Estorno (M4PG x M4LR): pela tela é um caso aprovado por outra pessoa; a aprovação executa pela regra do ledger (previsto não realizado é anulado
   sem movimento; quitado em baixas estorna cada baixa) e a aprovação repetida devolve o que a primeira gravou.
9. Checklist de contratos (M5): política padrão = soma das duas correções; a lista de padrões antigos tem o de 41addaa2 e os intermediários.
   A entrega de chaves chamava `resolveRequirementItems` com a assinatura antiga (a transação caía fora e a liberação travava): corrigido.
10. CAD-09: o status do financiamento atualiza a oportunidade por evento (no despacho do outbox); registrado no manifesto da bateria do
    Correspondente (M9-D240), como as alterações de 11/11.
11. `POST /finance/bank-transactions` com conta inexistente: 404 `FINANCE_BANK_ACCOUNT_NOT_FOUND` (a conciliação confere a conta antes do INSERT) em
    vez do 400 da rede de proteção do Marco 9; nenhum dos dois devolve o id.
12. Migration 9971 com o prefixo repetido (mensagens do Marco 9 e ocorrências do Marco 3): independentes, ficaram as duas.

## Mudanças de comportamento do Marco 9 (lista completa)

Levantadas pelo verificador independente sem contexto (14/11/2026) comparando `9863bee2` com a integração. Todas vêm de um item dos livros dos
Marcos 3 a 6; a coluna da direita diz qual.

| O que muda no Marco 9 | Por quê |
|---|---|
| Webhook do Clicksign com roteamento desconhecido: 200 `unknown_routing` -> 401 `LEGAL_WEBHOOK_HMAC_INVALID` (teste `m9d211.legado` ajustado) | Pentest do M5 (oráculo): signatário inexistente e assinatura inválida respondem igual. É a regra do próprio M9-D211 ("sem revelar se existe"); o 200 era do código legado, não da demanda. |
| Estados da intenção de pagamento: `SUBMITTING/SUBMITTED` -> `EXECUTING` + `submission_phase`, `EXECUTED` -> `CONFIRMED`, `PENDING` -> `PENDING_APPROVAL`, `CANCELLED` -> `CANCELED` (migration 11400; testes m9d228/237/252 e a ferramenta da NAY acompanham) | Guia M4 §4 (M4PG): os estados do livro. Todo estado antigo é convertido antes da CHECK. |
| Funil: `CLOSED_WON/CLOSED_LOST/QUALIFYING` -> `WON/LOST/QUALIFIED` no BI e na NAY (≈25 arquivos de `src/features/analytics`; migrations 9975 e 31001 convertem os dados) | Livro do Marco 3 (DI-M3CA-3). O número dos KPIs é o mesmo para o mesmo dado. O parâmetro `analytics.comercial.ordem_estagios` gravado com os nomes antigos precisa ser regravado (padrão do Front já usa WON/LOST). |
| Fórmulas do BI financeiro (`financeHealth.*`, checagens de qualidade, custo da obra): a pagar/a receber = saldo em aberto (inclui `PARTIALLY_SETTLED`), liquidado = linha do ledger, inadimplência sem os filhos | Caderno M4 §6/§7 (M4LR, ledger). Para o mesmo banco, os KPIs M9-D615/D620 dão número diferente (corrigido pelo ledger). |
| Imóvel criado já `PUBLISHED`: passa pelo portão de publicação (409 `PROPERTY_PUBLISH_REQUIRES_ACTIVE_OFFER` sem oferta ativa; teste `m9d409.gatilhos` reescrito) | Livro M3-09: publicar exige oferta ativa e campos obrigatórios. |
| MFA recente exigido para alterar parâmetros do Marco 9: `integration.admin.*`, `integration.registry.*`, `integration.secret.*`, `ia.fallback.max_saltos`, `killDays` das flags, `mfa.*` | DEC-007 (chave sensível exige MFA recente). Endurecimento. |
| Recusa de anexo (`fileAttachGuard`) adiada até a permissão da rota | Pentest M5 (achado 10): sem a permissão, PERMISSION_DENIED primeiro. Corrigido em 14/11: TODO middleware de permissão devolve a recusa guardada (antes só `requirePermission`); teste com varredura `test/fileAttachGuard.adiado.test.js`. |
| NAY Comercial e NAY Jurídica: capacidades, escopo, ferramenta `legal.compareInspections`, termos de escopo; job novo de lead esquecido (só com `ia.habilitada`); helper `aiAgentJuridica.js` (só afeta banco novo) | Livros M3 (NAY Comercial) e M5 (comparação de vistorias pela NAY). |
| Contrato público com 15 tipos de contrato (antes 12); ferramenta da NAY `legalDraftContract` sem `SERVICE` | Caderno M5 §3 (os 12 tipos do livro + 3 legados); ver decisão 4. |
| Teste `m9d200.legado-somente-leitura`: migration depois da 9964 precisa estar em algum `docs/DEPLOY_*.md` (antes só no do Marco 9) | As migrations da integração estão em `docs/DEPLOY_FECHAMENTO_MARCOS_3_A_6.md`. |
| Rota `POST /v1/webhooks/signature/:provider` antes da rota única do M9-D211 | Guia M5 §14. Corrigido em 14/11: fornecedor desconhecido ou sem canal segue para a rota única do Marco 9 (mesmo 404 genérico, limite e contador de antes). |
| Permissões trocadas em rotas que já existiam: estorno `finance:settle` -> `finance:reverse` + MFA (vira caso a aprovar, 202); reabertura de período `finance:approve` -> `finance:periodReopen`; alçada de Obras `construction:approval_threshold:manage` + MFA (concedidas pela migration 11400 a quem tinha a anterior) | Guia M4 §8 e Caderno §16 (duas pessoas); M6-29/M6-107. |
| Front: Atividades (M9-D852) com o estorno em `finance:reverse` e sem "Cancelar contrato"; padrões de parâmetros (`ordem_estagios` WON/LOST, `garantias_sem_vencimento` SECURITY_DEPOSIT, `ia.comercial.termos_escopo` mais amplo, diferentes de `public/marco9-dados/parametros.json`); 6 abas novas em Configurações e a tela NAY Comercial; abas do Marco 9 mostram uma frase no 403 de MFA em vez de travar como "Sem permissão" | Os mesmos itens dos livros acima. |
| Lint do OpenAPI (`diff.schema.js`, M9-D840): valor novo em enum `x-closed` de REQUISIÇÃO deixa de ser breaking (só na resposta) | O próprio M9-D840 §3.2, regra 6: "adicionar valor de enum em requisição nunca é breaking". O teste do Marco 9 ganhou o caso; nenhuma asserção afrouxada. |
| Cadastro de pessoa em corrida com o mesmo CPF/CNPJ: na mesma empresa, 409 `PERSON_DUPLICATE` FORTE com o existente; em outra empresa do grupo, 409 `PERSON_TAX_ID_IN_GROUP` (o Marco 9 respondia `PERSON_DUPLICATE_TAX_ID` nos dois) | Caderno M3 §4 (match forte) e DI-M9I (vínculo). A gravação usa SAVEPOINT por SQL na transação da requisição: a avaliação de qualidade na gravação (M9-D806) continua anotada. |
| União de cadastros (M9-D805): histórico imutável (assinatura de aditivo, garantia substituída, rastro do radar e do carrinho, entrega de campanha, titular de terceiro do lançamento) fica no cadastro absorvido; a rota `/impact` conta só o que a união move | Os gatilhos de imutabilidade dos Marcos 3 a 5 (e o do Marco 4 no lançamento). |
| `persons_company_select` (9965, Marco 9) alargada pela 10940: além da empresa dona, vê a pessoa quem tem vínculo ATIVO ou apresenta a prova (CPF/CNPJ + primeiro e último nome, na variável de sessão que só o serviço de vínculo grava e limpa) | DI-M9I (vínculo por empresa do grupo); ver decisão 5. O `down` volta a 9965. |

Antes do Marco 9 já existia, e agora também é tratado: a união de cadastros (M9-D805) dava erro em pessoa com entrega de campanha (o gatilho do Marco 9
não deixa trocar a pessoa da entrega). A entrega fica com o cadastro absorvido, como o histórico abaixo.

## Corrigido depois do CI do GitHub e do verificador independente (14/11/2026)

- Pessoas: corrida no cadastro do mesmo CPF NA MESMA empresa respondia "vincule o cadastro de outra empresa"; agora é a recusa do portão (409 `PERSON_DUPLICATE`
  FORTE com o existente). Achado pela carga do Marco 3 no CI.
- Esteira do Jurídico (prova dos renomes): a cláusula que a 15103 grava por empresa ficava contada como "copiada". Drill de restore de Obras: a fixture aprovava
  a perda pela alçada antiga (agora sem alçada nada se autoaprova, DI-M6V-6).
- União de cadastros: histórico imutável (assinatura de aditivo, garantia substituída, rastro do radar e do carrinho, entrega de campanha) fica no absorvido; antes
  a união dava erro. Teste `test/m9d805.historicoDosMarcos3a6.test.js`.
- Finalidade da mensagem: com o parâmetro desligado, agora é exatamente o Marco 9 (o `canContact` lia as listas da empresa mesmo desligado); o `canContact`
  carrega a política sozinho num processo que ainda não carregou o CRM (antes, nenhum contato era autorizado nesse processo).
- `POST /crm/opportunities/:id/interactions`: o mesmo limite de texto de `POST /messages` (DI-M9R-16); permissão antes da consulta de escopo nas rotas do livro.
- 15103: publicação sem publicador só para a versão 1 CODE_SEED do modelo do termo do imóvel usado cujas cláusulas são todas a TERMO_IMOVEL_USADO com o texto
  da semente (conferido por hash) ou uma versão dela escrita por pessoa (`created_by` preenchido, que passou pelo fluxo de cláusulas do jurídico).
- Migrations: 9985 numa transação; o erro original aparece quando uma migration falha (`forceRestaurado`); as 6 CHECKs do Jurídico validadas quando limpas.
- Lint do OpenAPI: valor novo em enum de REQUISIÇÃO nunca é breaking (M9-D840 §3.2, regra 6), também com `x-closed`.
- CI: o ESLint do `test.yml` lia a cópia do Front que o próprio CI põe em `front-checkout/` (o Marco 9 já reprovava por isso); os testes do Front que montam a tela
  no jsdom não rodavam no Node 20 do CI (`navigator`), dois deles já no Marco 9.
- Front: rótulos das 5 permissões novas; funções e rótulos duplicados; rótulo do MFA para parâmetro com "export" no nome; NAY Comercial no menu do CRM só com `ai:read`.

## Para o Patrick decidir

1. **NAY Financeira**: a conciliação do Marco 4 (DI-M4CC-4) passava a NAY Financeira a ler o retrato do BI, que só muda no recálculo. Isso lia o BI fora
   da camada de segurança (m9d700) e quebrava o Marco 9 (M9-D036: a NAY determinística e o agente de IA dão o mesmo número na hora) e a sonda P10 do
   M4LR. Ficou como no Marco 9 (FinanceHealthReport ao vivo, Guia §13), com o realizado pelo ledger (M4LR) e a FIN-005 da DEC-007. Para voltar ao
   retrato do BI, o agente de IA do Marco 9 precisa mudar junto.
2. **Finalidade obrigatória na mensagem (M3-18)**: virou o parâmetro `crm.mensagens.finalidade_obrigatoria` (aba CRM), padrão DESLIGADO = Marco 9 (sem
   finalidade vale TRANSACTIONAL; finalidade fora das listas segue a regra do Marco 9). Ligado, fecha o contorno do opt-out de marketing por omissão
   da finalidade. Recomendo ligar depois do aceite da Nayara.
3. **29 medições de obra antigas** marcadas "a pagar" sem a conta a pagar (dados de teste de 08 e 09/10 na homologação): a regra nova fica sem validar
   até a decisão (consulta e comando em `docs/DEPLOY_FECHAMENTO_MARCOS_3_A_6.md`).
4. **Contrato OpenAPI v1 com os 3 tipos de contrato do livro** (`ADDENDUM`, `KEY_DELIVERY`, `USED_PROPERTY_DELIVERY`, Caderno M5 §3): o enum `ContractType` é
   fechado (`x-closed`) desde o Marco 9 e, pela regra 6 do M9-D840, valor novo na RESPOSTA de `GET /legal/contracts` é mudança incompatível dentro da major 1 — o
   lint do OpenAPI (Governança) reprova o pull request contra a `marco-9`. A lista do Marco 9 tinha 12 entradas, mas não os 12 tipos do livro (AUD-015 pedia os 12
   do caderno). Caminhos: (a) aceitar como correção do contrato da v1 (a rota é interna, está no contrato por M9-D809; nenhum integrador externo a consome; o Front
   sobe junto) — depois da junção na `marco-9` o lint compara com o contrato novo e volta a passar; ou (b) abrir a v2 (`openapi.v2.yaml`) com a v1 deprecada e data
   de desligamento (M9-D840 §3.3). Recomendo (a).
5. **Vínculo de pessoa por empresa (DI-M9I, migration 10940)**: a leitura de pessoas do Marco 9 passa a aceitar a prova CPF/CNPJ + primeiro e último nome (para
   vincular um cadastro de outra empresa do grupo). Quem já sabe o CPF e o nome consegue ver a base daquela pessoa (sem empresa responsável, risco nem autoria) e
   cada tentativa conta no limite de tentativas. É o desenho do vínculo do Marco 9 (pedido da homologação); precisa do seu aceite explícito por afrouxar o
   isolamento entre empresas do mesmo grupo.

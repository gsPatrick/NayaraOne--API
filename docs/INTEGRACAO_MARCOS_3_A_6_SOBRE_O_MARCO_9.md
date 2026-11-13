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

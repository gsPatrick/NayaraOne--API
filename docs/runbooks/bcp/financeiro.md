# Runbook de continuidade — Financeiro

Roteiro impresso para operar **sem o sistema** no setor de Financeiro e lançar tudo depois sem perder nada. Formulários do setor: RECEBIMENTO (intenção `RECEIVE_PAYMENT`) e PAGAMENTO_EMERGENCIAL (intenção `EMERGENCY_PAYMENT`). Prefixo da numeração: `FIN` (número `FIN-AAAA-nnnnn`, impresso no papel).

## 1. Quando acionar
O sistema está indisponível e o responsável do setor decide acionar a contingência. Anote a hora de início no primeiro formulário. Não acione por lentidão: só por indisponibilidade que impeça o trabalho.

## 2. Quem aciona e quem é o responsável
- Aciona e responde: Responsável do financeiro (substituto: o segundo conferente designado pelo diretor).
- O responsável avisa a equipe, distribui os blocos numerados e controla a faixa de números usada.

## 3. O que continua funcionando sem o sistema
Receber pagamentos com comprovante, guardar documentos e atender cobranças já conhecidas pela via impressa.

## 4. Passo a passo manual
1. Para cada recebimento, preencha o formulário **RECEBIMENTO** (número `FIN-AAAA-nnnnn`): pagador, documento, valor **em centavos** (R$ 1.250,00 = 125000), forma (dinheiro, PIX, transferência, cheque), data, contrato ou parcela e se o comprovante foi anexado.
2. Guarde o comprovante junto da folha e fotografe os dois.
3. PAGAMENTO manual só em urgência real, no formulário **PAGAMENTO_EMERGENCIAL**, com **dupla checagem**: dois conferentes distintos escrevem o nome, a data e a hora no papel antes de qualquer saída de dinheiro.
4. Todo pagamento manual será conciliado depois com o extrato do banco (prazo no parâmetro `governanca.bcp.conciliar_pagamento_dias`, padrão 3 dias úteis).

## 5. O que é proibido fazer manualmente
- PAGAMENTO manual sem dupla checagem (dois conferentes distintos): é proibido, sem exceção.
- Pagar em dinheiro, ou a favorecido sem documento e comprovante da obrigação.
- Quem pede o pagamento não pode ser um dos dois conferentes.
- Emitir recibo ou nota fora da numeração oficial.

## 6. Como registrar para reconciliação
- Cada formulário tem seu número `FIN-AAAA-nnnnn`; esse número é a ponte com o sistema e nunca se repete.
- Fotografe ou escaneie cada folha preenchida: a imagem é a evidência obrigatória do registro (`POST /bcp/manual-operations`).
- Folhas do mesmo caso compartilham a mesma referência de correlação (`correlationRef`), informada ao registrar.
- Use o campo de valores em centavos, inteiros, sem vírgula nem ponto.

## 7. Como encerrar a contingência e importar
1. Com o sistema de volta, o responsável confere se todas as folhas usadas têm foto e número.
2. Quem tem permissão do setor registra cada folha em `POST /bcp/manual-operations`; folha com dado errado fica registrada com o erro e é corrigida em `PATCH /bcp/manual-operations/:id`.
3. A importação para o sistema e a conciliação seguem o procedimento de importação do BCP (M9-D832). Só depois dela o responsável registra o fim da contingência (hora de término) e arquiva as folhas originais.

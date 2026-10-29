# Runbook de continuidade — Locação

Roteiro impresso para operar **sem o sistema** no setor de Locação e lançar tudo depois sem perder nada. Formulários do setor: PROPOSTA_LOCACAO (intenção `REGISTER_PROPOSAL`) e ENTREGA_CHAVE (intenção `REGISTER_KEY_DELIVERY`). Prefixo da numeração: `LOC` (número `LOC-AAAA-nnnnn`, impresso no papel).

## 1. Quando acionar
O sistema está indisponível e o responsável do setor decide acionar a contingência. Anote a hora de início no primeiro formulário. Não acione por lentidão: só por indisponibilidade que impeça o trabalho.

## 2. Quem aciona e quem é o responsável
- Aciona e responde: Responsável pela locação (substituto: o analista de contratos do plantão).
- O responsável avisa a equipe, distribui os blocos numerados e controla a faixa de números usada.

## 3. O que continua funcionando sem o sistema
Atender locatários, receber propostas e entregar chaves de contratos já assinados, usando a via impressa do contrato.

## 4. Passo a passo manual
1. Para cada proposta recebida, preencha o formulário **PROPOSTA_LOCACAO** (número `LOC-AAAA-nnnnn`): proponente, CPF/CNPJ, imóvel, valor do aluguel proposto **em centavos**, prazo em meses e garantia oferecida.
2. Na entrega de chaves, preencha o formulário **ENTREGA_CHAVE**: contrato, imóvel, quem recebeu, documento, quantidade de chaves e data.
3. A vistoria de entrega é anotada no campo **estado do imóvel** do formulário ENTREGA_CHAVE; não existe formulário próprio de vistoria.
4. Faça o recebedor assinar a folha e fotografe-a inteira (a foto é a evidência exigida no registro).

## 5. O que é proibido fazer manualmente
- Assinar contrato ou aditivo fora do fluxo jurídico.
- Entregar chave sem conferir o documento do recebedor.
- Alterar valor de aluguel de contrato vigente.

## 6. Como registrar para reconciliação
- Cada formulário tem seu número `LOC-AAAA-nnnnn`; esse número é a ponte com o sistema e nunca se repete.
- Fotografe ou escaneie cada folha preenchida: a imagem é a evidência obrigatória do registro (`POST /bcp/manual-operations`).
- Folhas do mesmo caso compartilham a mesma referência de correlação (`correlationRef`), informada ao registrar.
- Use o campo de valores em centavos, inteiros, sem vírgula nem ponto.

## 7. Como encerrar a contingência e importar
1. Com o sistema de volta, o responsável confere se todas as folhas usadas têm foto e número.
2. Quem tem permissão do setor registra cada folha em `POST /bcp/manual-operations`; folha com dado errado fica registrada com o erro e é corrigida em `PATCH /bcp/manual-operations/:id`.
3. A importação para o sistema e a conciliação seguem o procedimento de importação do BCP (M9-D832). Só depois dela o responsável registra o fim da contingência (hora de término) e arquiva as folhas originais.

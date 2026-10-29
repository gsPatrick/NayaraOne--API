# Runbook de continuidade — Atendimento

Roteiro impresso para operar **sem o sistema** no setor de Atendimento e lançar tudo depois sem perder nada. Formulários do setor: LEAD_ATENDIMENTO (intenção `REGISTER_LEAD`) e REGISTRO_VISITA (intenção `REGISTER_VISIT`). Prefixo da numeração: `ATD` (número `ATD-AAAA-nnnnn`, impresso no papel).

## 1. Quando acionar
O sistema está indisponível e o responsável do setor decide acionar a contingência. Anote a hora de início no primeiro formulário. Não acione por lentidão: só por indisponibilidade que impeça o trabalho.

## 2. Quem aciona e quem é o responsável
- Aciona e responde: Responsável do atendimento (substituto: o corretor-chefe do plantão).
- O responsável avisa a equipe, distribui os blocos numerados e controla a faixa de números usada.

## 3. O que continua funcionando sem o sistema
Receber clientes e visitantes, anotar o interesse de cada um, mostrar imóveis já conhecidos e combinar retorno por telefone.

## 4. Passo a passo manual
1. Pegue o bloco de formulários **LEAD_ATENDIMENTO** (cada folha já vem com o número `ATD-AAAA-nnnnn` impresso) e preencha nome, telefone, interesse (compra, locação ou venda), origem e observação.
2. Para cada visita feita ou marcada, preencha o formulário **REGISTRO_VISITA**: cliente, telefone, imóvel, data e hora, corretor.
3. Use uma folha por cliente ou visita, nunca duas no mesmo papel, e nunca reaproveite um número.
4. Ao final do turno, o responsável confere as folhas, assina e guarda todas juntas.

## 5. O que é proibido fazer manualmente
- Prometer preço, condição ou disponibilidade que dependa de consulta ao sistema.
- Receber dinheiro ou assinar proposta: encaminhe ao setor de Locação ou Financeiro.
- Reescrever ou descartar folha numerada, mesmo errada (risque e anote o motivo).

## 6. Como registrar para reconciliação
- Cada formulário tem seu número `ATD-AAAA-nnnnn`; esse número é a ponte com o sistema e nunca se repete.
- Fotografe ou escaneie cada folha preenchida: a imagem é a evidência obrigatória do registro (`POST /bcp/manual-operations`).
- Folhas do mesmo caso compartilham a mesma referência de correlação (`correlationRef`), informada ao registrar.
- Use o campo de valores em centavos, inteiros, sem vírgula nem ponto.

## 7. Como encerrar a contingência e importar
1. Com o sistema de volta, o responsável confere se todas as folhas usadas têm foto e número.
2. Quem tem permissão do setor registra cada folha em `POST /bcp/manual-operations`; folha com dado errado fica registrada com o erro e é corrigida em `PATCH /bcp/manual-operations/:id`.
3. A importação para o sistema e a conciliação seguem o procedimento de importação do BCP (M9-D832). Só depois dela o responsável registra o fim da contingência (hora de término) e arquiva as folhas originais.

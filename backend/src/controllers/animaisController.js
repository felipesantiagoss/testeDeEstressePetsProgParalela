const pool = require('../config/db'); // Importa o pool de conexões com o banco de dados PostgreSQL

// Função que lista animais, aplicando filtros opcionais vindos da query string da URL
async function listar(req, res) {
  const { sexo, porte, idade, cor, raca, localizacao } = req.query; // Extrai os possíveis filtros da query string da requisição

  let query = 'SELECT * FROM animais WHERE 1=1'; // Inicia a query base; "1=1" facilita concatenar filtros com "AND"
  const params = []; // Array que guardará os valores dos parâmetros da query (proteção contra SQL injection)
  let i = 1; // Contador usado para numerar os placeholders ($1, $2, ...) da query

  if (sexo)        { query += ` AND sexo = $${i++}`;            params.push(sexo); } // Se 'sexo' foi informado, adiciona o filtro na query e o valor no array de parâmetros
  if (porte)       { query += ` AND porte = $${i++}`;           params.push(porte); } // Se 'porte' foi informado, adiciona o filtro na query e o valor no array de parâmetros
  if (idade)       { query += ` AND idade = $${i++}`;           params.push(idade); } // Se 'idade' foi informada, adiciona o filtro na query e o valor no array de parâmetros
  if (cor)         { query += ` AND cor = $${i++}`;             params.push(cor); } // Se 'cor' foi informada, adiciona o filtro na query e o valor no array de parâmetros
  if (raca)        { query += ` AND raca ILIKE $${i++}`;        params.push(`%${raca}%`); } // Se 'raca' foi informada, filtra por correspondência parcial sem diferenciar maiúsculas/minúsculas (ILIKE)
  if (localizacao) { query += ` AND localizacao ILIKE $${i++}`; params.push(`%${localizacao}%`); } // Se 'localizacao' foi informada, filtra por correspondência parcial sem diferenciar maiúsculas/minúsculas

  try {
    const { rows } = await pool.query(query, params); // Executa a query no banco passando os parâmetros e captura as linhas retornadas
    res.json(rows); // Retorna as linhas encontradas em formato JSON para o cliente
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar animais', detalhe: err.message }); // Em caso de erro, responde com status 500 e a mensagem do erro
  }
}

// Função que busca um único animal pelo seu ID (passado na URL)
async function buscarPorId(req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM animais WHERE id = $1', [req.params.id]); // Consulta o animal cujo id é igual ao parâmetro da URL
    if (rows.length === 0) return res.status(404).json({ erro: 'Animal não encontrado' }); // Se nenhum animal foi encontrado, responde com status 404
    res.json(rows[0]); // Retorna o primeiro (e único) animal encontrado em JSON
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar animal', detalhe: err.message }); // Em caso de erro, responde com status 500 e a mensagem do erro
  }
}

// Função que cria (cadastra) um novo animal a partir dos dados enviados no corpo da requisição
async function criar(req, res) {
  const { nome, sexo, porte, idade, cor, raca, localizacao, descricao, status } = req.body; // Extrai os dados do animal do corpo (body) da requisição

  // Valida se todos os campos obrigatórios foram preenchidos
  if (!nome || !sexo || !porte || !idade || !cor || !raca || !localizacao) {
    return res.status(400).json({ erro: 'Campos obrigatórios: nome, sexo, porte, idade, cor, raca, localizacao' }); // Se faltar algum campo obrigatório, responde com status 400 (requisição inválida)
  }

  try {
    // Insere o novo animal no banco; RETURNING id devolve o id gerado pelo banco
    const { rows } = await pool.query(
      'INSERT INTO animais (nome, sexo, porte, idade, cor, raca, localizacao, descricao, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [nome, sexo, porte, idade, cor, raca, localizacao, descricao || null, status || 'D'] // Valores a inserir; descricao vazia vira null e status vazio assume 'D' (disponível)
    );
    res.status(201).json({ id: rows[0].id, mensagem: 'Animal cadastrado com sucesso' }); // Responde com status 201 (criado) e o id do novo animal
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao cadastrar animal', detalhe: err.message }); // Em caso de erro, responde com status 500 e a mensagem do erro
  }
}

// Função que atualiza os dados de um animal já existente, identificado pelo ID na URL
async function atualizar(req, res) {
  const { nome, sexo, porte, idade, cor, raca, localizacao, descricao, status } = req.body; // Extrai os novos dados do animal do corpo da requisição

  // Valida se todos os campos obrigatórios foram preenchidos
  if (!nome || !sexo || !porte || !idade || !cor || !raca || !localizacao) {
    return res.status(400).json({ erro: 'Campos obrigatórios: nome, sexo, porte, idade, cor, raca, localizacao' }); // Se faltar algum campo obrigatório, responde com status 400
  }

  try {
    // Atualiza todos os campos do animal cujo id corresponde ao da URL; rowCount indica quantas linhas foram alteradas
    const { rowCount } = await pool.query(
      'UPDATE animais SET nome=$1, sexo=$2, porte=$3, idade=$4, cor=$5, raca=$6, localizacao=$7, descricao=$8, status=$9 WHERE id=$10',
      [nome, sexo, porte, idade, cor, raca, localizacao, descricao || null, status || 'D', req.params.id] // Valores a atualizar; o último é o id do animal vindo da URL
    );
    if (rowCount === 0) return res.status(404).json({ erro: 'Animal não encontrado' }); // Se nenhuma linha foi alterada, o animal não existe: responde 404
    res.json({ mensagem: 'Animal atualizado com sucesso' }); // Confirma a atualização ao cliente
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar animal', detalhe: err.message }); // Em caso de erro, responde com status 500 e a mensagem do erro
  }
}

// Função que remove (exclui) um animal do banco pelo seu ID
async function remover(req, res) {
  try {
    const { rowCount } = await pool.query('DELETE FROM animais WHERE id = $1', [req.params.id]); // Deleta o animal cujo id corresponde ao da URL; rowCount diz quantas linhas foram apagadas
    if (rowCount === 0) return res.status(404).json({ erro: 'Animal não encontrado' }); // Se nada foi apagado, o animal não existia: responde 404
    res.json({ mensagem: 'Animal removido com sucesso' }); // Confirma a remoção ao cliente
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover animal', detalhe: err.message }); // Em caso de erro, responde com status 500 e a mensagem do erro
  }
}

// Função que alterna (liga/desliga) o status de disponibilidade do animal entre 'D' e 'I'
async function toggleStatus(req, res) {
  try {
    const { rows } = await pool.query('SELECT status FROM animais WHERE id = $1', [req.params.id]); // Busca o status atual do animal pelo id da URL
    if (rows.length === 0) return res.status(404).json({ erro: 'Animal não encontrado' }); // Se o animal não existe, responde 404

    const novoStatus = rows[0].status === 'D' ? 'I' : 'D'; // Inverte o status: se estava 'D' (disponível) vira 'I' (indisponível) e vice-versa
    await pool.query('UPDATE animais SET status = $1 WHERE id = $2', [novoStatus, req.params.id]); // Grava o novo status no banco

    const label = novoStatus === 'D' ? 'disponível' : 'indisponível'; // Define um rótulo legível conforme o novo status
    res.json({ mensagem: `Animal marcado como ${label}`, status: novoStatus }); // Responde informando o novo status ao cliente
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar status', detalhe: err.message }); // Em caso de erro, responde com status 500 e a mensagem do erro
  }
}

// Contador de chegada, usado para registrar a ordem em que o servidor recebe
// cada requisição de adoção (instrumentação para análise de concorrência).
let _ordemChegadaAdocao = 0; // Variável de módulo que conta quantas requisições de adoção já chegaram ao servidor

// Função que processa a adoção de um animal, tratando a concorrência (várias pessoas tentando adotar o mesmo pet)
async function adotar(req, res) {
  // Instante em que o servidor recebeu a requisição. Cliente e servidor compartilham
  // o mesmo relógio em localhost, permitindo a comparação com o envio do cliente.
  const recebidoEm = Date.now(); // Marca o horário (em ms) de chegada da requisição ao servidor
  // Ordem sequencial de chegada ao servidor. Mesmo disparadas em paralelo, as
  // requisições são processadas uma a uma pelo event loop.
  const ordemChegada = ++_ordemChegadaAdocao; // Incrementa e guarda a posição desta requisição na fila de chegada

  const { id } = req.params; // Pega o id do animal a ser adotado, vindo da URL
  const { usuarioId } = req.body; // Pega o id do usuário que está tentando adotar, vindo do corpo da requisição

  // Valida se o usuarioId foi informado
  if (!usuarioId) {
    return res
      .status(400) // Responde com status 400 (requisição inválida)
      .json({ sucesso: false, motivo: 'Campo obrigatório: usuarioId', recebidoEm, ordemChegada }); // Informa que o usuarioId é obrigatório
  }

  // Transação dedicada (um client do pool por requisição). Precisamos SEGURAR a
  // trava de linha desde o instante em que a conseguimos (SELECT ... FOR UPDATE)
  // até o COMMIT, para cronometrar — por usuário — o momento EXATO da trava, tanto
  // do vencedor quanto dos perdedores, e gravar TODOS em corrida_trava. Assim o
  // SELECT no banco bate exatamente com a corrida real desta execução.
  const client = await pool.connect(); // Pega uma conexão dedicada do pool para usar uma transação isolada nesta requisição
  try {
    await client.query('BEGIN'); // Inicia a transação no banco de dados
    // performance.now() mede em frações de ms (precisão de microssegundos),
    // diferente de Date.now() que só conta ms inteiros. Por isso o dbMs sai como
    // 20.63 em vez de arredondado para 21.
    const t0 = performance.now(); // Marca o tempo inicial de alta precisão para medir a duração da operação no banco

    // SELECT ... FOR UPDATE serializa a disputa: cada transação só passa daqui
    // quando CONSEGUE a trava da linha. clock_timestamp()::text marca esse instante
    // com microssegundos (texto p/ o driver pg não arredondar para milissegundos).
    // Seleciona o status do animal e trava a linha (FOR UPDATE) para impedir adoções simultâneas
    const sel = await client.query(
      `SELECT status, clock_timestamp()::text AS travou_em
         FROM animais WHERE id = $1 FOR UPDATE`,
      [id] // Parâmetro: id do animal a ser travado/consultado
    );

    // Se nenhuma linha foi retornada, o animal não existe
    if (sel.rowCount === 0) {
      await client.query('ROLLBACK'); // Desfaz a transação, pois não há nada a adotar
      return res
        .status(404) // Responde com status 404 (não encontrado)
        .json({ sucesso: false, motivo: 'Animal não encontrado', recebidoEm, ordemChegada }); // Informa que o animal não existe
    }

    const encontrou = sel.rows[0].status;     // 'D' ou 'I' no instante em que pegou a trava
    const travouEm = sel.rows[0].travou_em;   // horário real da trava (texto, microssegundos)

    // A regra da adoção: só muda se ainda estava 'D' ao pegar a trava. A 1ª
    // transação a obter a trava muda D->I (rowCount=1, vence); as demais, ao pegar
    // a trava depois, já encontram 'I', o WHERE não casa (rowCount=0) e recebem 409.
    // Tenta marcar o animal como 'I' (indisponível) somente se ele ainda estiver 'D' (disponível)
    const upd = await client.query(
      "UPDATE animais SET status = 'I' WHERE id = $1 AND status = 'D' RETURNING id, nome",
      [id] // Parâmetro: id do animal
    );
    const venceu = upd.rowCount === 1; // Verdadeiro se esta transação foi a que conseguiu adotar (alterou exatamente 1 linha)
    // Tempo da requisição no banco: aquisição da trava + execução.
    const dbMs = Math.round((performance.now() - t0) * 100) / 100; // Calcula a duração no banco em ms, arredondada para 2 casas decimais

    // Registra ESTE usuário na corrida (vencedor E perdedores), com o horário real
    // da trava. É isto que faz o SELECT em corrida_trava refletir a última execução.
    // Best-effort: se a tabela não existir, a adoção não falha por causa do registro.
    try {
      // Registra na tabela corrida_trava os dados desta tentativa de adoção (para análise da concorrência)
      await client.query(
        `INSERT INTO corrida_trava (animal_id, usuario, travou_em, encontrou, venceu)
         VALUES ($1, $2, $3::timestamptz, $4, $5)`,
        [id, usuarioId, travouEm, encontrou, venceu] // Valores: animal, usuário, horário da trava, status encontrado e se venceu
      );
    } catch (err) {
      console.error(`Falha ao registrar corrida_trava p/ ${usuarioId}: ${err.message}`); // Apenas registra no console caso o INSERT falhe (não interrompe a adoção)
    }

    if (venceu) {
      // Adoção confirmada → enfileira a notificação para o worker processar em
      // BACKGROUND (fila + worker). A resposta HTTP não espera o processamento:
      // aqui só se registra o job; quem o executa é outro processo (worker.js).
      // Melhor esforço: a adoção (dado mestre) nunca falha por causa da fila.
      let jobId = null; // Guardará o id do job de notificação enfileirado (ou null se falhar)
      try {
        // Insere na fila de notificações um job do tipo 'adocao_confirmada' para o worker processar depois
        const fila = await client.query(
          "INSERT INTO fila_notificacoes (tipo, payload) VALUES ('adocao_confirmada', $1) RETURNING id",
          [JSON.stringify({ animalId: upd.rows[0].id, nome: upd.rows[0].nome, usuarioId })] // Payload em JSON com os dados necessários para a notificação
        );
        jobId = fila.rows[0].id; // Armazena o id do job recém-criado
      } catch (err) {
        console.error(`Falha ao enfileirar notificação da adoção ${upd.rows[0].id}: ${err.message}`); // Apenas loga caso a fila falhe (não impede a adoção)
      }

      await client.query('COMMIT'); // Confirma a transação, efetivando a adoção no banco
      // Responde ao cliente com os detalhes da adoção bem-sucedida
      return res.json({
        sucesso: true, // Indica que a adoção deu certo
        mensagem: 'Adoção realizada', // Mensagem de sucesso
        usuarioId, // Id do usuário que adotou
        animalId: upd.rows[0].id, // Id do animal adotado
        nome: upd.rows[0].nome, // Nome do animal adotado
        jobId, // Id do job de notificação enfileirado
        recebidoEm, // Horário de chegada da requisição
        ordemChegada, // Posição na ordem de chegada
        dbMs, // Tempo gasto no banco
        travouEm, // Horário em que a trava foi obtida
        encontrou, // Status encontrado ao pegar a trava
        venceu, // Indica que esta requisição venceu a disputa
      });
    }

    await client.query('COMMIT'); // Confirma a transação mesmo quando esta requisição não venceu (mantém o registro da corrida)
    // Responde ao cliente que perdeu a disputa (o animal já havia sido adotado)
    return res.status(409).json({ // Status 409 (conflito): o recurso já foi tomado por outra requisição
      sucesso: false, // Indica que esta adoção não foi concluída
      motivo: 'Animal já foi adotado', // Motivo da falha
      usuarioId, // Id do usuário que tentou adotar
      recebidoEm, // Horário de chegada da requisição
      ordemChegada, // Posição na ordem de chegada
      dbMs, // Tempo gasto no banco
      travouEm, // Horário em que a trava foi obtida
      encontrou, // Status encontrado ao pegar a trava (provavelmente 'I')
      venceu, // Falso, pois esta requisição não venceu
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {}); // Em caso de erro, desfaz a transação (ignora erro do próprio rollback)
    // Responde ao cliente que houve erro interno ao processar a adoção
    res.status(500).json({
      sucesso: false, // Indica falha
      motivo: 'Erro ao processar adoção', // Motivo genérico do erro
      detalhe: err.message, // Mensagem técnica do erro
      recebidoEm, // Horário de chegada da requisição
      ordemChegada, // Posição na ordem de chegada
    });
  } finally {
    client.release(); // Sempre devolve a conexão ao pool, tendo dado certo ou não
  }
}

module.exports = { listar, buscarPorId, criar, atualizar, remover, toggleStatus, adotar }; // Exporta todas as funções do controller para serem usadas nas rotas

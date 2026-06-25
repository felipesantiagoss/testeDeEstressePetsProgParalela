const pool = require('../src/config/db'); // Importa o pool de conexões com o banco PostgreSQL
const { criarSessao, estatisticas, throughput } = require('./lib/relatorio'); // Importa funções auxiliares para criar a sessão de teste, calcular estatísticas e throughput

const PERFIL = (process.env.PERFIL || 'reduzido').toLowerCase(); // Lê o perfil do teste da variável de ambiente (padrão 'reduzido') e converte para minúsculas

// Define os dois perfis de carga disponíveis: 'reduzido' (leve) e 'cheio' (pesado)
const PERFIS = {
  reduzido: { // Perfil leve, com poucos usuários
    navegacao: { usuarios: 100, duracaoMs: 6000, requestsPorUsuario: [3, 6] }, // Carga de navegação: 100 usuários por 6s, cada um faz de 3 a 6 requisições
    ondasAdocao: [ // Lista de ondas de adoção, cada onda mira um pet diferente
      { offset: 0, usuarios: 20 }, // Onda no pet de índice 0, com 20 usuários tentando adotar
      { offset: 1, usuarios: 20 }, // Onda no pet de índice 1, com 20 usuários tentando adotar
      { offset: 2, usuarios: 40 }, // Onda no pet de índice 2, com 40 usuários tentando adotar
      { offset: 3, usuarios: 10 }, // Onda no pet de índice 3, com 10 usuários tentando adotar
      { offset: 4, usuarios: 10 }, // Onda no pet de índice 4, com 10 usuários tentando adotar
    ],
  },
  cheio: { // Perfil pesado, com muitos usuários
    navegacao: { usuarios: 1000, duracaoMs: 10000, requestsPorUsuario: [3, 7] }, // Carga de navegação: 1000 usuários por 10s, cada um faz de 3 a 7 requisições
    ondasAdocao: [ // Lista de ondas de adoção do perfil pesado
      { offset: 0, usuarios: 200 }, // Onda no pet de índice 0, com 200 usuários tentando adotar
      { offset: 1, usuarios: 200 }, // Onda no pet de índice 1, com 200 usuários tentando adotar
      { offset: 2, usuarios: 400 }, // Onda no pet de índice 2, com 400 usuários tentando adotar
      { offset: 3, usuarios: 100 }, // Onda no pet de índice 3, com 100 usuários tentando adotar
      { offset: 4, usuarios: 100 }, // Onda no pet de índice 4, com 100 usuários tentando adotar
    ],
  },
};

const cfg = PERFIS[PERFIL] || PERFIS.reduzido; // Seleciona a configuração do perfil escolhido; se inválido, usa o 'reduzido'
const DISPARO_MS = 2000; // Instante (em ms) em que as ondas de adoção são disparadas, durante a navegação
const BASE_URL = process.env.BASE_URL || 'http://localhost:3001'; // URL base da API (padrão localhost:3001), podendo ser sobrescrita por variável de ambiente

// Lista de endpoints de navegação (GETs) que os usuários de carga de fundo vão acessar aleatoriamente
const ENDPOINTS_NAV = [
  'GET /api/animais', // Lista todos os animais
  'GET /api/animais?porte=grande', // Lista animais filtrando por porte grande
  'GET /api/animais?idade=filhote', // Lista animais filtrando por idade filhote
  'GET /api/animais?localizacao=taguatinga', // Lista animais filtrando por localização Taguatinga
  'GET /api/animais?sexo=fêmea', // Lista animais filtrando por sexo fêmea
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // Função utilitária que pausa a execução por 'ms' milissegundos (usando Promise)
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min; // Retorna um número inteiro aleatório entre min e max (inclusive)
const escolha = (arr) => arr[Math.floor(Math.random() * arr.length)]; // Retorna um elemento aleatório do array passado

// Cria (se ainda não existir) e ZERA a tabela corrida_trava ANTES das ondas, para
// que ela reflita SOMENTE esta execução (sempre a última). Durante as adoções, o
// servidor (controller adotar) grava 1 linha por usuário — vencedor e perdedores —
// com o horário REAL em que cada um pegou a trava de linha. Assim o SELECT no
// pgAdmin/psql bate exatamente com a corrida desta rodada.
async function prepararCorridaTrava() {
  // Cria a tabela corrida_trava caso ela ainda não exista (mesma estrutura usada no teste simples)
  await pool.query(`CREATE TABLE IF NOT EXISTS corrida_trava (
    id SERIAL PRIMARY KEY,
    animal_id INT,
    usuario TEXT,
    travou_em TIMESTAMPTZ,
    encontrou CHAR(1),
    venceu BOOLEAN,
    registrado_em TIMESTAMPTZ DEFAULT now()
  )`);
  await pool.query('TRUNCATE corrida_trava RESTART IDENTITY'); // Esvazia a tabela e reinicia o id, para guardar só esta execução
}

// Lê a corrida_trava (gravada pelo servidor nesta execução) e imprime, por pet,
// quem pegou a trava primeiro e venceu — com o MESMO SELECT que você roda no banco,
// para o console BATER com o pgAdmin/psql.
async function mostrarCorridaTrava(ondas, totalAdocao) {
  // Consulta todas as linhas gravadas, ordenadas por pet e pelo instante da trava
  const { rows } = await pool.query(
    `SELECT animal_id, usuario,
            to_char(travou_em, 'HH24:MI:SS.US') AS pegou_a_trava,
            encontrou, venceu
       FROM corrida_trava
      ORDER BY animal_id, travou_em`
  );
  console.log(''); // Linha em branco
  console.log('🗄️  TABELA corrida_trava (no banco) — só desta execução (foi zerada antes das ondas):'); // Cabeçalho
  console.log("     SELECT usuario, to_char(travou_em,'HH24:MI:SS.US') AS pegou_a_trava,"); // Mostra o SELECT equivalente (parte 1)
  console.log('            encontrou, venceu FROM corrida_trava ORDER BY travou_em;'); // Mostra o SELECT equivalente (parte 2)
  console.log(''); // Linha em branco
  if (rows.length === 0) { // Se nada foi gravado, o servidor está desatualizado
    console.log('   (vazia) — o servidor não gravou nada nesta execução.'); // Avisa que a tabela está vazia
    console.log('   Reinicie o servidor com o código atual (npm start / npm run dev) e rode de novo.'); // Sugere reiniciar o servidor
    console.log(''); // Linha em branco
    return; // Encerra a função ✅
  }
  // Resumo por pet: o vencedor é a 1ª trava que encontrou 'D' (mudou D->I).
  console.log('   Vencedor de cada pet (1º a pegar a trava, encontrou D):'); // Subtítulo do resumo por pet
  console.log('   pet | vencedor             | pegou a trava    | tentativas'); // Cabeçalho das colunas
  console.log('   ' + '-'.repeat(62)); // Linha separadora
  for (const o of ondas) { // Para cada onda (pet)
    const doPet = rows.filter((r) => r.animal_id === o.petId); // Filtra as linhas daquele pet
    const venc = doPet.find((r) => r.venceu); // Encontra a linha do vencedor (venceu = true)
    const quem = venc ? venc.usuario : '(nenhum)'; // Id do usuário vencedor (ou '(nenhum)')
    const trava = venc ? venc.pegou_a_trava : '—'; // Horário em que o vencedor pegou a trava
    console.log(`   ${String(o.petId).padEnd(3)} | ${quem.padEnd(20)} | ${trava.padEnd(16)} | ${doPet.length}`); // Imprime a linha do pet
  }
  console.log(''); // Linha em branco
  console.log(`   → ${rows.length} linha(s) gravadas no total (1 por tentativa de adoção: vencedores + perdedores; esperado ≈ ${totalAdocao}).`); // Total de linhas vs. esperado
  console.log(''); // Linha em branco
}

// Busca no banco os 5 pets que serão alvo das ondas de adoção
async function selecionarPetsAlvo() {
  // Consulta os 5 primeiros animais com status 'D' (Disponível), ordenados por id
  const { rows } = await pool.query(
    "SELECT id, nome FROM animais WHERE status = 'D' ORDER BY id LIMIT 5"
  );
  if (rows.length < 5) { // Se não houver 5 animais disponíveis, o cenário não pode rodar
    // Lança um erro explicando o problema e como corrigir (atualizando o status no banco)
    throw new Error(
      `Preciso de pelo menos 5 animais com status 'D' para o cenário. Encontrei ${rows.length}. Rode: UPDATE animais SET status = 'D' WHERE id IN (1,2,3,4,5);`
    );
  }
  return rows; // Retorna a lista de pets encontrados
}

// Simula um único usuário navegando (fazendo vários GETs aleatórios na API)
async function navegacaoUsuario(idUsuario, idsExistentes, sessao, contador, deadlineMs) {
  const total = rand(cfg.navegacao.requestsPorUsuario[0], cfg.navegacao.requestsPorUsuario[1]); // Sorteia quantas requisições este usuário fará (dentro do intervalo configurado)
  for (let i = 0; i < total; i++) { // Repete para cada requisição que o usuário fará
    if (Date.now() - sessao.inicioMs > deadlineMs) return; // Se o tempo limite da navegação já passou, encerra este usuário

    let url; // Variável que guardará a URL escolhida para esta requisição
    const ep = escolha(ENDPOINTS_NAV.concat(['GET /api/animais/:id'])); // Escolhe aleatoriamente um endpoint (lista ou detalhe de um pet)
    if (ep === 'GET /api/animais/:id') { // Se o endpoint sorteado for o de detalhe de um animal específico
      url = `${BASE_URL}/api/animais/${escolha(idsExistentes)}`; // Monta a URL com um id de pet aleatório existente
    } else {
      url = BASE_URL + ep.replace('GET ', ''); // Caso contrário, monta a URL removendo o prefixo "GET " do endpoint
    }

    const enviadoEm = Date.now() - sessao.inicioMs; // Marca o instante de envio (relativo ao início da sessão)
    contador.emVoo++; // Incrementa o contador de requisições atualmente em andamento (em voo)
    contador.navTotal++; // Incrementa o total de requisições de navegação feitas
    try {
      const res = await fetch(url); // Faz a requisição HTTP GET para a URL
      await res.text(); // Lê o corpo da resposta como texto (para liberar a conexão)
      const respondidoEm = Date.now() - sessao.inicioMs; // Marca o instante em que a resposta chegou (relativo ao início)
      sessao.log({ // Registra o evento desta requisição no log da sessão
        tipo: 'request', // Tipo do evento: uma requisição
        acao: 'navegar', // Ação realizada: navegação
        usuarioId: idUsuario, // Identificador do usuário simulado
        enviadoEm, // Instante de envio
        respondidoEm, // Instante de resposta
        latencia: respondidoEm - enviadoEm, // Latência: tempo total entre envio e resposta
        status: res.status, // Código de status HTTP retornado
        url, // URL acessada
        motivo: '', // Motivo vazio pois não houve erro
      });
      if (res.status >= 200 && res.status < 400) contador.navOK++; // Se o status indica sucesso (2xx/3xx), conta como OK
      else contador.navFail++; // Caso contrário, conta como falha
    } catch (err) { // Se ocorreu um erro de rede ao fazer a requisição
      const respondidoEm = Date.now() - sessao.inicioMs; // Marca o instante do erro (relativo ao início)
      sessao.log({ // Registra o evento de falha no log da sessão
        tipo: 'request', // Tipo do evento: uma requisição
        acao: 'navegar', // Ação realizada: navegação
        usuarioId: idUsuario, // Identificador do usuário simulado
        enviadoEm, // Instante de envio
        respondidoEm, // Instante em que o erro ocorreu
        latencia: respondidoEm - enviadoEm, // Latência até o erro
        status: 0, // Status 0 indica que não houve resposta HTTP (erro de rede)
        url, // URL que foi tentada
        motivo: `Erro de rede: ${err.message}`, // Descrição do erro de rede ocorrido
      });
      contador.navFail++; // Conta esta requisição como falha
    } finally {
      contador.emVoo--; // Independente de sucesso ou erro, decrementa o contador de requisições em voo
    }

    await sleep(rand(50, 250)); // Espera um tempo aleatório (50 a 250ms) antes da próxima requisição, simulando comportamento humano
  }
}

// Dispara uma "onda" de adoção: vários usuários tentam adotar O MESMO pet ao mesmo tempo
async function adotarOnda(petId, petNome, usuariosIds, sessao, contador) {
  // Cria uma Promise para cada usuário da onda, todas executando em paralelo
  const promessas = usuariosIds.map(async (usuarioId) => {
    const enviadoEm = Date.now() - sessao.inicioMs; // Marca o instante de envio (relativo ao início da sessão)
    contador.emVoo++; // Incrementa o contador de requisições em andamento
    contador.adTotal++; // Incrementa o total de tentativas de adoção
    try {
      // Faz a requisição POST tentando adotar o pet
      const res = await fetch(`${BASE_URL}/api/animais/${petId}/adotar`, {
        method: 'POST', // Método HTTP POST
        headers: { 'Content-Type': 'application/json' }, // Cabeçalho indicando que o corpo é JSON
        body: JSON.stringify({ usuarioId }), // Corpo da requisição com o id do usuário que está adotando
      });
      const corpo = await res.json().catch(() => ({})); // Tenta ler a resposta como JSON; se falhar, usa um objeto vazio
      const respondidoEm = Date.now() - sessao.inicioMs; // Marca o instante em que a resposta chegou
      sessao.log({ // Registra o evento da tentativa de adoção no log
        tipo: 'request', // Tipo do evento: uma requisição
        acao: 'adotar', // Ação realizada: adoção
        usuarioId, // Id do usuário que tentou adotar
        petId, // Id do pet alvo
        nome: corpo.nome || petNome, // Nome do pet (vindo da resposta ou o nome conhecido)
        enviadoEm, // Instante de envio
        respondidoEm, // Instante de resposta
        latencia: respondidoEm - enviadoEm, // Latência total da requisição
        status: res.status, // Código de status HTTP retornado
        motivo: corpo.mensagem || corpo.motivo || '', // Mensagem/motivo retornado pelo servidor (ex.: pet já adotado)
        // Instrumentação do servidor (explica a corrida): ordem de chegada,
        // instante de recebimento (convertido para o referencial relativo) e
        // tempo gasto no banco.
        recebidoEm: corpo.recebidoEm != null ? corpo.recebidoEm - sessao.inicioMs : null, // Instante em que o servidor recebeu a requisição (convertido para o referencial da sessão)
        ordemChegada: corpo.ordemChegada != null ? corpo.ordemChegada : null, // Posição de chegada da requisição no servidor (1º, 2º, ...)
        dbMs: corpo.dbMs != null ? corpo.dbMs : null, // Tempo gasto pela operação no banco de dados
        // Job de notificação enfileirado pela adoção vencedora (fila + worker).
        jobId: corpo.jobId != null ? corpo.jobId : null, // Id do job de notificação criado na fila (só para a adoção vencedora)
      });
      if (res.status === 200) contador.adSucesso++; // Status 200: adoção bem-sucedida (venceu a corrida)
      else if (res.status === 409) contador.adConflito++; // Status 409: conflito, o pet já havia sido adotado
      else contador.adErro++; // Qualquer outro status: erro
    } catch (err) { // Se ocorreu um erro de rede
      const respondidoEm = Date.now() - sessao.inicioMs; // Marca o instante do erro
      sessao.log({ // Registra o evento de falha no log
        tipo: 'request', // Tipo do evento: uma requisição
        acao: 'adotar', // Ação realizada: adoção
        usuarioId, // Id do usuário que tentou adotar
        petId, // Id do pet alvo
        enviadoEm, // Instante de envio
        respondidoEm, // Instante em que o erro ocorreu
        latencia: respondidoEm - enviadoEm, // Latência até o erro
        status: 0, // Status 0 indica erro de rede (sem resposta HTTP)
        motivo: `Erro de rede: ${err.message}`, // Descrição do erro de rede
      });
      contador.adErro++; // Conta como erro de adoção
    } finally {
      contador.emVoo--; // Independente do resultado, decrementa o contador de requisições em voo
    }
  });

  await Promise.all(promessas); // Aguarda todas as tentativas de adoção da onda terminarem
}

// Verifica se o limite de arquivos abertos do sistema (ulimit) é suficiente para o teste
async function checarUlimit(totalRequests) {
  try {
    const { execSync } = require('child_process'); // Importa a função para executar comandos do sistema de forma síncrona
    const limite = parseInt(execSync('ulimit -n', { shell: '/bin/sh' }).toString().trim(), 10); // Executa o comando 'ulimit -n' e converte o resultado para número inteiro
    if (limite && limite < totalRequests + 100) { // Se o limite for menor que o necessário (com margem de 100)
      console.log(''); // Linha em branco para espaçamento
      console.log(`⚠️  AVISO: ulimit -n = ${limite}, mas o teste pode abrir até ~${totalRequests} conexões simultâneas.`); // Avisa sobre o limite insuficiente
      console.log(`   Pra evitar "EMFILE: too many open files" rode antes:`); // Sugere como evitar o erro de muitos arquivos abertos
      console.log(`   ulimit -n 4096 && PERFIL=${PERFIL} npm run stress:cenario`); // Mostra o comando recomendado para aumentar o limite
      console.log(''); // Linha em branco para espaçamento
      console.log('Continuando assim mesmo em 3s. Ctrl+C pra abortar.'); // Informa que vai continuar em 3 segundos
      await sleep(3000); // Espera 3 segundos para dar chance de cancelar
    }
  } catch {} // Ignora qualquer erro (ex.: comando ulimit indisponível no Windows)
}

// Verifica se o servidor da API está de pé antes de iniciar o teste
async function checarServidor() {
  try {
    const res = await fetch(`${BASE_URL}/api/animais`); // Faz uma requisição de teste à API
    if (!res.ok) throw new Error(`status ${res.status}`); // Se a resposta não for OK, lança erro com o status
  } catch (err) { // Se o servidor não respondeu ou retornou erro
    console.error(`❌ Servidor não respondeu em ${BASE_URL}. Suba ele antes: cd backend && npm start`); // Mostra mensagem orientando a subir o servidor
    console.error(`   Erro: ${err.message}`); // Mostra o detalhe do erro ocorrido
    process.exit(1); // Encerra o programa com código de erro 1
  }
}

// Função principal que orquestra todo o teste de cenário
async function main() {
  await checarServidor(); // Garante que o servidor está no ar antes de começar

  let pets; // Variável que guardará os pets-alvo do teste
  try {
    pets = await selecionarPetsAlvo(); // Busca os 5 pets disponíveis para as ondas de adoção
  } catch (err) { // Se não houver pets suficientes
    console.error(`❌ ${err.message}`); // Mostra a mensagem de erro
    await pool.end(); // Fecha o pool de conexões com o banco
    process.exit(1); // Encerra o programa com código de erro
  }

  // Garante que os pets escolhidos estejam com status 'D' (Disponível) antes do teste
  await pool.query(
    `UPDATE animais SET status = 'D' WHERE id = ANY($1::int[])`, // Atualiza o status para 'D' nos ids informados
    [pets.map((p) => p.id)] // Passa o array de ids dos pets selecionados
  );

  // Zera a corrida_trava ANTES das ondas: assim o banco guarda só ESTA execução
  // (sempre a última). Quem grava nela é o servidor, a cada tentativa de adoção.
  await prepararCorridaTrava(); // Cria (se preciso) e esvazia a tabela corrida_trava

  // Monta a estrutura de cada onda de adoção, associando pet e lista de usuários
  const ondas = cfg.ondasAdocao.map((o, i) => ({
    petId: pets[o.offset].id, // Id do pet daquela onda (usando o offset como índice na lista de pets)
    petNome: pets[o.offset].nome, // Nome do pet daquela onda
    usuariosIds: Array.from({ length: o.usuarios }, (_, k) => `ad-pet${pets[o.offset].id}-u${k + 1}`), // Gera os ids dos usuários adotantes daquela onda
  }));

  const totalAdocao = ondas.reduce((s, o) => s + o.usuariosIds.length, 0); // Soma o total de tentativas de adoção em todas as ondas
  // Estima o total de requisições de navegação (usuários × média de requisições por usuário)
  const totalNavEstimado = cfg.navegacao.usuarios * Math.ceil((cfg.navegacao.requestsPorUsuario[0] + cfg.navegacao.requestsPorUsuario[1]) / 2);
  const totalEstimado = totalAdocao + totalNavEstimado; // Estima o total geral de requisições do teste

  console.log('=== PLANO DO TESTE DE CENÁRIO ==='); // Cabeçalho do plano do teste
  console.log(`Perfil: ${PERFIL}`); // Mostra o perfil selecionado
  console.log(`Navegação: ${cfg.navegacao.usuarios} usuários por ${cfg.navegacao.duracaoMs}ms (≈ ${totalNavEstimado} GETs)`); // Mostra o resumo da carga de navegação
  console.log('Adoção:'); // Título da seção de adoção
  for (const o of ondas) { // Para cada onda de adoção
    console.log(`  - pet ${o.petId} (${o.petNome}): ${o.usuariosIds.length} usuários disparam em t=${DISPARO_MS}ms`); // Mostra os detalhes da onda
  }
  console.log(`Total adoção: ${totalAdocao} requests`); // Mostra o total de requisições de adoção
  console.log(`Total estimado: ≈ ${totalEstimado} requests`); // Mostra o total estimado de requisições
  console.log(`Pool PG max: ${pool.options.max}`); // Mostra o número máximo de conexões do pool do Postgres
  console.log(''); // Linha em branco

  await checarUlimit(totalEstimado); // Verifica se o limite de arquivos abertos do sistema é suficiente

  const sessao = criarSessao('stress-cenario'); // Cria uma nova sessão de teste (gera diretório e arquivos de log)
  // Objeto que acumula os contadores de resultados durante o teste
  const contador = {
    emVoo: 0, navTotal: 0, navOK: 0, navFail: 0, // Contadores de navegação: em andamento, total, sucessos e falhas
    adTotal: 0, adSucesso: 0, adConflito: 0, adErro: 0, // Contadores de adoção: total, sucessos, conflitos (409) e erros
  };

  const idsExistentes = pets.map((p) => p.id); // Extrai apenas os ids dos pets, usado nas requisições de detalhe

  console.log('🚀 Disparando navegação...'); // Informa que a carga de navegação está começando
  // Cria uma Promise de navegação para cada usuário simulado, todas rodando em paralelo
  const promessasNav = Array.from({ length: cfg.navegacao.usuarios }, (_, i) =>
    navegacaoUsuario(`nav-u${i + 1}`, idsExistentes, sessao, contador, cfg.navegacao.duracaoMs) // Inicia a navegação de um usuário
  );

  // Cria um intervalo que imprime o progresso do teste a cada 400ms
  const interval = setInterval(() => {
    const t = Date.now() - sessao.inicioMs; // Tempo decorrido desde o início da sessão
    process.stdout.write( // Escreve a linha de progresso (sobrescrevendo a anterior com \r)
      `\r[+${t}ms] navegação: ${contador.navTotal} reqs (${contador.emVoo} em voo) | adoção: ${contador.adTotal}/${totalAdocao} | sucessos: ${contador.adSucesso} | erros: ${contador.adErro}   `
    );
  }, 400);

  // Agenda uma mensagem no console para o momento exato do disparo das ondas de adoção
  setTimeout(() => {
    console.log(`\n💥 t=${DISPARO_MS}ms: disparando ${ondas.length} ondas de adoção em paralelo...`); // Avisa que as ondas estão sendo disparadas
  }, DISPARO_MS);

  // Após esperar até o instante de disparo, executa todas as ondas de adoção em paralelo
  const promessaAdocao = sleep(DISPARO_MS).then(() =>
    Promise.all(ondas.map((o) => adotarOnda(o.petId, o.petNome, o.usuariosIds, sessao, contador))) // Dispara todas as ondas simultaneamente
  );

  await Promise.all([...promessasNav, promessaAdocao]); // Aguarda toda a navegação e toda a adoção terminarem
  clearInterval(interval); // Para o intervalo de impressão de progresso
  process.stdout.write('\n'); // Pula uma linha no console após o progresso

  // Consulta o status final dos pets-alvo após o teste
  const { rows: finalRows } = await pool.query(
    `SELECT id, nome, status FROM animais WHERE id = ANY($1::int[]) ORDER BY id`, // Busca id, nome e status dos pets
    [idsExistentes] // Passa os ids dos pets-alvo
  );

  console.log(''); // Linha em branco
  console.log('=== RESULTADOS POR PET ==='); // Cabeçalho da seção de resultados por pet

  const linhas = []; // Array que acumulará uma linha de resumo por pet
  for (const onda of ondas) { // Para cada onda (pet) do teste
    const final = finalRows.find((r) => r.id === onda.petId); // Encontra o status final do pet desta onda
    const eventosPet = await lerEventosLog(sessao.dir, 'adotar', onda.petId); // Lê do log todos os eventos de adoção daquele pet
    const vencedor = eventosPet.find((e) => e.status === 200); // Encontra a requisição vencedora (status 200)
    const lat = estatisticas(eventosPet.map((e) => e.latencia)); // Calcula estatísticas de latência das tentativas desse pet
    linhas.push({ // Adiciona a linha de resumo deste pet
      petId: onda.petId, // Id do pet
      nome: onda.petNome, // Nome do pet
      tentativas: eventosPet.length, // Quantidade de tentativas de adoção
      vencedor: vencedor ? vencedor.usuarioId : '(nenhum)', // Id do usuário vencedor, ou '(nenhum)' se ninguém venceu
      latVencedor: vencedor ? `${vencedor.latencia}ms` : '-', // Latência da requisição vencedora
      latP50: `${lat.p50}ms`, // Latência mediana (percentil 50)
      latP95: `${lat.p95}ms`, // Latência no percentil 95
      latMax: `${lat.max}ms`, // Latência máxima
      statusFinal: final.status, // Status final do pet no banco (deve ser 'I' = Indisponível/Adotado)
    });
  }

  // Imprime o cabeçalho da tabela de resultados, alinhando as colunas com padEnd
  console.log(
    'pet | nome'.padEnd(28) +
      ' | tent | vencedor'.padEnd(24) +
      ' | lat venc'.padEnd(11) +
      ' | p50    | p95    | max    | final'
  );
  console.log('-'.repeat(110)); // Imprime uma linha separadora de 110 traços
  for (const l of linhas) { // Para cada linha de resumo
    // Imprime os dados do pet formatados em colunas alinhadas
    console.log(
      `${String(l.petId).padEnd(3)} | ${l.nome.padEnd(20)} | ${String(l.tentativas).padEnd(4)} | ${l.vencedor.padEnd(20)} | ${l.latVencedor.padEnd(8)} | ${l.latP50.padEnd(6)} | ${l.latP95.padEnd(6)} | ${l.latMax.padEnd(6)} | ${l.statusFinal}`
    );
  }

  const navEventos = await lerEventosLog(sessao.dir, 'navegar'); // Lê do log todos os eventos de navegação
  const adEventos = await lerEventosLog(sessao.dir, 'adotar'); // Lê do log todos os eventos de adoção
  const statsNav = estatisticas(navEventos.map((e) => e.latencia)); // Calcula estatísticas de latência da navegação
  const tpNav = throughput(navEventos); // Calcula o throughput (vazão) da navegação
  console.log(''); // Linha em branco
  console.log('=== NAVEGAÇÃO (carga de fundo: gente só olhando a lista) ==='); // Cabeçalho da seção de navegação
  console.log(`Total: ${contador.navTotal}  |  OK: ${contador.navOK}  |  Falhas: ${contador.navFail}`); // Mostra totais de navegação
  console.log(`Latência (ms): min=${statsNav.min}  p50=${statsNav.p50}  p95=${statsNav.p95}  p99=${statsNav.p99}  max=${statsNav.max}`); // Mostra as estatísticas de latência
  console.log('  (p50 = mediana; p95 = 95% responderam até esse valor; p99 = quase pior caso.)'); // Explica o significado dos percentis
  // Throughput pela JANELA REAL (1º envio → última resposta), não pela duração
  // nominal. Os usuários terminam bem antes do prazo, então dividir pelo prazo
  // cheio daria um número artificialmente baixo.
  console.log( // Mostra o throughput da navegação
    `Throughput: ${tpNav.reqPorSeg} req/s  (${tpNav.reqs} requisições ÷ ${tpNav.janelaSeg}s de janela real)`
  );
  console.log( // Explica por que a janela real é menor que o prazo configurado
    `  Obs.: a janela real (${tpNav.janelaSeg}s) é menor que o prazo configurado (${(cfg.navegacao.duracaoMs / 1000).toFixed(0)}s) porque`
  );
  console.log('  cada usuário faz só 3–6 GETs e termina cedo. Por isso o divisor é a janela medida, não o prazo.'); // Continua a explicação sobre o cálculo

  console.log(''); // Linha em branco
  console.log('=== ADOÇÃO (a corrida do RF014: 1 pet, vários tentando) ==='); // Cabeçalho da seção de adoção
  console.log( // Mostra os totais de adoção
    `Total: ${contador.adTotal}  |  Sucessos: ${contador.adSucesso}  |  Conflitos (409): ${contador.adConflito}  |  Erros: ${contador.adErro}`
  );
  console.log('  Sucesso = pegou a trava de linha primeiro.  409 = chegou e o pet já era I.'); // Explica o significado de sucesso e conflito

  const sucessosEsperados = ondas.length; // O número esperado de sucessos é 1 por pet (= número de ondas)
  const passouRF014 = contador.adSucesso === sucessosEsperados; // Verifica se o requisito RF014 foi atendido (sucessos = esperados)
  let mensagemVer; // Variável que guardará a mensagem do veredito
  if (passouRF014) { // Se o número de sucessos foi exatamente o esperado
    mensagemVer = `✅ RF014 atendido: exatamente ${sucessosEsperados} sucessos (um por pet). Concorrência sob controle.`; // Mensagem de sucesso
  } else if (contador.adSucesso > sucessosEsperados) { // Se houve mais sucessos que o esperado (pet adotado mais de uma vez)
    mensagemVer = `❌ RF014 violado: ${contador.adSucesso} sucessos quando o esperado eram ${sucessosEsperados}. Algum pet foi adotado mais de uma vez.`; // Mensagem de violação do requisito
  } else { // Se houve menos sucessos que o esperado
    mensagemVer = `❌ Resultado parcial: ${contador.adSucesso}/${sucessosEsperados} pets foram adotados. ${contador.adErro} erros sugerem que o servidor caiu ou o ulimit estourou.`; // Mensagem de resultado parcial/falha
  }
  console.log(mensagemVer); // Imprime o veredito

  // Estatísticas de latência das requisições de adoção.
  const statsAd = estatisticas(adEventos.map((e) => e.latencia)); // Calcula estatísticas de latência da adoção
  const tpAd = throughput(adEventos); // Calcula o throughput da adoção

  // ---- Explicação por pet: por que aquele usuário ganhou a corrida ----
  console.log(''); // Linha em branco
  console.log('=== POR QUE CADA PET TEVE 1 VENCEDOR (a causa, não só "latência") ==='); // Cabeçalho da seção explicativa
  for (const onda of ondas) { // Para cada onda (pet)
    const reqsPet = adEventos.filter((e) => e.petId === onda.petId); // Filtra apenas as requisições de adoção daquele pet
    const venc = reqsPet.find((e) => e.status === 200); // Encontra a requisição vencedora
    if (!venc) { // Se não houve vencedor
      console.log(`• pet ${onda.petId} (${onda.petNome}): nenhum vencedor (verifique o status inicial / erros).`); // Avisa que não houve vencedor
      continue; // Pula para a próxima onda
    }
    const temInstr = reqsPet.some((e) => e.ordemChegada != null); // Verifica se há dados de instrumentação (ordem de chegada) do servidor
    // Ordena as requisições pela ordem de chegada no servidor (ou, na falta, pelo instante de recebimento/envio)
    const ordenados = [...reqsPet].sort((a, b) =>
      a.ordemChegada != null && b.ordemChegada != null
        ? a.ordemChegada - b.ordemChegada // Se ambas têm ordem de chegada, ordena por ela
        : (a.recebidoEm ?? a.enviadoEm) - (b.recebidoEm ?? b.enviadoEm) // Caso contrário, ordena por tempo de recebimento ou envio
    );
    const pos = temInstr ? ordenados.findIndex((e) => e === venc) + 1 : null; // Descobre em que posição o vencedor chegou no servidor
    const minLat = Math.min(...reqsPet.map((e) => e.latencia)); // Encontra a menor latência entre as requisições desse pet
    const donoMin = reqsPet.find((e) => e.latencia === minLat); // Encontra qual requisição teve a menor latência
    // Monta a frase sobre a ordem de chegada do vencedor no servidor
    const chegada = temInstr
      ? pos === 1
        ? 'chegou em 1º no servidor' // Se chegou em primeiro
        : `chegou em ${pos}º no servidor (mas pegou a trava de linha antes dos que chegaram antes)` // Se chegou depois mas ainda venceu a trava
      : 'pegou a trava de linha primeiro'; // Sem instrumentação, só sabemos que pegou a trava primeiro
    // Monta a frase comparando o vencedor com quem teve a menor latência
    const sobreLat =
      venc.usuarioId === donoMin.usuarioId
        ? `teve a menor latência (${minLat}ms) por consequência, não por causa` // O vencedor também teve a menor latência (efeito, não causa)
        : `NÃO teve a menor latência — a menor (${minLat}ms) foi de "${donoMin.usuarioId}", que perdeu (409)`; // O vencedor não teve a menor latência
    console.log( // Imprime a explicação do vencedor desta onda
      `• pet ${onda.petId} (${onda.petNome}): venceu "${venc.usuarioId}" — ${chegada}; ${sobreLat}.`
    );
  }
  console.log('  Causa em 1 frase: o 1º UPDATE a pegar a TRAVA DE LINHA no Postgres vence; os demais viram 409.'); // Resume a causa raiz da corrida

  // ---- Prova no BANCO: a corrida_trava desta execução (zerada antes das ondas) ----
  // Mostra, com o mesmo SELECT do pgAdmin/psql, os horários reais da trava gravados
  // pelo servidor — refletindo SOMENTE esta rodada (vencedor de cada um dos 5 pets).
  await mostrarCorridaTrava(ondas, totalAdocao); // Imprime o resumo da corrida_trava desta execução

  // ---- Evidência de PARALELISMO (fila + worker) ----
  // Cada adoção vencedora enfileirou um job de notificação; o worker (processo
  // separado) consome a fila em background. Com 2+ workers de pé, os jobs saem
  // distribuídos entre eles sem duplicar (FOR UPDATE SKIP LOCKED).
  const jobsIds = adEventos.filter((e) => e.status === 200 && e.jobId != null).map((e) => e.jobId); // Coleta os ids dos jobs de notificação criados pelas adoções vencedoras
  let filaResumo = 'sem jobs'; // Resumo da fila (valor padrão caso não haja jobs)
  if (jobsIds.length > 0) { // Se houve jobs enfileirados
    console.log(''); // Linha em branco
    console.log('=== PARALELISMO (fila + worker): notificações em background ==='); // Cabeçalho da seção de paralelismo
    console.log(`As ${jobsIds.length} adoções vencedoras enfileiraram jobs; as respostas HTTP já voltaram.`); // Explica que os jobs foram enfileirados
    // A fila é FIFO: jobs pendentes mais antigos saem antes dos desta rodada.
    // A janela de espera cresce com o backlog para não acusar o worker à toa.
    // Conta quantos jobs pendentes ('P') existem antes dos jobs desta rodada (o "backlog" acumulado)
    const { rows: backlogRows } = await pool.query(
      "SELECT count(*)::int AS n FROM fila_notificacoes WHERE status = 'P' AND id < $1", // Conta jobs pendentes com id menor que o menor job desta rodada
      [Math.min(...jobsIds)] // Usa o menor id de job desta rodada como referência
    );
    const backlog = backlogRows[0].n; // Quantidade de jobs pendentes anteriores
    const maxIter = 24 + backlog * 4; // Número máximo de tentativas de verificação (cresce com o backlog)
    const iterSemProgresso = 6 + backlog * 3; // Tolerância de iterações sem progresso antes de desistir
    let jobsRows = []; // Guardará o estado atual dos jobs desta rodada
    for (let i = 0; i < maxIter; i++) { // Faz polling: verifica repetidamente se os jobs foram concluídos
      // Consulta o estado atual dos jobs desta rodada (status, quem processou e tempo até o processamento)
      ({ rows: jobsRows } = await pool.query(
        `SELECT id, payload->>'nome' AS pet, status, processado_por,
                round(EXTRACT(EPOCH FROM (processado_em - criado_em))::numeric, 1) AS seg
           FROM fila_notificacoes WHERE id = ANY($1::int[]) ORDER BY id`, // Busca os jobs cujos ids estão na lista
        [jobsIds] // Passa os ids dos jobs desta rodada
      ));
      const concluidos = jobsRows.filter((r) => r.status === 'C').length; // Conta quantos jobs já foram concluídos ('C')
      process.stdout.write(`\r  aguardando workers: ${concluidos}/${jobsIds.length} jobs concluídos...   `); // Mostra o progresso do processamento dos jobs
      if (concluidos === jobsIds.length) break; // Se todos os jobs foram concluídos, encerra o polling
      // Sem nenhum job desta rodada concluído após a tolerância, não deve haver worker de pé.
      if (i >= iterSemProgresso && concluidos === 0) break; // Se passou da tolerância e nada foi processado, desiste (provavelmente não há worker)
      await sleep(500); // Espera 500ms antes da próxima verificação
    }
    process.stdout.write('\n'); // Pula uma linha após o polling
    for (const r of jobsRows) { // Para cada job desta rodada
      // Monta a descrição do que aconteceu com o job
      const quem =
        r.status === 'C'
          ? `processado por "${r.processado_por}" ${r.seg}s após a adoção` // Job concluído: mostra qual worker o processou e em quanto tempo
          : 'PENDENTE — worker ocupado ou fora do ar (confira: npm run fila | suba: npm run worker)'; // Job ainda pendente: orienta o usuário
      console.log(`  • job #${r.id} (${r.pet}): ${quem}`); // Imprime a situação de cada job
    }
    const concluidos = jobsRows.filter((r) => r.status === 'C').length; // Reconta os jobs concluídos para o resumo
    const workers = [...new Set(jobsRows.filter((r) => r.processado_por).map((r) => r.processado_por))]; // Lista os workers distintos que processaram jobs
    filaResumo = `${concluidos}/${jobsIds.length} jobs por ${workers.length} worker(s)`; // Monta o texto-resumo da fila
    if (workers.length > 1) { // Se mais de um worker processou jobs (paralelismo real)
      console.log(`  ⚡ Jobs distribuídos entre ${workers.length} workers em PARALELO (${workers.join(', ')}),`); // Mostra que houve distribuição entre workers
      console.log('     nenhum job duplicado — é o FOR UPDATE SKIP LOCKED entregando cada job a um único worker.'); // Explica o mecanismo que evita duplicação
    }
  }

  // Salva o resumo completo do teste (usado para gerar o relatório)
  sessao.salvar({
    nome: `Teste de cenário — perfil ${PERFIL}`, // Nome do teste, incluindo o perfil usado
    descricao: `${cfg.navegacao.usuarios} usuários navegando + ${ondas.length} ondas de adoção paralelas (${totalAdocao} adotantes).`, // Descrição resumida do cenário
    inicioISO: new Date(sessao.inicioMs).toISOString(), // Data/hora de início da sessão em formato ISO
    config: { PERFIL, BASE_URL, navegacao: cfg.navegacao, ondas: ondas.map((o) => ({ petId: o.petId, usuarios: o.usuariosIds.length })) }, // Configuração usada no teste
    cards: [ // Lista de cards-resumo exibidos no relatório
      { label: 'Perfil', valor: PERFIL, dica: 'reduzido (~550 reqs) ou cheio (~6000 reqs).' }, // Card do perfil utilizado
      { label: 'Usuários navegando', valor: String(cfg.navegacao.usuarios), dica: 'Carga de fundo: pessoas só consultando a lista de animais.' }, // Card de usuários navegando
      { label: 'Usuários adotando', valor: String(totalAdocao), dica: 'Total de tentativas de adoção somando as 5 ondas.' }, // Card de usuários adotando
      { label: 'Adoção sucesso', valor: String(contador.adSucesso), sub: `esperado: ${sucessosEsperados}`, dica: 'Deve ser 1 por pet. Mais que o esperado = RF014 violado.' }, // Card de adoções bem-sucedidas
      { label: 'Adoção 409', valor: String(contador.adConflito), dica: 'Perdedores corretos: chegaram quando o pet já era I.' }, // Card de conflitos (409)
      { label: 'Adoção erros', valor: String(contador.adErro), dica: 'Erros de servidor/rede. Deveria ser 0.' }, // Card de erros de adoção
      { label: 'Adoção throughput', valor: `${tpAd.reqPorSeg} req/s`, sub: `${tpAd.janelaSeg}s de janela`, dica: 'Vazão da adoção medida na janela real (1º envio → última resposta).' }, // Card de throughput de adoção
      { label: 'Navegação total', valor: String(contador.navTotal), dica: 'Quantos GETs a carga de fundo fez no total.' }, // Card do total de navegação
      { label: 'Nav throughput', valor: `${tpNav.reqPorSeg} req/s`, sub: `${tpNav.janelaSeg}s de janela`, dica: 'Vazão da navegação na janela real — não na duração nominal.' }, // Card de throughput de navegação
      { label: 'Nav p50', valor: `${statsNav.p50}ms`, dica: 'Mediana da latência de navegação.' }, // Card da latência mediana de navegação
      { label: 'Nav p95', valor: `${statsNav.p95}ms`, dica: '95% das navegações responderam em até esse tempo.' }, // Card da latência p95 de navegação
      { label: 'Nav p99', valor: `${statsNav.p99}ms`, dica: 'Quase pior caso da navegação.' }, // Card da latência p99 de navegação
      { label: 'PG pool max', valor: String(pool.options.max), dica: 'Conexões simultâneas no Postgres. Acima disso, os pedidos fazem fila.' }, // Card do limite do pool do Postgres
      { label: 'Fila (background)', valor: filaResumo, dica: 'Jobs de notificação enfileirados pelas adoções e processados pelo(s) worker(s) em processo separado (fila + worker).' }, // Card do resumo da fila de notificações
    ],
    veredito: { ok: passouRF014, mensagem: mensagemVer }, // Veredito final (se passou no RF014 e a mensagem)
    estatisticas: { navegacao: statsNav, adocao: statsAd }, // Estatísticas de latência de navegação e adoção
    throughput: { navegacao: tpNav, adocao: tpAd }, // Throughput de navegação e adoção
    porPet: linhas, // Detalhamento dos resultados por pet
  });

  await sessao.fechar(); // Fecha a sessão (finaliza os arquivos de log)
  const htmlPath = sessao.gerarHTML(); // Gera o relatório HTML e guarda o caminho do arquivo

  console.log(''); // Linha em branco
  console.log(`📄 Relatório HTML: ${htmlPath}`); // Mostra o caminho do relatório HTML gerado
  console.log(`📁 Logs JSONL:     ${sessao.dir}/log.jsonl`); // Mostra o caminho do arquivo de log em formato JSONL
  console.log(`📁 Summary JSON:   ${sessao.dir}/summary.json`); // Mostra o caminho do resumo em JSON
  console.log(''); // Linha em branco
  console.log(`Pra abrir o relatório no Mac:  open "${htmlPath}"`); // Mostra o comando para abrir o relatório no Mac

  await pool.end(); // Fecha o pool de conexões com o banco
  process.exit(passouRF014 ? 0 : 1); // Encerra o programa com código 0 (sucesso) se passou no RF014, ou 1 (falha) caso contrário
}

// Lê o arquivo de log e retorna os eventos filtrados por ação (e opcionalmente por pet)
async function lerEventosLog(dir, acao, petId) {
  const fs = require('fs'); // Importa o módulo de sistema de arquivos
  const path = require('path'); // Importa o módulo para manipular caminhos
  const linhas = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf-8').trim().split('\n').filter(Boolean); // Lê o arquivo log.jsonl, divide por linhas e remove linhas vazias
  return linhas
    .map((l) => JSON.parse(l)) // Converte cada linha (texto JSON) em objeto
    .filter((e) => e.tipo === 'request' && e.acao === acao && (petId == null || e.petId === petId)); // Filtra apenas requisições da ação desejada (e do pet, se informado)
}

main(); // Inicia a execução do teste chamando a função principal

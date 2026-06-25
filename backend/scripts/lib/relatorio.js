const fs = require('fs'); // Importa o modulo de sistema de arquivos do Node (ler/escrever arquivos)
const path = require('path'); // Importa o modulo para montar caminhos de arquivos de forma segura

// Define o diretorio de saida "out" (sobe dois niveis a partir desta pasta lib)
const OUT_DIR = path.join(__dirname, '..', '..', 'out');

// Gera um carimbo de tempo (timestamp) no formato AAAAMMDD-HHMMSS para nomear pastas
function ts() {
  const d = new Date(); // Captura a data e hora atuais
  const p = (n) => String(n).padStart(2, '0'); // Funcao auxiliar: transforma numero em texto com 2 digitos (ex: 5 -> "05")
  // Monta a string final concatenando ano, mes, dia, hora, minuto e segundo formatados
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Cria uma "sessao" de teste: uma pasta com log e funcoes para registrar e salvar resultados
function criarSessao(nome) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true }); // Cria a pasta "out" se ela ainda nao existir
  const dir = path.join(OUT_DIR, `${nome}-${ts()}`); // Monta o caminho da pasta desta sessao (nome + timestamp)
  fs.mkdirSync(dir, { recursive: true }); // Cria fisicamente a pasta da sessao

  const logPath = path.join(dir, 'log.jsonl'); // Caminho do arquivo de log (uma linha JSON por evento)
  const logStream = fs.createWriteStream(logPath); // Abre um fluxo de escrita para gravar o log incrementalmente
  const inicioMs = Date.now(); // Marca o instante de inicio da sessao em milissegundos

  // Retorna um objeto com as funcoes que controlam a sessao de teste
  return {
    dir, // Caminho da pasta da sessao
    inicioMs, // Instante de inicio da sessao
    // Registra um evento no arquivo de log, adicionando o tempo absoluto atual
    log(evento) {
      logStream.write(JSON.stringify({ tAbs: Date.now(), ...evento }) + '\n'); // Escreve o evento como uma linha JSON
    },
    // Salva o resumo final do teste em um arquivo summary.json
    salvar(summary) {
      fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2)); // Grava o JSON formatado com indentacao 2
    },
    // Le os arquivos de log e resumo e gera o relatorio HTML
    gerarHTML() {
      const linhas = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean); // Le o log, remove espacos, separa por linha e descarta vazias
      const eventos = linhas.map((l) => JSON.parse(l)); // Converte cada linha de texto JSON em objeto JavaScript
      const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf-8')); // Le e converte o arquivo de resumo
      const html = construirHTML(eventos, summary); // Monta o conteudo HTML do relatorio
      const htmlPath = path.join(dir, 'report.html'); // Define o caminho do arquivo HTML de saida
      fs.writeFileSync(htmlPath, html); // Grava o HTML no disco
      return htmlPath; // Retorna o caminho do relatorio gerado
    },
    // Fecha o fluxo de log, retornando uma Promise que resolve quando terminar
    fechar() {
      return new Promise((r) => logStream.end(r)); // Encerra o stream e chama o resolve quando concluido
    },
  };
}

// ---------------------------------------------------------------------------
// PERCENTIL — interpolação linear (método R-7), equivalente ao padrão do NumPy
// e à função PERCENTIL.INC do Excel.
//
// Encontra a posição fracionária do percentil no vetor ordenado e interpola
// entre os dois vizinhos:
//   posição = (p/100) · (N − 1)        → 0 = primeiro valor, N−1 = último
//   valor   = arr[piso] + fração · (arr[teto] − arr[piso])
// ---------------------------------------------------------------------------
function percentil(arr, p) {
  if (arr.length === 0) return 0; // Sem dados: retorna 0
  if (arr.length === 1) return arr[0]; // Com um unico valor: ele proprio e o percentil
  const s = [...arr].sort((a, b) => a - b); // Copia o vetor e ordena em ordem crescente
  const pos = (p / 100) * (s.length - 1); // Calcula a posicao fracionaria do percentil (0 = primeiro, N-1 = ultimo)
  const piso = Math.floor(pos); // Indice inteiro abaixo da posicao (vizinho de baixo)
  const teto = Math.ceil(pos); // Indice inteiro acima da posicao (vizinho de cima)
  const fracao = pos - piso; // Parte fracionaria usada para interpolar entre os dois vizinhos
  return s[piso] + fracao * (s[teto] - s[piso]); // Interpolacao linear entre os valores vizinhos
}

// Calcula estatisticas resumidas (min, percentis, max, media) de um vetor de latencias
function estatisticas(latencias) {
  if (latencias.length === 0) return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, media: 0 }; // Sem dados: retorna tudo zerado
  const s = [...latencias].sort((a, b) => a - b); // Copia e ordena as latencias em ordem crescente
  const soma = s.reduce((a, b) => a + b, 0); // Soma todas as latencias para calcular a media depois
  // Monta o objeto com todas as estatisticas calculadas
  return {
    count: s.length, // Quantidade de amostras
    min: s[0], // Menor latencia (primeiro elemento do vetor ordenado)
    p50: Math.round(percentil(s, 50)), // Mediana (percentil 50), arredondada
    p95: Math.round(percentil(s, 95)), // Percentil 95, arredondado
    p99: Math.round(percentil(s, 99)), // Percentil 99, arredondado
    max: s[s.length - 1], // Maior latencia (ultimo elemento do vetor ordenado)
    media: Math.round(soma / s.length), // Media aritmetica arredondada
  };
}

// ---------------------------------------------------------------------------
// THROUGHPUT — vazão (requisições por segundo) medida sobre a janela real de
// execução: do instante em que a primeira requisição foi enviada até o instante
// em que a última foi respondida. Vazão = total de requisições ÷ janela.
// ---------------------------------------------------------------------------
function throughput(eventos) {
  if (!eventos || eventos.length === 0) { // Se nao houver eventos
    return { reqs: 0, janelaMs: 0, janelaSeg: 0, reqPorSeg: 0 }; // Retorna vazao zerada
  }
  const inicio = Math.min(...eventos.map((e) => e.enviadoEm)); // Instante em que a primeira requisicao foi enviada
  const fim = Math.max(...eventos.map((e) => e.respondidoEm)); // Instante em que a ultima resposta chegou
  const janelaMs = Math.max(1, fim - inicio); // Duracao real da janela em ms (no minimo 1 para evitar divisao por zero)
  // Monta o objeto com os dados de vazao
  return {
    reqs: eventos.length, // Total de requisicoes
    janelaMs, // Janela em milissegundos
    janelaSeg: +(janelaMs / 1000).toFixed(2), // Janela em segundos (2 casas decimais)
    reqPorSeg: +((eventos.length * 1000) / janelaMs).toFixed(1), // Requisicoes por segundo (vazao), 1 casa decimal
  };
}

// Distribui as latencias em faixas (buckets) para montar um histograma
function histograma(latencias, buckets = [10, 25, 50, 100, 250, 500, 1000, 2500]) {
  const contagem = new Array(buckets.length + 1).fill(0); // Cria um vetor de contadores (um a mais que os buckets, para o "acima do maior")
  for (const l of latencias) { // Para cada latencia
    let i = 0; // Indice do bucket a partir do qual procurar
    while (i < buckets.length && l >= buckets[i]) i++; // Avanca enquanto a latencia for maior ou igual ao limite do bucket
    contagem[i]++; // Incrementa o contador do bucket encontrado
  }
  const labels = [`< ${buckets[0]}ms`]; // Primeiro rotulo: valores abaixo do menor limite
  for (let i = 1; i < buckets.length; i++) labels.push(`${buckets[i - 1]}-${buckets[i]}ms`); // Rotulos intermediarios (faixa entre dois limites)
  labels.push(`> ${buckets[buckets.length - 1]}ms`); // Ultimo rotulo: valores acima do maior limite
  return labels.map((label, i) => ({ label, count: contagem[i] })); // Junta cada rotulo com sua contagem correspondente
}

// Escapa caracteres especiais de HTML para evitar quebra de layout ou injecao de codigo
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); // Substitui cada caractere perigoso por sua entidade HTML
}

// Devolve uma cor (codigo hexadecimal) de acordo com o status HTTP
function corPorStatus(status) {
  if (status === 200) return '#22c55e'; // Verde: sucesso (adotou)
  if (status === 409) return '#eab308'; // Amarelo: conflito (perdeu a corrida)
  if (status === 404) return '#a855f7'; // Roxo: nao encontrado
  return '#ef4444'; // Vermelho: erro (5xx ou rede)
}

// Monta, para um pet, a explicação textual de POR QUE aquele usuário venceu,
// usando os dados reais de ordem de chegada, latência e tempo de banco.
function analisarCorrida(reqsPet) {
  const vencedor = reqsPet.find((r) => r.status === 200); // Encontra a requisicao vencedora (a unica que recebeu 200)
  if (!reqsPet.length) return null; // Se nao houver requisicoes para este pet, retorna null

  // Ordena as requisicoes pela ordem de chegada no servidor
  const ordenadosPorChegada = [...reqsPet].sort((a, b) => {
    if (a.ordemChegada != null && b.ordemChegada != null) return a.ordemChegada - b.ordemChegada; // Se ambas tem ordem de chegada, usa esse criterio
    return (a.recebidoEm ?? a.enviadoEm) - (b.recebidoEm ?? b.enviadoEm); // Caso contrario, usa o instante de recebimento (ou de envio como reserva)
  });

  const temInstrumentacao = reqsPet.some((r) => r.ordemChegada != null); // Indica se o servidor registrou a ordem de chegada
  const latencias = reqsPet.map((r) => r.latencia); // Extrai apenas as latencias de cada requisicao
  const minLat = Math.min(...latencias); // Calcula a menor latencia observada
  const donoMinLat = reqsPet.find((r) => r.latencia === minLat); // Encontra a requisicao que teve a menor latencia

  let posVencedorNaChegada = null; // Posicao do vencedor na ordem de chegada (inicialmente desconhecida)
  if (vencedor && temInstrumentacao) { // Se ha vencedor e dados de ordem de chegada
    posVencedorNaChegada = ordenadosPorChegada.findIndex((r) => r === vencedor) + 1; // Acha a posicao do vencedor (1-based)
  }

  // Retorna o objeto com toda a analise da corrida
  return {
    vencedor, // A requisicao vencedora
    ordenadosPorChegada, // Requisicoes ordenadas pela chegada
    temInstrumentacao, // Se ha dados de ordem de chegada
    minLat, // Menor latencia
    donoMinLat, // Requisicao com a menor latencia
    posVencedorNaChegada, // Posicao do vencedor na chegada
    venceuComMenorLatencia: vencedor && donoMinLat && vencedor.usuarioId === donoMinLat.usuarioId, // Verdadeiro se o vencedor tambem teve a menor latencia
  };
}

// Gera o bloco HTML que explica, para um pet, por que aquele usuario venceu a corrida
function blocoPorQueGanhou(petId, nomePet, reqsPet) {
  const a = analisarCorrida(reqsPet); // Analisa a corrida deste pet
  if (!a || !a.vencedor) { // Se nao houver analise ou nao houver vencedor
    // Bloco HTML alternativo: caso em que nenhum usuario conseguiu adotar (sem 200)
    return `<div class="corrida">
      <div class="corrida-head"><strong>Pet ${petId}${nomePet ? ` — ${escapeHTML(nomePet)}` : ''}</strong>
      <span class="badge badge-fail">❌ Nenhum usuário conseguiu adotar</span></div>
      <p class="explica">Ninguém recebeu 200. Se o animal já estava indisponível, isso é o esperado; caso contrário, o servidor pode ter caído durante a corrida.</p>
    </div>`;
  }

  const v = a.vencedor; // Atalho para a requisicao vencedora
  const totalTent = reqsPet.length; // Total de tentativas de adocao deste pet

  // Frases dinâmicas baseadas nos dados reais da corrida.
  // Frase que explica em que posicao o vencedor chegou ao servidor
  const fraseChegada = a.temInstrumentacao
    ? (a.posVencedorNaChegada === 1
        ? `Foi o <strong>1º pedido a chegar no servidor</strong> (de ${totalTent}). Chegou primeiro e seu <code>UPDATE</code> foi também o primeiro a encostar na trava de linha.`
        : `Chegou ao servidor na <strong>${a.posVencedorNaChegada}ª posição</strong> (de ${totalTent}) — <em>não</em> foi o primeiríssimo a chegar, mas seu <code>UPDATE</code> foi o primeiro a conquistar a trava de linha. A fila do pool de conexões pode reordenar quem encosta no banco primeiro.`)
    : `Foi o primeiro <code>UPDATE</code> a conquistar a trava de linha no Postgres. (Rode de novo com o servidor atualizado para ver a ordem exata de chegada.)`;

  // Frase que explica o papel da latencia: se o vencedor teve a menor latencia ou nao
  const fraseLatencia = a.venceuComMenorLatencia
    ? `Neste caso o vencedor <em>também</em> teve a menor latência (${a.minLat}ms) — mas isso é consequência, não causa: ele não esperou a trava de ninguém, então respondeu rápido.`
    : `Repare no ponto-chave: a <strong>menor latência foi ${a.minLat}ms, do usuário ${escapeHTML(a.donoMinLat.usuarioId)}, que MESMO ASSIM PERDEU</strong> (recebeu 409). Ou seja, <strong>latência não decide a corrida</strong> — quem decide é a ordem da trava de linha no banco.`;

  // Mini-tabela dos primeiros a chegar (até 8), destacando o vencedor.
  const primeiros = a.ordenadosPorChegada.slice(0, 8); // Pega ate as 8 primeiras requisicoes na ordem de chegada
  // Monta as linhas (<tr>) da mini-tabela, uma para cada requisicao
  const linhasMini = primeiros
    .map((r, i) => {
      const ehVenc = r === v; // Verifica se esta linha e a do vencedor
      // Posição RELATIVA na corrida deste pet (1º, 2º...), não o contador global.
      const ordem = `${i + 1}º`; // Texto da posicao relativa na corrida (1o, 2o, ...)
      // Linha HTML da tabela com os dados da requisicao (destacada se for a vencedora)
      return `<tr class="${ehVenc ? 'venc' : ''}">
        <td>${ordem}</td>
        <td>${escapeHTML(r.usuarioId)}</td>
        <td>${r.recebidoEm != null ? `+${r.recebidoEm}ms` : '—'}</td>
        <td class="status-${r.status === 200 ? 'ok' : r.status === 409 ? 'conflict' : 'erro'}">${r.status}${ehVenc ? ' 🏆' : ''}</td>
        <td>${r.latencia}ms</td>
        <td>${r.dbMs != null ? `${r.dbMs}ms` : '—'}</td>
      </tr>`;
    })
    .join(''); // Junta todas as linhas em um unico texto HTML

  // Bloco HTML principal: cabecalho, explicacao do vencedor, mini-tabela e legenda
  return `<div class="corrida">
    <div class="corrida-head">
      <strong>Pet ${petId}${nomePet ? ` — ${escapeHTML(nomePet)}` : ''}</strong>
      <span class="badge badge-ok">🏆 Vencedor: ${escapeHTML(v.usuarioId)}</span>
      <span class="badge">${totalTent} tentativas · 1 ganhou · ${totalTent - 1} levaram 409</span>
    </div>
    <p class="explica"><strong>Por que ${escapeHTML(v.usuarioId)} ganhou?</strong> ${fraseChegada} ${fraseLatencia}</p>
    <table class="mini">
      <thead><tr><th>Chegada</th><th>Usuário</th><th>Chegou em</th><th>Status</th><th>Latência (cliente)</th><th>Tempo no banco</th></tr></thead>
      <tbody>${linhasMini}</tbody>
    </table>
    <p class="legenda-mini">Ordenado pela <strong>ordem de chegada no servidor</strong>. <em>Chegou em</em> = instante (ms desde o disparo) em que o servidor recebeu o pedido. <em>Tempo no banco</em> = fila do pool + espera da trava + execução do UPDATE.</p>
  </div>`;
}

// Monta o documento HTML completo do relatorio a partir dos eventos e do resumo
function construirHTML(eventos, summary) {
  const requests = eventos.filter((e) => e.tipo === 'request'); // Filtra apenas os eventos do tipo "request"
  const adocao = requests.filter((e) => e.acao === 'adotar'); // Separa as requisicoes de adocao
  const navegacao = requests.filter((e) => e.acao === 'navegar'); // Separa as requisicoes de navegacao

  // Lista de IDs de pets disputados na adocao, sem repeticoes e em ordem crescente
  const petsAdocao = [...new Set(adocao.map((r) => r.petId))].sort((a, b) => a - b);

  let tMin = 0; // Menor instante de envio (inicio da janela)
  let tMax = 0; // Maior instante de resposta (fim da janela)
  if (adocao.length > 0) { // Se houve requisicoes de adocao
    tMin = Math.min(...adocao.map((r) => r.enviadoEm)); // Calcula o primeiro envio
    tMax = Math.max(...adocao.map((r) => r.respondidoEm)); // Calcula a ultima resposta
  }
  const span = Math.max(1, tMax - tMin); // Duracao total da janela (no minimo 1 para evitar divisao por zero)

  const larguraSVG = 1000; // Largura logica do grafico SVG da timeline

  // Gera o HTML de uma timeline (grafico SVG) para cada pet disputado
  const timelinesHTML = petsAdocao.map((petId) => {
    const reqsPet = adocao.filter((r) => r.petId === petId).sort((a, b) => a.enviadoEm - b.enviadoEm); // Requisicoes deste pet, ordenadas por envio
    const nomePet = (reqsPet.find((r) => r.nome) || {}).nome || `pet ${petId}`; // Nome do pet (ou rotulo padrao se nao houver)
    const vencedor = reqsPet.find((r) => r.status === 200); // Requisicao vencedora deste pet

    // Gera os retangulos SVG (uma barra por requisicao) que formam a timeline
    const linhas = reqsPet
      .map((r, idx) => {
        const x1 = ((r.enviadoEm - tMin) / span) * (larguraSVG - 80) + 80; // Posicao X inicial da barra (proporcional ao instante de envio)
        const x2 = ((r.respondidoEm - tMin) / span) * (larguraSVG - 80) + 80; // Posicao X final da barra (proporcional ao instante de resposta)
        const y = idx * 3 + 4; // Posicao Y da barra (cada requisicao em uma linha)
        const cor = corPorStatus(r.status); // Cor da barra de acordo com o status HTTP
        const venceu = r === vencedor; // Indica se esta barra e a do vencedor
        const stroke = venceu ? `stroke="#1e293b" stroke-width="1"` : ''; // Contorno extra para destacar o vencedor
        // Retangulo SVG representando a duracao da requisicao, com tooltip de detalhes
        return `<rect x="${x1.toFixed(1)}" y="${y}" width="${Math.max(1, x2 - x1).toFixed(1)}" height="2" fill="${cor}" ${stroke}><title>${escapeHTML(r.usuarioId)} → ${r.status} (${r.latencia}ms)</title></rect>`;
      })
      .join(''); // Junta todos os retangulos em um unico texto

    const alturaSVG = reqsPet.length * 3 + 16; // Altura do SVG, proporcional ao numero de requisicoes
    // Bloco HTML da timeline: cabecalho com vencedor e o grafico SVG
    return `
      <div class="timeline">
        <div class="timeline-head">
          <strong>Pet ${petId}${nomePet ? ` — ${escapeHTML(nomePet)}` : ''}</strong>
          <span class="badge">${reqsPet.length} tentativas</span>
          ${vencedor ? `<span class="badge badge-ok">🏆 Vencedor: ${escapeHTML(vencedor.usuarioId)} (${vencedor.latencia}ms)</span>` : '<span class="badge badge-fail">❌ Sem vencedor</span>'}
        </div>
        <svg width="100%" viewBox="0 0 ${larguraSVG} ${alturaSVG}" preserveAspectRatio="none">
          <line x1="80" y1="0" x2="80" y2="${alturaSVG}" stroke="#cbd5e1" stroke-width="0.5"/>
          ${linhas}
        </svg>
      </div>
    `;
  }).join(''); // Junta as timelines de todos os pets

  // Blocos "por que ganhou" — um por pet.
  // Gera o bloco explicativo "por que ganhou" para cada pet disputado
  const corridasHTML = petsAdocao
    .map((petId) => {
      const reqsPet = adocao.filter((r) => r.petId === petId); // Requisicoes deste pet
      const nomePet = (reqsPet.find((r) => r.nome) || {}).nome || ''; // Nome do pet (ou vazio se nao houver)
      return blocoPorQueGanhou(petId, nomePet, reqsPet); // Monta o bloco HTML explicativo
    })
    .join(''); // Junta os blocos de todos os pets

  const histAd = histograma(adocao.map((r) => r.latencia)); // Histograma das latencias de adocao
  const histNav = histograma(navegacao.map((r) => r.latencia)); // Histograma das latencias de navegacao

  const maxHistAd = Math.max(1, ...histAd.map((h) => h.count)); // Maior contagem do histograma de adocao (para escalar as barras)
  const maxHistNav = Math.max(1, ...histNav.map((h) => h.count)); // Maior contagem do histograma de navegacao (para escalar as barras)

  // Funcao que gera o HTML de um histograma (barras de altura proporcional a contagem)
  const histHTML = (hist, max, titulo) => `
    <div class="hist">
      <h3>${titulo}</h3>
      <div class="hist-bars">
        ${hist
          .map(
            (h) => `
          <div class="hist-bar">
            <div class="hist-bar-value">${h.count}</div>
            <div class="hist-bar-fill" style="height: ${(h.count / max) * 100}%"></div>
            <div class="hist-bar-label">${h.label}</div>
          </div>`
          )
          .join('')}
      </div>
    </div>
  `;

  // Throughput real (janela medida), calculado aqui a partir dos eventos.
  const tpNav = throughput(navegacao); // Calcula a vazao da navegacao
  const tpAd = throughput(adocao); // Calcula a vazao da adocao

  const veredito = summary.veredito || {}; // Pega o veredito do resumo (ou objeto vazio se nao houver)
  const vClasse = veredito.ok ? 'veredito ok' : 'veredito fail'; // Define a classe CSS conforme o teste passou ou falhou
  const vTexto = veredito.mensagem || (veredito.ok ? '✅ RF014 atendido' : '❌ RF014 violado'); // Texto do veredito (mensagem propria ou padrao)

  // Gera os cartoes (cards) de resumo a partir dos dados do summary
  const cards = (summary.cards || [])
    .map(
      (c) => `
    <div class="card"${c.dica ? ` title="${escapeHTML(c.dica)}"` : ''}>
      <div class="label">${escapeHTML(c.label)}</div>
      <div class="value">${escapeHTML(c.valor)}</div>
      ${c.sub ? `<div class="sub">${escapeHTML(c.sub)}</div>` : ''}
    </div>`
    )
    .join(''); // Junta todos os cartoes

  // Gera as opcoes do filtro de pets do relatorio (um <option> por pet)
  const filtrosPet = petsAdocao.map((id) => `<option value="${id}">pet ${id}</option>`).join('');

  // Gera as linhas da tabela de eventos (uma <tr> por requisicao)
  const linhasTabela = requests
    .map(
      (r) => `
    <tr data-pet="${r.petId || ''}" data-status="${r.status}" data-acao="${r.acao}">
      <td>${r.enviadoEm}ms</td>
      <td>${escapeHTML(r.acao)}</td>
      <td>${r.petId || ''}</td>
      <td>${escapeHTML(r.usuarioId || '')}</td>
      <td>${r.ordemChegada != null ? '#' + r.ordemChegada : ''}</td>
      <td class="status-${r.status === 200 ? 'ok' : r.status === 409 ? 'conflict' : 'erro'}">${r.status}</td>
      <td>${r.latencia}ms</td>
      <td>${r.dbMs != null ? r.dbMs + 'ms' : ''}</td>
      <td>${escapeHTML(r.motivo || '')}</td>
    </tr>`
    )
    .join(''); // Junta todas as linhas da tabela

  // Funcao auxiliar que formata o texto de vazao (throughput) para exibicao
  const fmtTp = (tp) =>
    tp.reqs > 0 // Se houve requisicoes
      ? `<strong>${tp.reqPorSeg} req/s</strong> &nbsp;=&nbsp; ${tp.reqs} requisições ÷ ${tp.janelaSeg}s de janela real` // Mostra a vazao e o calculo
      : '—'; // Caso contrario, mostra um traco

  // Documento HTML final do relatorio: cabecalho, estilos CSS, secoes de conteudo e script de filtros
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Relatório — ${escapeHTML(summary.nome || 'Teste de Estresse')}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f1f5f9; color: #0f172a; padding: 24px; line-height: 1.5; }
  h1 { font-size: 24px; margin-bottom: 4px; }
  h2 { font-size: 16px; margin: 16px 0 12px; color: #334155; text-transform: uppercase; letter-spacing: 0.5px; }
  h3 { font-size: 14px; margin-bottom: 8px; color: #475569; }
  .subtitulo { color: #64748b; font-size: 13px; margin-bottom: 16px; }
  section { background: white; border-radius: 8px; padding: 18px 20px; margin-bottom: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .intro { background: #eff6ff; border-left: 4px solid #3b82f6; font-size: 13px; color: #1e3a5f; }
  .intro p { margin-bottom: 8px; }
  .intro p:last-child { margin-bottom: 0; }
  .intro code { background: #dbeafe; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .card { background: #f8fafc; border: 1px solid #e2e8f0; padding: 10px 14px; border-radius: 6px; }
  .card .label { font-size: 10px; text-transform: uppercase; color: #64748b; letter-spacing: 0.5px; }
  .card .value { font-size: 20px; font-weight: 700; margin-top: 3px; color: #0f172a; }
  .card .sub { font-size: 11px; color: #64748b; margin-top: 2px; }
  .veredito { padding: 14px 18px; border-radius: 6px; font-weight: 600; font-size: 15px; }
  .veredito.ok { background: #dcfce7; color: #14532d; border-left: 4px solid #22c55e; }
  .veredito.fail { background: #fee2e2; color: #7f1d1d; border-left: 4px solid #ef4444; }
  .timeline { margin-bottom: 16px; padding-bottom: 14px; border-bottom: 1px solid #f1f5f9; }
  .timeline:last-child { border-bottom: none; }
  .timeline-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; font-size: 13px; flex-wrap: wrap; }
  .badge { background: #e2e8f0; color: #475569; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
  .badge-ok { background: #dcfce7; color: #14532d; }
  .badge-fail { background: #fee2e2; color: #7f1d1d; }
  .corrida { margin-bottom: 18px; padding-bottom: 16px; border-bottom: 1px solid #eef2f7; }
  .corrida:last-child { border-bottom: none; }
  .corrida-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 14px; flex-wrap: wrap; }
  .explica { font-size: 13px; color: #334155; background: #fafcff; border: 1px solid #e8eef6; border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; }
  .explica code { background: #f1f5f9; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  table.mini { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 6px; }
  table.mini th { background: #f8fafc; text-align: left; padding: 5px 8px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: #64748b; border-bottom: 1px solid #e2e8f0; }
  table.mini td { padding: 5px 8px; border-bottom: 1px solid #f1f5f9; }
  table.mini tr.venc { background: #f0fdf4; font-weight: 600; }
  .legenda-mini { font-size: 11px; color: #64748b; }
  .hist { padding: 8px 0; }
  .hist-bars { display: flex; align-items: flex-end; gap: 4px; height: 120px; padding: 0 4px; border-bottom: 1px solid #e2e8f0; }
  .hist-bar { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; min-width: 0; height: 100%; position: relative; }
  .hist-bar-fill { width: 80%; background: linear-gradient(180deg, #6366f1 0%, #4f46e5 100%); border-radius: 3px 3px 0 0; min-height: 1px; }
  .hist-bar-value { position: absolute; top: -16px; font-size: 10px; color: #475569; }
  .hist-bar-label { font-size: 9px; color: #64748b; margin-top: 4px; text-align: center; transform: rotate(-30deg); transform-origin: center; white-space: nowrap; }
  .hists { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 720px) { .hists { grid-template-columns: 1fr; } }
  .tp { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 720px) { .tp { grid-template-columns: 1fr; } }
  .tp-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px 14px; font-size: 13px; }
  .tp-box h3 { margin-bottom: 6px; }
  .nota { font-size: 12px; color: #64748b; margin-top: 10px; padding: 10px 12px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; }
  .glossario { font-size: 13px; }
  .glossario dt { font-weight: 700; color: #0f172a; margin-top: 10px; }
  .glossario dd { color: #475569; margin-left: 0; margin-top: 2px; }
  .glossario code { background: #f1f5f9; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  .filtros { display: flex; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
  .filtros select, .filtros input { padding: 5px 8px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 4px; background: white; }
  table.eventos { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.eventos th, table.eventos td { padding: 5px 8px; text-align: left; border-bottom: 1px solid #f1f5f9; }
  table.eventos th { background: #f8fafc; font-weight: 600; color: #475569; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; }
  .status-ok { color: #14532d; font-weight: 600; }
  .status-conflict { color: #854d0e; font-weight: 500; }
  .status-erro { color: #7f1d1d; font-weight: 700; }
  .tabela-wrap { max-height: 400px; overflow-y: auto; }
  tr.hidden { display: none; }
  .legenda { display: flex; gap: 14px; font-size: 11px; color: #475569; margin-top: 6px; flex-wrap: wrap; }
  .legenda span { display: flex; align-items: center; gap: 4px; }
  .legenda i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
</style>
</head>
<body>
  <h1>📊 ${escapeHTML(summary.nome || 'Teste de Estresse')}</h1>
  <div class="subtitulo">${escapeHTML(summary.descricao || '')} · ${escapeHTML(new Date(summary.inicioISO || Date.now()).toLocaleString('pt-BR'))}</div>

  <section class="intro">
    <p><strong>O que este teste verifica (RF014):</strong> quando vários usuários tentam adotar o <strong>mesmo</strong> pet ao mesmo tempo, o sistema deve deixar <strong>exatamente um</strong> vencer. Os demais recebem <code>409 Conflito</code> ("Animal já foi adotado").</p>
    <p><strong>Como a disputa é resolvida:</strong> a adoção roda <code>UPDATE animais SET status='I' WHERE id=? AND status='D'</code>. O Postgres dá uma <strong>trava de linha</strong> nessa linha: o primeiro <code>UPDATE</code> a pegar a trava muda <code>D→I</code> e vence; os outros, ao rodar o mesmo comando, já encontram <code>status='I'</code>, o <code>WHERE</code> não casa e voltam com <code>409</code>. <strong>É o banco que serializa a corrida — não o JavaScript.</strong></p>
  </section>

  <section>
    <div class="${vClasse}">${escapeHTML(vTexto)}</div>
  </section>

  <section>
    <h2>Resumo</h2>
    <div class="cards">${cards}</div>
  </section>

  ${
    petsAdocao.length > 0
      ? `<section>
    <h2>🏁 Quem ganhou e por quê</h2>
    <p class="subtitulo" style="margin-bottom:14px">Esta é a parte central: não basta dizer que alguém "chegou primeiro". Aqui mostramos, com os números reais da corrida, <strong>por que</strong> aquele usuário venceu — e por que a latência sozinha não explica.</p>
    ${corridasHTML}
  </section>`
      : ''
  }

  ${
    petsAdocao.length > 0
      ? `<section>
    <h2>Timeline da corrida de adoção</h2>
    <div class="legenda">
      <span><i style="background:#22c55e"></i>200 OK (vencedor)</span>
      <span><i style="background:#eab308"></i>409 Conflito (perdeu a corrida)</span>
      <span><i style="background:#a855f7"></i>404 Não encontrado</span>
      <span><i style="background:#ef4444"></i>5xx / Erro de rede</span>
    </div>
    ${timelinesHTML}
  </section>`
      : ''
  }

  <section>
    <h2>Throughput (vazão)</h2>
    <div class="tp">
      ${adocao.length > 0 ? `<div class="tp-box"><h3>Adoção</h3>${fmtTp(tpAd)}</div>` : ''}
      ${navegacao.length > 0 ? `<div class="tp-box"><h3>Navegação</h3>${fmtTp(tpNav)}</div>` : ''}
    </div>
    <div class="nota">⚠️ <strong>Por que a janela é menor que a duração configurada?</strong> A vazão é medida pela <strong>janela real</strong> — do primeiro pedido enviado até a última resposta — e <strong>não</strong> pela duração nominal do teste. Os usuários virtuais terminam suas requisições bem antes do prazo máximo, então usar o prazo cheio como divisor daria um número artificialmente baixo. Por isso: vazão = total de requisições ÷ janela real.</div>
  </section>

  <section>
    <h2>Distribuição de latência</h2>
    <div class="hists">
      ${adocao.length > 0 ? histHTML(histAd, maxHistAd, 'Adoção') : ''}
      ${navegacao.length > 0 ? histHTML(histNav, maxHistNav, 'Navegação') : ''}
    </div>
    <div class="nota">📐 <strong>Como os percentis são calculados:</strong> usamos <strong>interpolação linear</strong> (o mesmo método do NumPy e do Excel). Exemplo de leitura: um p95 de 80ms significa "95% das requisições responderam em até 80ms". Percentis são melhores que a média porque mostram a "cauda" (os casos mais lentos), que é o que trava o usuário real.</div>
  </section>

  <section>
    <h2>📖 Glossário — o que cada número significa</h2>
    <dl class="glossario">
      <dt>Latência</dt>
      <dd>Tempo total de ida e volta de UMA requisição, medido no cliente: do envio até a resposta chegar.</dd>
      <dt>Tempo no banco (<code>dbMs</code>)</dt>
      <dd>Quanto tempo o pedido passou no Postgres: fila do pool de conexões + espera da trava de linha + execução do <code>UPDATE</code>. É onde a corrida é de fato decidida.</dd>
      <dt>Ordem de chegada</dt>
      <dd>Posição (1, 2, 3...) em que o <strong>servidor</strong> recebeu o pedido. Mesmo disparando "juntos", os pedidos entram um de cada vez por causa do event loop do Node.</dd>
      <dt>p50 / p95 / p99 (percentis)</dt>
      <dd><code>p50</code> é a mediana (metade foi mais rápida, metade mais lenta). <code>p95</code>: 95% foram mais rápidas que esse valor. <code>p99</code>: 99%. Quanto maior o percentil, mais "pior caso" ele mostra.</dd>
      <dt>Throughput (vazão)</dt>
      <dd>Requisições processadas por segundo, medido na janela real (1ª requisição → última resposta).</dd>
      <dt>Status 200 / 409 / 404 / 5xx</dt>
      <dd><code>200</code> = adotou (venceu). <code>409</code> = chegou tarde, pet já era 'I' (perdeu, comportamento correto). <code>404</code> = pet não existe. <code>5xx</code>/0 = erro de servidor ou rede.</dd>
    </dl>
  </section>

  <section>
    <h2>Eventos (${requests.length})</h2>
    <div class="filtros">
      <select id="filtro-pet"><option value="">Todos os pets</option>${filtrosPet}</select>
      <select id="filtro-status"><option value="">Todos os status</option><option value="200">200 OK</option><option value="409">409 Conflito</option><option value="404">404</option><option value="500">5xx</option></select>
      <select id="filtro-acao"><option value="">Todas as ações</option><option value="adotar">adotar</option><option value="navegar">navegar</option></select>
    </div>
    <div class="tabela-wrap">
      <table class="eventos">
        <thead><tr><th>t (envio)</th><th>Ação</th><th>Pet</th><th>Usuário</th><th title="Nº de sequência global de chegada no servidor (só adoção)">Seq.serv.</th><th>Status</th><th>Latência</th><th>Banco</th><th>Mensagem</th></tr></thead>
        <tbody id="tbody">${linhasTabela}</tbody>
      </table>
    </div>
  </section>

<!-- Script (executado no navegador) que aplica os filtros de pet, status e acao na tabela de eventos -->
<script>
  const tbody = document.getElementById('tbody');
  const fPet = document.getElementById('filtro-pet');
  const fStatus = document.getElementById('filtro-status');
  const fAcao = document.getElementById('filtro-acao');
  function aplicarFiltros() {
    const pet = fPet.value;
    const status = fStatus.value;
    const acao = fAcao.value;
    for (const tr of tbody.children) {
      const okPet = !pet || tr.dataset.pet === pet;
      const okStatus = !status || (status === '500' ? Number(tr.dataset.status) >= 500 : tr.dataset.status === status);
      const okAcao = !acao || tr.dataset.acao === acao;
      tr.classList.toggle('hidden', !(okPet && okStatus && okAcao));
    }
  }
  fPet.addEventListener('change', aplicarFiltros);
  fStatus.addEventListener('change', aplicarFiltros);
  fAcao.addEventListener('change', aplicarFiltros);
</script>
</body>
</html>`;
}

// Exporta as funcoes publicas deste modulo para serem usadas por outros arquivos
module.exports = { criarSessao, estatisticas, histograma, percentil, throughput };

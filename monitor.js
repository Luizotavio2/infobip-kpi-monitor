require('dotenv').config();
const axios = require('axios');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.INFOBIP_BASE_URL || 'URL_BASE_NAO_ENCONTRADA';
const API_KEY = process.env.INFOBIP_API_KEY || 'CHAVE_API_NAO_ENCONTRADA';
const POLLING_INTERVAL = 30000; // 30 segundos
const SLA_LIMIT_MS = 5 * 60 * 1000;
const AGENT_REFRESH_CYCLES = 10; 

const QUEUE_NAMES_TO_MONITOR = [
  '(Labs) Agend. Fila 1',
  '(Labs) Agend. Fila 2',
  '(Labs) Agend. fila 3',
  '(Labs) Agend.Geral'
];

const CONVERSATION_STATUSES_ARRAY = ['OPEN', 'WAITING', 'PENDING', 'SOLVED', 'CLOSED'];

let QUEUES_TO_MONITOR = [];
let cachedAgentMap = null;
let cachedQueueNames = null;
let currentCycle = 0;

const AGENTS_BASE_ENDPOINT = `${BASE_URL}/ccaas/1/agents`;
const QUEUES_ENDPOINT = `${BASE_URL}/ccaas/1/queues?limit=1000`;
const msToMinutesSeconds = (ms) => {
  if (ms < 0) return `0m 0s`;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
};

async function mapQueueNamesToIds() {
  if (QUEUES_TO_MONITOR.length > 0) return;

  try {
    const response = await axios.get(QUEUES_ENDPOINT, {
      headers: { Authorization: `App ${API_KEY}` },
    });

    const allQueues = response.data.queues || [];
    const foundIds = [];
    const queueNameMap = {};
    const monitorNamesSet = new Set(QUEUE_NAMES_TO_MONITOR);

    allQueues.forEach((queue) => {
      if (monitorNamesSet.has(queue.name)) {
        foundIds.push(queue.id);
        queueNameMap[queue.id] = queue.name;
      }
    });

    QUEUES_TO_MONITOR = foundIds;
    cachedQueueNames = queueNameMap;

  } catch (error) {
    console.error('❌ Erro ao buscar filas:', error.message);
  }
}

async function getAgents() {
  const AGENT_PAGE_LIMIT = 50;
  let currentPage = 0;
  let allAgents = [];
  let hasMore = true;

  try {
    while (hasMore) {
      const endpoint = `${AGENTS_BASE_ENDPOINT}?limit=${AGENT_PAGE_LIMIT}&page=${currentPage}`;
      const response = await axios.get(endpoint, {
        headers: { Authorization: `App ${API_KEY}` },
      });

      const agentsOnPage = response.data.agents || [];
      allAgents = allAgents.concat(agentsOnPage);
      hasMore = agentsOnPage.length === AGENT_PAGE_LIMIT;
      currentPage++;
    }

    const agentMap = {};
    allAgents.forEach((agent) => {
      agentMap[agent.id] = agent.displayName || agent.username || agent.email || 'Agente Desconhecido';
    });

    return agentMap;

  } catch (error) {
    console.error('❌ Erro ao buscar agentes:', error.message);
    return {};
  }
}

async function getAgentsCached() {
  if (!cachedAgentMap || currentCycle % AGENT_REFRESH_CYCLES === 0) {
    cachedAgentMap = await getAgents();
  }
  return cachedAgentMap;
}

async function getConversations() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const offset = today.getTimezoneOffset();
  const sign = offset < 0 ? '+' : '-';
  const absOffset = Math.abs(offset);
  const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const offsetMinutes = String(absOffset % 60).padStart(2, '0');

  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');

  const startOfDayFormatted = `${year}-${month}-${day}T00:00:00.000${sign}${offsetHours}${offsetMinutes}`;

  if (QUEUES_TO_MONITOR.length === 0) return [];

  const queryParts = [`limit=1000`, `updatedAfter=${startOfDayFormatted}`];
  CONVERSATION_STATUSES_ARRAY.forEach((status) => queryParts.push(`status=${status}`));
  QUEUES_TO_MONITOR.forEach((id) => queryParts.push(`queueIds=${id}`));

  const query = queryParts.join('&');
  const CONVERSATIONS_ENDPOINT = `${BASE_URL}/ccaas/1/conversations?${query}`;

  try {
    const response = await axios.get(CONVERSATIONS_ENDPOINT, {
      headers: { Authorization: `App ${API_KEY}` },
    });
    return response.data.conversations || [];

  } catch (error) {
    const statusCode = error.response ? error.response.status : 'N/A';
    console.error(`❌ Erro [Status ${statusCode}] ao buscar conversas:`, error.message);
    return [];
  }
}
function calculateKpis(conversations) {
  const totalActive = conversations.length;
  let totalWaitTimeMs = 0;
  let waitingCount = 0;
  let slaRiskCount = 0;
  let maxWaitTimeMs = 0;
  let totalOpenTimeMs = 0;
  let openCount = 0;
  let totalDurationMs = 0;
  let closedCount = 0;
  const agentLoad = {};
  const queueKpis = {};

  conversations.forEach((conv) => {
    const now = Date.now();
    const created = new Date(conv.createdAt).getTime();
    const waitTimeMs = now - created;

    const isWaiting =
      ['WAITING', 'PENDING'].includes(conv.status) ||
      (conv.status === 'OPEN' && !conv.agentId);

    if (isWaiting) {
      const qId = conv.queueId;
      if (waitTimeMs > 0) {
        waitingCount++;
        totalWaitTimeMs += waitTimeMs;
        if (waitTimeMs > maxWaitTimeMs) maxWaitTimeMs = waitTimeMs;
        if (waitTimeMs > SLA_LIMIT_MS) slaRiskCount++;

        if (qId) {
          if (!queueKpis[qId]) queueKpis[qId] = { count: 0, maxWait: 0, totalWait: 0 };
          queueKpis[qId].count++;
          queueKpis[qId].totalWait += waitTimeMs;
          if (waitTimeMs > queueKpis[qId].maxWait) queueKpis[qId].maxWait = waitTimeMs;
        }
      }
    }

    if (['SOLVED', 'CLOSED'].includes(conv.status) && conv.closedAt) {
      const closed = new Date(conv.closedAt).getTime();
      const duration = closed - created;
      if (duration > 0) {
        totalDurationMs += duration;
        closedCount++;
      }
    }

    if (conv.status === 'OPEN' && conv.agentId) {
      if (waitTimeMs > 0) {
        openCount++;
        totalOpenTimeMs += waitTimeMs;
      }
      const agentId = conv.agentId;
      agentLoad[agentId] = (agentLoad[agentId] || 0) + 1;
    }
  });

  const avgWaitTimeMs = waitingCount > 0 ? totalWaitTimeMs / waitingCount : 0;
  const avgOpenTimeMs = openCount > 0 ? totalOpenTimeMs / openCount : 0;
  const avgDurationMs = closedCount > 0 ? totalDurationMs / closedCount : 0;

  const formattedQueueKpis = {};
  for (const qId in queueKpis) {
    const kpis = queueKpis[qId];
    const avgWait = kpis.count > 0 ? kpis.totalWait / kpis.count : 0;
    formattedQueueKpis[qId] = {
      count: kpis.count,
      avgWait: msToMinutesSeconds(avgWait),
      maxWait: msToMinutesSeconds(kpis.maxWait),
    };
  }

  return {
    'Total de Tickets (Filtrados)': totalActive,
    'Tickets em Risco de SLA (> 5min)': slaRiskCount,
    'Tickets em Atendimento (OPEN)': openCount,
    'Tempo Médio de Atendimento Ativo': msToMinutesSeconds(avgOpenTimeMs),
    'Tickets Fechados (Total)': closedCount,
    'Duração Média da Conversa': msToMinutesSeconds(avgDurationMs),
    'Carga de Agentes (Tickets Atribuídos)': agentLoad,
    'Dados por Fila': formattedQueueKpis,
  };
}
async function startMonitoring() {
  await mapQueueNamesToIds();
  currentCycle++;

  const conversations = await getConversations();
  const queueNames = cachedQueueNames;

  if (conversations.length > 0) {
    const kpis = calculateKpis(conversations);
    const agentNames = await getAgentsCached();

    const agentLoads = kpis['Carga de Agentes (Tickets Atribuídos)'];
    const sortedAgents = Object.entries(agentLoads).sort(([, a], [, b]) => b - a);

    const agentLoadDetails = sortedAgents.map(([agentId, count]) => {
      const name = agentNames[agentId];
      return {
        id: agentId,
        count,
        name: name || `Agente (ID: ${agentId.substring(0, 8)}...)`,
      };
    });

    const queueDetails = Object.entries(kpis['Dados por Fila'])
      .map(([qId, data]) => ({
        name: queueNames[qId] || `Fila Desconhecida (${qId.substring(0, 8)}...)`,
        count: data.count,
        maxWait: data.maxWait,
        avgWait: data.avgWait,
      }))
      .filter((detail) => detail.count > 0);

    io.emit('kpiUpdate', kpis, agentLoadDetails, queueDetails);
  } else {
    io.emit(
      'kpiUpdate',
      {
        'Total de Tickets (Filtrados)': 0,
        'Tickets em Risco de SLA (> 5min)': 0,
        'Tickets em Atendimento (OPEN)': 0,
        'Tempo Médio de Atendimento Ativo': '0m 0s',
        'Tickets Fechados (Total)': 0,
        'Duração Média da Conversa': '0m 0s',
      },
      [],
      []
    );
  }
}
const app = express();
app.use(express.static('public')); // pasta frontend

const server = http.createServer(app);
const io = new Server(server);

async function initMonitoring() {
  await getAgentsCached();
  await mapQueueNamesToIds();
  startMonitoring();
  setInterval(startMonitoring, POLLING_INTERVAL);
}

initMonitoring();

server.listen(PORT, () => {
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
});
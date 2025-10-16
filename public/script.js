function updateDateTime() {
    const now = new Date();
    const day = now.toLocaleDateString('pt-BR', { weekday: 'long' });
    const date = now.toLocaleDateString('pt-BR', { day: '2-digit', month: 'numeric', year: 'numeric' });
    const time = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    document.getElementById('datetime').textContent = `${day}, ${date} às ${time}`;
}
setInterval(updateDateTime, 1000);
updateDateTime();
const socket = io();

socket.on('connect', () => {
    console.log('✅ Conectado ao servidor.');
});

socket.on('disconnect', () => {
    console.warn('⚠️ Desconectado do servidor.');
});
socket.on('kpiUpdate', (kpis, agentLoadDetails, queueDetails) => {    
    updateKpis(kpis);
    updateAgentsTable(agentLoadDetails);
    updateTimestamp();
});

function updateKpis(kpis) {
    const kpiMap = {
    'total-tickets': 'Total de Tickets (Filtrados)',
    'sla-risk': 'Tickets em Risco de SLA (> 5min)',
    'avg-handling-time': 'Tempo Médio de Atendimento Ativo'
};
    document.getElementById('total-tickets').textContent = kpis[kpiMap['total-tickets']] || 0;
    document.getElementById('sla-risk').textContent = kpis[kpiMap['sla-risk']] || 0;
    document.getElementById('avg-handling-time').textContent = kpis[kpiMap['avg-handling-time']] || '0m 0s';
    console.log('KPIs atualizados:', kpis);
}

function updateAgentsTable(agents) {
    const tableBody = document.querySelector('#agents-table tbody'); 
    if (!tableBody) return;
    tableBody.innerHTML = '';

    if (!agents || agents.length === 0) {
        tableBody.innerHTML = `
            <tr class="no-data-row">
                <td colspan="2">Nenhum agente ativo no momento</td>
            </tr>
        `;
        return;
    }
    agents.forEach(agent => {
        const row = tableBody.insertRow();
        const nameCell = row.insertCell();
        nameCell.textContent = agent.name;
        const countCell = row.insertCell();
        countCell.textContent = agent.count;
        countCell.style.textAlign = 'center';
    });

    console.log('Tabela de Agentes atualizada:', agents);
}
function updateTimestamp() {
    const timestamp = document.getElementById('last-update');
    const now = new Date().toLocaleTimeString('pt-BR');
    timestamp.textContent = `Última atualização: ${now}`;
    timestamp.style.opacity = '0';
    setTimeout(() => (timestamp.style.opacity = '1'), 200);
}
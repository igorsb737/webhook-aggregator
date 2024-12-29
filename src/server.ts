import express from 'express';
import axios from 'axios';

const app = express();
const port = process.env.PORT || 3000;

// Middleware para processar JSON
app.use(express.json());

// Estruturas para armazenar mensagens, timers, histórico e status
const messageBuffers = new Map<string, any[]>();
const timeouts = new Map<string, NodeJS.Timeout>();
const queueInfo = new Map<string, {
    id_queue: string;
    messages: any[];
}>();
const idStatus = new Map<string, 'online' | 'paused'>();

// Função para gerar id_queue único
function generateQueueId(): string {
    return Math.random().toString(36).substring(2, 15);
}

interface WebhookRecord {
    timestamp: string;
    data: any;
}

interface WebhookSentRecord extends WebhookRecord {
    response: {
        status: number;
        data: any;
    };
}

const webhookHistory = {
    received: [] as WebhookRecord[],
    sent: [] as WebhookSentRecord[]
};

// Servir arquivos estáticos
app.use(express.static('public'));

// Função para enviar webhook agregado
async function sendAggregatedWebhook(id: string) {
    try {
        const currentQueueInfo = queueInfo.get(id);
        if (!currentQueueInfo || currentQueueInfo.messages.length === 0) return;

        // Pegar o último webhook recebido
        const lastMessage = currentQueueInfo.messages[currentQueueInfo.messages.length - 1];

        // Concatenar todas as mensagens se houver múltiplas
        let messages = currentQueueInfo.messages;
        if (messages.length > 1) {
            const concatenatedMessage = messages.map(m => m.message).join('\n\n');
            messages = [{
                message: concatenatedMessage
            }];
        }

        // Criar mensagem agregada com todos os dados
        const aggregatedMessage = {
            id,
            id_queue: currentQueueInfo.id_queue,
            messages: messages,
            timestamp: new Date().toISOString(),
            ...lastMessage
        };

        // Enviar webhook agregado
        const response = await axios.post(
            process.env.WEBHOOK_URL || 'https://n8n.appvendai.com.br/webhook-test/8ee2a9a5-184f-42fe-a197-3b8434227814', 
            aggregatedMessage,
            {
                validateStatus: () => true,
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log('Webhook agregado enviado:', aggregatedMessage);
        console.log('Resposta do webhook:', {
            status: response.status,
            data: response.data
        });
        
        // Adicionar ao histórico de enviados
        webhookHistory.sent.push({
            timestamp: new Date().toISOString(),
            data: aggregatedMessage,
            response: {
                status: response.status,
                data: response.data
            }
        });

        // Limpar buffers e remover queueInfo após envio
        messageBuffers.delete(id);
        timeouts.delete(id);
        queueInfo.delete(id);
    } catch (error) {
        console.error('Erro ao enviar webhook agregado:', error);
    }
}

// Endpoint para receber webhooks
app.post('/webhook', async (req: express.Request, res: express.Response) => {
    try {
        const { id, status, ...messageData } = req.body;
        
        if (!id) {
            return res.status(400).json({
                status: 'error',
                message: 'ID é obrigatório'
            });
        }

        // Processar mudança de status se presente
        if (status === 'paused' || status === 'online') {
            idStatus.set(id, status);
            return res.status(200).json({
                status: 'success',
                message: `Status do ID ${id} atualizado para ${status}`,
                data: { id, status }
            });
        }

        // Verificar se ID está pausado
        if (idStatus.get(id) === 'paused') {
            return res.status(200).json({
                status: 'success',
                message: 'Webhook recebido mas não processado - ID está pausado',
                data: { id, currentStatus: 'paused' }
            });
        }

        // Verificar se existe uma fila ativa para este ID
        let currentQueueInfo = queueInfo.get(id);

        // Se não existe fila, criar nova e definir status como online
        if (!currentQueueInfo) {
            currentQueueInfo = {
                id_queue: generateQueueId(),
                messages: []
            };
            queueInfo.set(id, currentQueueInfo);
            // Definir status como online se não existir
            if (!idStatus.has(id)) {
                idStatus.set(id, 'online');
            }
            console.log(`Nova fila criada - ID: ${id}, Queue ID: ${currentQueueInfo.id_queue}, Status: online`);
        }

        // Adicionar mensagem à fila atual (sem incluir id_queue)
        currentQueueInfo.messages.push(messageData);

        console.log('Webhook recebido:', { 
            id, 
            id_queue: currentQueueInfo.id_queue,
            ...messageData 
        });

        // Adicionar ao histórico de recebidos
        webhookHistory.received.push({
            timestamp: new Date().toISOString(),
            data: { 
                id, 
                id_queue: currentQueueInfo.id_queue,
                ...messageData 
            }
        });

        // Cancelar timer anterior se existir
        if (timeouts.has(id)) {
            clearTimeout(timeouts.get(id));
        }

        // Atualizar buffer de mensagens
        messageBuffers.set(id, currentQueueInfo.messages);

        // Configurar novo timer para esta mensagem
        const timeout = setTimeout(() => {
            sendAggregatedWebhook(id);
        }, 60000); // 60 segundos

        timeouts.set(id, timeout);
        
        res.status(200).json({
            status: 'success',
            message: 'Webhook recebido com sucesso',
            data: { 
                id, 
                id_queue: currentQueueInfo.id_queue,
                ...messageData 
            }
        });
    } catch (error) {
        console.error('Erro ao processar webhook:', error);
        res.status(500).json({
            status: 'error',
            message: 'Erro ao processar webhook'
        });
    }
});

// Endpoint para consultar histórico
app.get('/history', (req: express.Request, res: express.Response) => {
    // Converter o Map de status para um array de objetos
    const statusArray = Array.from(idStatus.entries()).map(([id, status]) => ({
        id,
        status: status.toUpperCase(),
        timestamp: new Date().toISOString(),
        data: { id }
    }));

    res.json({
        ...webhookHistory,
        status: statusArray
    });
});

// Endpoint para limpar histórico
// Endpoint para consultar status de um ID
app.get('/status/:id', (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const status = idStatus.get(id) || 'online';
    
    res.status(200).json({
        status: 'success',
        data: {
            id,
            currentStatus: status
        }
    });
});

app.post('/clear-logs', (req: express.Request, res: express.Response) => {
    webhookHistory.received = [];
    webhookHistory.sent = [];
    messageBuffers.clear();
    queueInfo.clear();
    idStatus.clear();
    
    // Limpar todos os timeouts pendentes
    timeouts.forEach(timeout => clearTimeout(timeout));
    timeouts.clear();
    
    res.status(200).json({
        status: 'success',
        message: 'Histórico limpo com sucesso'
    });
});

app.listen(port, () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
});

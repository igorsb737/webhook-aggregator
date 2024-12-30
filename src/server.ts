import express from 'express';
import axios from 'axios';
import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const REDIS_TTL = parseInt(process.env.REDIS_TTL || '86400');
const AGGREGATION_WINDOW = 10000; // 10 segundos de janela para agregação

interface QueueInfo {
    id_queue: string;
    messages: WebhookMessage[];
}

interface WebhookMessage {
    message: string;
    [key: string]: any;
}

interface HistoryItem {
    timestamp: string;
    data: any;
    response?: {
        status: number;
        data: any;
    };
}

type RedisClient = ReturnType<typeof createClient>;

// Função para criar cliente Redis
async function getRedisClient(): Promise<RedisClient> {
    const client = createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379'
    });

    client.on('error', err => console.error('Redis Client Error:', err));
    await client.connect();
    return client;
}

// Middleware para processar JSON
app.use(express.json());

// Servir arquivos estáticos
app.use(express.static('public'));

// Funções auxiliares Redis
async function getQueueInfo(client: RedisClient, id: string): Promise<QueueInfo | null> {
    const data = await client.get(`queue:${id}`);
    return data ? JSON.parse(data) : null;
}

async function setQueueInfo(client: RedisClient, id: string, info: QueueInfo): Promise<void> {
    await client.setEx(`queue:${id}`, REDIS_TTL, JSON.stringify(info));
}

async function getStatus(client: RedisClient, id: string): Promise<string> {
    const status = await client.get(`status:${id}`);
    if (!status) {
        await setStatus(client, id, 'online');
        return 'online';
    }
    return status;
}

async function setStatus(client: RedisClient, id: string, status: 'online' | 'paused'): Promise<void> {
    await client.set(`status:${id}`, status);
}

async function addToHistory(client: RedisClient, type: 'received' | 'sent', data: any): Promise<void> {
    const key = `history:${type}`;
    const history = await client.lRange(key, 0, -1);
    const parsedHistory: HistoryItem[] = history.map(item => JSON.parse(item));
    parsedHistory.push({
        timestamp: new Date().toISOString(),
        ...data
    });
    
    // Manter apenas os últimos 1000 registros
    while (parsedHistory.length > 1000) {
        parsedHistory.shift();
    }
    
    // Atualizar história no Redis
    await client.del(key);
    for (const item of parsedHistory) {
        await client.rPush(key, JSON.stringify(item));
    }
}

// Função para gerar id_queue único
function generateQueueId(): string {
    return Math.random().toString(36).substring(2, 15);
}

// Função para enviar webhook agregado
async function sendAggregatedWebhook(client: RedisClient, id: string): Promise<void> {
    try {
        const queueInfo = await getQueueInfo(client, id);
        if (!queueInfo || queueInfo.messages.length === 0) return;

        // Pegar o último webhook recebido
        const lastMessage = queueInfo.messages[queueInfo.messages.length - 1];

        // Concatenar todas as mensagens se houver múltiplas
        let messages = queueInfo.messages;
        if (messages.length > 1) {
            const concatenatedMessage = messages.map(m => m.message).join('\n\n');
            messages = [{
                message: concatenatedMessage
            }];
        }

        // Criar mensagem agregada
        const aggregatedMessage = {
            id,
            id_queue: queueInfo.id_queue,
            messages: messages,
            timestamp: new Date().toISOString(),
            ...lastMessage
        };

        // Enviar webhook agregado com timeout de 8 segundos
        const response = await axios.post(
            process.env.WEBHOOK_URL || 'https://n8n.appvendai.com.br/webhook-test/8ee2a9a5-184f-42fe-a197-3b8434227814',
            aggregatedMessage,
            {
                timeout: 8000,
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
        await addToHistory(client, 'sent', {
            data: aggregatedMessage,
            response: {
                status: response.status,
                data: response.data
            }
        });

        // Limpar dados do Redis
        await client.del(`queue:${id}`);
        await client.del(`lastMessage:${id}`);
    } catch (error) {
        console.error('Erro ao enviar webhook agregado:', error);
    }
}

// Endpoint para receber webhooks
app.post('/webhook', async (req: express.Request, res: express.Response) => {
    const client = await getRedisClient();
    try {
        const { id, status, ...messageData } = req.body;

        if (!id) {
            await client.quit();
            return res.status(400).json({
                status: 'error',
                message: 'ID é obrigatório'
            });
        }

        // Processar mudança de status se presente
        if (status === 'paused' || status === 'online') {
            await setStatus(client, id, status);
            await client.quit();
            return res.status(200).json({
                status: 'success',
                message: `Status do ID ${id} atualizado para ${status}`,
                data: { id, status }
            });
        }

        // Verificar se ID está pausado
        const currentStatus = await getStatus(client, id);
        if (currentStatus === 'paused') {
            await client.quit();
            return res.status(200).json({
                status: 'success',
                message: 'Webhook recebido mas não processado - ID está pausado',
                data: { id, currentStatus: 'paused' }
            });
        }

        // Verificar se existe uma fila ativa
        let currentQueueInfo = await getQueueInfo(client, id);

        // Se não existe fila, criar nova e definir status como online
        if (!currentQueueInfo) {
            currentQueueInfo = {
                id_queue: generateQueueId(),
                messages: []
            };
            await setStatus(client, id, 'online');
        }

        // Adicionar mensagem à fila
        currentQueueInfo.messages.push(messageData as WebhookMessage);
        await setQueueInfo(client, id, currentQueueInfo);

        // Adicionar ao histórico de recebidos
        await addToHistory(client, 'received', {
            data: {
                id,
                id_queue: currentQueueInfo.id_queue,
                ...messageData
            }
        });

        // Verificar tempo desde última mensagem
        const lastMessageTime = await client.get(`lastMessage:${id}`);
        const now = Date.now();
        
        if (!lastMessageTime || (now - parseInt(lastMessageTime)) >= AGGREGATION_WINDOW) {
            // Se passou mais de 10 segundos, envia imediatamente
            await sendAggregatedWebhook(client, id);
        } else {
            // Caso contrário, apenas atualiza o timestamp
            await client.setEx(`lastMessage:${id}`, 15, now.toString());
        }

        await client.quit();
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
        await client.quit();
        res.status(500).json({
            status: 'error',
            message: 'Erro ao processar webhook'
        });
    }
});

// Endpoint para consultar histórico
app.get('/history', async (req: express.Request, res: express.Response) => {
    const client = await getRedisClient();
    try {
        const received = await client.lRange('history:received', 0, -1);
        const sent = await client.lRange('history:sent', 0, -1);
        
        // Buscar todos os status
        const statusKeys = await client.keys('status:*');
        const statusPromises = statusKeys.map(async key => {
            const id = key.split(':')[1];
            const status = await client.get(key);
            return {
                id,
                status: status?.toUpperCase(),
                timestamp: new Date().toISOString(),
                data: { id }
            };
        });
        
        const statusArray = await Promise.all(statusPromises);

        await client.quit();
        res.json({
            received: received.map(item => JSON.parse(item)),
            sent: sent.map(item => JSON.parse(item)),
            status: statusArray
        });
    } catch (error) {
        console.error('Erro ao buscar histórico:', error);
        await client.quit();
        res.status(500).json({
            status: 'error',
            message: 'Erro ao buscar histórico'
        });
    }
});

// Endpoint para consultar status de um ID
app.get('/status/:id', async (req: express.Request, res: express.Response) => {
    const client = await getRedisClient();
    try {
        const { id } = req.params;
        const status = await getStatus(client, id);

        await client.quit();
        res.status(200).json({
            status: 'success',
            data: {
                id,
                currentStatus: status
            }
        });
    } catch (error) {
        await client.quit();
        res.status(500).json({
            status: 'error',
            message: 'Erro ao buscar status'
        });
    }
});

// Endpoint para limpar logs
app.post('/clear-logs', async (req: express.Request, res: express.Response) => {
    const client = await getRedisClient();
    try {
        // Limpar históricos
        await client.del('history:received');
        await client.del('history:sent');
        
        // Limpar filas e timers
        const queueKeys = await client.keys('queue:*');
        const lastMessageKeys = await client.keys('lastMessage:*');
        const statusKeys = await client.keys('status:*');
        
        // Deletar todas as chaves
        const allKeys = [...queueKeys, ...lastMessageKeys, ...statusKeys];
        if (allKeys.length > 0) {
            await client.del(allKeys);
        }

        await client.quit();
        res.status(200).json({
            status: 'success',
            message: 'Histórico limpo com sucesso'
        });
    } catch (error) {
        console.error('Erro ao limpar logs:', error);
        await client.quit();
        res.status(500).json({
            status: 'error',
            message: 'Erro ao limpar logs'
        });
    }
});

app.listen(port, () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
});

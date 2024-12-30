import express from 'express';
import axios from 'axios';
import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const REDIS_TTL = parseInt(process.env.REDIS_TTL || '86400');
const AGGREGATION_WINDOW = 10000; // 10 segundos de janela para agregação

// Log das variáveis de ambiente (sem dados sensíveis)
console.log('Environment Check:', {
    REDIS_TTL: REDIS_TTL,
    REDIS_URL: process.env.REDIS_URL ? 'Configurado' : 'Não configurado',
    WEBHOOK_URL: process.env.WEBHOOK_URL ? 'Configurado' : 'Não configurado',
    NODE_ENV: process.env.NODE_ENV
});

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

// Função para criar cliente Redis com retry
async function getRedisClient(): Promise<RedisClient> {
    console.log('Iniciando conexão com Redis...');
    
    const client = createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        socket: {
            reconnectStrategy: (retries) => {
                console.log(`Tentativa de reconexão ${retries}`);
                if (retries > 10) {
                    console.error('Máximo de tentativas de reconexão atingido');
                    return new Error('Máximo de tentativas de reconexão atingido');
                }
                return Math.min(retries * 100, 3000);
            }
        }
    });

    client.on('error', err => {
        console.error('Redis Client Error:', err);
        console.error('Redis Connection Details:', {
            url: process.env.REDIS_URL ? 'Configurado' : 'Não configurado',
            error: err.message,
            stack: err.stack
        });
    });

    client.on('connect', () => {
        console.log('Redis conectado com sucesso');
    });

    client.on('reconnecting', () => {
        console.log('Reconectando ao Redis...');
    });

    try {
        await client.connect();
        console.log('Conexão com Redis estabelecida');
        
        // Teste de conexão
        await client.ping();
        console.log('Redis PING successful');
        
        return client;
    } catch (error) {
        console.error('Erro ao conectar com Redis:', error);
        throw error;
    }
}

// Middleware para processar JSON
app.use(express.json());

// Servir arquivos estáticos
app.use(express.static('public'));

// Função para garantir que temos um cliente Redis válido
async function withRedisClient<T>(operation: (client: RedisClient) => Promise<T>): Promise<T> {
    const client = await getRedisClient();
    try {
        return await operation(client);
    } finally {
        try {
            await client.quit();
            console.log('Conexão Redis fechada com sucesso');
        } catch (error) {
            console.error('Erro ao fechar conexão Redis:', error);
        }
    }
}

// Funções auxiliares Redis com logs
async function getQueueInfo(client: RedisClient, id: string): Promise<QueueInfo | null> {
    try {
        console.log(`Buscando informações da fila para ID: ${id}`);
        const data = await client.get(`queue:${id}`);
        console.log(`Dados recuperados para ID ${id}:`, data ? 'Encontrado' : 'Não encontrado');
        return data ? JSON.parse(data) : null;
    } catch (error) {
        console.error(`Erro ao buscar fila para ID ${id}:`, error);
        throw error;
    }
}

async function setQueueInfo(client: RedisClient, id: string, info: QueueInfo): Promise<void> {
    try {
        console.log(`Salvando informações da fila para ID: ${id}`);
        await client.setEx(`queue:${id}`, REDIS_TTL, JSON.stringify(info));
        console.log(`Informações salvas com sucesso para ID: ${id}`);
    } catch (error) {
        console.error(`Erro ao salvar fila para ID ${id}:`, error);
        throw error;
    }
}

async function getStatus(client: RedisClient, id: string): Promise<string> {
    try {
        console.log(`Buscando status para ID: ${id}`);
        const status = await client.get(`status:${id}`);
        if (!status) {
            console.log(`Status não encontrado para ID ${id}, definindo como online`);
            await setStatus(client, id, 'online');
            return 'online';
        }
        console.log(`Status encontrado para ID ${id}: ${status}`);
        return status;
    } catch (error) {
        console.error(`Erro ao buscar status para ID ${id}:`, error);
        throw error;
    }
}

async function setStatus(client: RedisClient, id: string, status: 'online' | 'paused'): Promise<void> {
    try {
        console.log(`Definindo status para ID ${id}: ${status}`);
        await client.set(`status:${id}`, status);
        console.log(`Status definido com sucesso para ID ${id}`);
    } catch (error) {
        console.error(`Erro ao definir status para ID ${id}:`, error);
        throw error;
    }
}

async function addToHistory(client: RedisClient, type: 'received' | 'sent', data: any): Promise<void> {
    try {
        console.log(`Adicionando ao histórico - Tipo: ${type}`);
        const key = `history:${type}`;
        const history = await client.lRange(key, 0, -1);
        const parsedHistory: HistoryItem[] = history.map(item => JSON.parse(item));
        parsedHistory.push({
            timestamp: new Date().toISOString(),
            ...data
        });
        
        while (parsedHistory.length > 1000) {
            parsedHistory.shift();
        }
        
        await client.del(key);
        for (const item of parsedHistory) {
            await client.rPush(key, JSON.stringify(item));
        }
        console.log(`Histórico atualizado com sucesso - Tipo: ${type}`);
    } catch (error) {
        console.error(`Erro ao adicionar ao histórico - Tipo: ${type}:`, error);
        throw error;
    }
}

function generateQueueId(): string {
    return Math.random().toString(36).substring(2, 15);
}

async function sendAggregatedWebhook(client: RedisClient, id: string): Promise<void> {
    try {
        console.log(`Iniciando envio de webhook agregado para ID: ${id}`);
        const queueInfo = await getQueueInfo(client, id);
        if (!queueInfo || queueInfo.messages.length === 0) {
            console.log(`Nenhuma mensagem para enviar para ID: ${id}`);
            return;
        }

        const lastMessage = queueInfo.messages[queueInfo.messages.length - 1];
        let messages = queueInfo.messages;
        
        if (messages.length > 1) {
            console.log(`Agregando ${messages.length} mensagens para ID: ${id}`);
            const concatenatedMessage = messages.map(m => m.message).join('\n\n');
            messages = [{
                message: concatenatedMessage
            }];
        }

        const aggregatedMessage = {
            id,
            id_queue: queueInfo.id_queue,
            messages: messages,
            timestamp: new Date().toISOString(),
            ...lastMessage
        };

        console.log(`Enviando webhook agregado para ID ${id}:`, aggregatedMessage);
        
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

        console.log(`Resposta do webhook para ID ${id}:`, {
            status: response.status,
            data: response.data
        });

        await addToHistory(client, 'sent', {
            data: aggregatedMessage,
            response: {
                status: response.status,
                data: response.data
            }
        });

        await client.del(`queue:${id}`);
        await client.del(`lastMessage:${id}`);
        console.log(`Processo de webhook concluído para ID: ${id}`);
    } catch (error) {
        console.error(`Erro ao enviar webhook agregado para ID ${id}:`, error);
    }
}

// Endpoint para receber webhooks
app.post('/webhook', async (req: express.Request, res: express.Response) => {
    console.log('Recebendo nova requisição webhook');
    
    try {
        await withRedisClient(async (client) => {
            const { id, status, ...messageData } = req.body;

            console.log('Dados recebidos:', { id, status, messageData });

            if (!id) {
                console.log('Requisição sem ID');
                throw new Error('ID é obrigatório');
            }

            if (status === 'paused' || status === 'online') {
                console.log(`Atualizando status para ID ${id}: ${status}`);
                await setStatus(client, id, status);
                return res.status(200).json({
                    status: 'success',
                    message: `Status do ID ${id} atualizado para ${status}`,
                    data: { id, status }
                });
            }

            const currentStatus = await getStatus(client, id);
            if (currentStatus === 'paused') {
                console.log(`ID ${id} está pausado, ignorando mensagem`);
                return res.status(200).json({
                    status: 'success',
                    message: 'Webhook recebido mas não processado - ID está pausado',
                    data: { id, currentStatus: 'paused' }
                });
            }

            let currentQueueInfo = await getQueueInfo(client, id);

            if (!currentQueueInfo) {
                console.log(`Criando nova fila para ID: ${id}`);
                currentQueueInfo = {
                    id_queue: generateQueueId(),
                    messages: []
                };
                await setStatus(client, id, 'online');
            }

            currentQueueInfo.messages.push(messageData as WebhookMessage);
            await setQueueInfo(client, id, currentQueueInfo);

            await addToHistory(client, 'received', {
                data: {
                    id,
                    id_queue: currentQueueInfo.id_queue,
                    ...messageData
                }
            });

            const lastMessageTime = await client.get(`lastMessage:${id}`);
            const now = Date.now();
            
            if (!lastMessageTime || (now - parseInt(lastMessageTime)) >= AGGREGATION_WINDOW) {
                console.log(`Enviando webhook imediatamente para ID ${id}`);
                await sendAggregatedWebhook(client, id);
            } else {
                console.log(`Atualizando timestamp para agregação futura - ID: ${id}`);
                await client.setEx(`lastMessage:${id}`, 15, now.toString());
            }

            return res.status(200).json({
                status: 'success',
                message: 'Webhook recebido com sucesso',
                data: {
                    id,
                    id_queue: currentQueueInfo.id_queue,
                    ...messageData
                }
            });
        });
    } catch (error) {
        console.error('Erro ao processar webhook:', error);
        if ((error as Error).message === 'ID é obrigatório') {
            return res.status(400).json({
                status: 'error',
                message: 'ID é obrigatório'
            });
        }
        res.status(500).json({
            status: 'error',
            message: 'Erro ao processar webhook'
        });
    }
});

// Endpoint para consultar histórico
app.get('/history', async (req: express.Request, res: express.Response) => {
    console.log('Consultando histórico');
    
    try {
        const result = await withRedisClient(async (client) => {
            const received = await client.lRange('history:received', 0, -1);
            const sent = await client.lRange('history:sent', 0, -1);
            
            console.log(`Histórico recuperado - Recebidos: ${received.length}, Enviados: ${sent.length}`);
            
            const statusKeys = await client.keys('status:*');
            console.log(`Status encontrados: ${statusKeys.length}`);
            
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

            return {
                received: received.map(item => JSON.parse(item)),
                sent: sent.map(item => JSON.parse(item)),
                status: statusArray
            };
        });

        res.json(result);
    } catch (error) {
        console.error('Erro ao buscar histórico:', error);
        res.status(500).json({
            status: 'error',
            message: 'Erro ao buscar histórico'
        });
    }
});

// Endpoint para consultar status de um ID
app.get('/status/:id', async (req: express.Request, res: express.Response) => {
    console.log('Consultando status de ID específico');
    const { id } = req.params;
    
    try {
        const status = await withRedisClient(async (client) => {
            return await getStatus(client, id);
        });

        res.status(200).json({
            status: 'success',
            data: {
                id,
                currentStatus: status
            }
        });
    } catch (error) {
        console.error('Erro ao buscar status:', error);
        res.status(500).json({
            status: 'error',
            message: 'Erro ao buscar status'
        });
    }
});

// Endpoint para limpar logs
app.post('/clear-logs', async (req: express.Request, res: express.Response) => {
    console.log('Iniciando limpeza de logs');
    
    try {
        await withRedisClient(async (client) => {
            await client.del('history:received');
            await client.del('history:sent');
            
            const queueKeys = await client.keys('queue:*');
            const lastMessageKeys = await client.keys('lastMessage:*');
            const statusKeys = await client.keys('status:*');
            
            const allKeys = [...queueKeys, ...lastMessageKeys, ...statusKeys];
            if (allKeys.length > 0) {
                await client.del(allKeys);
            }
        });

        console.log('Logs limpos com sucesso');
        res.status(200).json({
            status: 'success',
            message: 'Histórico limpo com sucesso'
        });
    } catch (error) {
        console.error('Erro ao limpar logs:', error);
        res.status(500).json({
            status: 'error',
            message: 'Erro ao limpar logs'
        });
    }
});

app.listen(port, () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
    console.log('Versão do Node:', process.version);
    console.log('Ambiente:', process.env.NODE_ENV);
    
    // Teste inicial de conexão com Redis
    getRedisClient()
        .then(async (client) => {
            console.log('Teste inicial de conexão com Redis bem sucedido');
            await client.quit();
        })
        .catch(error => {
            console.error('Erro no teste inicial de conexão com Redis:', error);
        });
});

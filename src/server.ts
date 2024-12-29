import express from 'express';
import axios from 'axios';
import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const REDIS_TTL = parseInt(process.env.REDIS_TTL || '86400');

// Criar cliente Redis
const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', err => console.error('Redis Client Error:', err));

// Conectar ao Redis
(async () => {
    await redisClient.connect();
})();

// Middleware para processar JSON
app.use(express.json());

// Servir arquivos estáticos
app.use(express.static('public'));

// Funções auxiliares Redis
async function getQueueInfo(id: string) {
    const data = await redisClient.get(`queue:${id}`);
    return data ? JSON.parse(data) : null;
}

async function setQueueInfo(id: string, info: any) {
    await redisClient.setEx(`queue:${id}`, REDIS_TTL, JSON.stringify(info));
}

async function getStatus(id: string) {
    const status = await redisClient.get(`status:${id}`);
    if (!status) {
        await setStatus(id, 'online');
        return 'online';
    }
    return status;
}

async function setStatus(id: string, status: 'online' | 'paused') {
    await redisClient.set(`status:${id}`, status);
}

async function addToHistory(type: 'received' | 'sent', data: any) {
    const key = `history:${type}`;
    const history = await redisClient.lRange(key, 0, -1);
    const parsedHistory = history.map(item => JSON.parse(item));
    parsedHistory.push({
        timestamp: new Date().toISOString(),
        ...data
    });
    
    // Manter apenas os últimos 1000 registros
    while (parsedHistory.length > 1000) {
        parsedHistory.shift();
    }
    
    // Atualizar história no Redis
    await redisClient.del(key);
    for (const item of parsedHistory) {
        await redisClient.rPush(key, JSON.stringify(item));
    }
}

// Função para gerar id_queue único
function generateQueueId(): string {
    return Math.random().toString(36).substring(2, 15);
}

// Função para enviar webhook agregado
async function sendAggregatedWebhook(id: string) {
    try {
        const queueInfo = await getQueueInfo(id);
        if (!queueInfo || queueInfo.messages.length === 0) return;

        // Pegar o último webhook recebido
        const lastMessage = queueInfo.messages[queueInfo.messages.length - 1];

        // Concatenar todas as mensagens se houver múltiplas
        let messages = queueInfo.messages;
        if (messages.length > 1) {
            const concatenatedMessage = messages.map((m: { message: string }) => m.message).join('\n\n');
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
        await addToHistory('sent', {
            data: aggregatedMessage,
            response: {
                status: response.status,
                data: response.data
            }
        });

        // Limpar dados do Redis
        await redisClient.del(`queue:${id}`);
        await redisClient.del(`timer:${id}`);
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
            await setStatus(id, status);
            return res.status(200).json({
                status: 'success',
                message: `Status do ID ${id} atualizado para ${status}`,
                data: { id, status }
            });
        }

        // Verificar se ID está pausado
        const currentStatus = await getStatus(id);
        if (currentStatus === 'paused') {
            return res.status(200).json({
                status: 'success',
                message: 'Webhook recebido mas não processado - ID está pausado',
                data: { id, currentStatus: 'paused' }
            });
        }

        // Verificar se existe uma fila ativa
        let currentQueueInfo = await getQueueInfo(id);

        // Se não existe fila, criar nova e definir status como online
        if (!currentQueueInfo) {
            currentQueueInfo = {
                id_queue: generateQueueId(),
                messages: []
            };
            // Definir status como online para novos IDs
            await setStatus(id, 'online');
            console.log(`Nova fila criada - ID: ${id}, Queue ID: ${currentQueueInfo.id_queue}, Status: online`);
        }

        // Adicionar mensagem à fila
        currentQueueInfo.messages.push(messageData);
        await setQueueInfo(id, currentQueueInfo);

        console.log('Webhook recebido:', {
            id,
            id_queue: currentQueueInfo.id_queue,
            ...messageData
        });

        // Adicionar ao histórico de recebidos
        await addToHistory('received', {
            data: {
                id,
                id_queue: currentQueueInfo.id_queue,
                ...messageData
            }
        });

        // Configurar novo timer
        const existingTimer = await redisClient.get(`timer:${id}`);
        if (existingTimer) {
            clearTimeout(parseInt(existingTimer));
        }

        const timeout = setTimeout(() => {
            sendAggregatedWebhook(id);
        }, 60000);

        await redisClient.setEx(`timer:${id}`, 70, timeout.toString());

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
app.get('/history', async (req: express.Request, res: express.Response) => {
    try {
        const received = await redisClient.lRange('history:received', 0, -1);
        const sent = await redisClient.lRange('history:sent', 0, -1);
        
        // Buscar todos os status
        const statusKeys = await redisClient.keys('status:*');
        const statusPromises = statusKeys.map(async key => {
            const id = key.split(':')[1];
            const status = await redisClient.get(key);
            return {
                id,
                status: status?.toUpperCase(),
                timestamp: new Date().toISOString(),
                data: { id }
            };
        });
        
        const statusArray = await Promise.all(statusPromises);

        res.json({
            received: received.map(item => JSON.parse(item)),
            sent: sent.map(item => JSON.parse(item)),
            status: statusArray
        });
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
    const { id } = req.params;
    const status = await getStatus(id);

    res.status(200).json({
        status: 'success',
        data: {
            id,
            currentStatus: status
        }
    });
});

// Endpoint para limpar logs
app.post('/clear-logs', async (req: express.Request, res: express.Response) => {
    try {
        // Limpar históricos
        await redisClient.del('history:received');
        await redisClient.del('history:sent');
        
        // Limpar filas e timers
        const queueKeys = await redisClient.keys('queue:*');
        const timerKeys = await redisClient.keys('timer:*');
        const statusKeys = await redisClient.keys('status:*');
        
        // Limpar timers ativos
        for (const key of timerKeys) {
            const timerId = await redisClient.get(key);
            if (timerId) {
                clearTimeout(parseInt(timerId));
            }
        }
        
        // Deletar todas as chaves
        const allKeys = [...queueKeys, ...timerKeys, ...statusKeys];
        if (allKeys.length > 0) {
            await redisClient.del(allKeys);
        }

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

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('Recebido SIGTERM. Fechando conexões...');
    await redisClient.quit();
    process.exit(0);
});

app.listen(port, () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
});

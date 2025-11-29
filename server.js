const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

// Store connections - now by password instead of code
const computers = new Map(); // password -> {ws, info, connectedClients}
const clients = new Map();   // ws -> {password, deviceInfo}

// Create HTTP server
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    if (req.url === '/status') {
        res.end(JSON.stringify({
            status: 'online',
            computers: computers.size,
            clients: clients.size
        }));
    } else {
        res.end(JSON.stringify({ service: 'YAS Remote Relay', version: '2.0' }));
    }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    console.log('New connection from:', req.socket.remoteAddress);
    
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            handleMessage(ws, msg);
        } catch (e) {
            console.error('Invalid message:', e);
        }
    });
    
    ws.on('close', () => {
        handleDisconnect(ws);
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });
});

function handleMessage(ws, msg) {
    switch (msg.type) {
        
        // Computer registers itself with password
        case 'register_computer':
            const password = msg.password;
            
            if (!password) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Password required'
                }));
                return;
            }
            
            // If another computer with same password exists, disconnect it
            if (computers.has(password)) {
                const oldComp = computers.get(password);
                if (oldComp.ws && oldComp.ws.readyState === WebSocket.OPEN) {
                    oldComp.ws.send(JSON.stringify({
                        type: 'replaced',
                        message: 'Another computer connected with same password'
                    }));
                    oldComp.ws.close();
                }
            }
            
            computers.set(password, {
                ws: ws,
                info: msg.info || {},
                connectedClients: new Set()
            });
            ws.password = password;
            ws.isComputer = true;
            
            ws.send(JSON.stringify({
                type: 'registered',
                message: 'Connected successfully'
            }));
            
            console.log(`Computer registered with password`);
            break;
        
        // Client connects using password only
        case 'connect_to_computer':
            const targetPassword = msg.password;
            const computer = computers.get(targetPassword);
            
            if (!computer) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Computer not found or offline'
                }));
                return;
            }
            
            // Register client
            clients.set(ws, {
                password: targetPassword,
                deviceInfo: msg.deviceInfo || {}
            });
            computer.connectedClients.add(ws);
            ws.isClient = true;
            ws.targetPassword = targetPassword;
            
            ws.send(JSON.stringify({
                type: 'connected',
                computerInfo: computer.info
            }));
            
            // Notify computer
            computer.ws.send(JSON.stringify({
                type: 'client_connected',
                deviceInfo: msg.deviceInfo || {},
                totalClients: computer.connectedClients.size
            }));
            
            console.log(`Client connected`);
            break;
        
        // Relay messages between computer and client
        case 'relay':
            if (ws.isComputer) {
                const comp = computers.get(ws.password);
                if (comp) {
                    comp.connectedClients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(msg.data));
                        }
                    });
                }
            } else if (ws.isClient) {
                const comp = computers.get(ws.targetPassword);
                if (comp && comp.ws.readyState === WebSocket.OPEN) {
                    comp.ws.send(JSON.stringify(msg.data));
                }
            }
            break;
        
        // Get connected clients list
        case 'get_clients':
            if (ws.isComputer) {
                const comp = computers.get(ws.password);
                if (comp) {
                    const clientList = [];
                    comp.connectedClients.forEach(c => {
                        const info = clients.get(c);
                        if (info) clientList.push(info.deviceInfo);
                    });
                    ws.send(JSON.stringify({
                        type: 'clients_list',
                        clients: clientList
                    }));
                }
            }
            break;
            
        // Ping
        case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
    }
}

function handleDisconnect(ws) {
    if (ws.isComputer && ws.password) {
        const comp = computers.get(ws.password);
        if (comp) {
            comp.connectedClients.forEach(client => {
                client.send(JSON.stringify({
                    type: 'computer_disconnected'
                }));
            });
        }
        computers.delete(ws.password);
        console.log(`Computer disconnected`);
    }
    
    if (ws.isClient) {
        const info = clients.get(ws);
        if (info) {
            const comp = computers.get(info.password);
            if (comp) {
                comp.connectedClients.delete(ws);
                comp.ws.send(JSON.stringify({
                    type: 'client_disconnected',
                    totalClients: comp.connectedClients.size
                }));
            }
        }
        clients.delete(ws);
        console.log(`Client disconnected`);
    }
}

// Heartbeat to detect dead connections
const interval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

server.listen(PORT, () => {
    console.log(`YAS Remote Relay v2.0 running on port ${PORT}`);
});

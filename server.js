const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

// Store connections
const computers = new Map(); // id -> {ws, info, connectedClients}
const clients = new Map();   // ws -> {computerId, deviceInfo}

// Generate short code
function generateCode() {
    return 'YAS-' + Math.random().toString(36).substring(2, 6).toUpperCase();
}

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
    } else if (req.url === '/computers') {
        const list = [];
        computers.forEach((comp, id) => {
            list.push({
                code: id,
                name: comp.info.name || 'Unknown',
                clients: comp.connectedClients.size
            });
        });
        res.end(JSON.stringify(list));
    } else {
        res.end(JSON.stringify({ service: 'YAS Remote Relay', version: '1.0' }));
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
        
        // Computer registers itself
        case 'register_computer':
            const code = generateCode();
            computers.set(code, {
                ws: ws,
                info: msg.info || {},
                connectedClients: new Set(),
                password: msg.password || ''
            });
            ws.computerId = code;
            ws.isComputer = true;
            
            ws.send(JSON.stringify({
                type: 'registered',
                code: code
            }));
            
            console.log(`Computer registered: ${code}`);
            break;
        
        // Client connects to computer
        case 'connect_to_computer':
            const targetCode = msg.code;
            const computer = computers.get(targetCode);
            
            if (!computer) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Computer not found'
                }));
                return;
            }
            
            // Check password
            if (computer.password && computer.password !== msg.password) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Wrong password'
                }));
                return;
            }
            
            // Register client
            clients.set(ws, {
                computerId: targetCode,
                deviceInfo: msg.deviceInfo || {}
            });
            computer.connectedClients.add(ws);
            ws.isClient = true;
            ws.targetComputer = targetCode;
            
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
            
            console.log(`Client connected to ${targetCode}`);
            break;
        
        // Relay messages between computer and client
        case 'relay':
            if (ws.isComputer) {
                // From computer to specific client or all clients
                const comp = computers.get(ws.computerId);
                if (comp) {
                    comp.connectedClients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(msg.data));
                        }
                    });
                }
            } else if (ws.isClient) {
                // From client to computer
                const comp = computers.get(ws.targetComputer);
                if (comp && comp.ws.readyState === WebSocket.OPEN) {
                    comp.ws.send(JSON.stringify(msg.data));
                }
            }
            break;
        
        // Get connected clients list
        case 'get_clients':
            if (ws.isComputer) {
                const comp = computers.get(ws.computerId);
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
    if (ws.isComputer && ws.computerId) {
        const comp = computers.get(ws.computerId);
        if (comp) {
            // Notify all clients
            comp.connectedClients.forEach(client => {
                client.send(JSON.stringify({
                    type: 'computer_disconnected'
                }));
            });
        }
        computers.delete(ws.computerId);
        console.log(`Computer disconnected: ${ws.computerId}`);
    }
    
    if (ws.isClient) {
        const info = clients.get(ws);
        if (info) {
            const comp = computers.get(info.computerId);
            if (comp) {
                comp.connectedClients.delete(ws);
                comp.ws.send(JSON.stringify({
                    type: 'client_disconnected',
                    deviceInfo: info.deviceInfo,
                    totalClients: comp.connectedClients.size
                }));
            }
        }
        clients.delete(ws);
        console.log('Client disconnected');
    }
}

// Heartbeat to detect dead connections
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) {
            handleDisconnect(ws);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

server.listen(PORT, () => {
    console.log('');
    console.log('========================================');
    console.log('   YAS Remote Relay Server');
    console.log('========================================');
    console.log(`   Port: ${PORT}`);
    console.log('   Status: Running');
    console.log('========================================');
    console.log('');
});

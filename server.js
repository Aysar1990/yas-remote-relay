/**
 * YAS Remote Pro - Relay Server
 * Version: 3.2
 * Features: Auth, Sessions, Trusted devices, Security, File Transfer, Multi-User, File Manager
 */

const WebSocket = require('ws');
const http = require('http');
const dgram = require('dgram');
const auth = require('./auth');
const sessions = require('./sessions');
const fileHandler = require('./file-handler');

const PORT = process.env.PORT || 3000;
const VERSION = '3.3';

// ============================================
// Data Stores
// ============================================
const computers = new Map();  // password -> {ws, info, connectedClients}
const clients = new Map();    // ws -> {sessionId, password, deviceInfo}

// ============================================
// HTTP Server
// ============================================
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json');
    
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    const url = req.url.split('?')[0];
    
    switch (url) {
        case '/':
            res.end(JSON.stringify({ 
                service: 'YAS Remote Relay', 
                version: VERSION,
                features: ['auth', 'sessions', 'trusted-devices', 'security-log', 'file-transfer', 'multi-user', 'file-manager', 'file-watcher', 'wake-on-lan']
            }));
            break;
            
        case '/status':
            res.end(JSON.stringify({
                status: 'online',
                version: VERSION,
                computers: computers.size,
                clients: clients.size,
                sessions: sessions.getSessionStats()
            }));
            break;
        
        case '/wol':
            if (req.method === 'POST') {
                handleWakeOnLan(req, res);
            } else {
                res.statusCode = 405;
                res.end(JSON.stringify({ error: 'Method not allowed' }));
            }
            break;
            
        default:
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Not found' }));
    }
});

// ============================================
// WebSocket Server
// ============================================
const wss = new WebSocket.Server({ server, maxPayload: 10 * 1024 * 1024 });

wss.on('connection', (ws) => {
    console.log('New connection');
    
    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleMessage(ws, data);
        } catch (e) {
            console.error('Invalid message:', e.message);
        }
    });
    
    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', (e) => console.error('WS error:', e.message));
});

// Heartbeat
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// ============================================
// Message Handler
// ============================================
function handleMessage(ws, data) {
    switch (data.type) {
        // ============ Ping ============
        case 'ping':
            // Respond to keep-alive ping
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
            
        // ============ Computer Registration ============
        case 'register_computer':
            handleRegisterComputer(ws, data);
            break;
            
        // ============ Client Connection ============
        case 'connect_to_computer':
            handleConnectToComputer(ws, data);
            break;
            
        case 'auto_login':
            handleAutoLogin(ws, data);
            break;
            
        // ============ Relay Messages ============
        case 'relay':
            handleRelay(ws, data);
            break;
            
        // ============ Sessions ============
        case 'get_sessions':
            handleGetSessions(ws);
            break;
            
        case 'kick_session':
            handleKickSession(ws, data);
            break;
            
        case 'logout':
            handleLogout(ws);
            break;
            
        // ============ Security ============
        case 'get_security_log':
            handleGetSecurityLog(ws);
            break;
            
        case 'get_trusted_devices':
            handleGetTrustedDevices(ws);
            break;
            
        // ============ Connected Users ============
        case 'get_connected_users':
            handleGetConnectedUsers(ws);
            break;
            
        // ============ File Transfer ============
        case 'file_upload_start':
            handleFileUploadStart(ws, data);
            break;
            
        case 'file_chunk':
            handleFileChunk(ws, data);
            break;
            
        case 'file_upload_complete':
            handleFileUploadComplete(ws, data);
            break;
            
        case 'file_download_request':
            handleFileDownloadRequest(ws, data);
            break;
            
        case 'file_download_response':
            handleFileDownloadResponse(ws, data);
            break;
            
        case 'file_cancel':
            handleFileCancel(ws, data);
            break;
            
        case 'get_recent_files':
            handleGetRecentFiles(ws);
            break;
            
        case 'browse_files':
            handleBrowseFiles(ws, data);
            break;
            
        // ============ File Manager Operations ============
        case 'file_operation':
            handleFileOperation(ws, data);
            break;
            
        case 'file_operation_result':
            handleFileOperationResult(ws, data);
            break;
            
        // ============ File Watcher ============
        case 'start_file_watcher':
            handleStartFileWatcher(ws, data);
            break;
            
        case 'stop_file_watcher':
            handleStopFileWatcher(ws, data);
            break;
            
        case 'file_change_event':
            handleFileChangeEvent(ws, data);
            break;
            
        case 'get_watched_folders':
            handleGetWatchedFolders(ws);
            break;
            
        // ============ Browse Result from Computer ============
        case 'browse_result_relay':
            handleBrowseResultRelay(ws, data);
            break;
            
        case 'watcher_result':
            handleWatcherResultRelay(ws, data);
            break;
            
        case 'watched_folders':
            handleWatchedFoldersRelay(ws, data);
            break;
            
        // ============ Screenshot (from computer) ============
        case 'screenshot':
            handleScreenshot(ws, data);
            break;
            
        case 'result':
            handleResult(ws, data);
            break;
            
        default:
            console.log('Unknown message type:', data.type);
    }
}


// ============================================
// Computer Registration
// ============================================
function handleRegisterComputer(ws, data) {
    const password = data.password;
    
    if (!auth.validatePassword(password)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid password format' }));
        return;
    }
    
    computers.set(password, {
        ws: ws,
        info: data.info || {},
        connectedClients: new Set(),
        watchedFolders: new Map()
    });
    
    ws.computerPassword = password;
    ws.isComputer = true;
    
    auth.logSecurityEvent(password, 'computer_registered', { info: data.info });
    console.log(`✅ Computer registered: ${password.substring(0, 4)}***`);
    
    ws.send(JSON.stringify({ type: 'registered', success: true }));
}

// ============================================
// Client Connection
// ============================================
function handleConnectToComputer(ws, data) {
    const { password, trustDevice, deviceInfo } = data;
    
    // Check lockout
    const lockout = auth.checkLockout(password);
    if (lockout.locked) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: `Too many attempts. Try again in ${lockout.remainingMinutes} minutes` 
        }));
        return;
    }
    
    // Validate password
    if (!auth.validatePassword(password)) {
        auth.recordFailedAttempt(password);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid password' }));
        return;
    }
    
    // Find computer
    const computer = computers.get(password);
    if (!computer) {
        auth.recordFailedAttempt(password);
        auth.logSecurityEvent(password, 'connection_failed', { reason: 'computer_not_found', deviceInfo });
        ws.send(JSON.stringify({ type: 'error', message: 'Computer not found or offline' }));
        return;
    }
    
    // Create session
    const session = sessions.createSession(password, deviceInfo);
    
    // Handle trusted device
    let deviceId = null;
    if (trustDevice) {
        deviceId = auth.registerTrustedDevice(password, deviceInfo);
    }
    
    // Store client info
    clients.set(ws, {
        sessionId: session.id,
        password: password,
        deviceInfo: { ...deviceInfo, trusted: !!deviceId }
    });
    
    ws.clientPassword = password;
    ws.sessionId = session.id;
    computer.connectedClients.add(ws);
    
    auth.logSecurityEvent(password, 'client_connected', { deviceInfo, sessionId: session.id });
    console.log(`📱 Client connected: ${session.id}`);
    
    // Notify computer about new connection
    notifyComputerOfUserChange(password);
    
    ws.send(JSON.stringify({
        type: 'connected',
        sessionId: session.id,
        deviceId: deviceId,
        expiresIn: sessions.SESSION_TIMEOUT
    }));
}

function handleAutoLogin(ws, data) {
    const { deviceId, password } = data;
    
    // Validate trusted device
    const validation = auth.validateTrustedDevice(password, deviceId);
    if (!validation.valid) {
        ws.send(JSON.stringify({ 
            type: 'auto_login_failed', 
            reason: validation.reason 
        }));
        return;
    }
    
    // Find computer
    const computer = computers.get(password);
    if (!computer) {
        ws.send(JSON.stringify({ 
            type: 'auto_login_failed', 
            reason: 'Computer not found or offline' 
        }));
        return;
    }
    
    // Create session
    const deviceInfo = { ...validation.device, trusted: true, autoLogin: true };
    const session = sessions.createSession(password, deviceInfo);
    
    clients.set(ws, {
        sessionId: session.id,
        password: password,
        deviceInfo: deviceInfo
    });
    
    ws.clientPassword = password;
    ws.sessionId = session.id;
    computer.connectedClients.add(ws);
    
    auth.logSecurityEvent(password, 'auto_login_success', { deviceId, sessionId: session.id });
    console.log(`🔐 Auto-login: ${session.id}`);
    
    // Notify computer about new connection
    notifyComputerOfUserChange(password);
    
    ws.send(JSON.stringify({
        type: 'connected',
        sessionId: session.id,
        expiresIn: sessions.SESSION_TIMEOUT,
        autoLogin: true
    }));
}

// ============================================
// Connected Users Management
// ============================================
function handleGetConnectedUsers(ws) {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;
    
    const computer = computers.get(clientInfo.password);
    if (!computer) return;
    
    const users = [];
    computer.connectedClients.forEach(clientWs => {
        const info = clients.get(clientWs);
        if (info) {
            const session = sessions.getSession(info.sessionId);
            users.push({
                sessionId: info.sessionId,
                deviceInfo: info.deviceInfo,
                connectedAt: session?.createdAt,
                lastActivity: session?.lastActivity,
                isCurrentUser: clientWs === ws
            });
        }
    });
    
    ws.send(JSON.stringify({
        type: 'connected_users',
        users: users,
        totalCount: users.length
    }));
}

function notifyComputerOfUserChange(password) {
    const computer = computers.get(password);
    if (!computer) return;
    
    const users = [];
    computer.connectedClients.forEach(clientWs => {
        const info = clients.get(clientWs);
        if (info) {
            users.push({
                sessionId: info.sessionId,
                deviceInfo: info.deviceInfo
            });
        }
    });
    
    // Notify computer
    computer.ws.send(JSON.stringify({
        type: 'users_changed',
        users: users,
        totalCount: users.length
    }));
    
    // Notify all connected clients
    computer.connectedClients.forEach(clientWs => {
        clientWs.send(JSON.stringify({
            type: 'users_changed',
            users: users,
            totalCount: users.length
        }));
    });
}


// ============================================
// Relay Messages
// ============================================
function handleRelay(ws, data) {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;
    
    // Validate session
    if (!sessions.validateSession(clientInfo.sessionId)) {
        ws.send(JSON.stringify({ type: 'session_expired', message: 'Session expired' }));
        return;
    }
    
    // Touch session
    sessions.touchSession(clientInfo.sessionId);
    
    // Forward to computer
    const computer = computers.get(clientInfo.password);
    if (computer?.ws.readyState === WebSocket.OPEN) {
        computer.ws.send(JSON.stringify({
            type: 'command',
            sessionId: clientInfo.sessionId,
            data: data.data
        }));
    }
}

function handleScreenshot(ws, data) {
    if (!ws.computerPassword) return;
    
    const computer = computers.get(ws.computerPassword);
    if (!computer) return;
    
    computer.connectedClients.forEach(clientWs => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
                type: 'screenshot',
                data: data.data
            }));
        }
    });
}

function handleResult(ws, data) {
    if (!ws.computerPassword) return;
    
    const computer = computers.get(ws.computerPassword);
    if (!computer) return;
    
    computer.connectedClients.forEach(clientWs => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
                type: 'result',
                data: data.data
            }));
        }
    });
}

// ============================================
// Sessions Management
// ============================================
function handleGetSessions(ws) {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;
    
    const userSessions = sessions.getUserSessions(clientInfo.password);
    ws.send(JSON.stringify({
        type: 'sessions_list',
        sessions: userSessions
    }));
}

function handleKickSession(ws, data) {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;
    
    const result = sessions.kickSession(clientInfo.password, data.sessionId);
    
    if (result.success) {
        // Find and disconnect the kicked client
        const computer = computers.get(clientInfo.password);
        if (computer) {
            computer.connectedClients.forEach(clientWs => {
                if (clientWs.sessionId === data.sessionId) {
                    clientWs.send(JSON.stringify({ 
                        type: 'session_expired', 
                        message: 'You were disconnected by another user' 
                    }));
                    clientWs.close();
                }
            });
        }
        
        auth.logSecurityEvent(clientInfo.password, 'session_kicked', { 
            kickedSession: data.sessionId, 
            bySession: clientInfo.sessionId 
        });
    }
    
    ws.send(JSON.stringify({ type: 'kick_result', ...result }));
}

function handleLogout(ws) {
    const clientInfo = clients.get(ws);
    if (clientInfo) {
        sessions.destroySession(clientInfo.sessionId);
        auth.logSecurityEvent(clientInfo.password, 'logout', { sessionId: clientInfo.sessionId });
    }
    handleDisconnect(ws);
}

// ============================================
// Security
// ============================================
function handleGetSecurityLog(ws) {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;
    
    const log = auth.getSecurityLog(clientInfo.password);
    ws.send(JSON.stringify({ type: 'security_log', log }));
}

function handleGetTrustedDevices(ws) {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;
    
    const devices = auth.getTrustedDevices(clientInfo.password);
    ws.send(JSON.stringify({ type: 'trusted_devices', devices }));
}

// ============================================
// File Transfer
// ============================================
function handleFileUploadStart(ws, data) {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;
    
    const result = fileHandler.startUpload(clientInfo.password, {
        fileName: data.fileName,
        fileSize: data.fileSize,
        fileType: data.fileType
    });
    
    if (result.success) {
        ws.send(JSON.stringify({
            type: 'file_upload_ready',
            success: true,
            transferId: result.transferId
        }));
    } else {
        ws.send(JSON.stringify({
            type: 'file_upload_ready',
            success: false,
            error: result.error
        }));
    }
}

function handleFileChunk(ws, data) {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;
    
    const result = fileHandler.receiveChunk(data.transferId, data.chunkIndex, data.data);
    
    if (result.progress) {
        ws.send(JSON.stringify({
            type: 'file_progress',
            transferId: data.transferId,
            progress: result.progress,
            speed: result.speed
        }));
    }
}

function handleFileUploadComplete(ws, data) {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;
    
    const result = fileHandler.completeUpload(data.transferId);
    
    if (result.success) {
        // Send file to computer
        const computer = computers.get(clientInfo.password);
        if (computer?.ws.readyState === WebSocket.OPEN) {
            computer.ws.send(JSON.stringify({
                type: 'file_command',
                command: 'file_receive',
                transferId: data.transferId,
                fileName: result.fileName,
                fileData: result.fileData,
                fileSize: result.fileSize
            }));
        }
        
        ws.send(JSON.stringify({
            type: 'file_upload_success',
            transferId: data.transferId,
            fileName: result.fileName
        }));
    } else {
        ws.send(JSON.stringify({
            type: 'file_upload_error',
            transferId: data.transferId,
            error: result.error
        }));
    }
}

function handleFileDownloadRequest(ws, data) {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;
    
    const computer = computers.get(clientInfo.password);
    if (computer?.ws.readyState === WebSocket.OPEN) {
        computer.ws.send(JSON.stringify({
            type: 'file_command',
            command: 'file_download_request',
            filePath: data.filePath,
            requesterId: clientInfo.sessionId
        }));
    }
}

function handleFileDownloadResponse(ws, data) {
    if (!ws.computerPassword) return;
    
    const computer = computers.get(ws.computerPassword);
    if (!computer) return;
    
    computer.connectedClients.forEach(clientWs => {
        const info = clients.get(clientWs);
        if (info?.sessionId === data.requesterId) {
            clientWs.send(JSON.stringify({
                type: 'file_download_data',
                fileName: data.fileName,
                fileData: data.fileData,
                error: data.error
            }));
        }
    });
}

function handleFileCancel(ws, data) {
    fileHandler.cancelTransfer(data.transferId);
}

function handleGetRecentFiles(ws) {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;
    
    const files = fileHandler.getRecentFiles(clientInfo.password);
    ws.send(JSON.stringify({ type: 'recent_files', files }));
}

function handleBrowseFiles(ws, data) {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;
    
    const computer = computers.get(clientInfo.password);
    if (computer?.ws.readyState === WebSocket.OPEN) {
        computer.ws.send(JSON.stringify({
            type: 'file_command',
            command: 'browse_files',
            path: data.path,
            requesterId: clientInfo.sessionId
        }));
    }
}


// ============================================
// File Manager Operations
// ============================================
function handleFileOperation(ws, data) {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;
    
    const computer = computers.get(clientInfo.password);
    if (computer?.ws.readyState === WebSocket.OPEN) {
        computer.ws.send(JSON.stringify({
            type: 'file_command',
            command: 'file_operation',
            operation: data.operation,  // copy, move, delete, rename, create_folder
            sourcePath: data.sourcePath,
            destPath: data.destPath,
            newName: data.newName,
            requesterId: clientInfo.sessionId
        }));
    }
}

function handleFileOperationResult(ws, data) {
    if (!ws.computerPassword) return;
    
    const computer = computers.get(ws.computerPassword);
    if (!computer) return;
    
    computer.connectedClients.forEach(clientWs => {
        const info = clients.get(clientWs);
        if (info?.sessionId === data.requesterId) {
            clientWs.send(JSON.stringify({
                type: 'file_operation_result',
                operation: data.operation,
                success: data.success,
                error: data.error,
                path: data.path
            }));
        }
    });
}

// ============================================
// File Watcher
// ============================================
function handleStartFileWatcher(ws, data) {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;
    
    const computer = computers.get(clientInfo.password);
    if (computer?.ws.readyState === WebSocket.OPEN) {
        computer.ws.send(JSON.stringify({
            type: 'file_command',
            command: 'start_watcher',
            path: data.path,
            watcherId: data.watcherId || `watcher_${Date.now()}`,
            requesterId: clientInfo.sessionId
        }));
    }
}

function handleStopFileWatcher(ws, data) {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;
    
    const computer = computers.get(clientInfo.password);
    if (computer?.ws.readyState === WebSocket.OPEN) {
        computer.ws.send(JSON.stringify({
            type: 'file_command',
            command: 'stop_watcher',
            watcherId: data.watcherId
        }));
    }
}

function handleFileChangeEvent(ws, data) {
    if (!ws.computerPassword) return;
    
    const computer = computers.get(ws.computerPassword);
    if (!computer) return;
    
    // Broadcast file change to all connected clients
    computer.connectedClients.forEach(clientWs => {
        clientWs.send(JSON.stringify({
            type: 'file_changed',
            event: data.event,  // created, modified, deleted, renamed
            path: data.path,
            oldPath: data.oldPath,
            watcherId: data.watcherId,
            timestamp: Date.now()
        }));
    });
}

function handleGetWatchedFolders(ws) {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;
    
    const computer = computers.get(clientInfo.password);
    if (computer?.ws.readyState === WebSocket.OPEN) {
        computer.ws.send(JSON.stringify({
            type: 'file_command',
            command: 'get_watched_folders',
            requesterId: clientInfo.sessionId
        }));
    }
}

// ============================================
// Relay Results from Computer to Client
// ============================================
function handleBrowseResultRelay(ws, data) {
    if (!ws.computerPassword) return;
    
    const computer = computers.get(ws.computerPassword);
    if (!computer) return;
    
    computer.connectedClients.forEach(clientWs => {
        const info = clients.get(clientWs);
        if (info?.sessionId === data.requesterId) {
            clientWs.send(JSON.stringify({
                type: 'browse_result',
                success: data.success,
                path: data.path,
                items: data.items,
                error: data.error
            }));
        }
    });
}

function handleWatcherResultRelay(ws, data) {
    if (!ws.computerPassword) return;
    
    const computer = computers.get(ws.computerPassword);
    if (!computer) return;
    
    computer.connectedClients.forEach(clientWs => {
        const info = clients.get(clientWs);
        if (info?.sessionId === data.requesterId) {
            clientWs.send(JSON.stringify({
                type: 'watcher_result',
                success: data.success,
                watcherId: data.watcherId,
                path: data.path,
                error: data.error
            }));
        }
    });
}

function handleWatchedFoldersRelay(ws, data) {
    if (!ws.computerPassword) return;
    
    const computer = computers.get(ws.computerPassword);
    if (!computer) return;
    
    computer.connectedClients.forEach(clientWs => {
        const info = clients.get(clientWs);
        if (info?.sessionId === data.requesterId) {
            clientWs.send(JSON.stringify({
                type: 'watched_folders',
                folders: data.folders
            }));
        }
    });
}

// ============================================
// Disconnect Handler
// ============================================
function handleDisconnect(ws) {
    // Computer disconnected
    if (ws.isComputer && ws.computerPassword) {
        const computer = computers.get(ws.computerPassword);
        if (computer) {
            // Notify all clients
            computer.connectedClients.forEach(clientWs => {
                clientWs.send(JSON.stringify({ type: 'computer_disconnected' }));
            });
            computers.delete(ws.computerPassword);
        }
        auth.logSecurityEvent(ws.computerPassword, 'computer_disconnected', {});
        console.log(`💻 Computer disconnected: ${ws.computerPassword.substring(0, 4)}***`);
        return;
    }
    
    // Client disconnected
    const clientInfo = clients.get(ws);
    if (clientInfo) {
        sessions.destroySession(clientInfo.sessionId);
        
        const computer = computers.get(clientInfo.password);
        if (computer) {
            computer.connectedClients.delete(ws);
            notifyComputerOfUserChange(clientInfo.password);
        }
        
        clients.delete(ws);
        console.log(`📱 Client disconnected: ${clientInfo.sessionId}`);
    }
}

// ============================================
// Wake on LAN Handler
// ============================================
function handleWakeOnLan(req, res) {
    let body = '';
    
    req.on('data', chunk => {
        body += chunk.toString();
    });
    
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            const { mac, broadcastIp, port } = data;
            
            if (!mac) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'MAC address required' }));
                return;
            }
            
            // Create Magic Packet
            const magicPacket = createMagicPacket(mac);
            
            // Send UDP packet
            const client = dgram.createSocket('udp4');
            
            client.on('error', (err) => {
                console.error('WoL UDP Error:', err);
                client.close();
            });
            
            client.bind(() => {
                client.setBroadcast(true);
                
                const targetIp = broadcastIp || '255.255.255.255';
                const targetPort = port || 9;
                
                client.send(magicPacket, 0, magicPacket.length, targetPort, targetIp, (err) => {
                    client.close();
                    
                    if (err) {
                        console.error('WoL Send Error:', err);
                        res.statusCode = 500;
                        res.end(JSON.stringify({ error: 'Failed to send wake packet', details: err.message }));
                    } else {
                        console.log(`✅ WoL packet sent to ${mac} via ${targetIp}:${targetPort}`);
                        res.end(JSON.stringify({ 
                            success: true, 
                            message: 'Wake packet sent',
                            mac: mac,
                            target: `${targetIp}:${targetPort}`
                        }));
                    }
                });
            });
            
        } catch (e) {
            console.error('WoL Parse Error:', e);
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Invalid request body' }));
        }
    });
}

/**
 * Create Magic Packet for Wake on LAN
 * Format: 6 bytes of 0xFF followed by MAC address repeated 16 times
 */
function createMagicPacket(mac) {
    // Parse MAC address
    const macBytes = mac.split(/[-:]/).map(hex => parseInt(hex, 16));
    
    if (macBytes.length !== 6) {
        throw new Error('Invalid MAC address format');
    }
    
    // Create packet: 6 x 0xFF + 16 x MAC
    const packet = Buffer.alloc(102);
    
    // First 6 bytes: 0xFF
    for (let i = 0; i < 6; i++) {
        packet[i] = 0xFF;
    }
    
    // Repeat MAC 16 times
    for (let i = 0; i < 16; i++) {
        for (let j = 0; j < 6; j++) {
            packet[6 + (i * 6) + j] = macBytes[j];
        }
    }
    
    return packet;
}

// ============================================
// Start Server
// ============================================
server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║     YAS Remote Pro - Relay Server        ║
║     Version: ${VERSION}                          ║
╠══════════════════════════════════════════╣
║  ✅ HTTP Server: Port ${PORT}                 ║
║  ✅ WebSocket Server: Ready               ║
║  ✅ Auth System: Active                   ║
║  ✅ Sessions: Active                      ║
║  ✅ File Transfer: Ready                  ║
║  ✅ Multi-User: Ready                     ║
║  ✅ File Manager: Ready                   ║
║  ✅ File Watcher: Ready                   ║
║  ✅ Wake on LAN: Ready                    ║
╚══════════════════════════════════════════╝
    `);
});

/**
 * YAS Remote Pro - Session Management Module
 * Version: 3.0
 * Features: Session tracking, Auto-timeout, Activity monitoring
 */

const auth = require('./auth');

// ============================================
// Configuration
// ============================================
const SESSION_CONFIG = {
    timeout: 30 * 60 * 1000,           // 30 minutes inactivity timeout
    heartbeatInterval: 30 * 1000,       // 30 seconds heartbeat
    maxSessionsPerUser: 5,              // Max concurrent sessions
    cleanupInterval: 60 * 1000          // Cleanup every minute
};

// ============================================
// Data Stores
// ============================================
const sessions = new Map();  // sessionId -> SessionData
const userSessions = new Map(); // password -> Set<sessionId>

/**
 * Session Data Structure
 */
class Session {
    constructor(sessionId, password, deviceInfo, ip) {
        this.id = sessionId;
        this.password = password;
        this.deviceInfo = deviceInfo;
        this.ip = ip;
        this.createdAt = Date.now();
        this.lastActivity = Date.now();
        this.isActive = true;
        this.ws = null;
    }
    
    touch() {
        this.lastActivity = Date.now();
    }
    
    isExpired() {
        return Date.now() - this.lastActivity > SESSION_CONFIG.timeout;
    }
    
    getInfo() {
        return {
            id: this.id.substring(0, 10) + '...',
            deviceInfo: this.deviceInfo,
            ip: this.ip,
            createdAt: new Date(this.createdAt).toISOString(),
            lastActivity: new Date(this.lastActivity).toISOString(),
            isActive: this.isActive,
            expiresIn: Math.max(0, SESSION_CONFIG.timeout - (Date.now() - this.lastActivity))
        };
    }
}

// ============================================
// Session Management
// ============================================

/**
 * Create new session
 */
function createSession(password, deviceInfo, ip, ws) {
    const sessionId = auth.generateSessionToken();
    
    // Check max sessions per user
    const existingSessions = userSessions.get(password) || new Set();
    if (existingSessions.size >= SESSION_CONFIG.maxSessionsPerUser) {
        // Remove oldest session
        const oldestId = existingSessions.values().next().value;
        destroySession(oldestId, 'max_sessions_exceeded');
    }
    
    // Create session
    const session = new Session(sessionId, password, deviceInfo, ip);
    session.ws = ws;
    
    sessions.set(sessionId, session);
    
    // Track user sessions
    if (!userSessions.has(password)) {
        userSessions.set(password, new Set());
    }
    userSessions.get(password).add(sessionId);
    
    auth.logSecurityEvent('SESSION_CREATED', {
        sessionId: sessionId.substring(0, 10) + '...',
        device: deviceInfo.name,
        ip
    }, ip);
    
    return session;
}

/**
 * Get session by ID
 */
function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    
    if (session.isExpired()) {
        destroySession(sessionId, 'expired');
        return null;
    }
    
    return session;
}

/**
 * Update session activity
 */
function touchSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
        session.touch();
        return true;
    }
    return false;
}

/**
 * Destroy session
 */
function destroySession(sessionId, reason = 'manual') {
    const session = sessions.get(sessionId);
    if (!session) return false;
    
    session.isActive = false;
    
    // Notify client if connected
    if (session.ws && session.ws.readyState === 1) {
        try {
            session.ws.send(JSON.stringify({
                type: 'session_expired',
                reason: reason,
                message: getExpiryMessage(reason)
            }));
        } catch (e) {}
    }
    
    // Remove from maps
    sessions.delete(sessionId);
    
    const userSess = userSessions.get(session.password);
    if (userSess) {
        userSess.delete(sessionId);
        if (userSess.size === 0) {
            userSessions.delete(session.password);
        }
    }
    
    auth.logSecurityEvent('SESSION_DESTROYED', {
        sessionId: sessionId.substring(0, 10) + '...',
        reason
    }, session.ip);
    
    return true;
}

/**
 * Get expiry message
 */
function getExpiryMessage(reason) {
    const messages = {
        'expired': 'Session expired due to inactivity',
        'manual': 'You have been logged out',
        'max_sessions_exceeded': 'Logged out due to new session',
        'kicked': 'You were removed by admin',
        'password_changed': 'Password was changed'
    };
    return messages[reason] || 'Session ended';
}

/**
 * Get all sessions for a password
 */
function getUserSessions(password) {
    const sessionIds = userSessions.get(password);
    if (!sessionIds) return [];
    
    const result = [];
    sessionIds.forEach(id => {
        const session = sessions.get(id);
        if (session && !session.isExpired()) {
            result.push(session.getInfo());
        }
    });
    
    return result;
}

/**
 * Kick a session
 */
function kickSession(sessionId, kickerInfo = {}) {
    auth.logSecurityEvent('SESSION_KICKED', {
        sessionId: sessionId.substring(0, 10) + '...',
        by: kickerInfo.name || 'Admin'
    });
    
    return destroySession(sessionId, 'kicked');
}

/**
 * Validate session and return session object
 */
function validateSession(sessionId) {
    const session = getSession(sessionId);
    if (!session) {
        return { valid: false, reason: 'Session not found or expired' };
    }
    
    session.touch();
    return { valid: true, session };
}

// ============================================
// Cleanup & Monitoring
// ============================================

/**
 * Cleanup expired sessions
 */
function cleanupExpiredSessions() {
    let cleaned = 0;
    
    sessions.forEach((session, id) => {
        if (session.isExpired()) {
            destroySession(id, 'expired');
            cleaned++;
        }
    });
    
    if (cleaned > 0) {
        console.log(`[SESSIONS] Cleaned up ${cleaned} expired sessions`);
    }
    
    return cleaned;
}

/**
 * Get session statistics
 */
function getSessionStats() {
    let active = 0;
    let expired = 0;
    
    sessions.forEach(session => {
        if (session.isExpired()) {
            expired++;
        } else {
            active++;
        }
    });
    
    return {
        total: sessions.size,
        active,
        expired,
        uniqueUsers: userSessions.size
    };
}

/**
 * Get all active sessions
 */
function getAllSessions() {
    const result = [];
    sessions.forEach((session, id) => {
        if (!session.isExpired()) {
            result.push(session.getInfo());
        }
    });
    return result;
}

// ============================================
// Start Cleanup Interval
// ============================================
setInterval(cleanupExpiredSessions, SESSION_CONFIG.cleanupInterval);

// ============================================
// Exports
// ============================================
module.exports = {
    SESSION_CONFIG,
    createSession,
    getSession,
    touchSession,
    destroySession,
    getUserSessions,
    kickSession,
    validateSession,
    cleanupExpiredSessions,
    getSessionStats,
    getAllSessions
};

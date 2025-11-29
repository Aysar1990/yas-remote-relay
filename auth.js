/**
 * YAS Remote Pro - Authentication Module
 * Version: 3.0
 * Features: Password auth, Trusted devices, Session management, Security log
 */

const crypto = require('crypto');

// ============================================
// Configuration
// ============================================
const AUTH_CONFIG = {
    sessionTimeout: 30 * 60 * 1000,      // 30 minutes inactivity
    maxFailedAttempts: 5,                 // Max failed login attempts
    lockoutDuration: 15 * 60 * 1000,      // 15 minutes lockout
    trustedDeviceExpiry: 30 * 24 * 60 * 60 * 1000, // 30 days
    securityLogLimit: 100                 // Keep last 100 events
};

// ============================================
// Data Stores
// ============================================
const trustedDevices = new Map();  // deviceId -> {password, name, browser, lastUsed, createdAt}
const securityLog = [];            // [{timestamp, event, details, ip}]
const failedAttempts = new Map();  // ip -> {count, lastAttempt}

// ============================================
// Helper Functions
// ============================================

/**
 * Generate unique device ID
 */
function generateDeviceId() {
    return 'dev_' + crypto.randomBytes(16).toString('hex');
}

/**
 * Generate session token
 */
function generateSessionToken() {
    return 'sess_' + crypto.randomBytes(32).toString('hex');
}

/**
 * Hash password for comparison (simple hash for demo)
 */
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * Log security event
 */
function logSecurityEvent(event, details, ip = 'unknown') {
    const entry = {
        timestamp: new Date().toISOString(),
        event,
        details,
        ip
    };
    
    securityLog.unshift(entry);
    
    // Keep only last N events
    if (securityLog.length > AUTH_CONFIG.securityLogLimit) {
        securityLog.pop();
    }
    
    console.log(`[SECURITY] ${event}: ${JSON.stringify(details)}`);
    return entry;
}

// ============================================
// Authentication Functions
// ============================================

/**
 * Check if IP is locked out
 */
function isLockedOut(ip) {
    const attempts = failedAttempts.get(ip);
    if (!attempts) return false;
    
    if (attempts.count >= AUTH_CONFIG.maxFailedAttempts) {
        const timeSinceLast = Date.now() - attempts.lastAttempt;
        if (timeSinceLast < AUTH_CONFIG.lockoutDuration) {
            return true;
        }
        // Lockout expired, reset
        failedAttempts.delete(ip);
    }
    return false;
}

/**
 * Record failed attempt
 */
function recordFailedAttempt(key) {
    const attempts = failedAttempts.get(key) || { count: 0, lastAttempt: 0 };
    attempts.count++;
    attempts.lastAttempt = Date.now();
    failedAttempts.set(key, attempts);
    
    logSecurityEvent(key, 'FAILED_LOGIN', { 
        attempts: attempts.count,
        lockedOut: attempts.count >= AUTH_CONFIG.maxFailedAttempts
    });
    
    return attempts;
}

/**
 * Clear failed attempts on success
 */
function clearFailedAttempts(ip) {
    failedAttempts.delete(ip);
}

/**
 * Validate password format (simple validation)
 */
function validatePassword(password) {
    // Just check if password exists and has minimum length
    return password && password.length >= 4;
}

// ============================================
// Trusted Devices
// ============================================

/**
 * Register a trusted device
 */
function registerTrustedDevice(password, deviceInfo) {
    const deviceId = generateDeviceId();
    
    trustedDevices.set(deviceId, {
        passwordHash: hashPassword(password),
        name: deviceInfo.name || 'Unknown Device',
        browser: deviceInfo.browser || 'Unknown',
        createdAt: Date.now(),
        lastUsed: Date.now()
    });
    
    logSecurityEvent('DEVICE_TRUSTED', { 
        deviceId: deviceId.substring(0, 10) + '...', 
        name: deviceInfo.name 
    });
    
    return deviceId;
}

/**
 * Validate trusted device
 */
function validateTrustedDevice(deviceId, password) {
    const device = trustedDevices.get(deviceId);
    
    if (!device) {
        return { valid: false, reason: 'Device not found' };
    }
    
    // Check expiry
    if (Date.now() - device.createdAt > AUTH_CONFIG.trustedDeviceExpiry) {
        trustedDevices.delete(deviceId);
        logSecurityEvent('DEVICE_EXPIRED', { deviceId: deviceId.substring(0, 10) + '...' });
        return { valid: false, reason: 'Device trust expired' };
    }
    
    // Validate password hash
    if (device.passwordHash !== hashPassword(password)) {
        return { valid: false, reason: 'Password changed' };
    }
    
    // Update last used
    device.lastUsed = Date.now();
    
    logSecurityEvent('DEVICE_AUTO_LOGIN', { 
        deviceId: deviceId.substring(0, 10) + '...',
        name: device.name
    });
    
    return { valid: true, device };
}

/**
 * Remove trusted device
 */
function removeTrustedDevice(deviceId) {
    const device = trustedDevices.get(deviceId);
    if (device) {
        trustedDevices.delete(deviceId);
        logSecurityEvent('DEVICE_REMOVED', { 
            deviceId: deviceId.substring(0, 10) + '...',
            name: device.name
        });
        return true;
    }
    return false;
}

/**
 * Get all trusted devices for a password
 */
function getTrustedDevices(password) {
    const hash = hashPassword(password);
    const devices = [];
    
    trustedDevices.forEach((device, id) => {
        if (device.passwordHash === hash) {
            devices.push({
                id: id.substring(0, 10) + '...',
                name: device.name,
                browser: device.browser,
                lastUsed: device.lastUsed,
                createdAt: device.createdAt
            });
        }
    });
    
    return devices;
}

// ============================================
// Security Log
// ============================================

/**
 * Check if locked out (alias for compatibility)
 */
function checkLockout(password) {
    // Use password as key for lockout check
    const attempts = failedAttempts.get(password);
    if (!attempts) return { locked: false };
    
    if (attempts.count >= AUTH_CONFIG.maxFailedAttempts) {
        const timeSinceLast = Date.now() - attempts.lastAttempt;
        if (timeSinceLast < AUTH_CONFIG.lockoutDuration) {
            const remainingMs = AUTH_CONFIG.lockoutDuration - timeSinceLast;
            return { 
                locked: true, 
                remainingMinutes: Math.ceil(remainingMs / 60000)
            };
        }
        failedAttempts.delete(password);
    }
    return { locked: false };
}

/**
 * Get security log
 */
function getSecurityLog(limit = 20) {
    return securityLog.slice(0, limit);
}

/**
 * Get failed attempts info
 */
function getFailedAttemptsInfo() {
    const info = [];
    failedAttempts.forEach((data, ip) => {
        info.push({
            ip,
            count: data.count,
            lastAttempt: new Date(data.lastAttempt).toISOString(),
            lockedOut: data.count >= AUTH_CONFIG.maxFailedAttempts
        });
    });
    return info;
}

// ============================================
// Exports
// ============================================
module.exports = {
    // Config
    AUTH_CONFIG,
    
    // Auth functions
    validatePassword,
    isLockedOut,
    checkLockout,
    recordFailedAttempt,
    
    // Trusted devices
    registerTrustedDevice,
    validateTrustedDevice,
    removeTrustedDevice,
    getTrustedDevices,
    
    // Session helpers
    generateSessionToken,
    generateDeviceId,
    
    // Security
    logSecurityEvent,
    getSecurityLog,
    getFailedAttemptsInfo
};

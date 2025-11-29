/**
 * YAS Remote Pro - File Transfer Handler
 * Version: 3.0
 * Features: Upload/Download, Chunked transfer, Progress tracking
 */

// ============================================
// Configuration
// ============================================
const FILE_CONFIG = {
    maxFileSize: 100 * 1024 * 1024,      // 100 MB max
    chunkSize: 64 * 1024,                 // 64 KB chunks
    allowedTypes: [
        // Documents
        'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain', 'text/csv', 'text/html', 'text/css', 'text/javascript',
        'application/json', 'application/xml',
        // Images
        'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp',
        // Videos
        'video/mp4', 'video/webm', 'video/avi', 'video/quicktime',
        // Audio
        'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp3',
        // Archives
        'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed',
        // Other
        'application/octet-stream'
    ],
    recentFilesLimit: 10
};

// ============================================
// Data Stores
// ============================================
const activeTransfers = new Map();  // transferId -> TransferData
const recentFiles = new Map();      // password -> [{name, size, type, timestamp, direction}]

// ============================================
// Transfer Class
// ============================================
class FileTransfer {
    constructor(id, fileName, fileSize, fileType, direction, password) {
        this.id = id;
        this.fileName = fileName;
        this.fileSize = fileSize;
        this.fileType = fileType;
        this.direction = direction;  // 'upload' or 'download'
        this.password = password;
        this.chunks = [];
        this.receivedSize = 0;
        this.startTime = Date.now();
        this.status = 'pending';  // pending, transferring, completed, failed, cancelled
        this.error = null;
    }
    
    addChunk(chunk, index) {
        this.chunks[index] = chunk;
        this.receivedSize += chunk.length;
        this.status = 'transferring';
    }
    
    getProgress() {
        return {
            id: this.id,
            fileName: this.fileName,
            fileSize: this.fileSize,
            receivedSize: this.receivedSize,
            progress: Math.round((this.receivedSize / this.fileSize) * 100),
            status: this.status,
            speed: this.getSpeed(),
            eta: this.getETA()
        };
    }
    
    getSpeed() {
        const elapsed = (Date.now() - this.startTime) / 1000;
        if (elapsed === 0) return 0;
        return Math.round(this.receivedSize / elapsed);  // bytes per second
    }
    
    getETA() {
        const speed = this.getSpeed();
        if (speed === 0) return 0;
        const remaining = this.fileSize - this.receivedSize;
        return Math.round(remaining / speed);  // seconds
    }
    
    complete() {
        this.status = 'completed';
        return Buffer.concat(this.chunks.filter(c => c));
    }
    
    fail(error) {
        this.status = 'failed';
        this.error = error;
    }
    
    cancel() {
        this.status = 'cancelled';
    }
}

// ============================================
// Helper Functions
// ============================================

/**
 * Generate unique transfer ID
 */
function generateTransferId() {
    return 'tr_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

/**
 * Validate file type
 */
function isValidFileType(mimeType) {
    return FILE_CONFIG.allowedTypes.includes(mimeType) || mimeType.startsWith('text/');
}

/**
 * Format file size
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Get file extension
 */
function getFileExtension(fileName) {
    return fileName.split('.').pop().toLowerCase();
}

/**
 * Add to recent files
 */
function addToRecentFiles(password, fileInfo) {
    if (!recentFiles.has(password)) {
        recentFiles.set(password, []);
    }
    
    const files = recentFiles.get(password);
    files.unshift({
        name: fileInfo.fileName,
        size: fileInfo.fileSize,
        sizeFormatted: formatFileSize(fileInfo.fileSize),
        type: fileInfo.fileType,
        extension: getFileExtension(fileInfo.fileName),
        direction: fileInfo.direction,
        timestamp: Date.now()
    });
    
    // Keep only last N files
    if (files.length > FILE_CONFIG.recentFilesLimit) {
        files.pop();
    }
}

// ============================================
// Transfer Management
// ============================================

/**
 * Start a new upload transfer
 */
function startUpload(fileName, fileSize, fileType, password) {
    // Validate
    if (fileSize > FILE_CONFIG.maxFileSize) {
        return {
            success: false,
            error: `File too large. Max size: ${formatFileSize(FILE_CONFIG.maxFileSize)}`
        };
    }
    
    if (!isValidFileType(fileType)) {
        return {
            success: false,
            error: 'File type not allowed'
        };
    }
    
    // Create transfer
    const id = generateTransferId();
    const transfer = new FileTransfer(id, fileName, fileSize, fileType, 'upload', password);
    activeTransfers.set(id, transfer);
    
    console.log(`[FILE] Upload started: ${fileName} (${formatFileSize(fileSize)})`);
    
    return {
        success: true,
        transferId: id,
        chunkSize: FILE_CONFIG.chunkSize,
        totalChunks: Math.ceil(fileSize / FILE_CONFIG.chunkSize)
    };
}

/**
 * Receive a chunk
 */
function receiveChunk(transferId, chunkIndex, chunkData) {
    const transfer = activeTransfers.get(transferId);
    
    if (!transfer) {
        return { success: false, error: 'Transfer not found' };
    }
    
    if (transfer.status === 'cancelled' || transfer.status === 'failed') {
        return { success: false, error: 'Transfer cancelled or failed' };
    }
    
    // Decode base64 chunk
    const buffer = Buffer.from(chunkData, 'base64');
    transfer.addChunk(buffer, chunkIndex);
    
    return {
        success: true,
        progress: transfer.getProgress()
    };
}

/**
 * Complete upload
 */
function completeUpload(transferId) {
    const transfer = activeTransfers.get(transferId);
    
    if (!transfer) {
        return { success: false, error: 'Transfer not found' };
    }
    
    const fileData = transfer.complete();
    
    // Add to recent files
    addToRecentFiles(transfer.password, {
        fileName: transfer.fileName,
        fileSize: transfer.fileSize,
        fileType: transfer.fileType,
        direction: 'upload'
    });
    
    console.log(`[FILE] Upload completed: ${transfer.fileName}`);
    
    // Cleanup after a delay
    setTimeout(() => {
        activeTransfers.delete(transferId);
    }, 60000);
    
    return {
        success: true,
        fileName: transfer.fileName,
        fileSize: transfer.fileSize,
        fileData: fileData.toString('base64')
    };
}

/**
 * Start download (request file from PC)
 */
function startDownload(filePath, password) {
    const id = generateTransferId();
    
    // Create transfer placeholder
    const transfer = new FileTransfer(id, filePath, 0, 'unknown', 'download', password);
    activeTransfers.set(id, transfer);
    
    console.log(`[FILE] Download requested: ${filePath}`);
    
    return {
        success: true,
        transferId: id
    };
}

/**
 * Cancel transfer
 */
function cancelTransfer(transferId) {
    const transfer = activeTransfers.get(transferId);
    
    if (transfer) {
        transfer.cancel();
        activeTransfers.delete(transferId);
        console.log(`[FILE] Transfer cancelled: ${transfer.fileName}`);
        return { success: true };
    }
    
    return { success: false, error: 'Transfer not found' };
}

/**
 * Get transfer progress
 */
function getTransferProgress(transferId) {
    const transfer = activeTransfers.get(transferId);
    
    if (!transfer) {
        return null;
    }
    
    return transfer.getProgress();
}

/**
 * Get active transfers for a password
 */
function getActiveTransfers(password) {
    const transfers = [];
    
    activeTransfers.forEach((transfer, id) => {
        if (transfer.password === password && transfer.status !== 'completed') {
            transfers.push(transfer.getProgress());
        }
    });
    
    return transfers;
}

/**
 * Get recent files for a password
 */
function getRecentFiles(password) {
    return recentFiles.get(password) || [];
}

/**
 * Clear recent files
 */
function clearRecentFiles(password) {
    recentFiles.delete(password);
    return { success: true };
}

// ============================================
// Exports
// ============================================
module.exports = {
    FILE_CONFIG,
    
    // Transfer management
    startUpload,
    receiveChunk,
    completeUpload,
    startDownload,
    cancelTransfer,
    getTransferProgress,
    getActiveTransfers,
    
    // Recent files
    getRecentFiles,
    clearRecentFiles,
    addToRecentFiles,
    
    // Helpers
    generateTransferId,
    formatFileSize,
    isValidFileType,
    getFileExtension
};

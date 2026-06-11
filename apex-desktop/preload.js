const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe bridge API to the renderer (apex-ai.html)
contextBridge.exposeInMainWorld('APEX_DESKTOP', {
  // Get the machine's local IP address (for console setup screen)
  getLocalIP: () => ipcRenderer.invoke('get-local-ip'),

  // Get current bridge connection status
  getBridgeStatus: () => ipcRenderer.invoke('get-bridge-status'),

  // Restart the bridge
  restartBridge: () => ipcRenderer.invoke('restart-bridge'),

  // Open a URL in the default browser
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Listen for live telemetry data from the bridge
  onTelemetry: (callback) => {
    ipcRenderer.on('telemetry', (_, data) => callback(data));
  },

  // Listen for bridge status changes
  onBridgeStatus: (callback) => {
    ipcRenderer.on('bridge-status', (_, msg) => callback(msg));
  },

  // Listen for local IP updates
  onLocalIP: (callback) => {
    ipcRenderer.on('local-ip', (_, ip) => callback(ip));
  },

  // Remove listeners when page unloads
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners('telemetry');
    ipcRenderer.removeAllListeners('bridge-status');
    ipcRenderer.removeAllListeners('local-ip');
  }
});

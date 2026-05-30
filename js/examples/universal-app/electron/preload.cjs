'use strict';

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('linksqlPlayground', {
  platform: process.platform,
});

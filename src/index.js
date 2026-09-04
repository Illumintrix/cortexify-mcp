#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCortexifyMcpServer } from './tools.js';

const server = createCortexifyMcpServer();
await server.connect(new StdioServerTransport());
console.error('cortexify-mcp running on stdio');

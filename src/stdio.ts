#!/usr/bin/env node

// The stdio entry point: the process an MCP client spawns.
//
// This is the one file that reads the environment. The MCP specification tells
// stdio servers to take credentials that way rather than through the protocol's
// OAuth profile, and everything below it takes its configuration as arguments.

import { createRequire } from 'node:module';

import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { InternetData } from '@internetdata/internetdata';

import { clientOptions } from './env.js';
import { createTools, registerTools } from './tools.js';

const version = createRequire(import.meta.url)('../package.json').version as string;

function main(): void {
    const client = new InternetData(clientOptions(process.env));
    const tools = createTools({ client: client });

    // The opening exchange picks the protocol era, 2025-11-25's `initialize` or
    // 2026-07-28's `server/discover`, and the server this builds is pinned to it.
    serveStdio(() => {
        const server = new Server(
            { name: 'internetdata', version: version },
            { capabilities: { tools: {} } },
        );
        registerTools(server, tools);
        return server;
    }, {
        // stdout carries the protocol, so a diagnostic can only go to stderr.
        onerror: (err) => {
            console.error(err);
        },
    });
}

main();

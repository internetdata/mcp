# [<img src="https://s3.internetdata.io/internetdata-public/brand/mark.svg" alt="InternetData" height="28"/>](https://internetdata.io/) InternetData MCP Server

[![npm](https://img.shields.io/npm/v/internetdata-mcp.svg)](https://www.npmjs.com/package/internetdata-mcp)
[![license](https://img.shields.io/npm/l/internetdata-mcp.svg)](LICENSE)

The official [Model Context Protocol](https://modelcontextprotocol.io) server for the [InternetData](https://internetdata.io) API.

InternetData publishes IP databases: VPN and proxy address space, hosting and CDN ranges, provider catalogs, bogons and more, as gzipped CSV and as MMDB. This server gives an AI agent four read-only tools over them - which databases your organization is licensed for, what is inside one, the digests to verify a copy you already hold, and your recent download history.

## Getting Started

We host it at `https://mcp.internetdata.io/mcp`, and you sign in to it with your InternetData account. It also runs on your own machine from npm. Either way it sees the databases your organization is licensed for. Databases are licensed by contract rather than bought self-serve: see the [API documentation](https://docs.internetdata.io/api) or write to [dev@internetdata.io](mailto:dev@internetdata.io).

### In Claude

In claude.ai, the desktop app or Cowork, add `https://mcp.internetdata.io/mcp` as a custom connector and choose **Use Claude's published identity** when asked. In Claude Code, install our plugin, which adds the server with skills:

```console
/plugin marketplace add internetdata/claude-plugin
/plugin install internetdata@internetdata
```

Either way you sign in with your InternetData account, and Claude never sees your API key. The steps, the skills and how to disconnect: [docs.internetdata.io/integrations/claude](https://docs.internetdata.io/integrations/claude).

### In any other MCP client

Point it at `https://mcp.internetdata.io/mcp`. A client that supports MCP authorization signs in the same way. One that doesn't can send a key instead, as `Authorization: Bearer your-key`.

### On your own machine

You need an API key carrying the `db.download` scope. Add this to your MCP client's config:

```json
{
  "mcpServers": {
    "internetdata": {
      "command": "npx",
      "args": ["-y", "internetdata-mcp"],
      "env": { "INTERNETDATA_API_KEY": "your-key" }
    }
  }
}
```

Requires Node.js 22 or newer. `INTERNETDATA_BASE_URL` overrides the endpoint if you need to point somewhere else.

## Tools

| Tool | What it answers |
|---|---|
| `list_databases` | The databases your organization is licensed for, with the license type and term. |
| `database_metadata` | A database's columns, sample rows, row count, build date and file sizes. |
| `database_checksum` | The published digests for one database file. |
| `list_downloads` | Your organization's recent download attempts, refusals included. |

Every tool is read-only.

## Two spellings of a database id

`list_databases` answers a `base` id and a `versions` array:

```json
{
  "base": "vpn_ip",
  "standing": "licensed",
  "versions": [{ "id": "vpn_ip_v1", "version": 1, "formats": ["csvgz", "mmdb"] }]
}
```

The `base` is what a **license** names. `versions[].id` is what a **download** names, and it is the one `database_metadata` and `database_checksum` accept. The tools say so in their own descriptions, so an agent generally gets this right on its own; it is worth knowing when you read a transcript where one was refused.

## There is no download tool, deliberately

The published builds run to several GB, which is not something an agent should pull into a conversation. `database_metadata` is how you find out what a transfer would cost, and the [client libraries](https://github.com/internetdata) or the API are how you actually move the bytes.

## Reading the download history

`list_downloads` is a bounded window - at most 200 attempts, newest first - and it lists refusals alongside successes, because a denial and its `http_status` are what answer *"it stopped working"*. A database missing from the answer means it is not in that window, never that it was never fetched.

## Other Libraries

There are official InternetData client libraries available for many languages including PHP, Python, Go, Java, Ruby, and many popular frameworks such as Django, Rails, and Laravel. See our GitHub at https://github.com/internetdata for more.

## About InternetData

IP intelligence databases: VPN, proxy, hosting, CDN and relay address space, provider catalogs and network metadata, published as CSV and MMDB.

[<img src="https://s3.internetdata.io/internetdata-public/brand/mark.svg" alt="InternetData" height="64"/>](https://internetdata.io/)

## License

This project is licensed under the [MIT License](LICENSE).

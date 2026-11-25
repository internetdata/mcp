# [<img src="https://s3.internetdata.io/internetdata-public/brand/mark.svg" alt="InternetData" height="28"/>](https://internetdata.io/) InternetData MCP Server

[![npm](https://img.shields.io/npm/v/internetdata-mcp.svg)](https://www.npmjs.com/package/internetdata-mcp)
[![license](https://img.shields.io/npm/l/internetdata-mcp.svg)](LICENSE)

The official [Model Context Protocol](https://modelcontextprotocol.io) server for the [InternetData](https://internetdata.io) API.

It gives an AI agent nine read-only tools. Four look up an IP address, an AS or a domain in every database we publish: where an address is and who uses it, whether it is a VPN, a residential, datacenter, mobile or public proxy, a Tor node, a privacy relay, a hosting provider or a CDN, anycast, carrier, satellite or reserved space; whether a crawler or other bot uses it, and whose; and whether an SSH, mail, web, open DNS resolver or BitTorrent service answered on it. The rest cover your key's plan, the database catalog and your organization's license for each, what a database holds, its digests and your download history.

## Getting Started

We host it at `https://mcp.internetdata.io/mcp`, and you sign in to it with your InternetData account. It also runs on your own machine from npm. Databases are licensed by contract. The Open ones, `tor_ip_v1` among them, are licensed to every organization from the start and are free under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). For the rest, see the [API documentation](https://docs.internetdata.io/api), or [request an evaluation](https://internetdata.io/contact?purpose=evaluation&subject=Evaluation+license) if your organization doesn't have a license yet.

### In Claude

In claude.ai, the desktop app or Cowork, add InternetData from [Claude's connectors directory](https://claude.ai/directory/internetdata), or add `https://mcp.internetdata.io/mcp` yourself as a custom connector and choose **Use Claude's published identity** when asked. In Claude Code, install our plugin, which adds the server with skills:

```console
/plugin marketplace add internetdata/claude-plugin
/plugin install internetdata@internetdata
```

Either way you sign in with your InternetData account, and Claude never sees your API key. The steps, the skills and how to disconnect: [docs.internetdata.io/integrations/claude](https://docs.internetdata.io/integrations/claude).

### In ChatGPT and Codex

InternetData is in the plugin directory ChatGPT and Codex share: [add it from its listing](https://chatgpt.com/plugins/plugin_asdk_app_6acf4061581c8191a113796b35d99bae). Codex also installs our plugin from the command line, which adds the server with skills:

```console
codex plugin marketplace add internetdata/openai-plugin
codex plugin add internetdata@internetdata
codex mcp login internetdata
```

Either way you sign in with your InternetData account, and neither sees your API key. The steps: [docs.internetdata.io/integrations/chatgpt](https://docs.internetdata.io/integrations/chatgpt) and [docs.internetdata.io/integrations/codex](https://docs.internetdata.io/integrations/codex). On the OpenAI API, the Responses API's `mcp` tool takes the server as its `server_url` and your key as its `authorization`.

### In Gemini CLI

Install our extension, which runs the npm package below on your machine:

```console
gemini extensions install https://github.com/internetdata/mcp
```

It asks for your API key and keeps it in your system keychain. Leave it blank to look things up without one; the database tools need a key with the `db.download` scope.

### In any other MCP client

Point it at `https://mcp.internetdata.io/mcp`. A client that supports MCP authorization signs in the same way. One that doesn't can send a key instead, as `Authorization: Bearer your-key`.

### On your own machine

**No API key needed to look something up.** Unlimited, the free plan, answers with no daily or monthly cap, with a key or without one: an address's country-level location, the network that announces it, the company that uses it, its abuse email and reverse DNS name, and whether it is Tor, a relay, a bot, anycast, carrier or satellite space and which services answer on it; an AS's registration; and whether a domain is registered and which DNS record types it has. A paid plan answers every field: VPN, proxy, hosting and CDN detection with the detail behind each flag, whose bot uses an address, city-level location, Whois and RWHOIS and the domains an address hosts, an AS's prefixes, RPKI status, neighbors and hosted domains, and a domain's records, the network announcing each of its addresses, the domains sharing its first IPv4 address, IP ranges, whether it is disposable, its home page and the domains redirecting or linking to it. A free account tries every field.

Add this to your MCP client's config:

```json
{
  "mcpServers": {
    "internetdata": {
      "command": "npx",
      "args": ["-y", "internetdata-mcp"]
    }
  }
}
```

Requires Node.js 22 or newer.

A key on a paid plan unlocks every field, and the database tools need a key carrying the `db.download` scope. Put it in the environment:

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

`INTERNETDATA_BASE_URL` overrides the endpoint if you need to point somewhere else.

## Tools

| Tool | What it answers |
|---|---|
| `lookup_ip` | What every database says about one address. Pass the `User-Agent` a client at that address sent as `user_agent`, and the answer's `user_agent` says whether the address bears it out, which tells a real crawler from one forging its agent. An answer without it did not check the agent. |
| `lookup_ips` | The same for a whole list of addresses in one call, keyed by address. A long list is batched for you. `user_agents` takes one `User-Agent` per address, keyed as in `ips`, and checks each as `lookup_ip` does. Needs a key on a paid plan; with a key on the free plan, a list of up to 10 addresses is looked up one address at a time instead. |
| `lookup_asn` | What we know about one AS, by its number: its registration, its prefixes, RPKI status and Whois record, its rank and Tier 1 flag, its upstreams, peers and downstreams, and the domains it hosts. |
| `lookup_domain` | What we know about one domain: whether it is registered, which DNS record types it has, the records themselves, the network announcing each address, the other domains on its first IPv4 address, its organization's IP ranges, whether it is disposable, what its home page says and links to, and the domains redirecting or linking to it. |
| `my_entitlement` | What this key is entitled to and what it has spent: plan, field tier, requests so far, allowance, and when it resets. |
| `list_databases` | Every database we publish, with its `standing` for your organization (`licensed`, `expired` or `unlicensed`) and the type and term of any license. |
| `database_metadata` | A database's columns, sample rows, row count, build date and file sizes. |
| `database_checksum` | The published digests for one database file. |
| `list_downloads` | Your organization's recent download attempts, refusals included. |

Every tool is read-only. Answers come from our databases' latest builds: no lookup sends a DNS query, or opens a connection to the address or the domain.

**There is deliberately no `my_ip` tool, although every client library has one.** Over a hosted transport the address our edge observes belongs to whatever proxied the call - Claude's infrastructure, not the person asking - so the tool would answer confidently and wrongly for the only reading anyone would put on it. `my_entitlement` has no such problem and is the same answer from any transport, because it describes the credential rather than the connection.

A paid plan's usage counts against the anniversary of the subscription, not the calendar month and not the billing period, and the free plan's counts its trial, over the window the answer gives. `hard_limit` is where full answers stop, and a null one means they never do; it is not a limit of zero.

## Reading a result

Each lookup comes back with a `coverage` block beside it:

```json
{
  "result": { "ip": "146.70.116.130", "is_bogon": false, "is_tor": false, "location": { "country": "AT", "...": "..." }, "...": "..." },
  "coverage": {
    "included": ["ip", "is_bogon", "is_tor", "is_relay", "tor", "relay", "location", "asn", "..."],
    "not_included": ["is_vpn", "is_hosting", "vpn", "whois", "location.city", "..."],
    "note": "The fields in not_included were not returned, because this API key's plan does not include them. ..."
  }
}
```

This matters more here than in a normal client library. A field missing from a result means your plan doesn't include it, never "we checked and found nothing" - and a model reading the result on its own will otherwise treat the absence as a negative answer. `coverage` states the difference explicitly so it can't. A paid field inside an object every plan gets, such as `location.city`, is named by its path.

An answer to a key on the free plan also carries `trial_expired`: false while its organization's trial of every field lasts, and true once the answer is Unlimited's, which `coverage.note` then says.

An answer to a key on a paid plan carries `cap_reached` instead: false while it has every field, and true once its organization's overage cap is reached and the answer has Unlimited's fields, unbilled, which `coverage.note` says too. Raising or removing the cap in Billing turns it false again. The API never answers a reached cap with an error, and in `lookup_ips` a cap reached part way through answers the rest of the list this way, so `coverage` then gives the narrowest answer's lists and says the answers differ.

## Two spellings of a database ID

`list_databases` answers a `base` ID and a `versions` array:

```json
{
  "base": "vpn_ip",
  "standing": "licensed",
  "open": false,
  "versions": [{ "id": "vpn_ip_v1", "version": 1, "formats": ["csvgz", "mmdb"] }]
}
```

The `base` is what a **license** names. `versions[].id` is what a **download** names, and it is the one `database_metadata` and `database_checksum` accept. The tools say so in their own descriptions, so an agent generally gets this right on its own; it is worth knowing when you read a transcript where one was refused.

## There is no download tool, deliberately

The published builds run to several GB, which is not something an agent should pull into a conversation. `database_metadata` is how you find out what a transfer would cost, and the [client libraries](https://github.com/internetdata) or the API are how you actually move the bytes.

## Reading the download history

`list_downloads` is a bounded window - at most 200 attempts, newest first - and it lists refusals alongside successes, because a denial and its `http_status` are what answer *"it stopped working"*. A database missing from the answer means it is not in that window, never that it was never fetched.

## Other Libraries

There are official InternetData client libraries available for many languages including PHP, Python, Go, Java, and Ruby. See our GitHub at https://github.com/internetdata for more.

## About InternetData

Geolocation, anonymity, ownership, network, service and domain data for any IP address, AS or domain, by API or as databases you download.

[<picture><source media="(prefers-color-scheme: dark)" srcset="https://s3.internetdata.io/internetdata-public/brand/logo-dark.svg"><img src="https://s3.internetdata.io/internetdata-public/brand/logo.svg" alt="InternetData" height="40"/></picture>](https://internetdata.io/)

## License

This project is licensed under the [MIT License](LICENSE).

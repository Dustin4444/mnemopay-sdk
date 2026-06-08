# MCP Registry Publishing

MnemoPay's canonical Official MCP Registry name is `com.mnemopay/sdk`.
That namespace requires domain authentication for `mnemopay.com`.

## Canonical manifest

- Publish `server.json`.
- `server.dns.json` is kept synchronized as a recovery copy.
- The npm package must already expose the matching `mcpName`:
  `com.mnemopay/sdk`.

## Publish

Download the current Windows `mcp-publisher` release from the official
Model Context Protocol registry repository, then run:

```powershell
$line = Get-Content .\.mcp-publisher-dns.key |
  Where-Object { $_ -match '^MNEMOPAY_DNS_KEY=' } |
  Select-Object -First 1
$key = $line.Substring($line.IndexOf('=') + 1).Trim()
.\mcp-publisher.exe login dns --domain mnemopay.com --private-key $key
.\mcp-publisher.exe publish
```

If DNS login asks for a TXT record, add the exact challenge value to
`mnemopay.com`, wait for DNS propagation, and rerun the login and publish
commands. Do not commit `.mcp-publisher-dns.key`.

## Current DNS blocker

As of June 8, 2026, the root TXT record publishes an older verification key:

```text
v=MCPv1; k=ed25519; p=lkqOwvgYNGIhNHoFH6uMraJJELMOaBXoyBa2hzohlu4=
```

Replace it with the `Companion DNS TXT record` value stored in the local,
gitignored `.mcp-publisher-dns.key` file. The private key must remain local.
After DNS propagation, rerun the login and publish commands above.

## Verify

```powershell
Invoke-RestMethod "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.mnemopay/sdk"
```

The returned version, description, npm identifier, and website must match
`server.json`.

## Fallback namespace

GitHub authentication can publish `io.github.mnemopay/*`, but that is not the
canonical MnemoPay namespace and should only be used for testing.

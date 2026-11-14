# Standard for workloads that read from the platform Vault

Owner: platform. Applies to every new Vault client on any Quayside cluster. The staging services
predate it.

1. **One role per workload.** A role is bound to exactly one service account name in exactly one
   namespace. No wildcards. Never the `default` service account.
2. **Audience `vault`.** Roles set `audience` to `vault`. The pod gets that token from a projected
   service account token volume with audience `vault` and a lifetime of at most one hour, mounted
   only into the container or containers that log in. No other container in the pod carries a
   service account token of any kind.
3. **Short tokens.** `token_ttl` is at most 20 minutes and `token_max_ttl` at most 4 hours. Both
   are set.
4. **One policy per workload,** named like its role: `read` on exactly the secrets the workload
   reads. No globs, no other capability, nothing outside the workload's own secrets.
5. **TLS.** Clients use the address in `docs/vault.md` and verify Vault's certificate against the
   platform CA. Verification is never disabled.
6. **Where secrets land.** Secrets are rendered only onto a memory-backed volume, never with
   permission bits for "other", and are read by the consuming container as its own non-root user.
   Never in environment variables, ConfigMaps or logs.
7. **Vault tokens stay put.** A Vault token never leaves the container that obtained it. If it is
   written to a file, that file is on a memory-backed volume no other container mounts.
8. **Image.** The Vault image is the mirrored one, pinned (currently `1.15.6`). Its default user is
   `vault` (uid 100, gid 1000).

Exceptions are agreed with platform in writing, before deploying.

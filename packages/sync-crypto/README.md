# @ztools/sync-crypto

Decentralized end-to-end encrypted (E2EE) sync engine for ZTools, built on Argon2id, AES-256-GCM, WebDAV, and GitHub Gist.

ZTools 去中心化端到端加密同步引擎（基于 Argon2id、AES-256-GCM、WebDAV 与 GitHub Gist）。

## Capabilities / 架构能力

1. **E2EE Cryptography (`src/crypto/`) / E2EE 密码学核心**
   - **Argon2id Key Derivation / 密钥衍生**：RFC 9106 compliant hybrid key derivation from user passphrase + salt to a 256-bit symmetric key. / 基于 RFC 9106 从主密码与盐值派生 256 位对称密钥。
   - **AES-256-GCM Authenticated Encryption / 认证加密**：96-bit random IV, 128-bit auth tag, and AAD support against replay and tampering. / 采用 96-bit 随机 IV、128-bit 认证标签与 AAD 防篡改。
   - **Encrypted Envelopes / 密文封包**：Serializes and encrypts app settings, plugin metadata, and clipboard history. / 支持应用设置、插件元数据及剪贴板历史的安全加密封包。

2. **Storage Adapters (`src/adapters/`) / 去中心化存储适配器**
   - **WebDAV**：Supports Jianguoyun, Nextcloud, Synology, and private NAS (`PROPFIND`, `MKCOL`, `GET`, `PUT` with `If-Match` ETag optimistic locking, `DELETE`). / 支持坚果云、Nextcloud、群晖/私有 NAS 及 ETag 乐观锁并发控制。
   - **GitHub Gist**：Private Gist sync via Personal Access Token (PAT) with version diffing and `GistConflictError` detection. / 基于 PAT 的私有 Gist 读写与并发冲突检测。

3. **Sync Orchestrator (`src/engine/`) / 同步编排器**
   - **`E2eeSyncEngine`**：Coordinates key derivation, payload encryption, and two-way remote sync. / 串联密钥派生、密文打包与远端双向同步链路。

## Build & Test / 构建与测试

```bash
# Build TypeScript / 编译 TypeScript
npm run build

# Run unit tests / 运行全量单元测试
npm test
```

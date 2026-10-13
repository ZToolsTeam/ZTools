# @ztools/sync-crypto

ZTools 去中心化端到端加密同步引擎 (E2EE Sync Engine with Argon2id, AES-256-GCM, WebDAV & GitHub Gist)。

## 架构能力

1. **E2EE 密码学核心 (`src/crypto/`)**
   - **Argon2id 密钥衍生**：基于 RFC 9106 规范，具备数据无关与数据依赖寻址双重抗性（有效抵御侧信道与 GPU/ASIC 暴破），从用户主密码与盐值派生 256 位高强度对称密钥。
   - **AES-256-GCM 认证加密**：采用 96-bit 随机 IV 与 128-bit 消息认证码（Tag），支持 AAD 附加认证数据，具备完备的防重放与防篡改感知能力。
   - **配置与剪贴板密文封包**：支持全量应用设置、插件元数据及富文本/多模态剪贴板历史的安全加密与序列化。

2. **去中心化存储协议适配器 (`src/adapters/`)**
   - **WebDAV 适配器**：全面支持坚果云、Nextcloud、群晖/私有 NAS。支持 `PROPFIND`（深度与元数据检索）、`MKCOL`（目录递归创建）、`GET`、`PUT`（基于 `If-Match` ETag 的乐观锁并发控制）以及 `DELETE`。
   - **GitHub Gist 适配器**：基于 GitHub Personal Access Token (PAT) 的私有 Gist 读写，具备高精度版本比对与并发冲突检测（`GistConflictError`）。

3. **端到端同步编排器 (`src/engine/`)**
   - **E2eeSyncEngine**：一站式主控，串联密钥派生、密文打包与远端云存储的双向同步链路。

## 测试与构建

```bash
# 编译 TypeScript
npm run build

# 运行全量单元测试
npm test
```

// src/services/vault.ts
import { VaultStore } from "./vaultStore.js";
import { config } from "../config.js";
export const vault = new VaultStore(config.vaultRoot);
//# sourceMappingURL=vault.js.map
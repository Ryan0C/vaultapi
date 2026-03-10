// src/services/vaultRoot.ts
import path from "path";
import { config } from "../config";
/**
 * Return an absolute filesystem path pointing at the Foundry UserData root
 * (or whichever directory contains `vault/`).
 *
 * Example:
 *   /Users/you/FoundryVTT/Data
 * so vault lives at:
 *   /Users/you/FoundryVTT/Data/vault
 */
export function getVaultRoot() {
    // 1) Explicit env override
    const env = process.env.VAULT_ROOT;
    if (env && env.trim())
        return path.resolve(env.trim());
    // 2) Config-based (update this if your config uses different field names)
    // Options you might have:
    // - config.vaultRoot
    // - config.foundryDataPath
    // - config.userDataPath
    const cfg = config.vaultRoot ??
        config.foundryDataPath ??
        config.userDataPath;
    if (cfg && String(cfg).trim())
        return path.resolve(String(cfg).trim());
    // 3) Last resort fallback
    return path.resolve(process.cwd());
}
//# sourceMappingURL=vaultRoot.js.map
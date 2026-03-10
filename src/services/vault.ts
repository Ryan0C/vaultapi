// src/services/vault.ts
import { VaultStore } from "./vaultStore";
import { config } from "../config";

export const vault = new VaultStore(config.vaultRoot);
// @ts-nocheck
// uploads.ts
import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import multer from "multer";
import crypto from "node:crypto";
import { makeRequireUser } from "../middleware/authz.js";
import { forbidden } from "../utils/errors.js";
// If you want: use sharp to convert/resize to webp
// import sharp from "sharp";
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (_req, file, cb) => {
        const ok = ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype);
        cb(ok ? null : new Error("Invalid file type"), ok);
    }
});
function safeId(s) {
    return String(s ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}
export function makeUploadsRouter(deps) {
    const router = Router();
    const requireUser = makeRequireUser();
    router.post("/:worldId/uploads", requireUser, upload.single("file"), async (req, res, next) => {
        try {
            const dataRoot = deps.foundryDataRoot;
            if (!dataRoot)
                throw forbidden("FOUNDRY_DATA_ROOT not configured");
            const worldId = safeId(req.params.worldId);
            const kind = String(req.body?.kind ?? "misc");
            const characterId = safeId(String(req.body?.characterId ?? ""));
            if (!worldId)
                throw new Error("Missing worldId");
            if (!req.file)
                throw new Error("Missing file");
            // TODO: authz check: can this user upload to this world?
            // if (!canUpload(req.user, worldId)) throw forbidden("No permission");
            const ext = "webp"; // choose your canonical format
            const avatarId = characterId || "new";
            const baseName = kind === "avatar"
                ? `avatar-${avatarId}-${crypto.randomBytes(4).toString("hex")}.${ext}`
                : `upload-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
            const relDir = path.join("worlds", worldId, "vaulthero", "uploads", kind);
            const absDir = path.join(dataRoot, relDir);
            await fs.mkdir(absDir, { recursive: true });
            const absFile = path.join(absDir, baseName);
            // If you want to normalize/resize to 600px width:
            // const out = await sharp(req.file.buffer)
            //   .resize({ width: 600, withoutEnlargement: true })
            //   .webp({ quality: 82 })
            //   .toBuffer();
            // await fs.writeFile(absFile, out);
            // Or store as-is (less ideal)
            await fs.writeFile(absFile, req.file.buffer);
            // This is what you send to Foundry/VaultSync
            const mediaRelPath = path.join(relDir, baseName).replace(/\\/g, "/");
            const url = `/media/${mediaRelPath}`;
            return res.json({ ok: true, path: mediaRelPath, url });
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=uploads.js.map
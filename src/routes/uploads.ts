// @ts-nocheck
// uploads.ts
import { Router } from "express";
import path from "node:path";
import fs from "node:fs/promises";
import multer from "multer";
import crypto from "node:crypto";
import sharp from "sharp";
import type { CreateAppDeps } from "../app.js";
import { makeRequireUser } from "../middleware/authz.js";
import { forbidden } from "../utils/errors.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const ok = ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Invalid file type"), ok);
  }
});

function safeId(s: string) {
  return String(s ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

async function normalizeUploadedImage(input: Buffer, kind: string): Promise<Buffer> {
  const pipeline = sharp(input, { failOn: "warning" }).rotate();

  if (kind === "avatar") {
    pipeline.resize({
      width: 768,
      height: 768,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  return pipeline.webp({
    quality: kind === "avatar" ? 80 : 82,
    effort: 4,
  }).toBuffer();
}

export function makeUploadsRouter(deps: CreateAppDeps) {
  const router = Router();
  const requireUser = makeRequireUser();

  router.post("/:worldId/uploads",
    requireUser,
    upload.single("file"),
    async (req, res, next) => {
      try {
        const dataRoot = deps.foundryDataRoot;
        if (!dataRoot) throw forbidden("FOUNDRY_DATA_ROOT not configured");

        const worldId = safeId(req.params.worldId);
        const kind = String(req.body?.kind ?? "misc");
        const characterId = safeId(String(req.body?.characterId ?? ""));

        if (!worldId) throw new Error("Missing worldId");
        if (!req.file) throw new Error("Missing file");
        // TODO: authz check: can this user upload to this world?
        // if (!canUpload(req.user, worldId)) throw forbidden("No permission");

        const ext = "webp"; // choose your canonical format
        const avatarId = characterId || "new";
        const baseName =
          kind === "avatar"
            ? `avatar-${avatarId}-${crypto.randomBytes(4).toString("hex")}.${ext}`
            : `upload-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;

        const relDir = path.join("worlds", worldId, "vaulthero", "uploads", kind);
        const absDir = path.join(dataRoot, relDir);
        await fs.mkdir(absDir, { recursive: true });

        const absFile = path.join(absDir, baseName);

        const out = await normalizeUploadedImage(req.file.buffer, kind);
        await fs.writeFile(absFile, out);

        // This is what you send to Foundry/VaultSync
        const mediaRelPath = path.join(relDir, baseName).replace(/\\/g, "/");
        const url = `/media/${mediaRelPath}`;

        return res.json({ ok: true, path: mediaRelPath, url });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

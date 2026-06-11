import path from "node:path";
import fs from "node:fs/promises";
import { Job } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { runCommand } from "@/lib/system/command";

export async function runBackupCreateJob(job: Job) {
  const server = await prisma.gameServer.findUnique({
    where: { id: job.serverId },
  });

  if (!server) throw new Error("Server not found.");
  if (!server.installed) throw new Error("Server is not installed.");

  const backupRoot =
    process.env.APEXPANEL_BACKUP_ROOT ??
    "/opt/apexpanel-data/backups";

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(backupRoot, server.slug);

  await prisma.job.update({
    where: { id: job.id },
    data: {
      progress: 15,
      message: "Preparing backup folder.",
    },
  });

  await fs.mkdir(backupDir, { recursive: true });

  const backupName = `${server.slug}-${stamp}.tar.gz`;
  const backupPath = path.join(backupDir, backupName);

  await prisma.job.update({
    where: { id: job.id },
    data: {
      progress: 35,
      message: "Compressing server files.",
    },
  });

  await runCommand(
    "tar",
    [
      "--warning=no-file-changed",
      "--exclude=./logs",
      "-czf",
      backupPath,
      "-C",
      server.installPath,
      ".",
    ],
    "/",
  );

  await prisma.job.update({
    where: { id: job.id },
    data: {
      progress: 90,
      message: "Backup archive created.",
      result: {
        backupName,
        backupPath,
      },
    },
  });
}
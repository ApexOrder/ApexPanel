"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { create7dtdServerConfig } from "@/lib/games/7dtd/config";
import { runCommand } from "@/lib/system/command";
import { getServerRoot } from "@/lib/system/paths";
import { ServerStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import fs from "node:fs/promises";
import path from "node:path";
import { createJob } from "@/lib/jobs/create-job";

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

function escapeXmlAttribute(value: string) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function patchXmlProp(
  xml: string,
  name: string,
  value: string | number | boolean,
) {
  const safeValue = escapeXmlAttribute(String(value));

  const pattern = new RegExp(
    `(<property\\s+name="${name}"\\s+value=")([^"]*)("\\s*/>)`,
    "i",
  );

  if (pattern.test(xml)) {
    return xml.replace(pattern, `$1${safeValue}$3`);
  }

  return xml.replace(
    "</ServerSettings>",
    `  <property name="${name}" value="${safeValue}"/>\n</ServerSettings>`,
  );
}

function readXmlProp(xml: string, name: string) {
  const match = xml.match(
    new RegExp(`<property\\s+name="${name}"\\s+value="([^"]*)"\\s*/>`, "i"),
  );

  return match?.[1] ?? null;
}

function readXmlNumber(xml: string, name: string, fallback: number) {
  const value = readXmlProp(xml, name);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readXmlBoolean(xml: string, name: string, fallback: boolean) {
  const value = readXmlProp(xml, name);
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

async function requireServerAdmin() {
  const session = await auth();

  if (!session?.user) throw new Error("Unauthorised.");

  if (!["OWNER", "ADMIN"].includes(session.user.role)) {
    throw new Error("You do not have permission to manage servers.");
  }

  return session;
}

export async function createServer(formData: FormData) {
  await requireServerAdmin();

  const name = String(formData.get("name") ?? "").trim();
  const game = String(formData.get("game") ?? "7dtd");
  const gamePort = Number(formData.get("gamePort") ?? 26900);
  const queryPort = Number(formData.get("queryPort") ?? 26901);
  const maxPlayers = Number(formData.get("maxPlayers") ?? 8);

  if (!name) throw new Error("Server name is required.");

  const slug = slugify(name);
  const installPath = `${getServerRoot()}/${slug}`;

  await prisma.gameServer.create({
    data: {
      name,
      slug,
      game,
      installPath,
      gamePort,
      queryPort,
      maxPlayers,
    },
  });

  redirect(`/servers/${slug}`);
}

export async function updateServerStatus(
  serverId: string,
  status: ServerStatus,
) {
  await requireServerAdmin();

  await prisma.gameServer.update({
    where: { id: serverId },
    data: { status },
  });

  revalidatePath("/servers");
}

export async function installServer(serverId: string) {
  await requireServerAdmin();

  const server = await prisma.gameServer.findUnique({
    where: { id: serverId },
  });

  if (!server) throw new Error("Server not found.");

  await prisma.gameServer.update({
    where: { id: server.id },
    data: { status: "INSTALLING" },
  });

  await fs.mkdir(server.installPath, { recursive: true });
  await fs.mkdir(path.join(server.installPath, "data"), { recursive: true });
  await fs.mkdir(path.join(server.installPath, "config"), { recursive: true });
  await fs.mkdir(path.join(server.installPath, "logs"), { recursive: true });

  const envFile = `SERVER_NAME="${server.name}"
GAME_PORT=${server.gamePort}
QUERY_PORT=${server.queryPort ?? 26901}
MAX_PLAYERS=${server.maxPlayers}
`;

  const composeFile = `services:
  ${server.slug}:
    image: didstopia/7dtd-server:latest
    container_name: apexpanel-${server.slug}
    restart: unless-stopped
    ports:
      - "\${GAME_PORT}:26900/tcp"
      - "\${GAME_PORT}:26900/udp"
      - "\${QUERY_PORT}:26901/udp"
    environment:
      - SEVEN_DAYS_TO_DIE_SERVER_NAME=\${SERVER_NAME}
      - SEVEN_DAYS_TO_DIE_MAX_PLAYERS=\${MAX_PLAYERS}
    volumes:
      - ./data:/steamcmd/7dtd
      - ./config:/config
      - ./logs:/logs
`;

  await fs.writeFile(path.join(server.installPath, ".env"), envFile);
  await fs.writeFile(path.join(server.installPath, "docker-compose.yml"), composeFile);

  await fs.writeFile(
    path.join(server.installPath, "config", "serverconfig.xml"),
    create7dtdServerConfig({
      serverName: server.name,
      gamePort: server.gamePort,
      maxPlayers: server.maxPlayers,
      world: server.world,
      worldSeed: server.worldSeed,
      worldSize: server.worldSize,
      difficulty: server.difficulty,
      xpMultiplier: server.xpMultiplier,
      lootAbundance: server.lootAbundance,
      bloodMoonFreq: server.bloodMoonFreq,
      bloodMoonCount: server.bloodMoonCount,
      serverPassword: server.serverPassword,
      eacEnabled: server.eacEnabled,
    }),
  );

  await prisma.gameServer.update({
    where: { id: server.id },
    data: {
      status: "STOPPED",
      installed: true,
      containerName: `apexpanel-${server.slug}`,
    },
  });

  revalidatePath("/servers");
  revalidatePath(`/servers/${server.slug}`);
}

export async function startServer(serverId: string) {
  await requireServerAdmin();

  const server = await prisma.gameServer.findUnique({
    where: { id: serverId },
  });

  if (!server) throw new Error("Server not found.");
  if (!server.installed) throw new Error("Server is not installed.");

  await prisma.gameServer.update({
    where: { id: server.id },
    data: { status: "STARTING" },
  });

  try {
    await runCommand("docker", ["compose", "up", "-d"], server.installPath);

    await prisma.gameServer.update({
      where: { id: server.id },
      data: {
        status: "RUNNING",
        lastStartedAt: new Date(),
      },
    });
  } catch (error) {
    await prisma.gameServer.update({
      where: { id: server.id },
      data: { status: "ERROR" },
    });

    throw error;
  }

  revalidatePath("/servers");
  revalidatePath(`/servers/${server.slug}`);
}

export async function stopServer(serverId: string) {
  await requireServerAdmin();

  const server = await prisma.gameServer.findUnique({
    where: { id: serverId },
  });

  if (!server) throw new Error("Server not found.");
  if (!server.installed) throw new Error("Server is not installed.");

  await prisma.gameServer.update({
    where: { id: server.id },
    data: { status: "STOPPING" },
  });

  try {
    await runCommand("docker", ["compose", "down"], server.installPath);

    await prisma.gameServer.update({
      where: { id: server.id },
      data: {
        status: "STOPPED",
        lastStoppedAt: new Date(),
      },
    });
  } catch (error) {
    await prisma.gameServer.update({
      where: { id: server.id },
      data: { status: "ERROR" },
    });

    throw error;
  }

  revalidatePath("/servers");
  revalidatePath(`/servers/${server.slug}`);
}

export async function restartServer(serverId: string) {
  await stopServer(serverId);
  await startServer(serverId);
}

export async function refreshServerStatus(serverId: string) {
  await requireServerAdmin();

  const server = await prisma.gameServer.findUnique({
    where: { id: serverId },
  });

  if (!server) throw new Error("Server not found.");
  if (!server.containerName) throw new Error("No container name stored.");

  try {
    const result = await runCommand(
      "docker",
      ["inspect", "-f", "{{.State.Running}}", server.containerName],
      server.installPath,
    );

    await prisma.gameServer.update({
      where: { id: server.id },
      data: {
        status: result.stdout.trim() === "true" ? "RUNNING" : "STOPPED",
      },
    });
  } catch {
    await prisma.gameServer.update({
      where: { id: server.id },
      data: { status: "STOPPED" },
    });
  }

  revalidatePath("/servers");
  revalidatePath(`/servers/${server.slug}`);
}

export async function getServerLogs(serverId: string) {
  await requireServerAdmin();

  const server = await prisma.gameServer.findUnique({
    where: { id: serverId },
  });

  if (!server) throw new Error("Server not found.");
  if (!server.installed) return "Server is not installed yet.";

  try {
    const result = await runCommand(
      "docker",
      ["compose", "logs", "--tail", "150"],
      server.installPath,
    );

    return result.stdout || result.stderr || "No logs returned.";
  } catch {
    return "Unable to read logs. Container may not exist yet.";
  }
}

export async function updateServerConfig(serverId: string, formData: FormData) {
  await requireServerAdmin();

  const server = await prisma.gameServer.findUnique({
    where: { id: serverId },
  });

  if (!server) throw new Error("Server not found.");

  const name = String(formData.get("name") ?? server.name).trim();
  const maxPlayers = Number(formData.get("maxPlayers") ?? server.maxPlayers);
  const gamePort = Number(formData.get("gamePort") ?? server.gamePort);
  const queryPort = Number(formData.get("queryPort") ?? server.queryPort ?? 26901);

  const world = String(formData.get("world") ?? server.world ?? "Navezgane");
  const worldSeed = String(formData.get("worldSeed") ?? server.worldSeed ?? "ApexPanel");
  const worldSize = Number(formData.get("worldSize") ?? server.worldSize ?? 6144);
  const difficulty = Number(formData.get("difficulty") ?? server.difficulty ?? 0);
  const xpMultiplier = Number(formData.get("xpMultiplier") ?? server.xpMultiplier ?? 100);
  const lootAbundance = Number(formData.get("lootAbundance") ?? server.lootAbundance ?? 100);
  const bloodMoonFreq = Number(formData.get("bloodMoonFreq") ?? server.bloodMoonFreq ?? 7);
  const bloodMoonCount = Number(formData.get("bloodMoonCount") ?? server.bloodMoonCount ?? 8);
  const serverPassword = String(formData.get("serverPassword") ?? server.serverPassword ?? "");
  const eacEnabled = formData.get("eacEnabled") === "on";

  await prisma.gameServer.update({
    where: { id: server.id },
    data: {
      name,
      maxPlayers,
      gamePort,
      queryPort,
      world,
      worldSeed,
      worldSize,
      difficulty,
      xpMultiplier,
      lootAbundance,
      bloodMoonFreq,
      bloodMoonCount,
      serverPassword: serverPassword || null,
      eacEnabled,
    },
  });

  if (server.installed) {
    const envFile = `SERVER_NAME="${name}"
GAME_PORT=${gamePort}
QUERY_PORT=${queryPort}
MAX_PLAYERS=${maxPlayers}
`;

    await fs.writeFile(path.join(server.installPath, ".env"), envFile);

    const xmlPath = path.join(server.installPath, "config", "serverconfig.xml");

    let xml: string;

    try {
      xml = await fs.readFile(xmlPath, "utf8");
    } catch {
      xml = create7dtdServerConfig({
        serverName: name,
        gamePort,
        maxPlayers,
        world,
        worldSeed,
        worldSize,
        difficulty,
        xpMultiplier,
        lootAbundance,
        bloodMoonFreq,
        bloodMoonCount,
        serverPassword,
        eacEnabled,
      });
    }

    xml = patchXmlProp(xml, "ServerName", name);
    xml = patchXmlProp(xml, "ServerPort", gamePort);
    xml = patchXmlProp(xml, "ServerMaxPlayerCount", maxPlayers);
    xml = patchXmlProp(xml, "GameWorld", world);
    xml = patchXmlProp(xml, "WorldGenSeed", worldSeed);
    xml = patchXmlProp(xml, "WorldGenSize", worldSize);
    xml = patchXmlProp(xml, "EnemyDifficulty", difficulty);
    xml = patchXmlProp(xml, "XPMultiplier", xpMultiplier);
    xml = patchXmlProp(xml, "LootAbundance", lootAbundance);
    xml = patchXmlProp(xml, "BloodMoonFrequency", bloodMoonFreq);
    xml = patchXmlProp(xml, "BloodMoonEnemyCount", bloodMoonCount);
    xml = patchXmlProp(xml, "ServerPassword", serverPassword);
    xml = patchXmlProp(xml, "EACEnabled", eacEnabled);

    await fs.writeFile(xmlPath, xml);
  }

  revalidatePath(`/servers/${server.slug}`);
  revalidatePath(`/servers/${server.slug}/config`);
  revalidatePath(`/servers/${server.slug}/config/raw`);
}

export async function updateRawServerConfig(serverId: string, formData: FormData) {
  await requireServerAdmin();

  const server = await prisma.gameServer.findUnique({
    where: { id: serverId },
  });

  if (!server) throw new Error("Server not found.");

  const xml = String(formData.get("xml") ?? "");

  await fs.mkdir(path.join(server.installPath, "config"), { recursive: true });

  await fs.writeFile(
    path.join(server.installPath, "config", "serverconfig.xml"),
    xml,
  );

  await prisma.gameServer.update({
    where: { id: server.id },
    data: {
      name: readXmlProp(xml, "ServerName") ?? server.name,
      gamePort: readXmlNumber(xml, "ServerPort", server.gamePort),
      maxPlayers: readXmlNumber(xml, "ServerMaxPlayerCount", server.maxPlayers),
      world: readXmlProp(xml, "GameWorld") ?? server.world,
      worldSeed: readXmlProp(xml, "WorldGenSeed") ?? server.worldSeed,
      worldSize: readXmlNumber(xml, "WorldGenSize", server.worldSize ?? 6144),
      difficulty: readXmlNumber(xml, "EnemyDifficulty", server.difficulty ?? 0),
      xpMultiplier: readXmlNumber(xml, "XPMultiplier", server.xpMultiplier ?? 100),
      lootAbundance: readXmlNumber(xml, "LootAbundance", server.lootAbundance ?? 100),
      bloodMoonFreq: readXmlNumber(xml, "BloodMoonFrequency", server.bloodMoonFreq ?? 7),
      bloodMoonCount: readXmlNumber(xml, "BloodMoonEnemyCount", server.bloodMoonCount ?? 8),
      serverPassword: readXmlProp(xml, "ServerPassword") || null,
      eacEnabled: readXmlBoolean(xml, "EACEnabled", server.eacEnabled ?? true),
    },
  });

  revalidatePath("/servers");
  revalidatePath(`/servers/${server.slug}`);
  revalidatePath(`/servers/${server.slug}/config`);
  revalidatePath(`/servers/${server.slug}/config/raw`);
}

export async function createServerBackup(serverId: string) {
  await requireServerAdmin();

  const server = await prisma.gameServer.findUnique({
    where: { id: serverId },
  });

  if (!server) throw new Error("Server not found.");
  if (!server.installed) throw new Error("Server is not installed.");

  await createJob({
    serverId: server.id,
    type: "BACKUP_CREATE",
    title: "Creating backup",
    message: "Backup queued.",
    payload: {
      serverSlug: server.slug,
      installPath: server.installPath,
    },
  });

  revalidatePath(`/servers/${server.slug}`);
  revalidatePath(`/servers/${server.slug}/backups`);
}
export async function restoreServerBackup(
  serverId: string,
  fileName: string,
) {
  await requireServerAdmin();

  const server = await prisma.gameServer.findUnique({
    where: { id: serverId },
  });

  if (!server) throw new Error("Server not found.");

  const backupRoot =
    process.env.APEXPANEL_BACKUP_ROOT ??
    "/opt/apexpanel-data/backups";

  const backupPath = path.join(
    backupRoot,
    server.slug,
    fileName,
  );

  await runCommand(
    "tar",
    [
      "-xzf",
      backupPath,
      "-C",
      server.installPath,
    ],
    "/",
  );

  revalidatePath(`/servers/${server.slug}`);
  revalidatePath(`/servers/${server.slug}/backups`);
}
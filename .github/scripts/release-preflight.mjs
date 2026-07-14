#!/usr/bin/env node

import { readFileSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STABLE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function readUtf8(path) {
  const bytes = readFileSync(path);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function regularFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular, non-symlink file`);
  }
}

function cargoPackageVersion(source) {
  let section = "";
  const versions = [];
  for (const line of source.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section !== "package") continue;
    const version = line.match(/^\s*version\s*=\s*"([^"]+)"\s*(?:#.*)?$/);
    if (version) versions.push(version[1]);
  }
  if (versions.length !== 1) {
    throw new Error(`src-tauri/Cargo.toml must contain exactly one [package] version (found ${versions.length})`);
  }
  return versions[0];
}

function jsonObject(root, relativePath) {
  const path = resolve(root, relativePath);
  regularFile(path, relativePath);
  const value = JSON.parse(readUtf8(path));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${relativePath} must contain a JSON object`);
  }
  return value;
}

function jsonVersion(root, relativePath) {
  const value = jsonObject(root, relativePath);
  if (!value || typeof value !== "object" || typeof value.version !== "string") {
    throw new Error(`${relativePath} must contain a string version`);
  }
  return value.version;
}

export function runPreflight(tag, root = process.cwd()) {
  const match = STABLE_TAG.exec(tag);
  if (!match) {
    throw new Error("release tag must be stable vMAJOR.MINOR.PATCH without leading zeroes");
  }
  const version = tag.slice(1);
  const tauriConfig = jsonObject(root, "src-tauri/tauri.conf.json");
  const versions = new Map([
    ["package.json", jsonVersion(root, "package.json")],
    ["src-tauri/tauri.conf.json", tauriConfig.version],
  ]);
  const cargoPath = resolve(root, "src-tauri/Cargo.toml");
  regularFile(cargoPath, "src-tauri/Cargo.toml");
  versions.set("src-tauri/Cargo.toml", cargoPackageVersion(readUtf8(cargoPath)));
  for (const [source, actual] of versions) {
    if (actual !== version) {
      throw new Error(`${source} version ${JSON.stringify(actual)} does not match tag version ${JSON.stringify(version)}`);
    }
  }
  if (tauriConfig.bundle?.macOS?.signingIdentity !== "-") {
    throw new Error(
      'src-tauri/tauri.conf.json must set bundle.macOS.signingIdentity to "-" so release app bundles receive a complete ad-hoc signature',
    );
  }

  const notesRelative = `docs/release-notes/${tag}.md`;
  const notesPath = resolve(root, notesRelative);
  regularFile(notesPath, notesRelative);
  const notes = readUtf8(notesPath).trim();
  if (notes.length < 80) {
    throw new Error(`${notesRelative} is missing or looks like a placeholder`);
  }
  const firstLine = notes.split(/\r?\n/, 1)[0];
  if (!new RegExp(`^# ${tag.replaceAll(".", "\\.")}(?:\\s|$)`).test(firstLine)) {
    throw new Error(`${notesRelative} must start with a level-one ${tag} heading`);
  }

  const footerRelative = "docs/release-notes/_install_footer.md";
  const footerPath = resolve(root, footerRelative);
  regularFile(footerPath, footerRelative);
  if (readUtf8(footerPath).trim().length < 80) {
    throw new Error(`${footerRelative} is missing or looks like a placeholder`);
  }
  return { tag, version, notesRelative };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = runPreflight(process.argv[2] ?? "");
    console.log(`Release preflight passed for ${result.tag} (${result.notesRelative}).`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/**
 * Data directory migration (0.4.0 rename, plan M2).
 *
 * The plugin used to persist everything under `~/.opencode2dsh/`. The
 * directory name is a functional identifier (the status file, the models.dev
 * cache, the pinned gateway session and the sing-box conversion core all
 * live there), so the rename moves it to `~/.dsh-plugin-adapter/`.
 *
 * The migration is copy-then-rename, never a destructive move: the old
 * directory is renamed to `~/.opencode2dsh.bak-<yyyymmdd>` and stays a
 * complete rollback path until the user deletes it. Any failure keeps the
 * plugin running on the old directory instead of crashing the host.
 *
 * The migration is synchronous on purpose: the plugin's `apply()` must know
 * the data directory before it writes the status file or points the catalog
 * cache at it, and the payload is a few hundred kilobytes.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Current data directory (0.4.0+). */
export const DATA_DIR_NAME = '.dsh-plugin-adapter'
/** Pre-0.4.0 data directory, migrated on first start. */
export const LEGACY_DATA_DIR_NAME = '.opencode2dsh'

export interface DataDirResolution {
  /** Directory the plugin must use. */
  dir: string
  /** True when content was copied out of the legacy directory. */
  migrated: boolean
  /** Where the legacy directory was parked (rollback path), if it moved. */
  backup?: string
  /** True when the migration failed and the legacy directory is in use. */
  legacyFallback: boolean
  /** Human-readable reason for a fallback (empty when everything worked). */
  reason?: string
}

/** `~/.dsh-plugin-adapter` for a given home directory. */
export function dataDirPath(home: string = homedir()): string {
  return join(home, DATA_DIR_NAME)
}

/** `~/.opencode2dsh` for a given home directory. */
export function legacyDataDirPath(home: string = homedir()): string {
  return join(home, LEGACY_DATA_DIR_NAME)
}

/** `~/.opencode2dsh.bak-<yyyymmdd>` — the parked legacy directory. */
export function legacyBackupPath(legacyDir: string, stamp: string): string {
  return `${legacyDir}.bak-${stamp}`
}

/** The directory resolved for this process (set once at plugin start). */
let resolvedDir: string | null = null

/** Pin the process-wide data directory. */
export function setDataDir(dir: string): void {
  resolvedDir = dir
}

/**
 * The data directory this process uses. Falls back to the new path when the
 * migration has not run yet (e.g. a unit test that only needs a path).
 */
export function currentDataDir(home: string = homedir()): string {
  return resolvedDir ?? dataDirPath(home)
}

function fileSize(path: string): number | undefined {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}

/**
 * Copy every entry of `from` into `to` and verify the copy landed.
 * Verification is per entry (exists + same size for files), which is enough
 * to catch a truncated copy without hashing hundreds of megabytes.
 */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      cpSync(source, target, { recursive: true })
      if (!existsSync(target)) throw new Error(`copy verification failed: ${target}`)
      continue
    }
    if (!entry.isFile()) continue
    cpSync(source, target)
    if (fileSize(source) !== fileSize(target)) throw new Error(`copy verification failed: ${target}`)
  }
}

/**
 * Resolve the data directory, migrating the legacy one when needed.
 *
 * States:
 *  1. new directory exists -> use it (idempotent, safe on every restart).
 *  2. only the legacy directory exists -> copy it over, verify, then park the
 *     legacy directory as `~/.opencode2dsh.bak-<yyyymmdd>`.
 *  3. neither exists -> create the new directory (fresh install).
 *  4. anything throws -> keep using the legacy directory (when it exists) and
 *     report the reason; the plugin must never crash the host over a
 *     directory rename.
 */
export function resolveDataDir(
  options: { home?: string; now?: Date; logger?: { warn(...args: unknown[]): void } } = {},
): DataDirResolution {
  const home = options.home ?? homedir()
  const now = options.now ?? new Date()
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '')
  const newDir = dataDirPath(home)
  const legacyDir = legacyDataDirPath(home)

  try {
    if (existsSync(newDir)) {
      setDataDir(newDir)
      return { dir: newDir, migrated: false, legacyFallback: false }
    }

    if (!existsSync(legacyDir)) {
      mkdirSync(newDir, { recursive: true })
      setDataDir(newDir)
      return { dir: newDir, migrated: false, legacyFallback: false }
    }

    copyTree(legacyDir, newDir)
    const backup = legacyBackupPath(legacyDir, stamp)
    renameSync(legacyDir, backup)
    setDataDir(newDir)
    options.logger?.warn(`dsh-plugin-adapter: data directory migrated to ${newDir}; previous contents parked at ${backup}`)
    return { dir: newDir, migrated: true, backup, legacyFallback: false }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (existsSync(legacyDir)) {
      setDataDir(legacyDir)
      options.logger?.warn(`dsh-plugin-adapter: data directory migration failed (${reason}); keeping ${legacyDir}`)
      return { dir: legacyDir, migrated: false, legacyFallback: true, reason }
    }
    // The new directory could not even be created: keep the new path anyway
    // so the plugin writes where it expects to (individual writes are
    // best-effort and never fatal).
    setDataDir(newDir)
    options.logger?.warn(`dsh-plugin-adapter: data directory setup failed (${reason}); using ${newDir}`)
    return { dir: newDir, migrated: false, legacyFallback: false, reason }
  }
}

/**
 * Remove a parked legacy backup. Only called by an explicit user action —
 * the migration itself never destroys anything.
 */
export function removeLegacyBackup(backup: string): void {
  rmSync(backup, { recursive: true, force: true })
}

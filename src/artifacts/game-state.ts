/**
 * Per-game state persistence: reloads a game's BaselineRegistry/AdoptionLedger
 * across sessions instead of starting from an empty `new BaselineRegistry()`
 * every run (H5/H7). Storage layout mirrors run-store.ts's `runs/` root:
 * `<rootDir>/runs/<gameId>/registry.json` and `.../ledger.json`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BaselineRegistry } from './baseline-registry';
import { AdoptionLedger } from './adoption-ledger';

function gameDir(rootDir: string, gameId: string): string {
  return join(rootDir, 'runs', gameId);
}

function registryPath(rootDir: string, gameId: string): string {
  return join(gameDir(rootDir, gameId), 'registry.json');
}

function ledgerPath(rootDir: string, gameId: string): string {
  return join(gameDir(rootDir, gameId), 'ledger.json');
}

export function loadOrCreateRegistry(rootDir: string, gameId: string): BaselineRegistry {
  const path = registryPath(rootDir, gameId);
  if (!existsSync(path)) {
    return new BaselineRegistry();
  }
  return BaselineRegistry.fromJSON(JSON.parse(readFileSync(path, 'utf8')));
}

export function saveRegistry(rootDir: string, gameId: string, registry: BaselineRegistry): void {
  mkdirSync(gameDir(rootDir, gameId), { recursive: true });
  writeFileSync(registryPath(rootDir, gameId), JSON.stringify(registry.toJSON(), null, 2), 'utf8');
}

export function loadOrCreateLedger(rootDir: string, gameId: string): AdoptionLedger {
  const path = ledgerPath(rootDir, gameId);
  if (!existsSync(path)) {
    return new AdoptionLedger();
  }
  return AdoptionLedger.fromJSON(JSON.parse(readFileSync(path, 'utf8')));
}

export function saveLedger(rootDir: string, gameId: string, ledger: AdoptionLedger): void {
  mkdirSync(gameDir(rootDir, gameId), { recursive: true });
  writeFileSync(ledgerPath(rootDir, gameId), JSON.stringify(ledger.toJSON(), null, 2), 'utf8');
}

import { lstatSync } from 'node:fs'

export function hasPathEntry(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) != null
}

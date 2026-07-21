export interface OperationBackupError extends Error {
  backupDir: string
}

export function withOperationBackup(error: unknown, backupDir: string): OperationBackupError {
  const failure = error instanceof Error ? error : new Error(String(error))
  return Object.assign(failure, { backupDir })
}

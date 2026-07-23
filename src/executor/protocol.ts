import { z } from 'zod'

export const workspaceCommandInputSchema = z.object({
  cwd: z.enum(['workspace', 'repo']),
  command: z.string().min(1).max(8_000),
  timeoutMs: z.number().int().positive(),
  maxOutputChars: z.number().int().positive(),
}).strict()

export type WorkspaceCommandInput = z.infer<typeof workspaceCommandInputSchema>

export type WorkspaceCommandResult =
  | {
      ok: true
      exitCode: number | null
      stdout: string
      stderr: string
      timedOut: boolean
    }
  | {
      ok: false
      code: 'command_not_allowed' | 'executor_unavailable' | 'executor_error'
      error: string
    }

export type WorkspaceCommandRunner = (input: WorkspaceCommandInput) => Promise<WorkspaceCommandResult>
